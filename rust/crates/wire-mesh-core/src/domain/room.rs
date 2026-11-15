//! Room-notice verification (`spec/room.cddl`'s own noticeboard extension
//! of core/room). A room-notice is self-certifying the same way a
//! capability-token or revocation-entry already is: a bare `cose-sign1`
//! whose payload carries its own signer's key, so a reader verifies
//! posting authority from the entry alone, with no prior contact with the
//! poster and no central gatekeeper. Ported from `room.ts`.

use std::cmp::Ordering;

use wire_mesh_wire::room::{MessageRef, RoomNoticeClaims};
use wire_mesh_wire::tokens::CoseSign1;
use wire_mesh_wire::value::CanonicalMap;

use crate::domain::cose::{sig_structure, sign_cose_sign1};
use crate::domain::mint::{MintError, MintRefusal, MAX_EXACT_INTEGER};
use crate::domain::revocation::RevocationCheck;
use crate::domain::room_token_verification::{verify_room_token, RoomTokenRejection};
use crate::ports::{Clock, Identity};

/// Why a room-notice was rejected.
/// The literal content-type suffix marking a room-notice's content as
/// AES-256-GCM-encrypted under a room.rekey epoch's content key (room.cddl
/// obligation 7) -- the same suffix convention MIME structured syntaxes like
/// `application/jose+json` already use.
pub const ENCRYPTED_CONTENT_TYPE_SUFFIX: &str = "+aes256gcm";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomNoticeRejection {
    /// Not a well-formed COSE_Sign1 over room-notice-claims: a nil
    /// payload, or a payload that fails to decode.
    Malformed,
    /// The notice's own `room` field does not equal what the caller
    /// expected (checked before any cryptographic work).
    WrongRoom,
    /// The signature does not verify against the notice's own embedded
    /// `poster-key`.
    BadSignature,
    /// `sha256(poster-key.public-key)` does not equal the claimed
    /// `poster` device-id: the notice is not self-certifying.
    WrongPoster,
    /// The notice's own `valid-until` has already elapsed as of the
    /// injected clock, even though the embedded token is itself still
    /// valid.
    ContentExpired,
    /// room.cddl obligation 7's pairing is violated: `content-type`
    /// carries the `+aes256gcm` suffix but no `key-epoch` is present
    /// (a reader could not know which epoch to decrypt under), or a
    /// `key-epoch` is present on a plaintext content-type (it names a
    /// key nothing was encrypted under). Both directions are refused.
    KeyEpochMismatch,
    /// The embedded `room:member` token failed one of its own six
    /// verifier obligations.
    Token(RoomTokenRejection),
}

/// The verdict on a presented room-notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomNoticeVerdict {
    Valid { claims: Box<RoomNoticeClaims> },
    Invalid(RoomNoticeRejection),
}

/// Verifies one room-notice (`spec/room.cddl`) against every obligation
/// its own "Six verifier obligations" comment documents, including
/// `valid-until`: the envelope is a well-formed COSE_Sign1 whose
/// signature verifies against its own embedded poster-key, and
/// poster-key is self-certifying (`sha256(poster-key.public-key)` equals
/// `poster`); the embedded token independently passes every ordinary
/// capability-token obligation with its bearer pinned to this notice's
/// own `poster` field and its scope pinned to this notice's own `room`
/// field; and, if present, `valid-until` has not yet elapsed as of the
/// injected clock. Checks run cheapest-and-structural first, signature
/// next, the recursive token-chain verification last, mirroring
/// `verify_capability_token`'s own ordering discipline.
///
/// Cross-author ordering (obligation 4) is deliberately NOT checked here
/// -- it is a property of how a reader merges several posters' notices
/// into one sequence, not a pass/fail condition on any single notice.
/// Use [`compare_room_notices`] for that once notices are already
/// individually verified.
///
/// Revocation (obligation 5) needs no separate step of its own:
/// verifying the embedded token below already walks the full delegation
/// chain against `revocations` as part of ordinary capability-token
/// verification.
pub async fn verify_room_notice(
    identity: &dyn Identity,
    clock: &dyn Clock,
    revocations: &dyn RevocationCheck,
    notice: &CoseSign1,
    // When given, refuses any notice not claiming exactly this room --
    // "is this the room I actually asked to read", checked against the
    // notice's own self-declared `room` field before any cryptographic
    // work. Independent of, and layered on top of, this function's own
    // unconditional internal self-consistency check (the embedded
    // token's scope.path MUST equal the notice's own `room` field
    // regardless of whether expected_room is given at all).
    expected_room: Option<&str>,
) -> RoomNoticeVerdict {
    let Some(payload) = &notice.payload else {
        return RoomNoticeVerdict::Invalid(RoomNoticeRejection::Malformed);
    };
    let claims = match RoomNoticeClaims::decode_bytes(payload) {
        Ok(claims) => claims,
        Err(_) => return RoomNoticeVerdict::Invalid(RoomNoticeRejection::Malformed),
    };

    if let Some(expected_room) = expected_room {
        if claims.room != expected_room {
            return RoomNoticeVerdict::Invalid(RoomNoticeRejection::WrongRoom);
        }
    }

    let message = sig_structure(&notice.protected, payload);
    match identity
        .verify(&claims.poster_key, &message, &notice.signature)
        .await
    {
        Ok(true) => {}
        Ok(false) | Err(_) => return RoomNoticeVerdict::Invalid(RoomNoticeRejection::BadSignature),
    }

    if identity.derive_device_id(&claims.poster_key.public_key) != claims.poster {
        return RoomNoticeVerdict::Invalid(RoomNoticeRejection::WrongPoster);
    }

    if let Some(valid_until) = claims.valid_until {
        if valid_until <= clock.now_unix_ms() {
            return RoomNoticeVerdict::Invalid(RoomNoticeRejection::ContentExpired);
        }
    }

    // room.cddl obligation 7: key-epoch is present iff content-type names an
    // encrypted content-type (the `+aes256gcm` suffix). Checked structurally,
    // before the recursive token verification, matching the TS verifier's own
    // ordering.
    let encrypted_content_type = claims.content_type.ends_with(ENCRYPTED_CONTENT_TYPE_SUFFIX);
    if encrypted_content_type != claims.key_epoch.is_some() {
        return RoomNoticeVerdict::Invalid(RoomNoticeRejection::KeyEpochMismatch);
    }

    let token_verdict = verify_room_token(
        identity,
        clock,
        revocations,
        &claims.token,
        claims.poster,
        &claims.room,
    )
    .await;
    if let crate::domain::room_token_verification::RoomTokenVerdict::Invalid(rejection) =
        token_verdict
    {
        return RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(rejection));
    }

    RoomNoticeVerdict::Valid {
        claims: Box::new(claims),
    }
}

/// What a poster supplies to [`create_room_notice`]. `posted-at` is not here: it is always read from the clock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRoomNotice {
    /// The room the notice is posted to.
    pub room: String,
    /// The poster's own `room:member` token, embedded in full: a reader checks its bearer against the notice's signed `poster`.
    pub token: CoseSign1,
    /// Unique enough for [`compare_room_notices`]'s cross-author tiebreak. How it is generated is the caller's choice.
    pub notice_id: Vec<u8>,
    pub content_type: String,
    /// Opaque bytes. For an encrypted content type the caller has already encrypted them: this function never encrypts.
    pub content: Vec<u8>,
    /// Forward and reply references to other notices.
    pub refs: Option<Vec<MessageRef>>,
    /// Unix milliseconds after which the notice's content is no longer valid.
    pub valid_until: Option<u64>,
    /// The `room.rekey` epoch the content is encrypted under: present exactly when `content_type` names an encrypted content type, which [`verify_room_notice`] enforces and this function does not.
    pub key_epoch: Option<u64>,
}

/// Creates one self-certifying room-notice as `identity`, the counterpart of [`verify_room_notice`]: `poster` and `poster-key` are the identity's own, and `posted-at` is the clock's current time, never a caller's value, so a poster's own log stays non-decreasing.
///
/// The notice is otherwise not checked here: a notice whose pairing of content type and key epoch, or whose embedded token, a reader would refuse is still created, exactly as the TypeScript `createRoomNotice` does. The one exception is an integer the TypeScript cannot hold exactly: `valid-until`, `key-epoch` and the clock's reading are bounded at [`MAX_EXACT_INTEGER`], as every other minter of this crate is, because a notice carrying a larger one is unreadable there.
///
/// # Errors
///
/// [`MintError::Refused`] with [`MintRefusal::ValueNotRepresentable`] when `valid-until`, `key-epoch` or the clock's reading is above [`MAX_EXACT_INTEGER`] (nothing is signed), and [`MintError::Port`] when `identity.sign` fails.
pub async fn create_room_notice(
    identity: &dyn Identity,
    clock: &dyn Clock,
    notice: NewRoomNotice,
) -> Result<CoseSign1, MintError> {
    let posted_at = clock.now_unix_ms();
    if [Some(posted_at), notice.valid_until, notice.key_epoch]
        .into_iter()
        .flatten()
        .any(|value| value > MAX_EXACT_INTEGER)
    {
        return Err(MintRefusal::ValueNotRepresentable.into());
    }
    let claims = RoomNoticeClaims {
        room: notice.room,
        poster: *identity.device_id(),
        poster_key: identity.identity_key().clone(),
        token: notice.token,
        notice_id: notice.notice_id,
        posted_at,
        content_type: notice.content_type,
        content: notice.content,
        refs: notice.refs,
        valid_until: notice.valid_until,
        key_epoch: notice.key_epoch,
        extra: CanonicalMap::new(),
    };
    Ok(sign_cose_sign1(identity, &claims.encode_to_vec()).await?)
}

/// Deterministic display ordering for room-notice entries from possibly
/// several different posters (`spec/room.cddl` obligation 4): sorts by
/// `(posted-at, poster, notice-id)`, the same "lowest wins" idiom
/// `coordinator-frame`'s own lowest-device-id rule already uses for
/// equal-term claims elsewhere in this spec. Takes already-verified
/// claims (the output of [`verify_room_notice`]) -- this is purely a
/// merge-order comparator, never a validity check.
pub fn compare_room_notices(a: &RoomNoticeClaims, b: &RoomNoticeClaims) -> Ordering {
    a.posted_at
        .cmp(&b.posted_at)
        .then_with(|| a.poster.cmp(&b.poster))
        .then_with(|| a.notice_id.cmp(&b.notice_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::node_identity::NodeIdentity;
    use crate::domain::revocation::RevocationView;
    use wire_mesh_wire::identity::{DeviceId, IdentityKey};
    use wire_mesh_wire::management::RevocationClaims;
    use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb, CoseTokenHeaders, TokenClaims};
    use wire_mesh_wire::value::CanonicalMap;

    const NOW: u64 = 1_893_456_000_000;
    const HOUR_MS: u64 = 3_600_000;

    struct FixedClock(u64);

    impl Clock for FixedClock {
        fn now_unix_ms(&self) -> u64 {
            self.0
        }
    }

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
        expires: u64,
    ) -> CoseSign1 {
        mint_token(
            issuer,
            bearer,
            CapabilityVerb("room:member".to_owned()),
            CapabilityScope {
                kind: "room".to_owned(),
                path: Some(room_path.to_owned()),
            },
            expires,
        )
        .await
    }

    async fn mint_token(
        issuer: &NodeIdentity,
        bearer: &NodeIdentity,
        capability: CapabilityVerb,
        scope: CapabilityScope,
        expires: u64,
    ) -> CoseSign1 {
        let claims = TokenClaims {
            token_id: next_token_id(),
            issuer: *issuer.device_id(),
            issuer_key: issuer.identity_key().clone(),
            bearer: *bearer.device_id(),
            capability,
            scope,
            expires,
            not_before: None,
            valid_until: None,
            conditions: None,
            parent: None,
            delegations_remaining: None,
            authorised_by: None,
            grants_capability: None,
            requests_capability: None,
            extra: CanonicalMap::new(),
        };
        issuer
            .mint_cose_sign1(&claims.encode_to_vec())
            .await
            .expect("mint")
    }

    static NEXT_TOKEN_ID: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(1);
    fn next_token_id() -> Vec<u8> {
        vec![NEXT_TOKEN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed); 16]
    }

    static NEXT_NOTICE_ID: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(1);
    fn next_notice_id() -> Vec<u8> {
        vec![NEXT_NOTICE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed); 16]
    }

    struct NoticeSeed<'a> {
        room: String,
        poster: Option<DeviceId>,
        token: CoseSign1,
        posted_at: u64,
        valid_until: Option<u64>,
        /// Overrides the default plaintext content-type -- tests exercising room.cddl
        /// obligation 7 pass a `+aes256gcm`-suffixed (or mismatched) value instead.
        content_type: Option<String>,
        /// Which room.rekey epoch content is encrypted under; paired with content_type
        /// per obligation 7.
        key_epoch: Option<u64>,
        signer: &'a NodeIdentity,
    }

    /// Builds and signs one room-notice, mirroring `signRoomNotice`'s own
    /// deliberate field-by-field construction -- performs none of
    /// `verify_room_notice`'s own checks, so tests exercising its
    /// enforcement can construct notices it would refuse.
    async fn sign_room_notice(seed: NoticeSeed<'_>) -> CoseSign1 {
        let claims = RoomNoticeClaims {
            room: seed.room,
            poster: seed.poster.unwrap_or(*seed.signer.device_id()),
            poster_key: seed.signer.identity_key().clone(),
            token: seed.token,
            notice_id: next_notice_id(),
            posted_at: seed.posted_at,
            content_type: seed.content_type.unwrap_or_else(|| "text/plain".to_owned()),
            content: b"hello".to_vec(),
            refs: None,
            valid_until: seed.valid_until,
            key_epoch: seed.key_epoch,
            extra: CanonicalMap::new(),
        };
        let payload = claims.encode_to_vec();
        let protected = Vec::new();
        let message = sig_structure(&protected, &payload);
        let signature = seed.signer.sign(&message).await.expect("sign");
        CoseSign1 {
            protected,
            unprotected: CoseTokenHeaders::default(),
            payload: Some(payload),
            signature,
        }
    }

    #[tokio::test]
    async fn accepts_a_well_formed_notice_posted_in_a_named_room() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert!(matches!(verdict, RoomNoticeVerdict::Valid { .. }));
    }

    #[tokio::test]
    async fn a_store_that_cannot_answer_refuses_the_notice_and_never_reads_as_not_revoked() {
        use crate::domain::revocation::{RevocationCheck, RevocationUnavailable};
        use wire_mesh_wire::management::RevocationClaims;
        struct Down;
        #[async_trait::async_trait]
        impl RevocationCheck for Down {
            async fn entries_for(
                &self,
                _: &[u8],
            ) -> Result<Vec<RevocationClaims>, RevocationUnavailable> {
                Err(RevocationUnavailable {
                    reason: "the store is down".to_owned(),
                })
            }
        }
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(&owner, &FixedClock(NOW), &Down, &notice, None).await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(RoomTokenRejection::Token(
                crate::domain::tokens::TokenRejection::RevocationUnavailable(
                    "the store is down".to_owned()
                )
            )))
        );
    }

    #[tokio::test]
    async fn accepts_a_well_formed_notice_posted_in_a_dm_room_verified_by_one_participant() {
        let me = NodeIdentity::generate_ed25519();
        let them = NodeIdentity::generate_ed25519();
        let room_path = dm_room_path(
            &crate::domain::room_path::device_id_to_hex(me.device_id()),
            &crate::domain::room_path::device_id_to_hex(them.device_id()),
        );
        let token = mint_room_member_token(&me, &them, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &them,
        })
        .await;

        let verdict =
            verify_room_notice(&me, &FixedClock(NOW), &RevocationView::new(), &notice, None).await;

        assert!(matches!(verdict, RoomNoticeVerdict::Valid { .. }));
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_envelope_payload_is_absent() {
        let owner = NodeIdentity::generate_ed25519();
        let notice = CoseSign1 {
            protected: Vec::new(),
            unprotected: CoseTokenHeaders::default(),
            payload: None,
            signature: Vec::new(),
        };

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Malformed)
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_payload_does_not_decode_as_room_notice_claims() {
        let owner = NodeIdentity::generate_ed25519();
        let notice = CoseSign1 {
            protected: Vec::new(),
            unprotected: CoseTokenHeaders::default(),
            // 0xff is not a valid CBOR major-type/length prefix combination.
            payload: Some(vec![0xff, 0xff]),
            signature: Vec::new(),
        };

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Malformed)
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_signature_has_been_tampered_with() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let mut notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;
        notice.signature = vec![0u8; notice.signature.len()];

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::BadSignature)
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_poster_field_does_not_match_its_own_poster_key() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let someone_else = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: Some(*someone_else.device_id()),
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::WrongPoster)
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_claiming_a_different_room_than_the_caller_expected() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let owner_hex = crate::domain::room_path::device_id_to_hex(owner.device_id());
        let room_path = owner_named_room_path(&owner_hex, "general");
        let other_room_path = owner_named_room_path(&owner_hex, "other");
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            Some(&other_room_path),
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::WrongRoom)
        );
    }

    #[tokio::test]
    async fn accepts_a_notice_matching_the_callers_expected_room() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path.clone(),
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            Some(&room_path),
        )
        .await;

        assert!(matches!(verdict, RoomNoticeVerdict::Valid { .. }));
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_embedded_token_bears_a_different_device_than_the_poster() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let impostor = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        // The embedded token bears `impostor`, but the notice's own signed poster field claims `poster`.
        let token = mint_room_member_token(&owner, &impostor, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(RoomTokenRejection::Token(
                crate::domain::tokens::TokenRejection::BearerMismatch
            )))
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_embedded_token_is_scoped_to_a_non_room_capability() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_token(
            &owner,
            &poster,
            CapabilityVerb("exec:pty".to_owned()),
            CapabilityScope {
                kind: "folder".to_owned(),
                path: None,
            },
            NOW + HOUR_MS,
        )
        .await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(
                RoomTokenRejection::WrongScopeKind
            ))
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_embedded_token_is_scoped_to_a_different_room() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let owner_hex = crate::domain::room_path::device_id_to_hex(owner.device_id());
        let actual_room_path = owner_named_room_path(&owner_hex, "general");
        let other_room_path = owner_named_room_path(&owner_hex, "other");
        let token = mint_room_member_token(&owner, &poster, &other_room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: actual_room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(
                RoomTokenRejection::WrongScopePath
            ))
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_embedded_token_is_rooted_at_neither_owner_nor_verifier() {
        let owner = NodeIdentity::generate_ed25519();
        let impostor = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        // Self-issued by an impostor, not the room's real owner -- the attack this obligation exists to catch.
        let token = mint_room_member_token(&impostor, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(
                RoomTokenRejection::WrongChainRoot
            ))
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_embedded_token_has_expired() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + 1).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW + HOUR_MS),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert!(matches!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(RoomTokenRejection::Token(
                crate::domain::tokens::TokenRejection::Expired { .. }
            )))
        ));
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_embedded_token_has_been_revoked() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token_id = next_token_id();
        let claims = TokenClaims {
            token_id: token_id.clone(),
            issuer: *owner.device_id(),
            issuer_key: owner.identity_key().clone(),
            bearer: *poster.device_id(),
            capability: CapabilityVerb("room:member".to_owned()),
            scope: CapabilityScope {
                kind: "room".to_owned(),
                path: Some(room_path.clone()),
            },
            expires: NOW + HOUR_MS,
            not_before: None,
            valid_until: None,
            conditions: None,
            parent: None,
            delegations_remaining: None,
            authorised_by: None,
            grants_capability: None,
            requests_capability: None,
            extra: CanonicalMap::new(),
        };
        let token = owner
            .mint_cose_sign1(&claims.encode_to_vec())
            .await
            .expect("mint");

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

        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(&owner, &FixedClock(NOW), &view, &notice, None).await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::Token(RoomTokenRejection::Token(
                crate::domain::tokens::TokenRejection::Revoked { token_id }
            )))
        );
    }

    #[tokio::test]
    async fn rejects_a_notice_whose_own_valid_until_has_already_elapsed() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: Some(NOW + 1),
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW + HOUR_MS),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::ContentExpired)
        );
    }

    #[tokio::test]
    async fn accepts_a_notice_whose_valid_until_has_not_yet_elapsed() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: Some(NOW + HOUR_MS),
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert!(matches!(verdict, RoomNoticeVerdict::Valid { .. }));
    }

    #[tokio::test]
    async fn accepts_a_notice_with_no_valid_until_at_all_even_long_after_posting() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let far_future_expiry = NOW + 1_000 * HOUR_MS;
        let token = mint_room_member_token(&owner, &poster, &room_path, far_future_expiry).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW + 10 * HOUR_MS),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert!(matches!(verdict, RoomNoticeVerdict::Valid { .. }));
    }

    #[tokio::test]
    async fn accepts_an_encrypted_notice_whose_content_type_and_key_epoch_agree() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: Some("text/plain+aes256gcm".to_owned()),
            key_epoch: Some(1),
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert!(matches!(verdict, RoomNoticeVerdict::Valid { .. }));
    }

    #[tokio::test]
    async fn rejects_an_encrypted_content_type_with_no_key_epoch() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: Some("text/plain+aes256gcm".to_owned()),
            key_epoch: None,
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::KeyEpochMismatch)
        );
    }

    #[tokio::test]
    async fn rejects_a_key_epoch_on_a_plaintext_content_type() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let notice = sign_room_notice(NoticeSeed {
            room: room_path,
            poster: None,
            token,
            posted_at: NOW,
            valid_until: None,
            content_type: None,
            key_epoch: Some(1),
            signer: &poster,
        })
        .await;

        let verdict = verify_room_notice(
            &owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            &notice,
            None,
        )
        .await;

        assert_eq!(
            verdict,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::KeyEpochMismatch)
        );
    }

    fn claims_with(posted_at: u64, poster: DeviceId, notice_id: Vec<u8>) -> RoomNoticeClaims {
        RoomNoticeClaims {
            room: format!("{}/general", "aa".repeat(32)),
            poster,
            poster_key: IdentityKey {
                alg: -7,
                public_key: Vec::new(),
            },
            token: CoseSign1 {
                protected: Vec::new(),
                unprotected: CoseTokenHeaders::default(),
                payload: Some(Vec::new()),
                signature: Vec::new(),
            },
            notice_id,
            posted_at,
            content_type: "text/plain".to_owned(),
            content: Vec::new(),
            refs: None,
            valid_until: None,
            key_epoch: None,
            extra: CanonicalMap::new(),
        }
    }

    #[test]
    fn compare_room_notices_orders_by_posted_at_first() {
        let p = DeviceId([1; 32]);
        let earlier = claims_with(100, p, vec![1]);
        let later = claims_with(200, p, vec![1]);

        assert_eq!(compare_room_notices(&earlier, &later), Ordering::Less);
        assert_eq!(compare_room_notices(&later, &earlier), Ordering::Greater);
    }

    #[test]
    fn compare_room_notices_breaks_a_posted_at_tie_by_poster_lowest_first() {
        let a = claims_with(100, DeviceId([1; 32]), vec![9]);
        let b = claims_with(100, DeviceId([2; 32]), vec![0]);

        assert_eq!(compare_room_notices(&a, &b), Ordering::Less);
    }

    #[test]
    fn compare_room_notices_breaks_a_posted_at_and_poster_tie_by_notice_id_lowest_first() {
        let p = DeviceId([1; 32]);
        let a = claims_with(100, p, vec![1]);
        let b = claims_with(100, p, vec![2]);

        assert_eq!(compare_room_notices(&a, &b), Ordering::Less);
        assert_eq!(compare_room_notices(&b, &a), Ordering::Greater);
        assert_eq!(compare_room_notices(&a, &a), Ordering::Equal);
    }
    async fn create_in_named_room(
        owner: &NodeIdentity,
        poster: &NodeIdentity,
        clock_ms: u64,
        change: impl FnOnce(&mut NewRoomNotice),
    ) -> CoseSign1 {
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(owner, poster, &room_path, NOW + HOUR_MS).await;
        let mut notice = NewRoomNotice {
            room: room_path,
            token,
            notice_id: vec![0xa1; 16],
            content_type: "text/plain".to_owned(),
            content: b"hello".to_vec(),
            refs: None,
            valid_until: None,
            key_epoch: None,
        };
        change(&mut notice);
        create_room_notice(poster, &FixedClock(clock_ms), notice)
            .await
            .expect("create")
    }

    async fn verify_created(owner: &NodeIdentity, notice: &CoseSign1) -> RoomNoticeVerdict {
        verify_room_notice(
            owner,
            &FixedClock(NOW),
            &RevocationView::new(),
            notice,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn a_created_notice_is_signed_by_the_poster_and_stamped_from_the_clock() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let notice = create_in_named_room(&owner, &poster, NOW, |_| {}).await;

        let RoomNoticeVerdict::Valid { claims } = verify_created(&owner, &notice).await else {
            panic!("a created notice verifies");
        };
        assert_eq!(claims.poster, *poster.device_id());
        assert_eq!(&claims.poster_key, poster.identity_key());
        assert_eq!(claims.posted_at, NOW);
        assert_eq!(claims.notice_id, vec![0xa1; 16]);
        assert_eq!(claims.content_type, "text/plain");
        assert_eq!(claims.content, b"hello");
        assert_eq!(claims.refs, None);
        assert_eq!(claims.valid_until, None);
        assert_eq!(claims.key_epoch, None);
    }

    #[tokio::test]
    async fn a_created_notice_takes_posted_at_from_the_clock_at_creation() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let notice = create_in_named_room(&owner, &poster, NOW - 5, |_| {}).await;

        let RoomNoticeVerdict::Valid { claims } = verify_created(&owner, &notice).await else {
            panic!("a created notice verifies");
        };
        assert_eq!(claims.posted_at, NOW - 5);
    }

    #[tokio::test]
    async fn a_created_notice_carries_forward_refs_and_an_expiry() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let refs = vec![MessageRef {
            id: vec![0xa2; 16],
            relation: "forward".to_owned(),
        }];
        let expected = refs.clone();
        let notice = create_in_named_room(&owner, &poster, NOW, |n| {
            n.refs = Some(refs);
            n.valid_until = Some(NOW + HOUR_MS);
        })
        .await;

        let RoomNoticeVerdict::Valid { claims } = verify_created(&owner, &notice).await else {
            panic!("a created notice verifies");
        };
        assert_eq!(claims.refs, Some(expected));
        assert_eq!(claims.valid_until, Some(NOW + HOUR_MS));
    }

    #[tokio::test]
    async fn a_created_encrypted_notice_carries_its_epoch_and_verifies() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let notice = create_in_named_room(&owner, &poster, NOW, |n| {
            n.content_type = "text/plain+aes256gcm".to_owned();
            n.key_epoch = Some(3);
        })
        .await;

        let RoomNoticeVerdict::Valid { claims } = verify_created(&owner, &notice).await else {
            panic!("a created notice verifies");
        };
        assert_eq!(claims.key_epoch, Some(3));
        assert_eq!(claims.content_type, "text/plain+aes256gcm");
    }

    #[tokio::test]
    async fn an_integer_the_typescript_cannot_hold_exactly_is_refused_before_signing() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let beyond = MAX_EXACT_INTEGER + 1;
        let room_path = owner_named_room_path(
            &crate::domain::room_path::device_id_to_hex(owner.device_id()),
            "general",
        );
        let token = mint_room_member_token(&owner, &poster, &room_path, NOW + HOUR_MS).await;
        let base = NewRoomNotice {
            room: room_path,
            token,
            notice_id: vec![0xa1; 16],
            content_type: "text/plain".to_owned(),
            content: b"hello".to_vec(),
            refs: None,
            valid_until: None,
            key_epoch: None,
        };
        let refused = Err(MintError::Refused(MintRefusal::ValueNotRepresentable));
        let mut valid_until = base.clone();
        valid_until.valid_until = Some(beyond);
        assert_eq!(
            create_room_notice(&poster, &FixedClock(NOW), valid_until).await,
            refused
        );
        let mut key_epoch = base.clone();
        key_epoch.key_epoch = Some(beyond);
        assert_eq!(
            create_room_notice(&poster, &FixedClock(NOW), key_epoch).await,
            refused
        );
        assert_eq!(
            create_room_notice(&poster, &FixedClock(beyond), base.clone()).await,
            refused
        );
        let mut at_the_limit = base;
        at_the_limit.valid_until = Some(MAX_EXACT_INTEGER);
        at_the_limit.key_epoch = Some(MAX_EXACT_INTEGER);
        assert!(create_room_notice(&poster, &FixedClock(NOW), at_the_limit)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn creation_does_not_check_the_pairing_of_content_type_and_key_epoch() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let notice = create_in_named_room(&owner, &poster, NOW, |n| {
            n.content_type = "text/plain+aes256gcm".to_owned();
        })
        .await;

        assert_eq!(
            verify_created(&owner, &notice).await,
            RoomNoticeVerdict::Invalid(RoomNoticeRejection::KeyEpochMismatch)
        );
    }

    #[tokio::test]
    async fn a_created_notice_signs_the_canonical_protected_header() {
        let owner = NodeIdentity::generate_ed25519();
        let poster = NodeIdentity::generate_ed25519();
        let notice = create_in_named_room(&owner, &poster, NOW, |_| {}).await;

        assert_eq!(
            notice.protected,
            crate::domain::cose::protected_header(poster.identity_key().alg, poster.device_id())
        );
    }
}
