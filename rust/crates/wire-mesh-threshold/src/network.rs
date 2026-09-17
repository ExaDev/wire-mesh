//! Real network integration for both roles of `exadev.io/threshold:sign`
//! (wire-mesh#171): [`NetworkThresholdCoordinator`] drives
//! [`crate::identity::ThresholdCoordinator`]'s own `commit_round`/
//! `sign_round` over actual `manage-request`/`manage-response` traffic via
//! a caller-supplied [`ManageRequestSender`], and [`handle_threshold_commit`]/
//! [`handle_threshold_sign`]/[`handle_threshold_abort`] are the participant-
//! side handlers a real dispatch loop calls once it has already decoded a
//! `ManageParams::Threshold*` variant (`wire-mesh-wire::threshold`, this
//! issue's own Rust wire codec).
//!
//! This crate has no transport dependency of its own (see this crate's own
//! `Cargo.toml` comment on why `wire-mesh-core`'s `net` feature stays off,
//! required for `wire-mesh-threshold-wasm`'s `wasm32-unknown-unknown` build
//! to succeed at all) -- [`ManageRequestSender`] is the transport-agnostic
//! contract a real binary's own TCP/relay-routed session implements,
//! mirroring how `mesh-session.ts`'s `sendManageRequest`/
//! `incomingManageRequests` play the identical role on the TypeScript side
//! (`ts/packages/core/src/adapters/threshold-network-coordinator.ts` and
//! `threshold-participant.ts`). Unlike TypeScript, this codebase has no
//! live Rust node/session runtime at all yet (no equivalent of
//! `mesh-session.ts`'s own incoming-request dispatch loop) -- these handlers
//! are the building blocks such a runtime would call, not a runnable loop
//! in their own right.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use frost_ed25519::keys::KeyPackage;
use frost_ed25519::round1::SigningCommitments;
use frost_ed25519::round2::SignatureShare;
use frost_ed25519::Identifier;
use wire_mesh_core::ports::identity::Identity;
use wire_mesh_core::ports::CoreError;
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::{ManageCommand, ManageOutcome, ManageParams};
use wire_mesh_wire::threshold::{
    ThresholdCommit, ThresholdCommitment, ThresholdSign, ThresholdSubject as WireThresholdSubject,
};
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb, CoseSign1};
use wire_mesh_wire::value::CborValue;

use crate::identifiers::identifier_for_device;
use crate::identity::ThresholdCoordinator;
use crate::nonce_store::{NonceStore, SessionId};
use crate::share_envelope::verify_share_envelope;
use crate::signing::{combine_commitments, round1_commit, round2_respond, split_commitments};
use crate::subject::{refuse_unrecognised_kind, to_be_signed, SubjectDecision, ThresholdSubject};

/// Gates `threshold.commit`/`.sign`/`.abort` -- matches
/// `ts/packages/core/src/domain/threshold-network.ts`'s own
/// `THRESHOLD_SIGN_VERB` exactly.
pub const THRESHOLD_SIGN_VERB: &str = "exadev.io/threshold:sign";
/// Gates `threshold.keygen-round1/round2/confirm` when `existing-group-key`
/// is absent on round1 -- a fresh DKG among devices that already trust each
/// other. Matches `ts/packages/core/src/domain/threshold-network.ts`'s own
/// `THRESHOLD_KEYGEN_VERB` exactly.
pub const THRESHOLD_KEYGEN_VERB: &str = "exadev.io/threshold:keygen";
/// Gates the same keygen-round1/round2/confirm triplet when
/// `existing-group-key` is present -- resharing can redefine the participant
/// set entirely and is strictly more dangerous than an initial keygen, so it
/// is a separately grantable and separately revocable capability. Matches
/// `ts/packages/core/src/domain/threshold-network.ts`'s own
/// `THRESHOLD_RESHARE_VERB` exactly.
pub const THRESHOLD_RESHARE_VERB: &str = "exadev.io/threshold:reshare";

/// Which capability verb gates one keygen-round1/round2/confirm ceremony --
/// `THRESHOLD_RESHARE_VERB` when the ceremony carries an
/// `existing-group-key` (round1), `THRESHOLD_KEYGEN_VERB` otherwise. Matches
/// `threshold-network.ts`'s own `keygenCapabilityVerb` exactly; a caller
/// driving one ceremony's round2/confirm messages under the same verb its
/// own round1 used must pass the identical `is_reshare` value throughout.
pub(crate) fn keygen_capability_verb(is_reshare: bool) -> &'static str {
    if is_reshare {
        THRESHOLD_RESHARE_VERB
    } else {
        THRESHOLD_KEYGEN_VERB
    }
}

pub(crate) fn threshold_group_scope() -> CapabilityScope {
    CapabilityScope {
        kind: "group".to_owned(),
        path: None,
    }
}

fn wire_subject(subject: &ThresholdSubject) -> WireThresholdSubject {
    WireThresholdSubject {
        kind: subject.kind.clone(),
        protected: subject.protected.clone(),
        payload: subject.payload.clone(),
    }
}

fn domain_subject(subject: &WireThresholdSubject) -> ThresholdSubject {
    ThresholdSubject {
        kind: subject.kind.clone(),
        protected: subject.protected.clone(),
        payload: subject.payload.clone(),
    }
}

/// The transport-agnostic contract a real `manage-request`/`manage-response`
/// session implements -- never assumes TCP, a specific framing, or a
/// retry/timeout policy, matching this project's async-contracts
/// convention. A second implementation on a completely different transport
/// satisfies this exact contract with zero changes to the contract or its
/// callers.
#[async_trait::async_trait]
pub trait ManageRequestSender: Send + Sync {
    async fn send_manage_request(
        &self,
        target: DeviceId,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<CoseSign1>,
    ) -> Result<ManageOutcome, CoreError>;
}

fn bytes_field<'a>(
    extra: &'a wire_mesh_wire::value::CanonicalMap<String, CborValue>,
    key: &str,
) -> Option<&'a [u8]> {
    match extra.get(&key.to_owned()) {
        Some(CborValue::Bytes(bytes)) => Some(bytes),
        _ => None,
    }
}

fn device_id_field(
    extra: &wire_mesh_wire::value::CanonicalMap<String, CborValue>,
    key: &str,
) -> Option<DeviceId> {
    let bytes = bytes_field(extra, key)?;
    let arr: [u8; 32] = bytes.try_into().ok()?;
    Some(DeviceId::from_bytes(arr))
}

/// Drives the two-round FROST signing protocol over a real
/// [`ManageRequestSender`], exactly as `core/webrtc`'s own negotiation rides
/// `manage-request-frame`. `group`/`verifier_identity`/`token` are fixed for
/// this coordinator's whole lifetime (a coordinator instance is scoped to
/// one group), matching [`ThresholdCoordinator`]'s own contract, which
/// deliberately carries no group/verifier parameters of its own.
///
/// [`ThresholdCoordinator::sign_round`] receives commitments keyed by FROST
/// `Identifier`, not `DeviceId` -- deriving one from the other is one-way, so
/// this coordinator caches the `Identifier -> DeviceId` mapping `commit_round`
/// already has, per session-id, consumed (and removed) by the matching
/// `sign_round` call. This relies on `commit_round` being called once
/// immediately before `sign_round` for a given session, exactly
/// `ThresholdIdentity::sign_subject`'s own usage pattern.
pub struct NetworkThresholdCoordinator<S: ManageRequestSender> {
    sender: S,
    group: DeviceId,
    scope: CapabilityScope,
    token: Option<CoseSign1>,
    verifier_identity: Arc<dyn Identity>,
    identifier_lookup: Mutex<HashMap<u64, HashMap<Identifier, DeviceId>>>,
}

impl<S: ManageRequestSender> NetworkThresholdCoordinator<S> {
    pub fn new(sender: S, group: DeviceId, verifier_identity: Arc<dyn Identity>) -> Self {
        Self {
            sender,
            group,
            scope: threshold_group_scope(),
            token: None,
            verifier_identity,
            identifier_lookup: Mutex::new(HashMap::new()),
        }
    }

    #[must_use]
    pub fn with_token(mut self, token: CoseSign1) -> Self {
        self.token = Some(token);
        self
    }
}

#[async_trait::async_trait]
impl<S: ManageRequestSender> ThresholdCoordinator for NetworkThresholdCoordinator<S> {
    async fn commit_round(
        &self,
        session_id: u64,
        participants: &[DeviceId],
        subject: &ThresholdSubject,
        deadline_unix_ms: u64,
    ) -> Result<Vec<(Identifier, SigningCommitments)>, CoreError> {
        let wire_subject = wire_subject(subject);
        let mut identifier_map = HashMap::new();
        let mut results = Vec::new();
        for &participant in participants {
            let command = ManageCommand {
                verb: CapabilityVerb(THRESHOLD_SIGN_VERB.to_owned()),
                params: ManageParams::ThresholdCommit(ThresholdCommit {
                    session_id,
                    group: self.group,
                    subject: wire_subject.clone(),
                    deadline: deadline_unix_ms,
                }),
            };
            let outcome = self
                .sender
                .send_manage_request(participant, command, self.scope.clone(), self.token.clone())
                .await?;
            let ManageOutcome::Ok(ok) = outcome else {
                continue;
            };
            let (Some(responder), Some(hiding), Some(binding)) = (
                device_id_field(&ok.extra, "participant"),
                bytes_field(&ok.extra, "hiding"),
                bytes_field(&ok.extra, "binding"),
            ) else {
                continue;
            };
            if responder != participant {
                continue;
            }
            let Ok(commitments) = combine_commitments(hiding, binding) else {
                continue;
            };
            let Ok(identifier) = identifier_for_device(&participant) else {
                continue;
            };
            identifier_map.insert(identifier, participant);
            results.push((identifier, commitments));
        }
        if !identifier_map.is_empty() {
            self.identifier_lookup
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(session_id, identifier_map);
        }
        Ok(results)
    }

    async fn sign_round(
        &self,
        session_id: u64,
        commitments: &[(Identifier, SigningCommitments)],
    ) -> Result<Vec<(Identifier, SignatureShare)>, CoreError> {
        let identifier_map = {
            let mut lock = self
                .identifier_lookup
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            lock.remove(&session_id)
        }
        .ok_or_else(|| {
            CoreError::Crypto(
                "sign_round called for a session with no prior commit_round".to_owned(),
            )
        })?;

        let mut wire_commitments = Vec::with_capacity(commitments.len());
        for (identifier, signing_commitments) in commitments {
            let device_id = *identifier_map
                .get(identifier)
                .ok_or_else(|| CoreError::Crypto("unknown identifier in commitments".to_owned()))?;
            let (hiding, binding) = split_commitments(signing_commitments)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            wire_commitments.push(ThresholdCommitment {
                participant: device_id,
                hiding,
                binding,
            });
        }

        let mut results = Vec::new();
        for (identifier, _) in commitments {
            let device_id = *identifier_map
                .get(identifier)
                .ok_or_else(|| CoreError::Crypto("unknown identifier in commitments".to_owned()))?;
            let command = ManageCommand {
                verb: CapabilityVerb(THRESHOLD_SIGN_VERB.to_owned()),
                params: ManageParams::ThresholdSign(ThresholdSign {
                    session_id,
                    commitments: wire_commitments.clone(),
                }),
            };
            let outcome = self
                .sender
                .send_manage_request(device_id, command, self.scope.clone(), self.token.clone())
                .await?;
            let ManageOutcome::Ok(ok) = outcome else {
                continue;
            };
            let Some(share_bytes) = bytes_field(&ok.extra, "share") else {
                continue;
            };
            let Ok(envelope) = CoseSign1::decode_bytes(share_bytes) else {
                continue;
            };
            let Ok(claims) =
                verify_share_envelope(self.verifier_identity.as_ref(), &envelope).await
            else {
                continue;
            };
            if claims.session_id != session_id
                || claims.group != self.group
                || claims.issuer != device_id
            {
                continue;
            }
            let Ok(share) = SignatureShare::deserialize(&claims.share) else {
                continue;
            };
            results.push((*identifier, share));
        }
        Ok(results)
    }
}

/// An error handling an incoming threshold.commit/.sign/.abort request --
/// the participant-side counterpart to [`NetworkThresholdCoordinator`]'s own
/// `CoreError` returns. Every variant maps to a `manage-error` a real
/// dispatch loop sends back; none of them panic or silently swallow.
#[derive(Debug)]
pub enum ParticipantError {
    DeadlinePassed,
    UnknownGroup,
    Refused(String),
    NoSuchSession,
    NonceUnavailable,
    Crypto(String),
}

impl core::fmt::Display for ParticipantError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ParticipantError::DeadlinePassed => write!(f, "deadline-passed"),
            ParticipantError::UnknownGroup => write!(f, "unknown-group"),
            ParticipantError::Refused(reason) => write!(f, "refused: {reason}"),
            ParticipantError::NoSuchSession => write!(f, "no-such-session"),
            ParticipantError::NonceUnavailable => write!(f, "nonce-unavailable"),
            ParticipantError::Crypto(e) => write!(f, "crypto: {e}"),
        }
    }
}

impl std::error::Error for ParticipantError {}

/// `threshold.commit`'s own manage-ok extension: `participant`/`hiding`/
/// `binding`, matching `spec/threshold.cddl`'s own comment on that verb.
pub struct CommitResponse {
    pub participant: DeviceId,
    pub hiding: Vec<u8>,
    pub binding: Vec<u8>,
}

/// A signing session's own state a caller must persist between round 1 and
/// round 2, keyed by session-id -- round 2 carries no subject of its own
/// (`spec/threshold.cddl`'s own structural closure against a coordinator
/// showing different participants different content across the two rounds),
/// so the message this participant is actually signing must be recalled
/// from its own round-1 state, never re-derived from round 2's own wire
/// bytes.
pub struct SigningSessionState {
    pub message: Vec<u8>,
}

/// Round-1 handling: runs `refuse_unrecognised_kind` (always first,
/// regardless of what `authorise` returns) then `authorise` against
/// `params.subject`, and -- only if both pass -- computes this
/// participant's own commitment. Returning a commitment IS this
/// participant's act of authorisation. `own_device_id` is this
/// participant's own device-id -- `KeyPackage` carries only a FROST
/// `Identifier`, and deriving a device-id back out of one is one-way, so the
/// caller (which already knows its own identity) supplies it directly
/// rather than this function trying to recover it. `key_package_of_group`
/// resolves this participant's own FROST key package for `params.group`,
/// `None` meaning this participant holds no share in that group at all.
pub fn handle_threshold_commit(
    params: &ThresholdCommit,
    own_device_id: DeviceId,
    key_package_of_group: impl Fn(&DeviceId) -> Option<KeyPackage>,
    nonce_store: &dyn NonceStore,
    now_unix_ms: u64,
    authorise: impl Fn(&ThresholdSubject) -> Option<SubjectDecision>,
) -> Result<(CommitResponse, SigningSessionState), ParticipantError> {
    if params.deadline <= now_unix_ms {
        return Err(ParticipantError::DeadlinePassed);
    }
    let key_package = key_package_of_group(&params.group).ok_or(ParticipantError::UnknownGroup)?;
    let subject = domain_subject(&params.subject);
    let decision = refuse_unrecognised_kind(&subject, crate::subject::KNOWN_KINDS)
        .unwrap_or_else(|| authorise(&subject).unwrap_or(SubjectDecision::Authorise));
    if let SubjectDecision::Refuse { reason } = decision {
        return Err(ParticipantError::Refused(reason));
    }

    let message = to_be_signed(&subject);
    let session_id: SessionId = params.session_id;
    let commitments = round1_commit(nonce_store, session_id, &key_package)
        .map_err(|e| ParticipantError::Crypto(e.to_string()))?;
    let (hiding, binding) =
        split_commitments(&commitments).map_err(|e| ParticipantError::Crypto(e.to_string()))?;

    Ok((
        CommitResponse {
            participant: own_device_id,
            hiding,
            binding,
        },
        SigningSessionState { message },
    ))
}

/// Round-2 handling: takes (one-shot) this session's own persisted nonce and
/// `state.message` (recalled from round 1, never re-derived from
/// `params.commitments`), releases this participant's signature share, and
/// mints a real `threshold-share-envelope` signed under `personal_identity`
/// -- never the group's own key.
pub async fn handle_threshold_sign(
    params: &ThresholdSign,
    state: &SigningSessionState,
    key_package: &KeyPackage,
    nonce_store: &dyn NonceStore,
    personal_identity: &dyn Identity,
    group: DeviceId,
) -> Result<CoseSign1, ParticipantError> {
    let session_id: SessionId = params.session_id;
    let mut commitments_map = std::collections::BTreeMap::new();
    for entry in &params.commitments {
        let identifier = identifier_for_device(&entry.participant)
            .map_err(|e| ParticipantError::Crypto(e.to_string()))?;
        let combined = combine_commitments(&entry.hiding, &entry.binding)
            .map_err(|e| ParticipantError::Crypto(e.to_string()))?;
        commitments_map.insert(identifier, combined);
    }
    let signing_package = crate::signing::build_signing_package(commitments_map, &state.message);
    round2_respond(
        nonce_store,
        session_id,
        &signing_package,
        key_package,
        personal_identity,
        group,
    )
    .await
    .map_err(|_| ParticipantError::NonceUnavailable)
}

/// Discards this session's own persisted nonce and any recalled state --
/// the `deadline` expiry path and an explicit `threshold.abort` both call
/// this, never `round2_respond`, since neither actually produces a
/// signature.
pub fn handle_threshold_abort(session_id: u64, nonce_store: &dyn NonceStore) {
    let _ = nonce_store.discard(session_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dkg::{round1 as dkg_round1, round2 as dkg_round2, round3 as dkg_round3};
    use crate::identifiers::identifier_for_device;
    use crate::nonce_store::InMemoryNonceStore;
    use crate::subject::ThresholdSubject as DomainThresholdSubject;
    use frost_ed25519::keys::PublicKeyPackage;
    use std::collections::BTreeMap as Map;
    use std::sync::Mutex as StdMutex;
    use wire_mesh_core::adapters::node_identity::NodeIdentity;
    use wire_mesh_wire::value::CanonicalMap;

    /// A fresh T=2-of-3 DKG purely as test fixture setup -- identical in
    /// shape to `signing.rs`'s own `dkg_fixture`, kept local for the same
    /// stated reason: this module's own tests build a real coordinator
    /// directly on top of it.
    /// `device_ids` MUST be each intended signer's own REAL personal
    /// device-id (e.g. a `NodeIdentity`'s), never a synthetic placeholder --
    /// the FROST `Identifier` this fixture derives for each participant
    /// must match the identifier a real wire round trip later derives from
    /// that same participant's `threshold-commitment.participant` field, or
    /// `frost_ed25519::round2::sign` rejects the signing package outright
    /// ("must contain the participant's Commitment").
    fn dkg_fixture(
        device_ids: &[DeviceId],
    ) -> (
        Vec<Identifier>,
        Map<Identifier, KeyPackage>,
        DeviceId,
        PublicKeyPackage,
    ) {
        let ids: Vec<Identifier> = device_ids
            .iter()
            .map(|d| identifier_for_device(d).expect("derives"))
            .collect();

        let mut secrets1 = Map::new();
        let mut packages1: Map<Identifier, frost_ed25519::keys::dkg::round1::Package> = Map::new();
        for &id in &ids {
            let (s, p) = dkg_round1(id, ids.len() as u16, 2).expect("round1");
            secrets1.insert(id, s);
            packages1.insert(id, p);
        }

        let mut round2_inbox: Map<
            Identifier,
            Map<Identifier, frost_ed25519::keys::dkg::round2::Package>,
        > = Map::new();
        let mut secrets2 = Map::new();
        for &id in &ids {
            let own = secrets1.remove(&id).expect("secret1");
            let others: Map<_, _> = packages1
                .iter()
                .filter(|(&p, _)| p != id)
                .map(|(&p, v)| (p, v.clone()))
                .collect();
            let (s2, outgoing) = dkg_round2(own, &others).expect("round2");
            secrets2.insert(id, s2);
            for (recipient, package) in outgoing {
                round2_inbox
                    .entry(recipient)
                    .or_default()
                    .insert(id, package);
            }
        }

        let mut key_packages = Map::new();
        let mut group_device_id = None;
        let mut group_public_key_package = None;
        for &id in &ids {
            let s2 = secrets2.get(&id).expect("secret2");
            let others1: Map<_, _> = packages1
                .iter()
                .filter(|(&p, _)| p != id)
                .map(|(&p, v)| (p, v.clone()))
                .collect();
            let inbox = round2_inbox.get(&id).expect("inbox");
            let (kp, pkp) = dkg_round3(s2, &others1, inbox).expect("round3");
            group_device_id = Some(
                wire_mesh_core::adapters::node_identity::derive_device_id_from_public_key(
                    &pkp.verifying_key().serialize().expect("serialize"),
                ),
            );
            group_public_key_package = Some(pkp);
            key_packages.insert(id, kp);
        }

        (
            ids,
            key_packages,
            group_device_id.expect("at least one participant"),
            group_public_key_package.expect("at least one participant"),
        )
    }

    struct FakeParticipant {
        device_id: DeviceId,
        key_package: KeyPackage,
        identity: NodeIdentity,
        nonce_store: InMemoryNonceStore,
        session_state: StdMutex<HashMap<u64, SigningSessionState>>,
    }

    struct FakeSender {
        group: DeviceId,
        participants: Vec<FakeParticipant>,
    }

    fn manage_ok(fields: Vec<(&str, Vec<u8>)>) -> ManageOutcome {
        let mut extra = CanonicalMap::new();
        for (key, value) in fields {
            extra
                .insert(key.to_owned(), CborValue::Bytes(value))
                .expect("unique key");
        }
        ManageOutcome::Ok(wire_mesh_wire::management::ManageOk { extra })
    }

    fn manage_error(code: &str) -> ManageOutcome {
        ManageOutcome::Error(wire_mesh_wire::management::ManageError {
            code: code.to_owned(),
            message: None,
        })
    }

    #[async_trait::async_trait]
    impl ManageRequestSender for FakeSender {
        async fn send_manage_request(
            &self,
            target: DeviceId,
            command: ManageCommand,
            _scope: CapabilityScope,
            _token: Option<CoseSign1>,
        ) -> Result<ManageOutcome, CoreError> {
            let participant = self
                .participants
                .iter()
                .find(|p| p.device_id == target)
                .expect("test fixture: unknown target device");
            match command.params {
                ManageParams::ThresholdCommit(params) => {
                    let result = handle_threshold_commit(
                        &params,
                        target,
                        |g| {
                            if *g == self.group {
                                Some(participant.key_package.clone())
                            } else {
                                None
                            }
                        },
                        &participant.nonce_store,
                        0,
                        |_subject: &DomainThresholdSubject| None,
                    );
                    match result {
                        Ok((response, state)) => {
                            participant
                                .session_state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .insert(params.session_id, state);
                            Ok(manage_ok(vec![
                                ("participant", response.participant.as_ref().to_vec()),
                                ("hiding", response.hiding),
                                ("binding", response.binding),
                            ]))
                        }
                        Err(e) => Ok(manage_error(&e.to_string())),
                    }
                }
                ManageParams::ThresholdSign(params) => {
                    let state = participant
                        .session_state
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&params.session_id);
                    let Some(state) = state else {
                        return Ok(manage_error("no-such-session"));
                    };
                    let result = handle_threshold_sign(
                        &params,
                        &state,
                        &participant.key_package,
                        &participant.nonce_store,
                        &participant.identity,
                        self.group,
                    )
                    .await;
                    match result {
                        Ok(envelope) => Ok(manage_ok(vec![("share", envelope.encode_to_vec())])),
                        Err(e) => Ok(manage_error(&e.to_string())),
                    }
                }
                _ => Ok(manage_error("unsupported")),
            }
        }
    }

    #[tokio::test]
    async fn commit_and_sign_round_over_a_fake_sender_produce_a_verifying_signature() {
        // Personal identities are generated FIRST, and the DKG fixture is built around their own real device-ids -- see dkg_fixture's own doc comment for why a synthetic placeholder device-id would silently derive the wrong FROST identifier.
        let personal_identities: Vec<NodeIdentity> =
            (0..2).map(|_| NodeIdentity::generate_ed25519()).collect();
        let device_ids: Vec<DeviceId> = personal_identities
            .iter()
            .map(|identity| *identity.device_id())
            .collect();

        let (ids, key_packages, group, public_key_package) = dkg_fixture(&device_ids);
        let signers = ids.clone();

        let mut participants = Vec::new();
        for (index, identity) in personal_identities.into_iter().enumerate() {
            let device_id = device_ids[index];
            let id = signers[index];
            participants.push(FakeParticipant {
                device_id,
                key_package: key_packages.get(&id).expect("key package").clone(),
                identity,
                nonce_store: InMemoryNonceStore::new(),
                session_state: StdMutex::new(HashMap::new()),
            });
        }

        let sender = FakeSender {
            group,
            participants,
        };
        let verifier_identity: Arc<dyn Identity> = Arc::new(NodeIdentity::generate_ed25519());
        let coordinator = NetworkThresholdCoordinator::new(sender, group, verifier_identity);

        let subject = DomainThresholdSubject {
            kind: "capability-token".to_owned(),
            protected: vec![0xa1, 0x01, 0x27],
            payload: vec![0xa1, 0x00, 0x01],
        };
        let message = crate::subject::to_be_signed(&subject);

        let commitments = coordinator
            .commit_round(1, &device_ids, &subject, u64::MAX)
            .await
            .expect("commit_round");
        assert_eq!(commitments.len(), 2);

        let shares = coordinator
            .sign_round(1, &commitments)
            .await
            .expect("sign_round");
        assert_eq!(shares.len(), 2);

        let commitments_map: Map<_, _> = commitments.into_iter().collect();
        let signing_package = crate::signing::build_signing_package(commitments_map, &message);
        let shares_map: Map<_, _> = shares.into_iter().collect();

        let signature =
            crate::signing::aggregate(&signing_package, &shares_map, &public_key_package)
                .expect("aggregate");
        assert!(public_key_package
            .verifying_key()
            .verify(&message, &signature)
            .is_ok());
    }
}
