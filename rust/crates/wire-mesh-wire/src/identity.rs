//! `identity.cddl` — a node's identity is the hash of its raw public key,
//! never the certificate DER that might carry it.
//!
//! `device-id` is SHA-256 of `identity-key.public-key` and is modelled as a
//! fixed `[u8; 32]` so a wrong-length id is unrepresentable after decode:
//! decoding anything but a 32-byte byte string is an error, not a value
//! that fails later.
//!
//! Hashing the certificate DER (which embeds a serial number and validity
//! window that change on every reissue even with an identical key) was a
//! Hashing the certificate DER (which embeds a serial number and validity window that change on every reissue even with an identical key) was a bug found independently in Cascade and agent-comms; the CDDL rule and this module's fixed-size type make the correct derivation the only one representable. Deriving the hash itself lives behind the `Identity` port in `wire-mesh-core`; the wire crate has no crypto dependencies by design.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::strict;

/// `identity-key = { alg: int, public-key: bstr }`.
///
/// `alg` is a COSE algorithm identifier (RFC 9053), e.g. -7 ES256 or -8
/// EdDSA; `public_key` is the raw public-key bytes in that algorithm's own
/// canonical encoding (32 raw bytes for Ed25519, 65-byte uncompressed SEC1
/// for ES256). CDE key order: `alg` (4 encoded bytes) before
/// `public-key` (11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityKey {
    pub alg: i64,
    pub public_key: Vec<u8>,
}

impl IdentityKey {
    /// COSE algorithm identifier for ES256 (P-256 + SHA-256).
    pub const ALG_ES256: i64 = -7;
    /// COSE algorithm identifier for EdDSA (pure Ed25519).
    pub const ALG_ED25519: i64 = -8;
}

impl Encode<()> for IdentityKey {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("alg")?.i64(self.alg)?;
        e.str("public-key")?.bytes(&self.public_key)?;
        e.ok()
    }
}

impl Decode<'_, ()> for IdentityKey {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        identity_key_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn identity_key_from(d: &mut Decoder<'_>) -> Result<IdentityKey, DecodeError> {
    let n = strict::definite_map(d)?;
    let mut alg: Option<i64> = None;
    let mut public_key: Option<Vec<u8>> = None;
    for _ in 0..n {
        match strict::text_key(d)? {
            "alg" => alg = Some(strict::int_value(d)?),
            "public-key" => public_key = Some(strict::bytes_value(d)?),
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(IdentityKey {
        alg: alg.ok_or(DecodeError::MissingField("alg"))?,
        public_key: public_key.ok_or(DecodeError::MissingField("public-key"))?,
    })
}

/// `device-id = bstr .size 32` — SHA-256 of the raw public key, never of
/// certificate DER.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DeviceId(pub [u8; 32]);

impl DeviceId {
    pub const SIZE: usize = 32;

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        DeviceId(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl AsRef<[u8]> for DeviceId {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl Encode<()> for DeviceId {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.bytes(&self.0)?.ok()
    }
}

impl Decode<'_, ()> for DeviceId {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        device_id_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn device_id_from(d: &mut Decoder<'_>) -> Result<DeviceId, DecodeError> {
    let bytes = strict::bytes_value(d)?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|v: Vec<u8>| DecodeError::InvalidLength {
            field: "device-id",
            expected: DeviceId::SIZE,
            found: v.len(),
        })?;
    Ok(DeviceId(arr))
}

/// `peer-identity = { device-id, identity-key, ? certificate }`.
///
/// `certificate` is optional X.509 DER, present only if the transport
/// binding uses TLS; the device-id is always derived from the identity key
/// regardless. CDE key order: `device-id` (10), `certificate` (12),
/// `identity-key` (13).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerIdentity {
    pub device_id: DeviceId,
    pub identity_key: IdentityKey,
    pub certificate: Option<Vec<u8>>,
}

impl Encode<()> for PeerIdentity {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 2 + usize::from(self.certificate.is_some());
        e.map(len as u64)?;
        e.str("device-id")?.encode(self.device_id)?;
        if let Some(cert) = &self.certificate {
            e.str("certificate")?.bytes(cert)?;
        }
        e.str("identity-key")?.encode(&self.identity_key)?;
        e.ok()
    }
}

impl Decode<'_, ()> for PeerIdentity {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        peer_identity_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn peer_identity_from(d: &mut Decoder<'_>) -> Result<PeerIdentity, DecodeError> {
    let n = strict::definite_map(d)?;
    let mut device_id: Option<DeviceId> = None;
    let mut identity_key: Option<IdentityKey> = None;
    let mut certificate: Option<Vec<u8>> = None;
    for _ in 0..n {
        match strict::text_key(d)? {
            "device-id" => device_id = Some(device_id_from(d)?),
            "identity-key" => identity_key = Some(identity_key_from(d)?),
            "certificate" => certificate = Some(strict::bytes_value(d)?),
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(PeerIdentity {
        device_id: device_id.ok_or(DecodeError::MissingField("device-id"))?,
        identity_key: identity_key.ok_or(DecodeError::MissingField("identity-key"))?,
        certificate,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip<T>(value: T)
    where
        T: Encode<()> + PartialEq + core::fmt::Debug + for<'a> Decode<'a, ()>,
    {
        let bytes = minicbor::to_vec(&value).expect("encode");
        let back: T = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, value, "round trip of {value:?}");
    }

    #[test]
    fn identity_key_round_trips_in_cde_order() {
        let key = IdentityKey {
            alg: -7,
            public_key: vec![0x04; 65],
        };
        round_trip(key.clone());
        let bytes = minicbor::to_vec(&key).expect("encode");
        // a2 63"alg" 26(-7) 6a"public-key" 58 41 ...
        let mut expected = vec![0xa2, 0x63, b'a', b'l', b'g', 0x26, 0x6a];
        expected.extend_from_slice(b"public-key");
        expected.extend_from_slice(&[0x58, 0x41]);
        expected.extend_from_slice(&[0x04; 65]);
        assert_eq!(bytes, expected);
    }

    #[test]
    fn device_id_rejects_wrong_length() {
        let mut bytes = vec![0x58, 31];
        bytes.extend_from_slice(&[0u8; 31]);
        let err: Result<DeviceId, _> = minicbor::decode(&bytes);
        assert!(err.is_err());
    }

    #[test]
    fn peer_identity_certificate_between_device_id_and_identity_key() {
        let identity = PeerIdentity {
            device_id: DeviceId([7; 32]),
            identity_key: IdentityKey {
                alg: -8,
                public_key: vec![9; 32],
            },
            certificate: Some(vec![1, 2]),
        };
        round_trip(identity.clone());
        let bytes = minicbor::to_vec(&identity).expect("encode");
        // First key after the map head must be "device-id" (10 encoded
        // bytes), then "certificate" (12), then "identity-key" (13).
        let positions: Vec<usize> = ["device-id", "certificate", "identity-key"]
            .iter()
            .map(|k| {
                bytes
                    .windows(k.len())
                    .position(|w| w == k.as_bytes())
                    .unwrap_or_else(|| panic!("{k} not found"))
            })
            .collect();
        assert!(positions[0] < positions[1] && positions[1] < positions[2]);
    }

    #[test]
    fn identity_key_rejects_unknown_keys() {
        // {"alg": -8, "unknown": 1}
        let bytes: Vec<u8> = [0xa2u8, 0x63, b'a', b'l', b'g', 0x27, 0x67]
            .into_iter()
            .chain(b"unknown".iter().copied())
            .chain([0x01])
            .collect();
        let err: Result<IdentityKey, _> = minicbor::decode(&bytes);
        assert!(err.is_err());
    }
}
