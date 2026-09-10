//! Revocation: gossiped, signed entries that let a peer check a token
//! against a shared revocation view without a synchronous lookup against
//! the issuer for every use of the token.
//!
//! Two verifier obligations from `management.cddl` live here:
//!
//! - An entry's `revocation-claims.issuer` must match the *token's own*
//!   issuer — only a token's own issuer may revoke it. A signature from
//!   some other key proves only that someone else wants the token gone.
//!   This is enforced by keying the view on `(token-id, issuer)` pairs.
//! - A verifier walking a token's parent chain must check *every*
//!   ancestor's own token-id against the view, not just the leaf's —
//!   revoking one ancestor thereby revokes everything delegated beneath
//!   it. [`crate::domain::tokens::verify_capability_token`] performs that
//!   sweep.

use std::collections::BTreeMap;

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::RevocationEntry;

use crate::domain::cose::sig_structure;
use crate::ports::{CoreError, Identity};

/// Why a revocation entry could not be admitted to the view.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevocationError {
    /// The entry is not a well-formed COSE_Sign1 over revocation-claims.
    Malformed(String),
    /// The signature over the revocation-claims does not verify against
    /// the issuer-key embedded in the claims.
    BadSignature,
    /// `sha256(issuer-key.public-key)` does not equal the claimed issuer
    /// device-id: the entry is not self-certifying.
    IssuerMismatch,
}

impl core::fmt::Display for RevocationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            RevocationError::Malformed(m) => write!(f, "malformed revocation entry: {m}"),
            RevocationError::BadSignature => write!(
                f,
                "revocation signature does not verify against the embedded issuer key"
            ),
            RevocationError::IssuerMismatch => write!(
                f,
                "sha256(issuer-key) does not equal the claimed issuer device-id"
            ),
        }
    }
}

impl std::error::Error for RevocationError {}

impl From<CoreError> for RevocationError {
    fn from(e: CoreError) -> Self {
        RevocationError::Malformed(e.to_string())
    }
}

impl From<wire_mesh_wire::DecodeError> for RevocationError {
    fn from(e: wire_mesh_wire::DecodeError) -> Self {
        RevocationError::Malformed(e.to_string())
    }
}

/// The local revocation view: verified `(token-id, issuer)` pairs.
///
/// Build it by admitting gossiped entries through [`RevocationView::verify_and_insert`]
/// (which checks each entry's own signature and self-certification) or, on
/// startup, by re-admitting raw entries persisted through the
/// [`crate::ports::KeyValueStorage`] port — the same bytes, verified the
/// same way, before being trusted.
#[derive(Debug, Clone, Default)]
pub struct RevocationView {
    entries: BTreeMap<(Vec<u8>, [u8; 32]), u64>,
}

impl RevocationView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Verify a gossiped entry — signature over the revocation-claims per
    /// the Sig_structure convention, and the self-certifying
    /// `sha256(issuer-key.public-key) == issuer` check — and admit it to
    /// the view. Re-inserting an existing entry is a no-op.
    pub async fn verify_and_insert(
        &mut self,
        entry: &RevocationEntry,
        identity: &dyn Identity,
    ) -> Result<(), RevocationError> {
        let claims = entry.decode_claims()?;
        let payload = entry.0.payload.as_deref().ok_or_else(|| {
            RevocationError::Malformed("revocation-entry payload is nil".to_owned())
        })?;
        let message = sig_structure(&entry.0.protected, payload);
        if !identity
            .verify(&claims.issuer_key, &message, &entry.0.signature)
            .await?
        {
            return Err(RevocationError::BadSignature);
        }
        if identity.derive_device_id(&claims.issuer_key.public_key) != claims.issuer {
            return Err(RevocationError::IssuerMismatch);
        }
        self.entries
            .entry((claims.token_id.clone(), claims.issuer.0))
            .and_modify(|at| *at = (*at).max(claims.revoked_at))
            .or_insert(claims.revoked_at);
        Ok(())
    }

    /// Is the token identified by `token_id`, issued by `issuer`, revoked?
    /// The issuer must be *the token's own* issuer: only a token's own
    /// issuer may revoke it, so a different issuer's entry never matches.
    pub fn is_revoked(&self, token_id: &[u8], issuer: &DeviceId) -> bool {
        self.entries.contains_key(&(token_id.to_vec(), issuer.0))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::node_identity::NodeIdentity;
    use wire_mesh_wire::management::RevocationClaims;

    #[tokio::test]
    async fn non_self_certifying_entry_is_rejected_at_admission() {
        // Signed by the real key, but claiming someone else's device-id: sha256(issuer-key) != issuer.
        let issuer = NodeIdentity::generate_ed25519();
        let stranger = NodeIdentity::generate_ed25519();
        let claims = RevocationClaims {
            token_id: vec![1; 16],
            issuer: *stranger.device_id(),
            issuer_key: issuer.identity_key().clone(),
            revoked_at: 42,
        };
        let entry = RevocationEntry(
            issuer
                .mint_cose_sign1(&claims.encode_to_vec())
                .await
                .expect("mint"),
        );
        let mut view = RevocationView::new();
        let err = view.verify_and_insert(&entry, &issuer).await.unwrap_err();
        assert!(matches!(err, RevocationError::IssuerMismatch));
        assert!(view.is_empty());
    }

    #[tokio::test]
    async fn admitted_entries_match_only_their_own_issuer() {
        let issuer = NodeIdentity::generate_ed25519();
        let other = NodeIdentity::generate_ed25519();
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &RevocationEntry(
                issuer
                    .mint_cose_sign1(
                        &RevocationClaims {
                            token_id: vec![1; 16],
                            issuer: *issuer.device_id(),
                            issuer_key: issuer.identity_key().clone(),
                            revoked_at: 42,
                        }
                        .encode_to_vec(),
                    )
                    .await
                    .expect("mint"),
            ),
            &issuer,
        )
        .await
        .expect("verifies");
        // Same token-id, wrong issuer: not revoked by this view.
        assert!(view.is_revoked(&[1; 16], issuer.device_id()));
        assert!(!view.is_revoked(&[1; 16], other.device_id()));
        assert!(!view.is_revoked(&[2; 16], issuer.device_id()));
    }
}
