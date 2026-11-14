//! Minting capability tokens and revocation entries, the Rust port of `mintCapabilityToken`, `mintRevocationEntry`, `canGrant` and `canGrantVia` in `ts/packages/core/src/domain/tokens.ts`.
//!
//! A mint refuses rather than produce a token that [`crate::domain::tokens::verify_capability_token`] would reject anyway: every narrowing rule of a `parent` link and every obligation of an `authorised-by` link is enforced at issuance, and the refusal names the rule broken. The order of the checks is part of the contract, since a candidate that breaks two rules gets the first one's reason.

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::{RevocationClaims, RevocationEntry};
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb, CoseSign1, TokenClaims};

use crate::domain::cose::sign_cose_sign1;
use crate::domain::predicates::{decode_conditions, evaluate_conditions, GrantSubject};
use crate::domain::tokens::MANAGE_GRANT_CAPABILITY;
use crate::ports::{Clock, CoreError, Identity};

/// Why a mint was refused, in the order the checks run. The string form is the name the conformance vectors use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MintRefusal {
    /// `expires` is not after the clock's present.
    AlreadyExpired,
    /// The capability, grants-capability or requests-capability is not a capability verb of the spec's grammar.
    InvalidCapability,
    /// The parent token did not decode into valid claims.
    ParentMalformed,
    /// The parent's bearer is not the minting identity.
    ParentBearerMismatch,
    /// The expiry is later than the parent's.
    ExpiresExceedsParent,
    /// The scope is not within the parent's.
    ScopeDoesNotNarrow,
    /// The capability verb differs from the parent's.
    CapabilityMismatch,
    /// The delegations-remaining is not strictly less than the parent's.
    DelegationExceedsParent,
    /// A parent and an authorised-by link were both given; they are mutually exclusive.
    LinksExclusive,
    /// The authorising token, or its conditions, did not decode.
    AuthorisationMalformed,
    /// The authoriser itself has a parent, or a `manage:grant` token was minted through a parent.
    AuthorisationParentForbidden,
    /// The authoriser's bearer is not the minting identity.
    AuthorisationBearerMismatch,
    /// The authoriser is not `manage:grant`, or its grants-capability names another verb.
    AuthorisationCapabilityMismatch,
    /// The scope is not within the authoriser's.
    AuthorisationScopeDoesNotNarrow,
    /// The expiry is later than the authoriser's.
    AuthorisationExceedsAuthoriser,
    /// The delegations-remaining is not strictly less than the authoriser's.
    AuthorisationDelegationExceeds,
    /// The authoriser's conditions, evaluated against the candidate, did not all hold.
    AuthorisationConditionsNotSatisfied,
}

impl MintRefusal {
    /// The name the conformance vectors give the refusal.
    pub fn as_str(self) -> &'static str {
        match self {
            MintRefusal::AlreadyExpired => "already_expired",
            MintRefusal::InvalidCapability => "invalid_capability",
            MintRefusal::ParentMalformed => "parent_malformed",
            MintRefusal::ParentBearerMismatch => "parent_bearer_mismatch",
            MintRefusal::ExpiresExceedsParent => "expires_exceeds_parent",
            MintRefusal::ScopeDoesNotNarrow => "scope_does_not_narrow",
            MintRefusal::CapabilityMismatch => "capability_mismatch",
            MintRefusal::DelegationExceedsParent => "delegation_exceeds_parent",
            MintRefusal::LinksExclusive => "links_exclusive",
            MintRefusal::AuthorisationMalformed => "authorisation_malformed",
            MintRefusal::AuthorisationParentForbidden => "authorisation_parent_forbidden",
            MintRefusal::AuthorisationBearerMismatch => "authorisation_bearer_mismatch",
            MintRefusal::AuthorisationCapabilityMismatch => "authorisation_capability_mismatch",
            MintRefusal::AuthorisationScopeDoesNotNarrow => "authorisation_scope_does_not_narrow",
            MintRefusal::AuthorisationExceedsAuthoriser => "authorisation_exceeds_authoriser",
            MintRefusal::AuthorisationDelegationExceeds => "authorisation_delegation_exceeds",
            MintRefusal::AuthorisationConditionsNotSatisfied => {
                "authorisation_conditions_not_satisfied"
            }
        }
    }
}

impl core::fmt::Display for MintRefusal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why [`mint_capability_token`] produced no token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MintError {
    /// The candidate breaks a rule of the spec: nothing was signed.
    Refused(MintRefusal),
    /// The identity port failed to sign.
    Port(CoreError),
}

impl core::fmt::Display for MintError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            MintError::Refused(refusal) => write!(f, "mint refused: {refusal}"),
            MintError::Port(error) => write!(f, "the identity port failed: {error}"),
        }
    }
}

impl std::error::Error for MintError {}

impl From<MintRefusal> for MintError {
    fn from(refusal: MintRefusal) -> Self {
        MintError::Refused(refusal)
    }
}

impl From<CoreError> for MintError {
    fn from(error: CoreError) -> Self {
        MintError::Port(error)
    }
}

/// What a parent link must narrow: the token a delegation would be minted as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NarrowingCandidate {
    pub capability: CapabilityVerb,
    pub scope: CapabilityScope,
    pub expires: u64,
    pub delegations_remaining: Option<u64>,
}

/// A token minted through an `authorised-by` link: a [`NarrowingCandidate`] and the device that would bear it, which the authoriser's conditions read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantCandidate {
    pub candidate: NarrowingCandidate,
    pub bearer: DeviceId,
}

/// The fields of a token to mint. `parent` and `authorised_by` are the whole COSE_Sign1 of the token the new one derives its authority from.
pub struct MintCapabilityToken<'a> {
    /// The issuer: signs the token and supplies its `issuer` and `issuer-key` claims.
    pub identity: &'a dyn Identity,
    pub clock: &'a dyn Clock,
    pub token_id: Vec<u8>,
    pub bearer: DeviceId,
    pub capability: CapabilityVerb,
    pub scope: CapabilityScope,
    pub expires: u64,
    pub not_before: Option<u64>,
    /// How many further delegation hops the resulting token permits below it. It bounds nothing about the issuer's own authority to mint other root-level grants.
    pub delegations_remaining: Option<u64>,
    /// The issuer's own token, when this is a delegation rather than a root grant.
    pub parent: Option<&'a CoseSign1>,
    /// Issuer-chosen restrictions beyond the mandatory narrowing: the canonical CBOR of a trilean predicate-node array, carried verbatim (a minter does not re-validate its own conditions, a verifier always decodes them).
    pub conditions: Option<Vec<u8>>,
    /// The grant-capability authorising this mint, mutually exclusive with `parent`.
    pub authorised_by: Option<&'a CoseSign1>,
    /// On a `manage:grant` token: the single verb it authorises minting.
    pub grants_capability: Option<CapabilityVerb>,
    /// On a `manage:request` token: the single verb it authorises requesting.
    pub requests_capability: Option<CapabilityVerb>,
}

fn decode_valid_claims(token: &CoseSign1) -> Option<TokenClaims> {
    let claims = token.decode_claims().ok()?;
    claims.validate_verbs().ok()?;
    claims.scope.validate().ok()?;
    Some(claims)
}

/// The five mandatory narrowing rules of a parent link, in the order they are checked: the parent's bearer is the minting device, the expiry is within the parent's, the scope is within the parent's, the verb is the parent's and the delegations-remaining is strictly less than the parent's.
fn check_narrowing(
    parent: &TokenClaims,
    granter: &DeviceId,
    candidate: &NarrowingCandidate,
) -> Option<MintRefusal> {
    if parent.bearer != *granter {
        return Some(MintRefusal::ParentBearerMismatch);
    }
    if candidate.expires > parent.expires {
        return Some(MintRefusal::ExpiresExceedsParent);
    }
    if !candidate.scope.is_within(&parent.scope) {
        return Some(MintRefusal::ScopeDoesNotNarrow);
    }
    if parent.capability != candidate.capability {
        return Some(MintRefusal::CapabilityMismatch);
    }
    if let Some(remaining) = parent.delegations_remaining {
        if candidate
            .delegations_remaining
            .is_none_or(|value| value >= remaining)
        {
            return Some(MintRefusal::DelegationExceedsParent);
        }
    }
    None
}

/// The obligations of an `authorised-by` link, checked against a token not yet minted, in the order they are checked.
fn check_authorisation(
    authoriser: &TokenClaims,
    minter: &DeviceId,
    candidate: &GrantCandidate,
) -> Option<MintRefusal> {
    let token = &candidate.candidate;
    if authoriser.parent.is_some() {
        return Some(MintRefusal::AuthorisationParentForbidden);
    }
    if authoriser.bearer != *minter {
        return Some(MintRefusal::AuthorisationBearerMismatch);
    }
    if authoriser.capability.0 != MANAGE_GRANT_CAPABILITY
        || authoriser
            .grants_capability
            .as_ref()
            .is_some_and(|grants| *grants != token.capability)
    {
        return Some(MintRefusal::AuthorisationCapabilityMismatch);
    }
    if !token.scope.is_within(&authoriser.scope) {
        return Some(MintRefusal::AuthorisationScopeDoesNotNarrow);
    }
    if token.expires > authoriser.expires {
        return Some(MintRefusal::AuthorisationExceedsAuthoriser);
    }
    if let Some(remaining) = authoriser.delegations_remaining {
        if token
            .delegations_remaining
            .is_none_or(|value| value >= remaining)
        {
            return Some(MintRefusal::AuthorisationDelegationExceeds);
        }
    }
    if let Some(conditions) = &authoriser.conditions {
        let Ok(nodes) = decode_conditions(conditions) else {
            return Some(MintRefusal::AuthorisationMalformed);
        };
        let subject = GrantSubject {
            capability: &token.capability.0,
            bearer: &candidate.bearer,
        };
        if !evaluate_conditions(&nodes, Some(&subject)) {
            return Some(MintRefusal::AuthorisationConditionsNotSatisfied);
        }
    }
    None
}

/// A pure query: could `device`, presenting `held` as its own delegation authority, mint a delegation matching `candidate` at `now`. It checks the narrowing rules a parent link requires and nothing about `held`'s signature or revocation status, exactly as [`mint_capability_token`] never re-verifies its own parent; a caller that needs those confirmed verifies `held` separately.
pub fn can_grant(
    held: &CoseSign1,
    device: &DeviceId,
    candidate: &NarrowingCandidate,
    now: u64,
) -> bool {
    if candidate.expires <= now {
        return false;
    }
    let Some(claims) = decode_valid_claims(held) else {
        return false;
    };
    check_narrowing(&claims, device, candidate).is_none()
}

/// [`can_grant`]'s `authorised-by` analogue: could `device`, presenting `held` as its minting authority, mint a token matching `candidate` at `now`. The candidate carries a bearer because the authoriser's conditions read it, the no-self-grant bar among them. The same caveat holds: `held`'s signature and revocation status are not checked here.
pub fn can_grant_via(
    held: &CoseSign1,
    device: &DeviceId,
    candidate: &GrantCandidate,
    now: u64,
) -> bool {
    if candidate.candidate.expires <= now {
        return false;
    }
    let Some(claims) = decode_valid_claims(held) else {
        return false;
    };
    check_authorisation(&claims, device, candidate).is_none()
}

/// Mints one capability token: builds the token-claims, signs them as a COSE_Sign1 under `options.identity` with the canonical protected header, and refuses with the reason of the first rule a delegation breaks.
///
/// # Errors
///
/// [`MintError::Refused`] with the [`MintRefusal`] for the first check that fails, in this order: the verbs, the expiry, the two links being exclusive, a `manage:grant` token with a parent, the parent link's narrowing, the authorised-by link's obligations. [`MintError::Port`] when the identity cannot sign.
pub async fn mint_capability_token(
    options: MintCapabilityToken<'_>,
) -> Result<CoseSign1, MintError> {
    for verb in [
        Some(&options.capability),
        options.grants_capability.as_ref(),
        options.requests_capability.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        if CapabilityVerb::validate(&verb.0).is_err() {
            return Err(MintRefusal::InvalidCapability.into());
        }
    }
    if options.expires <= options.clock.now_unix_ms() {
        return Err(MintRefusal::AlreadyExpired.into());
    }
    if options.parent.is_some() && options.authorised_by.is_some() {
        return Err(MintRefusal::LinksExclusive.into());
    }
    if options.capability.0 == MANAGE_GRANT_CAPABILITY && options.parent.is_some() {
        return Err(MintRefusal::AuthorisationParentForbidden.into());
    }

    let granter = options.identity.device_id();
    let narrowing = NarrowingCandidate {
        capability: options.capability.clone(),
        scope: options.scope.clone(),
        expires: options.expires,
        delegations_remaining: options.delegations_remaining,
    };
    let mut parent_bytes = None;
    if let Some(parent) = options.parent {
        let Some(parent_claims) = decode_valid_claims(parent) else {
            return Err(MintRefusal::ParentMalformed.into());
        };
        if let Some(refusal) = check_narrowing(&parent_claims, granter, &narrowing) {
            return Err(refusal.into());
        }
        parent_bytes = Some(parent.encode_to_vec());
    }
    let mut authorisation_bytes = None;
    if let Some(authoriser) = options.authorised_by {
        let Some(authoriser_claims) = decode_valid_claims(authoriser) else {
            return Err(MintRefusal::AuthorisationMalformed.into());
        };
        let candidate = GrantCandidate {
            candidate: narrowing,
            bearer: options.bearer,
        };
        if let Some(refusal) = check_authorisation(&authoriser_claims, granter, &candidate) {
            return Err(refusal.into());
        }
        authorisation_bytes = Some(authoriser.encode_to_vec());
    }

    let claims = TokenClaims {
        token_id: options.token_id,
        issuer: *granter,
        issuer_key: options.identity.identity_key().clone(),
        bearer: options.bearer,
        capability: options.capability,
        scope: options.scope,
        expires: options.expires,
        not_before: options.not_before,
        valid_until: None,
        conditions: options.conditions,
        parent: parent_bytes,
        delegations_remaining: options.delegations_remaining,
        authorised_by: authorisation_bytes,
        grants_capability: options.grants_capability,
        requests_capability: options.requests_capability,
        extra: wire_mesh_wire::value::CanonicalMap::new(),
    };
    Ok(sign_cose_sign1(options.identity, &claims.encode_to_vec()).await?)
}

/// Mints one revocation entry (`management.cddl`): a COSE_Sign1 over revocation-claims, signed the way [`mint_capability_token`] signs a token. Only a token's own issuer may revoke it, so `identity` must be the identity that minted the token named by `token_id`; that is checked where an entry is consulted, not here.
///
/// # Errors
///
/// The error `identity.sign` returns.
pub async fn mint_revocation_entry(
    identity: &dyn Identity,
    token_id: Vec<u8>,
    revoked_at: u64,
) -> Result<RevocationEntry, CoreError> {
    let claims = RevocationClaims {
        token_id,
        issuer: *identity.device_id(),
        issuer_key: identity.identity_key().clone(),
        revoked_at,
        authorization: None,
    };
    Ok(RevocationEntry(
        sign_cose_sign1(identity, &claims.encode_to_vec()).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::NodeIdentity;
    use crate::domain::revocation::RevocationView;
    use crate::domain::tokens::{verify_capability_token, TokenRejection, TokenVerdict};

    struct FixedClock(u64);

    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> u64 {
            self.0
        }
    }

    const NOW: u64 = 1_000_000;

    fn verb(text: &str) -> CapabilityVerb {
        CapabilityVerb(text.to_owned())
    }

    fn folder(path: &str) -> CapabilityScope {
        CapabilityScope {
            kind: "folder".to_owned(),
            path: Some(path.to_owned()),
        }
    }

    fn root<'a>(
        identity: &'a NodeIdentity,
        clock: &'a FixedClock,
        bearer: DeviceId,
    ) -> MintCapabilityToken<'a> {
        MintCapabilityToken {
            identity,
            clock,
            token_id: vec![1; 16],
            bearer,
            capability: verb("exec:pty"),
            scope: folder("/work"),
            expires: NOW + 1_000,
            not_before: None,
            delegations_remaining: None,
            parent: None,
            conditions: None,
            authorised_by: None,
            grants_capability: None,
            requests_capability: None,
        }
    }

    async fn verdict(identity: &NodeIdentity, token: &CoseSign1) -> TokenVerdict {
        verify_capability_token(
            identity,
            &FixedClock(NOW),
            &RevocationView::new(),
            token,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn a_minted_root_grant_verifies_and_carries_the_claims_given() {
        let issuer = NodeIdentity::generate_ed25519();
        let bearer = NodeIdentity::generate_es256();
        let clock = FixedClock(NOW);
        let token = mint_capability_token(root(&issuer, &clock, *bearer.device_id()))
            .await
            .expect("mint");
        match verdict(&issuer, &token).await {
            TokenVerdict::Valid { claims, .. } => {
                assert_eq!(claims.bearer, *bearer.device_id());
                assert_eq!(claims.issuer, *issuer.device_id());
                assert_eq!(claims.capability, verb("exec:pty"));
            }
            TokenVerdict::Invalid(why) => panic!("{why}"),
        }
    }

    #[tokio::test]
    async fn a_delegation_minted_under_a_parent_verifies_and_one_that_widens_is_refused() {
        let owner = NodeIdentity::generate_ed25519();
        let delegate = NodeIdentity::generate_ed25519();
        let clock = FixedClock(NOW);
        let parent = mint_capability_token(MintCapabilityToken {
            delegations_remaining: Some(1),
            ..root(&owner, &clock, *delegate.device_id())
        })
        .await
        .expect("parent");
        let child = mint_capability_token(MintCapabilityToken {
            token_id: vec![2; 16],
            scope: folder("/work/sub"),
            delegations_remaining: Some(0),
            parent: Some(&parent),
            ..root(&delegate, &clock, *owner.device_id())
        })
        .await
        .expect("child");
        assert!(matches!(
            verdict(&delegate, &child).await,
            TokenVerdict::Valid { .. }
        ));
        let widened = mint_capability_token(MintCapabilityToken {
            scope: folder("/elsewhere"),
            delegations_remaining: Some(0),
            parent: Some(&parent),
            ..root(&delegate, &clock, *owner.device_id())
        })
        .await;
        assert_eq!(
            widened.unwrap_err(),
            MintError::Refused(MintRefusal::ScopeDoesNotNarrow)
        );
    }

    #[tokio::test]
    async fn a_token_a_verifier_would_reject_is_not_minted() {
        let issuer = NodeIdentity::generate_ed25519();
        let clock = FixedClock(NOW);
        let expired = mint_capability_token(MintCapabilityToken {
            expires: NOW,
            ..root(&issuer, &clock, *issuer.device_id())
        })
        .await;
        assert_eq!(
            expired.unwrap_err(),
            MintError::Refused(MintRefusal::AlreadyExpired)
        );
        let bad_verb = mint_capability_token(MintCapabilityToken {
            capability: verb("two:colons:here"),
            ..root(&issuer, &clock, *issuer.device_id())
        })
        .await;
        assert_eq!(
            bad_verb.unwrap_err(),
            MintError::Refused(MintRefusal::InvalidCapability)
        );
    }

    #[tokio::test]
    async fn a_token_minted_through_a_grant_capability_verifies_and_the_no_self_grant_bar_holds() {
        let owner = NodeIdentity::generate_ed25519();
        let minter = NodeIdentity::generate_ed25519();
        let grantee = NodeIdentity::generate_ed25519();
        let clock = FixedClock(NOW);
        let bar = {
            use wire_mesh_wire::value::{CanonicalMap, CborValue};
            // not(and(granted-capability-is "exec:pty", grantee-is <minter>)) as the conditions list the spec's no-self-grant bar encodes.
            let delegate = |system: &str, payload: CborValue| {
                let mut map = CanonicalMap::new();
                for (key, value) in [
                    ("kind", CborValue::Text("delegate".to_owned())),
                    ("system", CborValue::Text(system.to_owned())),
                    ("payload", payload),
                ] {
                    map.insert(CborValue::Text(key.to_owned()), value)
                        .expect("distinct keys");
                }
                CborValue::Map(map)
            };
            let compare = |system: &str, payload: CborValue| {
                let mut map = CanonicalMap::new();
                let mut literal = CanonicalMap::new();
                for (key, value) in [
                    ("kind", CborValue::Text("booleanLiteral".to_owned())),
                    ("value", CborValue::Bool(true)),
                ] {
                    literal
                        .insert(CborValue::Text(key.to_owned()), value)
                        .expect("distinct keys");
                }
                for (key, value) in [
                    ("kind", CborValue::Text("compare".to_owned())),
                    ("op", CborValue::Text("eq".to_owned())),
                    ("left", delegate(system, payload)),
                    ("right", CborValue::Map(literal)),
                ] {
                    map.insert(CborValue::Text(key.to_owned()), value)
                        .expect("distinct keys");
                }
                CborValue::Map(map)
            };
            let hex: String = minter
                .device_id()
                .as_bytes()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect();
            let mut and = CanonicalMap::new();
            for (key, value) in [
                ("kind", CborValue::Text("and".to_owned())),
                (
                    "left",
                    compare(
                        "granted-capability-is",
                        CborValue::Text("exec:pty".to_owned()),
                    ),
                ),
                ("right", compare("grantee-is", CborValue::Text(hex))),
            ] {
                and.insert(CborValue::Text(key.to_owned()), value)
                    .expect("distinct keys");
            }
            let mut not = CanonicalMap::new();
            for (key, value) in [
                ("kind", CborValue::Text("not".to_owned())),
                ("operand", CborValue::Map(and)),
            ] {
                not.insert(CborValue::Text(key.to_owned()), value)
                    .expect("distinct keys");
            }
            wire_mesh_wire::to_vec(&CborValue::Array(vec![CborValue::Map(not)]))
        };
        let grant = mint_capability_token(MintCapabilityToken {
            capability: verb(MANAGE_GRANT_CAPABILITY),
            grants_capability: Some(verb("exec:pty")),
            delegations_remaining: Some(1),
            conditions: Some(bar),
            ..root(&owner, &clock, *minter.device_id())
        })
        .await
        .expect("grant");
        let candidate = |bearer: DeviceId| GrantCandidate {
            candidate: NarrowingCandidate {
                capability: verb("exec:pty"),
                scope: folder("/work/x"),
                expires: NOW + 500,
                delegations_remaining: Some(0),
            },
            bearer,
        };
        assert!(can_grant_via(
            &grant,
            minter.device_id(),
            &candidate(*grantee.device_id()),
            NOW
        ));
        assert!(!can_grant_via(
            &grant,
            minter.device_id(),
            &candidate(*minter.device_id()),
            NOW
        ));
        let minted = mint_capability_token(MintCapabilityToken {
            token_id: vec![2; 16],
            scope: folder("/work/x"),
            delegations_remaining: Some(0),
            authorised_by: Some(&grant),
            ..root(&minter, &clock, *grantee.device_id())
        })
        .await
        .expect("minted through the grant");
        assert!(matches!(
            verdict(&minter, &minted).await,
            TokenVerdict::Valid { .. }
        ));
        let to_itself = mint_capability_token(MintCapabilityToken {
            scope: folder("/work/x"),
            delegations_remaining: Some(0),
            authorised_by: Some(&grant),
            ..root(&minter, &clock, *minter.device_id())
        })
        .await;
        assert_eq!(
            to_itself.unwrap_err(),
            MintError::Refused(MintRefusal::AuthorisationConditionsNotSatisfied)
        );
    }

    #[tokio::test]
    async fn a_minted_revocation_entry_is_admitted_and_revokes_the_token() {
        let issuer = NodeIdentity::generate_ed25519();
        let clock = FixedClock(NOW);
        let token = mint_capability_token(root(&issuer, &clock, *issuer.device_id()))
            .await
            .expect("mint");
        let entry = mint_revocation_entry(&issuer, vec![1; 16], NOW - 1)
            .await
            .expect("entry");
        let mut view = RevocationView::new();
        view.verify_and_insert(&entry, &issuer)
            .await
            .expect("admitted");
        let verdict = verify_capability_token(&issuer, &FixedClock(NOW), &view, &token, None).await;
        assert!(matches!(
            verdict,
            TokenVerdict::Invalid(TokenRejection::Revoked { .. })
        ));
    }

    #[test]
    fn every_refusal_has_a_distinct_name() {
        let all = [
            MintRefusal::AlreadyExpired,
            MintRefusal::InvalidCapability,
            MintRefusal::ParentMalformed,
            MintRefusal::ParentBearerMismatch,
            MintRefusal::ExpiresExceedsParent,
            MintRefusal::ScopeDoesNotNarrow,
            MintRefusal::CapabilityMismatch,
            MintRefusal::DelegationExceedsParent,
            MintRefusal::LinksExclusive,
            MintRefusal::AuthorisationMalformed,
            MintRefusal::AuthorisationParentForbidden,
            MintRefusal::AuthorisationBearerMismatch,
            MintRefusal::AuthorisationCapabilityMismatch,
            MintRefusal::AuthorisationScopeDoesNotNarrow,
            MintRefusal::AuthorisationExceedsAuthoriser,
            MintRefusal::AuthorisationDelegationExceeds,
            MintRefusal::AuthorisationConditionsNotSatisfied,
        ];
        let names: std::collections::BTreeSet<&str> = all.iter().map(|r| r.as_str()).collect();
        assert_eq!(names.len(), all.len());
    }
}
