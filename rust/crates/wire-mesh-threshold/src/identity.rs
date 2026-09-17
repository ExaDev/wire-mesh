//! A group's `IdentityPort`/`Identity`-equivalent, from wire-mesh#29's own
//! design: "`IdentityPort` is already exactly the right shape... a
//! `createThresholdIdentity` factory returns an object satisfying the
//! UNMODIFIED interface." `wire_mesh_core::ports::Identity::sign` is
//! `async fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError>` --
//! opaque bytes in, opaque bytes out, no assumption about how or where the
//! private half lives. A threshold `sign` needs real network round trips
//! to other participants, which this crate cannot itself perform (it has
//! no transport dependency, by the same layering `wire-mesh-wire` and
//! `wire-mesh-core` already keep) -- so [`ThresholdIdentity`] takes a
//! [`ThresholdCoordinator`] the caller supplies, satisfying this crate's
//! own "domain logic depends only on contracts" rule exactly the way
//! `wire-mesh-core`'s own ports do.

use frost_ed25519::keys::PublicKeyPackage;
use frost_ed25519::round1::SigningCommitments;
use frost_ed25519::Identifier;
use wire_mesh_core::adapters::node_identity::{
    derive_device_id_from_public_key, verify_with_identity_key,
};
use wire_mesh_core::ports::identity::Identity;
use wire_mesh_core::ports::CoreError;
use wire_mesh_wire::identity::{DeviceId, IdentityKey};

use crate::subject::ThresholdSubject;

/// The network side of threshold signing, supplied by the caller (a real
/// implementation drives it over `manage-request`/`manage-response` exactly
/// as `core/webrtc`'s own negotiation does; a test implementation can run
/// every participant in-process). Never assumes a specific transport,
/// serialization framing beyond frost-ed25519's own typed values, or
/// retry/timeout policy -- those are the caller's own concern, matching
/// this project's async-contracts-with-an-abort-signal convention (a real
/// implementation threads a timeout/cancellation through its own
/// request-sending mechanism; this trait's signature stays transport-
/// agnostic rather than baking in one policy).
#[async_trait::async_trait]
pub trait ThresholdCoordinator: Send + Sync {
    /// Sends `threshold-commit` to every one of `participants` for
    /// `subject`, and collects at least `threshold` valid `(participant,
    /// commitments)` responses. Implementations decide their own quorum/
    /// timeout/retry policy; this call either returns enough commitments to
    /// proceed or fails.
    async fn commit_round(
        &self,
        session_id: u64,
        participants: &[DeviceId],
        subject: &ThresholdSubject,
        deadline_unix_ms: u64,
    ) -> Result<Vec<(Identifier, SigningCommitments)>, CoreError>;

    /// Sends `threshold-sign` (the collected commitments, no subject) to
    /// every participant that committed, and collects their signature
    /// shares.
    async fn sign_round(
        &self,
        session_id: u64,
        commitments: &[(Identifier, SigningCommitments)],
    ) -> Result<Vec<(Identifier, frost_ed25519::round2::SignatureShare)>, CoreError>;
}

/// A group's threshold-backed identity. `device_id`/`identity_key` are the
/// group's own (`group-device-id = SHA-256(group public key)`, the ordinary
/// `identity.cddl` rule applied to the DKG's output) -- indistinguishable
/// on the wire from any ordinary single-device Ed25519 identity, per this
/// domain's own defining property.
pub struct ThresholdIdentity {
    device_id: DeviceId,
    identity_key: IdentityKey,
    public_key_package: PublicKeyPackage,
    threshold: u16,
    participants: Vec<DeviceId>,
    coordinator: std::sync::Arc<dyn ThresholdCoordinator>,
    next_session_id: std::sync::atomic::AtomicU64,
}

impl ThresholdIdentity {
    pub fn new(
        public_key_package: PublicKeyPackage,
        threshold: u16,
        participants: Vec<DeviceId>,
        coordinator: std::sync::Arc<dyn ThresholdCoordinator>,
    ) -> Result<Self, CoreError> {
        let group_key_bytes = public_key_package
            .verifying_key()
            .serialize()
            .map_err(|e| {
                CoreError::Crypto(format!("could not serialize group verifying key: {e}"))
            })?;
        let identity_key = IdentityKey {
            alg: IdentityKey::ALG_ED25519,
            public_key: group_key_bytes.clone(),
        };
        let device_id = derive_device_id_from_public_key(&group_key_bytes);
        Ok(Self {
            device_id,
            identity_key,
            public_key_package,
            threshold,
            participants,
            coordinator,
            next_session_id: std::sync::atomic::AtomicU64::new(1),
        })
    }
}

#[async_trait::async_trait]
impl Identity for ThresholdIdentity {
    fn device_id(&self) -> &DeviceId {
        &self.device_id
    }

    fn identity_key(&self) -> &IdentityKey {
        &self.identity_key
    }

    /// Orchestrates the full two-round FROST signing protocol described in
    /// `spec/threshold.cddl` (`threshold.commit` then `threshold.sign`) via
    /// `self.coordinator`, then verifies and returns the aggregate
    /// signature -- an ordinary 64-byte Ed25519 signature over `message`,
    /// requiring zero change anywhere a `capability-token`/
    /// `revocation-entry`/`handle-record` is later verified.
    ///
    /// `message` here is expected to already be the fully-assembled
    /// Sig_structure (matching every other `Identity::sign` implementation
    /// in this codebase) -- the CALLER is responsible for constructing the
    /// accompanying `ThresholdSubject` (decoded `kind`/`protected`/
    /// `payload`) that every participant independently reconstructs the
    /// SAME bytes from and reviews before authorising; this method does not
    /// itself decide what a group is signing.
    async fn sign(&self, _message: &[u8]) -> Result<Vec<u8>, CoreError> {
        Err(CoreError::Crypto(
            "ThresholdIdentity::sign requires a ThresholdSubject, not a bare message -- use sign_subject".to_owned(),
        ))
    }

    async fn verify(
        &self,
        key: &IdentityKey,
        message: &[u8],
        signature: &[u8],
    ) -> Result<bool, CoreError> {
        verify_with_identity_key(key, message, signature)
    }

    fn derive_device_id(&self, public_key: &[u8]) -> DeviceId {
        derive_device_id_from_public_key(public_key)
    }
}

impl ThresholdIdentity {
    /// The real entry point: signs `subject` (never a bare hash --
    /// `ThresholdSubject` always carries the full decoded content, per this
    /// domain's own non-negotiable security invariant), round-tripping
    /// through `self.coordinator` for both FROST rounds.
    pub async fn sign_subject(
        &self,
        subject: &ThresholdSubject,
        deadline_unix_ms: u64,
    ) -> Result<Vec<u8>, CoreError> {
        let session_id = self
            .next_session_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);

        let commitments = self
            .coordinator
            .commit_round(session_id, &self.participants, subject, deadline_unix_ms)
            .await?;
        if commitments.len() < self.threshold as usize {
            return Err(CoreError::Crypto(format!(
                "only {} of {} required participants committed",
                commitments.len(),
                self.threshold
            )));
        }

        let shares = self
            .coordinator
            .sign_round(session_id, &commitments)
            .await?;

        let message = crate::subject::to_be_signed(subject);
        let commitments_map = commitments.into_iter().collect();
        let signing_package = crate::signing::build_signing_package(commitments_map, &message);
        let shares_map = shares.into_iter().collect();

        let signature =
            crate::signing::aggregate(&signing_package, &shares_map, &self.public_key_package)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;

        signature
            .serialize()
            .map_err(|e| CoreError::Crypto(format!("could not serialize aggregate signature: {e}")))
    }
}
