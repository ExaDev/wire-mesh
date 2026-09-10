//! `discovery.cddl` — DNS-anchored handle resolution. `handle-claims`
//! carries the pluralised `mailboxes` (relay/hub devices holding core/data
//! entries on the handle's behalf); `handle-record` reuses the same
//! COSE_Sign1 envelope as `capability-token` so every implementation can
//! verify it with the same off-the-shelf COSE maths.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{device_id_from, DeviceId, IdentityKey};
use crate::strict;
use crate::tokens::CoseSign1;
use crate::transport::WireCandidate;

/// `handle-claims = { handle, device-id, identity-key, ? candidates, ? mailboxes, issued, expires }`.
///
/// A resolver MUST verify `device-id == sha256(identity-key.public-key)`
/// and check `expires` before trusting a resolved record, regardless of
/// which channel delivered it. CDE key order over the full key set:
/// `handle` (7), `issued` (7), `expires` (8), `device-id` (10),
/// `mailboxes` (10), `candidates` (11), `identity-key` (13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleClaims {
    /// `local-part@domain`, matching what was requested.
    pub handle: String,
    pub device_id: DeviceId,
    pub identity_key: IdentityKey,
    pub candidates: Option<Vec<WireCandidate>>,
    pub mailboxes: Option<Vec<DeviceId>>,
    /// Unix ms.
    pub issued: u64,
    /// Unix ms; records are refreshed periodically, mirroring a DNS TTL.
    pub expires: u64,
}

impl HandleClaims {
    pub fn decode_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut d = Decoder::new(bytes);
        let claims = handle_claims_from(&mut d)?;
        if d.position() != bytes.len() {
            return Err(DecodeError::TrailingBytes {
                consumed: d.position(),
                total: bytes.len(),
            });
        }
        Ok(claims)
    }

    pub fn encode_to_vec(&self) -> Vec<u8> {
        minicbor::to_vec(self).unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"))
    }
}

impl Encode<()> for HandleClaims {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len =
            5 + usize::from(self.candidates.is_some()) + usize::from(self.mailboxes.is_some());
        e.map(len as u64)?;
        e.str("handle")?.str(&self.handle)?;
        e.str("issued")?.u64(self.issued)?;
        e.str("expires")?.u64(self.expires)?;
        e.str("device-id")?.encode(self.device_id)?;
        if let Some(mailboxes) = &self.mailboxes {
            e.str("mailboxes")?.array(mailboxes.len() as u64)?;
            for mailbox in mailboxes {
                mailbox.encode(e, &mut ())?;
            }
        }
        if let Some(candidates) = &self.candidates {
            e.str("candidates")?.array(candidates.len() as u64)?;
            for candidate in candidates {
                candidate.encode(e, &mut ())?;
            }
        }
        e.str("identity-key")?.encode(&self.identity_key)?;
        e.ok()
    }
}

impl Decode<'_, ()> for HandleClaims {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        handle_claims_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn handle_claims_from(d: &mut Decoder<'_>) -> Result<HandleClaims, DecodeError> {
    let n = strict::definite_map(d)?;
    let mut handle: Option<String> = None;
    let mut device_id: Option<DeviceId> = None;
    let mut identity_key: Option<IdentityKey> = None;
    let mut candidates: Option<Vec<WireCandidate>> = None;
    let mut mailboxes: Option<Vec<DeviceId>> = None;
    let mut issued: Option<u64> = None;
    let mut expires: Option<u64> = None;
    for _ in 0..n {
        match strict::text_key(d)? {
            "handle" => handle = Some(strict::text_value(d)?),
            "device-id" => device_id = Some(device_id_from(d)?),
            "identity-key" => identity_key = Some(crate::identity::identity_key_from(d)?),
            "candidates" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(crate::transport::wire_candidate_from(d)?);
                }
                candidates = Some(list);
            }
            "mailboxes" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(device_id_from(d)?);
                }
                mailboxes = Some(list);
            }
            "issued" => issued = Some(strict::uint_value(d)?),
            "expires" => expires = Some(strict::uint_value(d)?),
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(HandleClaims {
        handle: handle.ok_or(DecodeError::MissingField("handle"))?,
        device_id: device_id.ok_or(DecodeError::MissingField("device-id"))?,
        identity_key: identity_key.ok_or(DecodeError::MissingField("identity-key"))?,
        candidates,
        mailboxes,
        issued: issued.ok_or(DecodeError::MissingField("issued"))?,
        expires: expires.ok_or(DecodeError::MissingField("expires"))?,
    })
}

/// `handle-record = cose-sign1`, `payload = bstr .cbor handle-claims`.
///
/// Reuses the same COSE_Sign1 envelope as capability-token for the same
/// reason: self-certifying (signed by the same key it claims to belong
/// to), safe to serve and cache through an untrusted intermediary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandleRecord(pub CoseSign1);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::CandidateKind;

    #[test]
    fn handle_claims_cde_order() {
        let claims = HandleClaims {
            handle: "alice@example.com".to_owned(),
            device_id: DeviceId([0x44; 32]),
            identity_key: IdentityKey {
                alg: -7,
                public_key: vec![0xee; 65],
            },
            candidates: Some(vec![WireCandidate {
                address: "203.0.113.5:4433".to_owned(),
                kind: CandidateKind::Host,
                priority: 100,
            }]),
            mailboxes: Some(vec![DeviceId([0x11; 32]), DeviceId([0x22; 32])]),
            issued: 1861833600000,
            expires: 1864425600000,
        };
        let bytes = claims.encode_to_vec();
        let back = HandleClaims::decode_bytes(&bytes).expect("decode");
        assert_eq!(back, claims);
        // handle, issued, expires, device-id, mailboxes, candidates, identity-key.
        let order: Vec<usize> = [
            "handle",
            "issued",
            "expires",
            "device-id",
            "mailboxes",
            "candidates",
            "identity-key",
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
        assert_eq!(bytes[0], 0xa7);
    }
}
