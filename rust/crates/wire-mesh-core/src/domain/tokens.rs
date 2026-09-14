// ! Capability-token verification: signature against the embedded issuer ! key, the self-certifying device-id check, expiry, not-before, and ! valid-until windows, revocation of every link in the chain, and ! delegation's narrowing-only rule.
//!
//! Every check here is a verifier obligation the CDDL deliberately cannot
//! express (see `tokens.cddl`'s prose): a token is self-certifying — no
//! prior contact with the issuer is needed, only the token itself — and
//! delegation can only narrow authority, never widen it.

use wire_mesh_wire::management::RevocationClaims;
use wire_mesh_wire::tokens::{CapabilityVerb, CoseSign1, TokenClaims};

use crate::domain::cose::sig_structure;
use crate::domain::revocation::RevocationView;
use crate::ports::{Clock, CoreError, Identity};

/// The capability a `revocation-claims.authorization` token must carry to
/// delegate revoke authority outside a token's own issuing chain
/// (wire-mesh#84, `spec/registry/core-capabilities.md`).
const REVOKE_CAPABILITY: &str = "manage:revoke";

/// A hard bound on delegation-chain walking. Honest chains are short; the
/// bound exists so a maliciously nested token cannot make a verifier
/// recurse without limit. Cycles are separately impossible to admit
/// because every ancestor's token-id is remembered along the walk.
pub const MAX_CHAIN_DEPTH: usize = 64;

/// Why a token was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenRejection {
    /// Not a well-formed COSE_Sign1 over token-claims, or the chain is
    /// malformed somewhere.
    Malformed(String),
    /// The issuer-key's COSE algorithm is not one this verifier implements.
    UnsupportedAlgorithm(i64),
    /// The signature over the Sig_structure does not verify against the
    /// embedded issuer-key.
    BadSignature,
    /// `sha256(issuer-key.public-key)` does not equal the claimed issuer
    /// device-id: the token is not self-certifying.
    IssuerMismatch,
    /// A link in the chain has expired.
    Expired {
        token_id: Vec<u8>,
        expires: u64,
        now: u64,
    },
    /// A link in the chain is not yet valid.
    NotYetValid {
        token_id: Vec<u8>,
        not_before: u64,
        now: u64,
    },
    /// A link's own content/action has outlived its `valid-until`, even
    /// though the token's `expires` (authorisation to present it) has not
    /// yet elapsed.
    ContentExpired {
        token_id: Vec<u8>,
        valid_until: u64,
        now: u64,
    },
    /// This link's token-id is revoked by its own issuer.
    Revoked { token_id: Vec<u8> },
    /// A delegation hop widened authority instead of narrowing it:
    /// mismatched bearer/issuer, a changed capability verb, a scope
    /// outside the parent's subtree, or an expiry beyond the parent's.
    NotNarrowed(&'static str),
    /// The chain revisits a token-id: a delegation cycle.
    ChainCycle,
    /// A link's claims fail their own grammar: the capability verb
    /// matches no tier, or the scope is malformed.
    InvalidClaims(String),
    /// The chain exceeds [`MAX_CHAIN_DEPTH`].
    ChainTooDeep,
    /// A link carries a `conditions` field, but this implementation has no
    /// predicate evaluator to check it against -- refused rather than
    /// silently ignored, since an unchecked `conditions` entry could carry
    /// a restriction the issuer intended to narrow the token's validity
    /// with (see tokens.cddl's own comment on the field). Track full Rust
    /// predicate-evaluator parity separately; this is the fail-closed
    /// stopgap until it lands.
    ConditionsUnsupported { token_id: Vec<u8> },
}

impl core::fmt::Display for TokenRejection {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            TokenRejection::Malformed(m) => write!(f, "malformed token: {m}"),
            TokenRejection::UnsupportedAlgorithm(alg) => {
                write!(f, "unsupported COSE algorithm {alg}")
            }
            TokenRejection::BadSignature => write!(
                f,
                "signature does not verify against the embedded issuer key"
            ),
            TokenRejection::IssuerMismatch => write!(
                f,
                "sha256(issuer-key) does not equal the claimed issuer device-id"
            ),
            TokenRejection::Expired {
                token_id,
                expires,
                now,
            } => write!(
                f,
                "token {} expired at {expires} (now {now})",
                hex_prefix(token_id)
            ),
            TokenRejection::NotYetValid {
                token_id,
                not_before,
                now,
            } => write!(
                f,
                "token {} not valid before {not_before} (now {now})",
                hex_prefix(token_id)
            ),
            TokenRejection::ContentExpired {
                token_id,
                valid_until,
                now,
            } => write!(
                f,
                "token {}'s content expired at {valid_until} (now {now})",
                hex_prefix(token_id)
            ),
            TokenRejection::Revoked { token_id } => write!(
                f,
                "token {} is revoked by its own issuer",
                hex_prefix(token_id)
            ),
            TokenRejection::NotNarrowed(what) => write!(f, "delegation widened authority: {what}"),
            TokenRejection::ChainCycle => write!(f, "delegation chain revisits a token-id (cycle)"),
            TokenRejection::InvalidClaims(what) => {
                write!(f, "claims violate the token grammar: {what}")
            }
            TokenRejection::ChainTooDeep => {
                write!(f, "delegation chain deeper than {MAX_CHAIN_DEPTH}")
            }
            TokenRejection::ConditionsUnsupported { token_id } => write!(
                f,
                "token {} carries a conditions field this verifier cannot evaluate",
                hex_prefix(token_id)
            ),
        }
    }
}

impl std::error::Error for TokenRejection {}

fn hex_prefix(bytes: &[u8]) -> String {
    let mut out = String::new();
    for byte in bytes.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out.push_str("...");
    out
}

impl From<CoreError> for TokenRejection {
    fn from(e: CoreError) -> Self {
        TokenRejection::Malformed(e.to_string())
    }
}

impl From<wire_mesh_wire::DecodeError> for TokenRejection {
    fn from(e: wire_mesh_wire::DecodeError) -> Self {
        TokenRejection::Malformed(e.to_string())
    }
}

/// The verdict on a presented token.
///
/// `claims` is boxed: a full `TokenClaims` dwarfs every `TokenRejection`
/// variant, and an unboxed copy would tax every verdict move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenVerdict {
    /// The token verifies. `claims` are the *presented* (leaf) token's own
    /// claims; `effective_expires` is the tightest expiry along the whole
    /// chain — the window the delegated authority is actually usable for,
    /// clamped by every ancestor.
    Valid {
        claims: Box<TokenClaims>,
        effective_expires: u64,
    },
    Invalid(TokenRejection),
}

impl TokenVerdict {
    pub fn is_valid(&self) -> bool {
        matches!(self, TokenVerdict::Valid { .. })
    }
}

/// Does one recorded revocation-claims entry actually revoke `target`, per
/// `management.cddl`'s own additive obligation (wire-mesh#84)? Valid when
/// EITHER the entry's own issuer equals the target token's own issuer (the
/// original, unconditional rule — only a token's own issuer may revoke it),
/// OR the entry carries an `authorization` that independently verifies as
/// an ordinary capability-token — bearing `target`, proving the
/// authorization was actually granted to the party submitting this
/// revocation, not merely referenced from someone else's — whose own
/// `capability` is [`REVOKE_CAPABILITY`] and whose own `scope` narrows
/// `target`'s scope. An authorization that fails any part of this (wrong
/// capability, scope doesn't narrow, fails ordinary verification — expired,
/// revoked, bad signature, wrong bearer) makes the entry no more valid than
/// if `authorization` were absent; it never falls back to weakening the
/// issuer-match rule.
///
/// The recursive call into [`verify_capability_token`] is boxed: an async
/// fn whose own body calls itself produces a self-referential (infinite-
/// size) future type unless the recursive call is boxed at the call site —
/// this is that box, not a stylistic choice.
async fn revocation_entry_grants_revoke(
    entry: &RevocationClaims,
    target: &TokenClaims,
    identity: &dyn Identity,
    clock: &dyn Clock,
    revocations: &RevocationView,
) -> bool {
    if entry.issuer == target.issuer {
        return true;
    }
    let Some(authorization_bytes) = &entry.authorization else {
        return false;
    };
    let Ok(authorization_token) = CoseSign1::decode_bytes(authorization_bytes) else {
        return false;
    };
    let verdict = Box::pin(verify_capability_token(
        identity,
        clock,
        revocations,
        &authorization_token,
    ))
    .await;
    match verdict {
        TokenVerdict::Valid { claims, .. } => {
            claims.bearer == entry.issuer
                && claims.capability.0 == REVOKE_CAPABILITY
                && target.scope.is_within(&claims.scope)
        }
        TokenVerdict::Invalid(_) => false,
    }
}

/// Verify a capability token, walking its whole delegation chain.
///
/// For every link from the presented token up to its root:
///
/// 1. the COSE_Sign1 signature verifies against the issuer-key embedded
///    in that link's own claims (self-certifying — no external key
///    lookup),
/// 2. `sha256(issuer-key.public-key)` equals the claimed issuer device-id,
/// 3. the link's own token-id is checked against the revocation view —
///    revoking one ancestor revokes everything delegated beneath it, so
///    the sweep covers every ancestor, not just the leaf; an entry counts
///    when its own issuer matches this link's issuer, OR when it carries a
///    verified delegated `manage:revoke` authorization
///    ([`revocation_entry_grants_revoke`], wire-mesh#84),
/// 4. the link's expiry, not-before, and valid-until windows hold at
///    `clock.now()`,
/// 5. against the link *below* it: the parent's bearer is the child's
///    issuer, the capability verb is unchanged, the child's scope lies
///    within the parent's, and the child's expiry does not exceed the
///    parent's — narrowing only, never widening.
pub async fn verify_capability_token(
    identity: &dyn Identity,
    clock: &dyn Clock,
    revocations: &RevocationView,
    token: &CoseSign1,
) -> TokenVerdict {
    let now = clock.now_unix_ms();
    let mut current = token.clone();
    let mut child: Option<TokenClaims> = None;
    let mut leaf: Option<TokenClaims> = None;
    let mut effective_expires = u64::MAX;
    let mut seen: Vec<Vec<u8>> = Vec::new();

    for _ in 0..MAX_CHAIN_DEPTH {
        let claims = match current.decode_claims() {
            Ok(claims) => claims,
            Err(e) => return TokenVerdict::Invalid(TokenRejection::Malformed(e.to_string())),
        };
        if seen.contains(&claims.token_id) {
            return TokenVerdict::Invalid(TokenRejection::ChainCycle);
        }
        seen.push(claims.token_id.clone());

        // Every link's claims must satisfy their own grammar: a signed
        // token whose verb matches no capability tier or whose scope is
        // malformed is invalid at verification time, not only where a
        // frame gate happens to check (Frame::validate covers
        // manage-requests; the verifier must not depend on that).
        if let Err(e) = CapabilityVerb::validate(&claims.capability.0) {
            return TokenVerdict::Invalid(TokenRejection::InvalidClaims(e.to_string()));
        }
        if let Err(e) = claims.scope.validate() {
            return TokenVerdict::Invalid(TokenRejection::InvalidClaims(e.to_string()));
        }

        let Some(payload) = current.payload.clone() else {
            return TokenVerdict::Invalid(TokenRejection::Malformed(
                "token payload is nil".to_owned(),
            ));
        };
        // identity.cddl names exactly these two algorithms; anything else is reported as unsupported rather than as a generic crypto failure.
        if !matches!(
            claims.issuer_key.alg,
            wire_mesh_wire::identity::IdentityKey::ALG_ES256
                | wire_mesh_wire::identity::IdentityKey::ALG_ED25519
        ) {
            return TokenVerdict::Invalid(TokenRejection::UnsupportedAlgorithm(
                claims.issuer_key.alg,
            ));
        }
        let message = sig_structure(&current.protected, &payload);
        match identity
            .verify(&claims.issuer_key, &message, &current.signature)
            .await
        {
            Ok(true) => {}
            Ok(false) => return TokenVerdict::Invalid(TokenRejection::BadSignature),
            Err(e) => return TokenVerdict::Invalid(TokenRejection::from(e)),
        }

        if identity.derive_device_id(&claims.issuer_key.public_key) != claims.issuer {
            return TokenVerdict::Invalid(TokenRejection::IssuerMismatch);
        }

        // management.cddl's obligation: every ancestor's own token-id is swept against the view, checking each recorded entry via revocation_entry_grants_revoke (issuer-match, or a verified delegated manage:revoke authorization -- wire-mesh#84).
        for entry in revocations.entries_for(&claims.token_id) {
            if revocation_entry_grants_revoke(entry, &claims, identity, clock, revocations).await {
                return TokenVerdict::Invalid(TokenRejection::Revoked {
                    token_id: claims.token_id,
                });
            }
        }

        if claims.expires <= now {
            return TokenVerdict::Invalid(TokenRejection::Expired {
                token_id: claims.token_id,
                expires: claims.expires,
                now,
            });
        }
        if let Some(not_before) = claims.not_before {
            if not_before > now {
                return TokenVerdict::Invalid(TokenRejection::NotYetValid {
                    token_id: claims.token_id,
                    not_before,
                    now,
                });
            }
        }
        if let Some(valid_until) = claims.valid_until {
            if valid_until <= now {
                return TokenVerdict::Invalid(TokenRejection::ContentExpired {
                    token_id: claims.token_id,
                    valid_until,
                    now,
                });
            }
        }
        if claims.conditions.is_some() {
            return TokenVerdict::Invalid(TokenRejection::ConditionsUnsupported {
                token_id: claims.token_id,
            });
        }

        // Narrowing against the link below, checked from the parent's
        // side of the relationship.
        if let Some(child_claims) = &child {
            if child_claims.issuer != claims.bearer {
                return TokenVerdict::Invalid(TokenRejection::NotNarrowed(
                    "the parent's bearer is not the child's issuer",
                ));
            }
            if child_claims.capability != claims.capability {
                return TokenVerdict::Invalid(TokenRejection::NotNarrowed(
                    "the delegated capability verb differs from the parent's",
                ));
            }
            if !child_claims.scope.is_within(&claims.scope) {
                return TokenVerdict::Invalid(TokenRejection::NotNarrowed(
                    "the delegated scope is not within the parent's subtree",
                ));
            }
            if child_claims.expires > claims.expires {
                return TokenVerdict::Invalid(TokenRejection::NotNarrowed(
                    "the delegated expiry is later than the parent's",
                ));
            }
        }

        effective_expires = effective_expires.min(claims.expires);
        if leaf.is_none() {
            leaf = Some(claims.clone());
        }

        match claims.parent.clone() {
            Some(parent) => {
                child = Some(claims);
                match CoseSign1::decode_bytes(&parent) {
                    Ok(next) => current = next,
                    Err(e) => {
                        return TokenVerdict::Invalid(TokenRejection::Malformed(e.to_string()))
                    }
                }
            }
            None => {
                return match leaf {
                    Some(claims) => TokenVerdict::Valid {
                        claims: Box::new(claims),
                        effective_expires,
                    },
                    None => {
                        TokenVerdict::Invalid(TokenRejection::Malformed("empty chain".to_owned()))
                    }
                }
            }
        }
    }
    TokenVerdict::Invalid(TokenRejection::ChainTooDeep)
}

/// Mint a capability token's claims for signing: assembles nothing but
/// the canonical Sig_structure over an existing `protected`/`payload`
/// pair, so a signer (the `Identity` port) and this verifier share the
/// exact same construction.
pub fn signing_message(protected: &[u8], payload: &[u8]) -> Vec<u8> {
    sig_structure(protected, payload)
}

/// Convenience: does the verified verdict authorise `verb` over `scope`?
/// A scope is authorised when the verb matches and the requested scope
/// lies within the token's own (a token scoped to `/work` authorises
/// `/work/subdir`, not `/other`).
pub fn verdict_authorises(
    verdict: &TokenVerdict,
    verb: &str,
    scope: &wire_mesh_wire::tokens::CapabilityScope,
) -> bool {
    match verdict {
        TokenVerdict::Valid { claims, .. } => {
            claims.capability.0 == verb && scope.is_within(&claims.scope)
        }
        TokenVerdict::Invalid(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::node_identity::NodeIdentity;
    use crate::domain::revocation::RevocationView;
    use wire_mesh_wire::identity::DeviceId;
    use wire_mesh_wire::management::{RevocationClaims, RevocationEntry};
    use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb};
    use wire_mesh_wire::value::CanonicalMap;

    const NOW: u64 = 1_000_000;

    struct FixedClock(u64);

    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> u64 {
            self.0
        }
    }

    fn claims_for(issuer: &NodeIdentity, bearer: DeviceId) -> TokenClaims {
        TokenClaims {
            token_id: vec![0x01; 16],
            issuer: *issuer.device_id(),
            issuer_key: issuer.identity_key().clone(),
            bearer,
            capability: CapabilityVerb("pin:write".to_owned()),
            scope: CapabilityScope {
                kind: "folder".to_owned(),
                path: Some("/work".to_owned()),
            },
            expires: NOW + 60_000,
            not_before: None,
            valid_until: None,
            conditions: None,
            parent: None,
            extra: CanonicalMap::new(),
        }
    }

    /// A root-level authorization token, held by `bearer`, for `capability` over `scope` -- used to build both a genuine `manage:revoke` delegation and the negative-case variants (wrong capability, non-narrowing scope) the authorization-branch tests below exercise.
    fn authorization_claims_for(
        issuer: &NodeIdentity,
        bearer: DeviceId,
        capability: &str,
        scope: CapabilityScope,
        expires: u64,
    ) -> TokenClaims {
        TokenClaims {
            token_id: vec![0x02; 16],
            issuer: *issuer.device_id(),
            issuer_key: issuer.identity_key().clone(),
            bearer,
            capability: CapabilityVerb(capability.to_owned()),
            scope,
            expires,
            not_before: None,
            valid_until: None,
            conditions: None,
            parent: None,
            extra: CanonicalMap::new(),
        }
    }

    async fn mint(issuer: &NodeIdentity, claims: &TokenClaims) -> CoseSign1 {
        issuer
            .mint_cose_sign1(&claims.encode_to_vec())
            .await
            .expect("mint")
    }

    async fn mint_revocation(by: &NodeIdentity, token_id: Vec<u8>) -> RevocationEntry {
        mint_revocation_with_authorization(by, token_id, None).await
    }

    async fn mint_revocation_with_authorization(
        by: &NodeIdentity,
        token_id: Vec<u8>,
        authorization: Option<Vec<u8>>,
    ) -> RevocationEntry {
        let claims = RevocationClaims {
            token_id,
            issuer: *by.device_id(),
            issuer_key: by.identity_key().clone(),
            revoked_at: NOW,
            authorization,
        };
        RevocationEntry(
            by.mint_cose_sign1(&claims.encode_to_vec())
                .await
                .expect("mint revocation"),
        )
    }

    async fn verify(
        identity: &dyn Identity,
        revocations: &RevocationView,
        token: &CoseSign1,
    ) -> TokenVerdict {
        verify_capability_token(identity, &FixedClock(NOW), revocations, token).await
    }

    /// A two-link chain: `parent_identity` grants the whole `/work` scope
    /// to `delegate`, who re-grants only `/work/subdir` to a third bearer,
    /// with `mutate_child` applied before the child is signed (so a test
    /// can mint a widened or otherwise rule-breaking delegation).
    async fn mint_delegated(
        parent_identity: &NodeIdentity,
        mutate_child: impl FnOnce(&mut TokenClaims),
    ) -> (NodeIdentity, CoseSign1, TokenClaims) {
        let delegate = NodeIdentity::generate_ed25519();
        let mut parent_claims = claims_for(parent_identity, *delegate.device_id());
        parent_claims.token_id = vec![0x01; 16];
        let parent_token = mint(parent_identity, &parent_claims).await;

        let mut child_claims = claims_for(&delegate, DeviceId([0xDD; 32]));
        child_claims.token_id = vec![0x02; 16];
        child_claims.scope = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/work/subdir".to_owned()),
        };
        child_claims.expires = NOW + 30_000;
        child_claims.parent = Some(parent_token.encode_to_vec());
        mutate_child(&mut child_claims);
        let child_token = mint(&delegate, &child_claims).await;
        (delegate, child_token, child_claims)
    }

    #[tokio::test]
    async fn root_token_verifies_for_both_algorithms() {
        for issuer in [
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_es256(),
        ] {
            let claims = claims_for(&issuer, DeviceId([0xAA; 32]));
            let token = mint(&issuer, &claims).await;
            let verdict = verify(&issuer, &RevocationView::new(), &token).await;
            match &verdict {
                TokenVerdict::Valid {
                    claims: verified,
                    effective_expires,
                } => {
                    assert_eq!(verified.token_id, claims.token_id);
                    assert_eq!(*effective_expires, claims.expires);
                }
                other => panic!("expected Valid, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn tampered_payload_fails_the_signature() {
        let issuer = NodeIdentity::generate_ed25519();
        let signed = mint(&issuer, &claims_for(&issuer, DeviceId([0xAA; 32]))).await;
        // Keep the signature, swap the payload: what a tampering relay
        // would produce.
        let mut tampered = signed.clone();
        tampered.payload = Some(claims_for(&issuer, DeviceId([0xBB; 32])).encode_to_vec());
        let verdict = verify(&issuer, &RevocationView::new(), &tampered).await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::BadSignature)
        ));
    }

    #[tokio::test]
    async fn claims_issuer_must_be_hash_of_embedded_key() {
        let issuer = NodeIdentity::generate_ed25519();
        let mut claims = claims_for(&issuer, DeviceId([0xAA; 32]));
        claims.issuer = DeviceId([0xCC; 32]);
        let token = mint(&issuer, &claims).await;
        let verdict = verify(&issuer, &RevocationView::new(), &token).await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::IssuerMismatch)
        ));
    }

    #[tokio::test]
    async fn expiry_and_not_before_windows() {
        let issuer = NodeIdentity::generate_ed25519();
        let mut expired = claims_for(&issuer, DeviceId([0xAA; 32]));
        expired.expires = NOW;
        let verdict = verify(
            &issuer,
            &RevocationView::new(),
            &mint(&issuer, &expired).await,
        )
        .await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::Expired { .. })
        ));

        let mut future = claims_for(&issuer, DeviceId([0xAA; 32]));
        future.not_before = Some(NOW + 1);
        let verdict = verify(
            &issuer,
            &RevocationView::new(),
            &mint(&issuer, &future).await,
        )
        .await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::NotYetValid { .. })
        ));
    }

    #[tokio::test]
    async fn valid_until_window() {
        let issuer = NodeIdentity::generate_ed25519();

        // The token itself hasn't expired, but its content has -- rejected with a distinct reason from an ordinary expired token.
        let mut content_expired = claims_for(&issuer, DeviceId([0xAA; 32]));
        content_expired.valid_until = Some(NOW - 1);
        let verdict = verify(
            &issuer,
            &RevocationView::new(),
            &mint(&issuer, &content_expired).await,
        )
        .await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::ContentExpired { .. })
        ));

        // Still in the future: accepted.
        let mut still_valid = claims_for(&issuer, DeviceId([0xAA; 32]));
        still_valid.valid_until = Some(NOW + 1);
        let verdict = verify(
            &issuer,
            &RevocationView::new(),
            &mint(&issuer, &still_valid).await,
        )
        .await;
        assert!(verdict.is_valid());

        // Absent means unbounded -- claims_for's own default already omits it, and expiry_and_not_before_windows' own "accepts" path above already covers that a claim with no valid-until at all verifies; this asserts it explicitly against the same fixture used here.
        let unbounded = claims_for(&issuer, DeviceId([0xAA; 32]));
        assert_eq!(unbounded.valid_until, None);
        let verdict = verify(
            &issuer,
            &RevocationView::new(),
            &mint(&issuer, &unbounded).await,
        )
        .await;
        assert!(verdict.is_valid());
    }

    #[tokio::test]
    async fn conditions_field_is_refused_not_silently_ignored() {
        // This implementation has no predicate evaluator (issue #85's TS-side evaluator has no Rust port yet): a token carrying `conditions` must be refused, not accepted as if the field weren't there -- the same fail-closed treatment an unrecognised discriminator already gets, and the mistake `valid-until` itself once made when it was still falling into `extra` unenforced.
        let issuer = NodeIdentity::generate_ed25519();
        let mut with_conditions = claims_for(&issuer, DeviceId([0xAA; 32]));
        with_conditions.conditions = Some(vec![0x80]); // bstr content is irrelevant -- presence alone must refuse
        let verdict = verify(
            &issuer,
            &RevocationView::new(),
            &mint(&issuer, &with_conditions).await,
        )
        .await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::ConditionsUnsupported { .. })
        ));

        // Absent conditions verifies exactly as before this field existed.
        let without_conditions = claims_for(&issuer, DeviceId([0xAA; 32]));
        assert_eq!(without_conditions.conditions, None);
        let verdict = verify(
            &issuer,
            &RevocationView::new(),
            &mint(&issuer, &without_conditions).await,
        )
        .await;
        assert!(verdict.is_valid());
    }

    #[tokio::test]
    async fn malformed_verb_or_scope_in_signed_claims_is_rejected_at_verification() {
        let issuer = NodeIdentity::generate_ed25519();
        let mut view = RevocationView::new();
        let _ = &mut view;

        // Grammatically malformed verb: signed by a real issuer, so the
        // signature and self-certification checks pass — the grammar check
        // is what rejects it.
        let mut claims = claims_for(&issuer, DeviceId([0xBB; 32]));
        claims.capability = CapabilityVerb("NOT-A-VERB".to_owned());
        let token = mint(&issuer, &claims).await;
        assert!(matches!(
            verify(&issuer, &RevocationView::new(), &token).await,
            TokenVerdict::Invalid(TokenRejection::InvalidClaims(_))
        ));

        // Empty-kind scope: same story, different field.
        let mut claims = claims_for(&issuer, DeviceId([0xBB; 32]));
        claims.scope = CapabilityScope {
            kind: String::new(),
            path: None,
        };
        let token = mint(&issuer, &claims).await;
        assert!(matches!(
            verify(&issuer, &RevocationView::new(), &token).await,
            TokenVerdict::Invalid(TokenRejection::InvalidClaims(_))
        ));
    }

    #[tokio::test]
    async fn unsupported_algorithm_is_reported_distinctly() {
        let issuer = NodeIdentity::generate_ed25519();
        let mut claims = claims_for(&issuer, DeviceId([0xAA; 32]));
        claims.issuer_key.alg = -47;
        let token = mint(&issuer, &claims).await;
        let verdict = verify(&issuer, &RevocationView::new(), &token).await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::UnsupportedAlgorithm(-47))
        ));
    }

    #[tokio::test]
    async fn delegation_narrowing_happy_path_clamps_effective_expiry() {
        let parent = NodeIdentity::generate_ed25519();
        let (_, child_token, child_claims) = mint_delegated(&parent, |_| {}).await;
        let verdict = verify(&parent, &RevocationView::new(), &child_token).await;
        match &verdict {
            TokenVerdict::Valid {
                claims,
                effective_expires,
            } => {
                assert_eq!(claims.token_id, child_claims.token_id);
                assert_eq!(
                    *effective_expires,
                    NOW + 30_000,
                    "effective expiry is the chain minimum"
                );
            }
            other => panic!("expected Valid, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn delegation_cannot_widen_scope() {
        let parent = NodeIdentity::generate_ed25519();
        let (_, token, _) = mint_delegated(&parent, |child| {
            child.scope = CapabilityScope {
                kind: "folder".to_owned(),
                path: Some("/other".to_owned()),
            };
        })
        .await;
        assert!(matches!(
            verify(&parent, &RevocationView::new(), &token).await,
            TokenVerdict::Invalid(TokenRejection::NotNarrowed(_))
        ));
    }

    #[tokio::test]
    async fn delegation_cannot_change_capability_verb() {
        let parent = NodeIdentity::generate_ed25519();
        let (_, token, _) = mint_delegated(&parent, |child| {
            child.capability = CapabilityVerb("pin:read".to_owned());
        })
        .await;
        assert!(matches!(
            verify(&parent, &RevocationView::new(), &token).await,
            TokenVerdict::Invalid(TokenRejection::NotNarrowed(_))
        ));
    }

    #[tokio::test]
    async fn delegation_cannot_outlive_its_parent() {
        let parent = NodeIdentity::generate_ed25519();
        let (_, token, _) = mint_delegated(&parent, |child| {
            child.expires = NOW + 90_000;
        })
        .await;
        assert!(matches!(
            verify(&parent, &RevocationView::new(), &token).await,
            TokenVerdict::Invalid(TokenRejection::NotNarrowed(_))
        ));
    }

    #[tokio::test]
    async fn parent_bearer_must_be_the_child_issuer() {
        // A token from an unrelated issuer nested as the child's parent:
        // its bearer is not the child's issuer, so the hop widened.
        let unrelated = NodeIdentity::generate_ed25519();
        let bystander_root = mint(&unrelated, &claims_for(&unrelated, DeviceId([0xEE; 32]))).await;

        let parent = NodeIdentity::generate_ed25519();
        let (_, token, _) = mint_delegated(&parent, |child| {
            child.parent = Some(bystander_root.encode_to_vec());
        })
        .await;
        assert!(matches!(
            verify(&parent, &RevocationView::new(), &token).await,
            TokenVerdict::Invalid(TokenRejection::NotNarrowed(_))
        ));
    }

    #[tokio::test]
    async fn delegation_cycle_is_detected() {
        let issuer = NodeIdentity::generate_ed25519();
        // A0: a root. B: delegates under A0. A1: same token-id as A0 but parented at B — presenting A1 revisits token-id 1 on the walk. Every link bears the issuer's own device-id so narrowing holds and the walk actually reaches the cycle.
        let a0 = claims_for(&issuer, *issuer.device_id());
        let a0_token = mint(&issuer, &a0).await;
        let mut b = a0.clone();
        b.token_id = vec![0x02; 16];
        b.parent = Some(a0_token.encode_to_vec());
        let b_token = mint(&issuer, &b).await;
        let mut a1 = a0.clone();
        a1.parent = Some(b_token.encode_to_vec());
        let a1_token = mint(&issuer, &a1).await;
        assert!(matches!(
            verify(&issuer, &RevocationView::new(), &a1_token).await,
            TokenVerdict::Invalid(TokenRejection::ChainCycle)
        ));
    }

    #[tokio::test]
    async fn chain_deeper_than_the_bound_is_rejected() {
        let issuer = NodeIdentity::generate_ed25519();
        let mut root = claims_for(&issuer, *issuer.device_id());
        root.token_id = vec![0xFF; 16];
        let mut current = mint(&issuer, &root).await;
        for depth in 0u64..(MAX_CHAIN_DEPTH as u64 + 2) {
            let mut claims = claims_for(&issuer, *issuer.device_id());
            claims.token_id = vec![depth as u8; 16];
            claims.expires = NOW + 60_000 - depth; // keep clamping monotone
            claims.parent = Some(current.encode_to_vec());
            current = mint(&issuer, &claims).await;
        }
        assert!(matches!(
            verify(&issuer, &RevocationView::new(), &current).await,
            TokenVerdict::Invalid(TokenRejection::ChainTooDeep)
        ));
    }

    #[tokio::test]
    async fn revoking_the_leaf_revokes_the_token() {
        let parent = NodeIdentity::generate_ed25519();
        let (delegate, token, claims) = mint_delegated(&parent, |_| {}).await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation(&delegate, claims.token_id.clone()).await,
            &delegate,
        )
        .await
        .expect("entry verifies");
        assert!(matches!(
            verify(&parent, &view, &token).await,
            TokenVerdict::Invalid(TokenRejection::Revoked { .. })
        ));
    }

    #[tokio::test]
    async fn revoking_the_ancestor_revokes_the_whole_chain() {
        // management.cddl's obligation: every ancestor's token-id is swept,
        // so revoking the root kills the delegated child even though the
        // child's own token-id was never revoked.
        let parent = NodeIdentity::generate_ed25519();
        let (_delegate, token, _) = mint_delegated(&parent, |_| {}).await;
        let mut view = RevocationView::new();
        view.verify_and_insert(&mint_revocation(&parent, vec![0x01; 16]).await, &parent)
            .await
            .expect("entry verifies");
        let verdict = verify(&parent, &view, &token).await;
        match verdict {
            TokenVerdict::Invalid(TokenRejection::Revoked { token_id }) => {
                assert_eq!(token_id, vec![0x01; 16], "the revoked ancestor is reported");
            }
            other => panic!("expected Revoked on the ancestor, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn only_the_tokens_own_issuer_may_revoke_it() {
        // A validly-signed revocation from an unrelated issuer is admitted
        // to the view (it is a well-formed entry) but never matches the
        // token's own (token-id, issuer) pair, so the token stays valid.
        let parent = NodeIdentity::generate_ed25519();
        let (_delegate, token, claims) = mint_delegated(&parent, |_| {}).await;
        let stranger = NodeIdentity::generate_ed25519();
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation(&stranger, claims.token_id.clone()).await,
            &stranger,
        )
        .await
        .expect("the entry itself is well-formed");
        assert!(verify(&parent, &view, &token).await.is_valid());
    }

    #[tokio::test]
    async fn revoke_authorization_held_outside_the_issuing_chain_revokes_the_token() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let authorization_claims = authorization_claims_for(
            &issuer,
            *security_team_member.device_id(),
            REVOKE_CAPABILITY,
            target_claims.scope.clone(),
            NOW + 60_000,
        );
        let authorization = mint(&issuer, &authorization_claims).await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(authorization.encode_to_vec()),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        assert!(matches!(
            verify(&issuer, &view, &target).await,
            TokenVerdict::Invalid(TokenRejection::Revoked { .. })
        ));
    }

    #[tokio::test]
    async fn revoke_authorization_scoped_broader_than_the_target_still_covers_it() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        // Whole-kind root: no path at all, wider than the target's own /work.
        let authorization_claims = authorization_claims_for(
            &issuer,
            *security_team_member.device_id(),
            REVOKE_CAPABILITY,
            CapabilityScope {
                kind: "folder".to_owned(),
                path: None,
            },
            NOW + 60_000,
        );
        let authorization = mint(&issuer, &authorization_claims).await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(authorization.encode_to_vec()),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        assert!(matches!(
            verify(&issuer, &view, &target).await,
            TokenVerdict::Invalid(TokenRejection::Revoked { .. })
        ));
    }

    #[tokio::test]
    async fn authorization_with_the_wrong_capability_does_not_revoke() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let wrong_capability_authorization = mint(
            &issuer,
            &authorization_claims_for(
                &issuer,
                *security_team_member.device_id(),
                "exec:pty",
                target_claims.scope.clone(),
                NOW + 60_000,
            ),
        )
        .await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(wrong_capability_authorization.encode_to_vec()),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        assert!(verify(&issuer, &view, &target).await.is_valid());
    }

    #[tokio::test]
    async fn authorization_whose_scope_does_not_narrow_the_target_does_not_revoke() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let unrelated_scope_authorization = mint(
            &issuer,
            &authorization_claims_for(
                &issuer,
                *security_team_member.device_id(),
                REVOKE_CAPABILITY,
                CapabilityScope {
                    kind: "folder".to_owned(),
                    path: Some("/other".to_owned()),
                },
                NOW + 60_000,
            ),
        )
        .await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(unrelated_scope_authorization.encode_to_vec()),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        assert!(verify(&issuer, &view, &target).await.is_valid());
    }

    #[tokio::test]
    async fn authorization_held_by_someone_else_does_not_revoke() {
        // The authorization is genuinely valid, but held by security_team_member -- someone_else_entirely is submitting the revocation and citing it anyway.
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let someone_else_entirely = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let authorization_held_by_someone_else = mint(
            &issuer,
            &authorization_claims_for(
                &issuer,
                *security_team_member.device_id(),
                REVOKE_CAPABILITY,
                target_claims.scope.clone(),
                NOW + 60_000,
            ),
        )
        .await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &someone_else_entirely,
                target_claims.token_id.clone(),
                Some(authorization_held_by_someone_else.encode_to_vec()),
            )
            .await,
            &someone_else_entirely,
        )
        .await
        .expect("entry verifies");
        assert!(verify(&issuer, &view, &target).await.is_valid());
    }

    #[tokio::test]
    async fn an_expired_authorization_does_not_revoke() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let expired_authorization = mint(
            &issuer,
            &authorization_claims_for(
                &issuer,
                *security_team_member.device_id(),
                REVOKE_CAPABILITY,
                target_claims.scope.clone(),
                NOW - 1,
            ),
        )
        .await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(expired_authorization.encode_to_vec()),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        assert!(verify(&issuer, &view, &target).await.is_valid());
    }

    #[tokio::test]
    async fn an_authorization_that_is_itself_revoked_does_not_revoke() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let authorization_claims = authorization_claims_for(
            &issuer,
            *security_team_member.device_id(),
            REVOKE_CAPABILITY,
            target_claims.scope.clone(),
            NOW + 60_000,
        );
        let authorization = mint(&issuer, &authorization_claims).await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(authorization.encode_to_vec()),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        // The authorization token's own token-id is separately revoked by its own issuer.
        view.verify_and_insert(
            &mint_revocation(&issuer, authorization_claims.token_id.clone()).await,
            &issuer,
        )
        .await
        .expect("entry verifies");
        assert!(verify(&issuer, &view, &target).await.is_valid());
    }

    #[tokio::test]
    async fn malformed_authorization_bytes_do_not_revoke() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(vec![0xff]),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        assert!(verify(&issuer, &view, &target).await.is_valid());
    }

    #[tokio::test]
    async fn the_direct_issuer_match_path_is_unaffected_by_an_unrelated_failing_authorization() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = DeviceId([0xAA; 32]);
        let security_team_member = NodeIdentity::generate_ed25519();
        let target_claims = claims_for(&issuer, bearer);
        let target = mint(&issuer, &target_claims).await;
        let wrong_capability_authorization = mint(
            &issuer,
            &authorization_claims_for(
                &issuer,
                *security_team_member.device_id(),
                "exec:pty",
                target_claims.scope.clone(),
                NOW + 60_000,
            ),
        )
        .await;
        let mut view = RevocationView::new();
        view.verify_and_insert(
            &mint_revocation_with_authorization(
                &security_team_member,
                target_claims.token_id.clone(),
                Some(wrong_capability_authorization.encode_to_vec()),
            )
            .await,
            &security_team_member,
        )
        .await
        .expect("entry verifies");
        view.verify_and_insert(
            &mint_revocation(&issuer, target_claims.token_id.clone()).await,
            &issuer,
        )
        .await
        .expect("entry verifies");
        assert!(matches!(
            verify(&issuer, &view, &target).await,
            TokenVerdict::Invalid(TokenRejection::Revoked { .. })
        ));
    }

    #[tokio::test]
    async fn forged_revocation_is_rejected_at_admission() {
        // Claims naming the real issuer's key, but signed by an attacker.
        let parent = NodeIdentity::generate_ed25519();
        let attacker = NodeIdentity::generate_ed25519();
        let forged_claims = RevocationClaims {
            token_id: vec![0x01; 16],
            issuer: *parent.device_id(),
            issuer_key: parent.identity_key().clone(),
            revoked_at: NOW,
            authorization: None,
        };
        let entry = RevocationEntry(
            attacker
                .mint_cose_sign1(&forged_claims.encode_to_vec())
                .await
                .expect("mint"),
        );
        let mut view = RevocationView::new();
        let err = view.verify_and_insert(&entry, &parent).await.unwrap_err();
        assert!(matches!(
            err,
            crate::domain::revocation::RevocationError::BadSignature
        ));
        assert!(view.is_empty());
    }

    #[tokio::test]
    async fn verdict_authorises_scopes_within_the_grant() {
        let issuer = NodeIdentity::generate_ed25519();
        let claims = claims_for(&issuer, DeviceId([0xAA; 32]));
        let token = mint(&issuer, &claims).await;
        let verdict = verify(&issuer, &RevocationView::new(), &token).await;
        let inside = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/work/subdir".to_owned()),
        };
        let outside = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/other".to_owned()),
        };
        assert!(verdict_authorises(&verdict, "pin:write", &inside));
        assert!(!verdict_authorises(&verdict, "pin:write", &outside));
        assert!(!verdict_authorises(&verdict, "pin:read", &inside));
    }
}
