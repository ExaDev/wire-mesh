//! `room.cddl` — core/room's noticeboard entries on core/data.
//! `room-notice-claims` is the signed payload of a `room-notice`
//! (`cose-sign1`, the identical self-certifying envelope `capability-token`
//! and `handle-claims` already use). The manage-command verbs this domain
//! also defines (`room.send`, `room.read`, `room.leave`, `room.members`,
//! `room.join`, `room.invite`) need no typed Rust struct at all: they ride
//! `manage-request-frame`'s existing `Json` params catch-all, exactly as
//! confirmed when `core/room` was first added (zero Rust changes beyond
//! the frame layer already handles). Noticeboard entries are different:
//! the conformance harness typed-decodes every `tokens.v1.json` payload,
//! so `room-notice-claims` needs a real decoder here the same way
//! `TokenClaims`/`HandleClaims` do.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{device_id_from, DeviceId, IdentityKey};
use crate::strict;
use crate::tokens::{cose_sign1_from, CoseSign1};
use crate::value::{CanonicalMap, CborValue, CdeKey, CdeMapBuilder};

/// `message-ref = { id: bstr, relation: tstr }` — a typed reference to
/// another notice (reply, forward, or any future relation), an open `tstr`
/// discriminator on purpose so a new relation never needs a schema change.
/// CDE key order: `id` (2 encoded bytes) before `relation` (8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageRef {
    pub id: Vec<u8>,
    pub relation: String,
}

impl Encode<()> for MessageRef {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("id")?.bytes(&self.id)?;
        e.str("relation")?.str(&self.relation)?;
        e.ok()
    }
}

impl Decode<'_, ()> for MessageRef {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        message_ref_from(d).map_err(minicbor::decode::Error::custom)
    }
}

fn message_ref_from(d: &mut Decoder<'_>) -> Result<MessageRef, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut id: Option<Vec<u8>> = None;
    let mut relation: Option<String> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "id" => strict::set_once(&mut id, strict::bytes_value(d)?)?,
            "relation" => strict::set_once(&mut relation, strict::text_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(MessageRef {
        id: id.ok_or(DecodeError::MissingField("id"))?,
        relation: relation.ok_or(DecodeError::MissingField("relation"))?,
    })
}

/// `room-notice-claims` — see room.cddl for the five verifier obligations
/// (self-certification, `token.bearer == poster`, `token.scope` matching
/// this notice's own `room`, the `(posted-at, poster, notice-id)`
/// cross-author tiebreak, and posting-time-valid-not-retroactive
/// revocation), none of them expressible in the type system, all binding
/// on any verifier regardless of language.
///
/// `token` embeds the poster's `room:member` capability-token in full
/// (the same direct, non-`bstr`-wrapped embedding `manage-request-frame`'s
/// own optional `token` field already uses), not a `parent`-style nested
/// `bstr .cbor capability-token` reference — a reader with no other
/// context must be able to verify posting authority from the notice alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomNoticeClaims {
    pub room: String,
    pub poster: DeviceId,
    pub poster_key: IdentityKey,
    pub token: CoseSign1,
    pub notice_id: Vec<u8>,
    /// Unix ms, self-asserted — see room.cddl obligation 4.
    pub posted_at: u64,
    pub content_type: String,
    pub content: Vec<u8>,
    pub refs: Option<Vec<MessageRef>>,
    pub extra: CanonicalMap<String, CborValue>,
}

impl RoomNoticeClaims {
    /// Strictly decode from a complete byte string, rejecting trailing
    /// bytes.
    pub fn decode_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut d = Decoder::new(bytes);
        let claims = room_notice_claims_from(&mut d)?;
        if d.position() != bytes.len() {
            return Err(DecodeError::TrailingBytes {
                consumed: d.position(),
                total: bytes.len(),
            });
        }
        Ok(claims)
    }

    /// Encode to bytes.
    pub fn encode_to_vec(&self) -> Vec<u8> {
        minicbor::to_vec(self).unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"))
    }
}

impl Encode<()> for RoomNoticeClaims {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let mut builder = CdeMapBuilder::new();
        builder.push("room", &self.room);
        builder.push("poster", &self.poster);
        builder.push("poster-key", &self.poster_key);
        builder.push("token", &self.token);
        builder.push_bytes("notice-id", &self.notice_id);
        builder.push("posted-at", &self.posted_at);
        builder.push("content-type", &self.content_type);
        builder.push_bytes("content", &self.content);
        if let Some(refs) = &self.refs {
            let mut buf = Vec::new();
            let mut enc = Encoder::new(&mut buf);
            enc.array(refs.len() as u64)
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
            for r in refs {
                r.encode(&mut enc, &mut ())
                    .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
            }
            builder.push_raw("refs".encoded(), buf);
        }
        for (key, value) in self.extra.iter() {
            let mut value_buf = Vec::new();
            let mut value_enc = Encoder::new(&mut value_buf);
            value
                .encode(&mut value_enc, &mut ())
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
            builder.push_raw(key.encoded(), value_buf);
        }
        builder.write(e)
    }
}

impl Decode<'_, ()> for RoomNoticeClaims {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        room_notice_claims_from(d).map_err(minicbor::decode::Error::custom)
    }
}

fn room_notice_claims_from(d: &mut Decoder<'_>) -> Result<RoomNoticeClaims, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut room: Option<String> = None;
    let mut poster: Option<DeviceId> = None;
    let mut poster_key: Option<IdentityKey> = None;
    let mut token: Option<CoseSign1> = None;
    let mut notice_id: Option<Vec<u8>> = None;
    let mut posted_at: Option<u64> = None;
    let mut content_type: Option<String> = None;
    let mut content: Option<Vec<u8>> = None;
    let mut refs: Option<Vec<MessageRef>> = None;
    let mut extra = CanonicalMap::new();
    while let Some(key) = map.next_key(d)? {
        match key {
            "room" => strict::set_once(&mut room, strict::text_value(d)?)?,
            "poster" => strict::set_once(&mut poster, device_id_from(d)?)?,
            "poster-key" => {
                strict::set_once(&mut poster_key, crate::identity::identity_key_from(d)?)?
            }
            "token" => strict::set_once(&mut token, cose_sign1_from(d)?)?,
            "notice-id" => strict::set_once(&mut notice_id, strict::bytes_value(d)?)?,
            "posted-at" => strict::set_once(&mut posted_at, strict::uint_value(d)?)?,
            "content-type" => strict::set_once(&mut content_type, strict::text_value(d)?)?,
            "content" => strict::set_once(&mut content, strict::bytes_value(d)?)?,
            "refs" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(message_ref_from(d)?);
                }
                refs = Some(list);
            }
            other => {
                let value = CborValue::decode_strict(d)?;
                extra.insert(other.to_owned(), value)?;
            }
        }
    }
    Ok(RoomNoticeClaims {
        room: room.ok_or(DecodeError::MissingField("room"))?,
        poster: poster.ok_or(DecodeError::MissingField("poster"))?,
        poster_key: poster_key.ok_or(DecodeError::MissingField("poster-key"))?,
        token: token.ok_or(DecodeError::MissingField("token"))?,
        notice_id: notice_id.ok_or(DecodeError::MissingField("notice-id"))?,
        posted_at: posted_at.ok_or(DecodeError::MissingField("posted-at"))?,
        content_type: content_type.ok_or(DecodeError::MissingField("content-type"))?,
        content: content.ok_or(DecodeError::MissingField("content"))?,
        refs,
        extra,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::IdentityKey;

    fn sample_token() -> CoseSign1 {
        CoseSign1 {
            protected: vec![0xa0],
            unprotected: crate::tokens::CoseTokenHeaders::default(),
            payload: Some(vec![0x01, 0x02]),
            signature: vec![0xff; 64],
        }
    }

    #[test]
    fn room_notice_claims_round_trips_with_refs() {
        let claims = RoomNoticeClaims {
            room: format!("{}/general", "11".repeat(32)),
            poster: DeviceId([0x22; 32]),
            poster_key: IdentityKey {
                alg: -7,
                public_key: vec![0xcc; 65],
            },
            token: sample_token(),
            notice_id: vec![0xa1; 16],
            posted_at: 1861920000000,
            content_type: "text/plain".to_owned(),
            content: b"see you at the usual spot".to_vec(),
            refs: Some(vec![MessageRef {
                id: vec![0xa0; 16],
                relation: "reply".to_owned(),
            }]),
            extra: CanonicalMap::new(),
        };
        let bytes = claims.encode_to_vec();
        let back = RoomNoticeClaims::decode_bytes(&bytes).expect("decode");
        assert_eq!(back, claims);
    }

    #[test]
    fn room_notice_claims_round_trips_without_refs() {
        let claims = RoomNoticeClaims {
            room: format!("{}/general", "11".repeat(32)),
            poster: DeviceId([0x22; 32]),
            poster_key: IdentityKey {
                alg: -7,
                public_key: vec![0xcc; 65],
            },
            token: sample_token(),
            notice_id: vec![0xa1; 16],
            posted_at: 1861920000000,
            content_type: "text/plain".to_owned(),
            content: b"hello".to_vec(),
            refs: None,
            extra: CanonicalMap::new(),
        };
        let bytes = claims.encode_to_vec();
        let back = RoomNoticeClaims::decode_bytes(&bytes).expect("decode");
        assert_eq!(back, claims);
        // room (4), token (5), poster (6), content (7), notice-id/posted-at (9), poster-key (10), content-type (12).
        let order: Vec<usize> = [
            "room",
            "token",
            "poster",
            "content",
            "notice-id",
            "posted-at",
            "poster-key",
            "content-type",
        ]
        .iter()
        .map(|k| {
            bytes
                .windows(k.len())
                .position(|w| w == k.as_bytes())
                .expect("key present")
        })
        .collect();
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(order, sorted);
    }

    #[test]
    fn room_notice_claims_carries_extension_fields() {
        // An unrecognised key is accepted into the open `* tstr => any` tail, the same forward-compatible-extension pattern token-claims already carries -- not rejected the way a genuinely unknown, non-tail field would be.
        let claims = RoomNoticeClaims {
            room: format!("{}/general", "11".repeat(32)),
            poster: DeviceId([0x22; 32]),
            poster_key: IdentityKey {
                alg: -7,
                public_key: vec![0xcc; 65],
            },
            token: sample_token(),
            notice_id: vec![0xa1; 16],
            posted_at: 1861920000000,
            content_type: "text/plain".to_owned(),
            content: b"hello".to_vec(),
            refs: None,
            extra: {
                let mut extra = CanonicalMap::new();
                extra
                    .insert("edited".to_owned(), CborValue::Bool(true))
                    .expect("insert");
                extra
            },
        };
        let bytes = claims.encode_to_vec();
        let back = RoomNoticeClaims::decode_bytes(&bytes).expect("decode");
        assert_eq!(back, claims);
    }

    #[test]
    fn room_notice_claims_rejects_duplicate_typed_key() {
        // { "content-type": "a", "content-type": "b" }: the repeated key is rejected as a duplicate rather than silently taking the last value.
        let bytes = [
            0xa2, 0x6c, b'c', b'o', b'n', b't', b'e', b'n', b't', b'-', b't', b'y', b'p', b'e',
            0x61, b'a', 0x6c, b'c', b'o', b'n', b't', b'e', b'n', b't', b'-', b't', b'y', b'p',
            b'e', 0x61, b'b',
        ];
        assert_eq!(
            RoomNoticeClaims::decode_bytes(&bytes),
            Err(DecodeError::DuplicateKey)
        );
    }
}
