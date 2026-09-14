//! Revocation: gossiped, signed entries that let a peer check a token
//! against a shared revocation view without a synchronous lookup against
//! the issuer for every use of the token.
//!
//! This view is a dumb store: it verifies and records entries, keyed by
//! token-id alone (a token-id can legitimately carry entries from more
//! than one issuer -- the token's own issuer, and/or any number of parties
//! holding a delegated `manage:revoke` authorization over it,
//! wire-mesh#84), and hands every recorded entry back via
//! [`RevocationView::entries_for`] unfiltered. The actual verifier
//! obligation lives in [`crate::domain::tokens::verify_capability_token`],
//! which already holds the `Identity`/`Clock` needed to verify a nested
//! `authorization` token and the target token's own scope needed to check
//! it narrows into -- none of which this store, built ahead of time, has
//! access to. Two verifier obligations from `management.cddl`:
//!
//! - An entry counts against a token when EITHER its own
//!   `revocation-claims.issuer` matches the *token's own* issuer, OR its
//!   optional `authorization` decodes and independently verifies as an
//!   ordinary capability-token -- held by this entry's own issuer, bearing
//!   `manage:revoke`, over a scope the target token's own scope narrows
//!   into.
//! - A verifier walking a token's parent chain must check *every*
//!   ancestor's own token-id against the view, not just the leaf's —
//!   revoking one ancestor thereby revokes everything delegated beneath
//!   it. [`crate::domain::tokens::verify_capability_token`] performs that
//!   sweep.

use std::collections::BTreeMap;

use wire_mesh_wire::management::{RevocationClaims, RevocationEntry};

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

/// The local revocation view: every verified revocation-claims, keyed by
/// token-id.
///
/// Build it by admitting gossiped entries through [`RevocationView::verify_and_insert`]
/// (which checks each entry's own signature and self-certification) or, on
/// startup, by re-admitting raw entries persisted through the
/// [`crate::ports::KeyValueStorage`] port — the same bytes, verified the
/// same way, before being trusted.
#[derive(Debug, Clone, Default)]
pub struct RevocationView {
    entries: BTreeMap<Vec<u8>, Vec<RevocationClaims>>,
}

impl RevocationView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Verify a gossiped entry — signature over the revocation-claims per
    /// the Sig_structure convention, and the self-certifying
    /// `sha256(issuer-key.public-key) == issuer` check — and admit it to
    /// the view. Re-admitting an entry from an issuer already recorded for
    /// this token-id replaces the stored claims only when the new
    /// `revoked-at` is at least as recent, mirroring the previous
    /// timestamp-only dedup this view used before it started keeping full
    /// claims (rather than just a revoked-at, needed now to also carry a
    /// possibly-updated `authorization`).
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
        let bucket = self.entries.entry(claims.token_id.clone()).or_default();
        match bucket
            .iter_mut()
            .find(|existing| existing.issuer == claims.issuer)
        {
            Some(existing) => {
                if claims.revoked_at >= existing.revoked_at {
                    *existing = claims;
                }
            }
            None => bucket.push(claims),
        }
        Ok(())
    }

    /// Every recorded, already-signature-verified revocation-claims for
    /// `token_id`, across every issuer that has ever submitted one —
    /// unfiltered by this store. The caller (`verify_capability_token`)
    /// decides which entries actually apply.
    pub fn entries_for(&self, token_id: &[u8]) -> &[RevocationClaims] {
        self.entries.get(token_id).map(Vec::as_slice).unwrap_or(&[])
    }

    pub fn len(&self) -> usize {
        self.entries.values().map(Vec::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::node_identity::NodeIdentity;

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
            authorization: None,
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
    async fn admitted_entries_are_returned_by_entries_for_regardless_of_issuer() {
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
                            authorization: None,
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
        // entries_for returns everything recorded for the token-id, unfiltered by issuer -- filtering by which issuer actually counts is verify_capability_token's own job, not this store's.
        let entries = view.entries_for(&[1; 16]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].issuer, *issuer.device_id());
        assert_ne!(entries[0].issuer, *other.device_id());
        assert!(view.entries_for(&[2; 16]).is_empty());
    }

    #[tokio::test]
    async fn re_admitting_an_entry_from_the_same_issuer_updates_rather_than_duplicates() {
        let issuer = NodeIdentity::generate_ed25519();
        let mut view = RevocationView::new();
        for revoked_at in [10, 42] {
            view.verify_and_insert(
                &RevocationEntry(
                    issuer
                        .mint_cose_sign1(
                            &RevocationClaims {
                                token_id: vec![1; 16],
                                issuer: *issuer.device_id(),
                                issuer_key: issuer.identity_key().clone(),
                                revoked_at,
                                authorization: None,
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
        }
        let entries = view.entries_for(&[1; 16]);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].revoked_at, 42);
    }
}
