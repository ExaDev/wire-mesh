//! core/room's six verifier obligations (spec/room.cddl), layered on top of
//! [`verify_capability_token`] (obligations 2, 4, and 5 -- bearer match,
//! ordinary token-claims checks, and delegations-remaining narrowing --
//! already live there). This module adds the two obligations specific to
//! room-shaped scopes: the chain must terminate at the correct root for
//! the path's own shape (1), and the token's own scope must actually name
//! the room the request claims to act on (3). Obligation 6 (refuse an
//! unrecognised content-type/kind) is a message-handling concern, not a
//! token-verification one, and belongs to each consumer's own room verb
//! router instead. Ported from `room-token-verification.ts`.

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::tokens::{CoseSign1, TokenClaims};

use crate::domain::revocation::RevocationView;
use crate::domain::room_path::{device_id_to_hex, parse_room_path, ParsedRoomPath};
use crate::domain::tokens::{verify_capability_token, TokenRejection};
use crate::ports::{Clock, Identity};

/// The one capability every core/room verb (room.send/read/leave/members)
/// is gated by, per spec/room.cddl -- room.join/room.invite are
/// deliberately ungated instead and need no token check at all.
pub const ROOM_MEMBER_CAPABILITY: &str = "room:member";

/// Why a `room:member` token was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomTokenRejection {
    /// An ordinary capability-token verifier obligation failed.
    Token(TokenRejection),
    /// The token's own `scope.kind` is not `"room"`.
    WrongScopeKind,
    /// The token's own `scope.path` does not equal the room this request
    /// claims to act on.
    WrongScopePath,
    /// `room_path` itself matches neither the owner-named nor the DM
    /// shape -- there is no chain root to check it against.
    MalformedRoomPath,
    /// The chain's root issuer is not the room's own trust root: the
    /// owner named in the path for an owner-named room, or the verifying
    /// identity itself for a DM.
    WrongChainRoot,
}

/// The verdict on a presented `room:member` token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomTokenVerdict {
    Valid {
        claims: Box<TokenClaims>,
        /// The chain's own certified root issuer-key -- for a named room,
        /// exactly the room's rightful owner (obligation 1 just confirmed
        /// the chain terminates there); for a DM, the verifying identity's
        /// own key. Lets a caller (e.g. room.rekey's handler) derive an
        /// ECDH shared secret against the room's real owner with no
        /// separate live-sender identity check -- the same field the TS
        /// verdict carries.
        root_issuer_key: wire_mesh_wire::identity::IdentityKey,
    },
    Invalid(RoomTokenRejection),
}

/// Verifies a `room:member` capability token against all six of
/// core/room's verifier obligations. Delegates obligations 2/4/5 to
/// [`verify_capability_token`] directly; adds obligation 3 (scope.kind /
/// scope.path must match the room being acted on) and obligation 1 (the
/// chain's root must be the room's own owner for a named room, or the
/// verifying identity itself for a DM -- never either named participant
/// directly, since a DM token minted by anyone other than the verifier
/// would let a sender self-issue authority to message a stranger
/// unsolicited).
pub async fn verify_room_token(
    identity: &dyn Identity,
    clock: &dyn Clock,
    revocations: &RevocationView,
    token: &CoseSign1,
    // The peer identity actually authenticated on the arriving connection
    // (obligation 2) -- never a relay-asserted or gossip-derived value.
    // Mandatory here: every room verb requires a bearer, unlike
    // verify_capability_token's own optional parameter for callers
    // presenting a token to authorise themselves rather than a specific
    // counterparty.
    expected_bearer: DeviceId,
    // The room path this request claims to act on (obligation 3) -- must
    // equal the token's own scope.path, and its own shape determines the
    // chain root obligation 1 requires.
    room_path: &str,
) -> RoomTokenVerdict {
    let verdict =
        verify_capability_token(identity, clock, revocations, token, Some(expected_bearer)).await;
    let (claims, root_issuer, root_issuer_key) = match verdict {
        crate::domain::tokens::TokenVerdict::Valid {
            claims,
            root_issuer,
            root_issuer_key,
            ..
        } => (claims, root_issuer, root_issuer_key),
        crate::domain::tokens::TokenVerdict::Invalid(rejection) => {
            return RoomTokenVerdict::Invalid(RoomTokenRejection::Token(rejection));
        }
    };

    if claims.scope.kind != "room" {
        return RoomTokenVerdict::Invalid(RoomTokenRejection::WrongScopeKind);
    }
    if claims.scope.path.as_deref() != Some(room_path) {
        return RoomTokenVerdict::Invalid(RoomTokenRejection::WrongScopePath);
    }

    let Some(parsed) = parse_room_path(room_path) else {
        return RoomTokenVerdict::Invalid(RoomTokenRejection::MalformedRoomPath);
    };
    let expected_root_hex = match parsed {
        ParsedRoomPath::OwnerNamed { owner, .. } => owner,
        ParsedRoomPath::Dm { .. } => device_id_to_hex(identity.device_id()),
    };
    if device_id_to_hex(&root_issuer) != expected_root_hex {
        return RoomTokenVerdict::Invalid(RoomTokenRejection::WrongChainRoot);
    }

    RoomTokenVerdict::Valid {
        claims,
        root_issuer_key,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::node_identity::NodeIdentity;
    use wire_mesh_wire::management::RevocationClaims;
    use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb, TokenClaims};
    use wire_mesh_wire::value::CanonicalMap;

    const NOW: u64 = 1_893_456_000_000;
    const HOUR_MS: u64 = 3_600_000;

    struct FixedClock(u64);

    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> u64 {
            self.0
        }
    }

    /// Test-only room-path construction -- `room_path.rs` deliberately
    /// stays verification-side only (see its own doc comment), so these
    /// two mirror `room-path.ts`'s `ownerNamedRoomPath`/`dmRoomPath`
    /// locally rather than widening that module's production surface for
    /// a test-only need.
    fn owner_named_room_path(owner: &str, local_name: &str) -> String {
        format!("{owner}/{local_name}")
    }

    fn dm_room_path(a: &str, b: &str) -> String {
        if a < b {
            format!("{a}+{b}")
        } else {
            format!("{b}+{a}")
        }
    }

    async fn mint_room_member_token(
        issuer: &NodeIdentity,
        bearer: &NodeIdentity,
        room_path: &str,
        token_id: Vec<u8>,
    ) -> CoseSign1 {
        let claims = TokenClaims {
            token_id,
            issuer: *issuer.device_id(),
            issuer_key: issuer.identity_key().clone(),
            bearer: *bearer.device_id(),
            capability: CapabilityVerb(ROOM_MEMBER_CAPABILITY.to_owned()),
            scope: CapabilityScope {
                kind: "room".to_owned(),
                path: Some(room_path.to_owned()),
            },
            expires: NOW + HOUR_MS,
            not_before: None,
            valid_until: None,
            conditions: None,
            parent: None,
            extra: CanonicalMap::new(),
        };
        issuer
            .mint_cose_sign1(&claims.encode_to_vec())
            .await
            .expect("mint")
    }

    #[tokio::test]
    async fn accepts_a_token_rooted_at_the_named_rooms_own_owner() {
        let owner = NodeIdentity::generate_ed25519();
        let member = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(&device_id_to_hex(owner.device_id()), "general");
        let token = mint_room_member_token(&owner, &member, &room_path, vec![0x01; 16]).await;

        let verdict = verify_room_token(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &token,
            *member.device_id(),
            &room_path,
        )
        .await;

        // The chain's certified root is exactly the room's rightful owner -- obligation 1
        // just confirmed it -- and threading its issuer-key up is what lets room.rekey's
        // Rust handler derive an ECDH shared secret against it with no separate
        // live-sender identity check (the same property the TS verdict carries).
        match verdict {
            RoomTokenVerdict::Valid {
                root_issuer_key, ..
            } => {
                assert_eq!(&root_issuer_key, owner.identity_key());
            }
            other => panic!("expected Valid, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn refuses_a_token_rooted_at_the_wrong_device_for_a_named_room() {
        let owner = NodeIdentity::generate_ed25519();
        let impostor = NodeIdentity::generate_ed25519();
        let member = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(&device_id_to_hex(owner.device_id()), "general");
        let token = mint_room_member_token(&impostor, &member, &room_path, vec![0x01; 16]).await;

        let verdict = verify_room_token(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &token,
            *member.device_id(),
            &room_path,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomTokenVerdict::Invalid(RoomTokenRejection::WrongChainRoot)
        ));
    }

    #[tokio::test]
    async fn accepts_a_dm_token_rooted_at_the_verifying_identity_itself() {
        let me = NodeIdentity::generate_ed25519();
        let them = NodeIdentity::generate_ed25519();
        let room_path = dm_room_path(
            &device_id_to_hex(me.device_id()),
            &device_id_to_hex(them.device_id()),
        );
        let token = mint_room_member_token(&me, &them, &room_path, vec![0x01; 16]).await;

        let verdict = verify_room_token(
            &me,
            &FixedClock(NOW),
            &RevocationView::new(),
            &token,
            *them.device_id(),
            &room_path,
        )
        .await;

        assert!(matches!(verdict, RoomTokenVerdict::Valid { .. }));
    }

    #[tokio::test]
    async fn refuses_a_dm_token_rooted_at_neither_participant_nor_the_verifier() {
        let me = NodeIdentity::generate_ed25519();
        let them = NodeIdentity::generate_ed25519();
        let stranger = NodeIdentity::generate_ed25519();
        let room_path = dm_room_path(
            &device_id_to_hex(me.device_id()),
            &device_id_to_hex(them.device_id()),
        );
        let token = mint_room_member_token(&stranger, &them, &room_path, vec![0x01; 16]).await;

        let verdict = verify_room_token(
            &me,
            &FixedClock(NOW),
            &RevocationView::new(),
            &token,
            *them.device_id(),
            &room_path,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomTokenVerdict::Invalid(RoomTokenRejection::WrongChainRoot)
        ));
    }

    #[tokio::test]
    async fn refuses_a_token_scoped_to_a_different_room_path() {
        let owner = NodeIdentity::generate_ed25519();
        let member = NodeIdentity::generate_ed25519();
        let actual_room_path =
            owner_named_room_path(&device_id_to_hex(owner.device_id()), "general");
        let other_room_path =
            owner_named_room_path(&device_id_to_hex(owner.device_id()), "other-room");
        let token =
            mint_room_member_token(&owner, &member, &actual_room_path, vec![0x01; 16]).await;

        let verdict = verify_room_token(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &token,
            *member.device_id(),
            &other_room_path,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomTokenVerdict::Invalid(RoomTokenRejection::WrongScopePath)
        ));
    }

    #[tokio::test]
    async fn refuses_a_token_scoped_to_a_non_room_capability() {
        let owner = NodeIdentity::generate_ed25519();
        let member = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(&device_id_to_hex(owner.device_id()), "general");
        let claims = TokenClaims {
            token_id: vec![0x01; 16],
            issuer: *owner.device_id(),
            issuer_key: owner.identity_key().clone(),
            bearer: *member.device_id(),
            capability: CapabilityVerb("exec:pty".to_owned()),
            scope: CapabilityScope {
                kind: "folder".to_owned(),
                path: None,
            },
            expires: NOW + HOUR_MS,
            not_before: None,
            valid_until: None,
            conditions: None,
            parent: None,
            extra: CanonicalMap::new(),
        };
        let token = owner
            .mint_cose_sign1(&claims.encode_to_vec())
            .await
            .expect("mint");

        let verdict = verify_room_token(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &token,
            *member.device_id(),
            &room_path,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomTokenVerdict::Invalid(RoomTokenRejection::WrongScopeKind)
        ));
    }

    #[tokio::test]
    async fn refuses_a_token_bearing_a_different_device_than_the_authenticated_connection() {
        let owner = NodeIdentity::generate_ed25519();
        let member = NodeIdentity::generate_ed25519();
        let impostor = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(&device_id_to_hex(owner.device_id()), "general");
        let token = mint_room_member_token(&owner, &member, &room_path, vec![0x01; 16]).await;

        let verdict = verify_room_token(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &token,
            *impostor.device_id(),
            &room_path,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomTokenVerdict::Invalid(RoomTokenRejection::Token(TokenRejection::BearerMismatch))
        ));
    }

    #[tokio::test]
    async fn refuses_an_expired_token() {
        let owner = NodeIdentity::generate_ed25519();
        let member = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(&device_id_to_hex(owner.device_id()), "general");
        let token = mint_room_member_token(&owner, &member, &room_path, vec![0x01; 16]).await;

        let verdict = verify_room_token(
            &owner,
            &FixedClock(NOW + HOUR_MS + HOUR_MS),
            &RevocationView::new(),
            &token,
            *member.device_id(),
            &room_path,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomTokenVerdict::Invalid(RoomTokenRejection::Token(TokenRejection::Expired { .. }))
        ));
    }

    #[tokio::test]
    async fn refuses_a_revoked_token() {
        let owner = NodeIdentity::generate_ed25519();
        let member = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(&device_id_to_hex(owner.device_id()), "general");
        let token_id = vec![0x01; 16];
        let token = mint_room_member_token(&owner, &member, &room_path, token_id.clone()).await;

        let revocation_claims = RevocationClaims {
            token_id: token_id.clone(),
            issuer: *owner.device_id(),
            issuer_key: owner.identity_key().clone(),
            revoked_at: NOW,
            authorization: None,
        };
        let entry = wire_mesh_wire::management::RevocationEntry(
            owner
                .mint_cose_sign1(&revocation_claims.encode_to_vec())
                .await
                .expect("mint revocation"),
        );
        let mut view = RevocationView::new();
        view.verify_and_insert(&entry, &owner)
            .await
            .expect("entry verifies");

        let verdict = verify_room_token(
            &owner,
            &FixedClock(NOW),
            &view,
            &token,
            *member.device_id(),
            &room_path,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomTokenVerdict::Invalid(RoomTokenRejection::Token(TokenRejection::Revoked { .. }))
        ));
    }
}
