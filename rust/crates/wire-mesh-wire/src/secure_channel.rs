//! `core/secure-channel` frames (`spec/secure-channel.cddl`): the hello two
//! devices exchange to open an end-to-end channel inside a relay pairing, and
//! the sealed data that then carries every manage-request and
//! manage-response. Both travel as the payload of a `relay-data-frame`.
//!
//! This module is the codec only. The handshake, key schedule and sealing
//! are the secure channel itself and live with the crypto ports.

use minicbor::{decode::Decoder, encode::Encoder, Decode, Encode};

use crate::error::DecodeError;
use crate::identity::{device_id_from, identity_key_from, DeviceId, IdentityKey};
use crate::strict;

/// `bstr .size 65`: a SEC1 uncompressed P-256 point.
pub const EPHEMERAL_KEY_SIZE: usize = 65;
/// `bstr .size 16`.
pub const NONCE_SIZE: usize = 16;

/// `secure-hello-frame`. CDE key order: `type` (5), `nonce` (6),
/// `signature` (10), `to-device` (10), `identity-key` (13),
/// `ephemeral-key` (14), each counted with its length byte.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecureHelloFrame {
    pub ephemeral_key: Vec<u8>,
    pub nonce: Vec<u8>,
    pub identity_key: IdentityKey,
    pub to_device: DeviceId,
    pub signature: Vec<u8>,
}

impl SecureHelloFrame {
    pub const TYPE: &'static str = "secure-hello";
}

impl Encode<()> for SecureHelloFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(6)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("nonce")?.bytes(&self.nonce)?;
        e.str("signature")?.bytes(&self.signature)?;
        e.str("to-device")?.encode(self.to_device)?;
        e.str("identity-key")?.encode(&self.identity_key)?;
        e.str("ephemeral-key")?.bytes(&self.ephemeral_key)?;
        e.ok()
    }
}

impl Decode<'_, ()> for SecureHelloFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        secure_hello_from(d).map_err(minicbor::decode::Error::custom)
    }
}

fn sized(field: &'static str, bytes: Vec<u8>, expected: usize) -> Result<Vec<u8>, DecodeError> {
    if bytes.len() == expected {
        Ok(bytes)
    } else {
        Err(DecodeError::InvalidLength {
            field,
            expected,
            found: bytes.len(),
        })
    }
}

pub(crate) fn secure_hello_from(d: &mut Decoder<'_>) -> Result<SecureHelloFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut ephemeral_key: Option<Vec<u8>> = None;
    let mut nonce: Option<Vec<u8>> = None;
    let mut identity_key: Option<IdentityKey> = None;
    let mut to_device: Option<DeviceId> = None;
    let mut signature: Option<Vec<u8>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, SecureHelloFrame::TYPE)?,
            "ephemeral-key" => strict::set_once(
                &mut ephemeral_key,
                sized("ephemeral-key", strict::bytes_value(d)?, EPHEMERAL_KEY_SIZE)?,
            )?,
            "nonce" => strict::set_once(
                &mut nonce,
                sized("nonce", strict::bytes_value(d)?, NONCE_SIZE)?,
            )?,
            "identity-key" => strict::set_once(&mut identity_key, identity_key_from(d)?)?,
            "to-device" => strict::set_once(&mut to_device, device_id_from(d)?)?,
            "signature" => strict::set_once(&mut signature, strict::bytes_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(SecureHelloFrame {
        ephemeral_key: ephemeral_key.ok_or(DecodeError::MissingField("ephemeral-key"))?,
        nonce: nonce.ok_or(DecodeError::MissingField("nonce"))?,
        identity_key: identity_key.ok_or(DecodeError::MissingField("identity-key"))?,
        to_device: to_device.ok_or(DecodeError::MissingField("to-device"))?,
        signature: signature.ok_or(DecodeError::MissingField("signature"))?,
    })
}

/// `secure-data-frame`. CDE key order: `type` (5), `counter` (8),
/// `ciphertext` (11).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecureDataFrame {
    pub counter: u64,
    pub ciphertext: Vec<u8>,
}

impl SecureDataFrame {
    pub const TYPE: &'static str = "secure-data";
}

impl Encode<()> for SecureDataFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("counter")?.u64(self.counter)?;
        e.str("ciphertext")?.bytes(&self.ciphertext)?;
        e.ok()
    }
}

impl Decode<'_, ()> for SecureDataFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        secure_data_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn secure_data_from(d: &mut Decoder<'_>) -> Result<SecureDataFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut counter: Option<u64> = None;
    let mut ciphertext: Option<Vec<u8>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, SecureDataFrame::TYPE)?,
            "counter" => strict::set_once(&mut counter, strict::uint_value(d)?)?,
            "ciphertext" => strict::set_once(&mut ciphertext, strict::bytes_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(SecureDataFrame {
        counter: counter.ok_or(DecodeError::MissingField("counter"))?,
        ciphertext: ciphertext.ok_or(DecodeError::MissingField("ciphertext"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello() -> SecureHelloFrame {
        SecureHelloFrame {
            ephemeral_key: vec![0x04; EPHEMERAL_KEY_SIZE],
            nonce: vec![0x0b; NONCE_SIZE],
            identity_key: IdentityKey {
                alg: -8,
                public_key: vec![0x0d; 32],
            },
            to_device: DeviceId([0x22; 32]),
            signature: vec![0x0c; 64],
        }
    }

    fn round_trip<T>(value: T) -> Vec<u8>
    where
        T: Encode<()> + for<'b> Decode<'b, ()> + PartialEq + core::fmt::Debug,
    {
        let bytes = minicbor::to_vec(&value).expect("encode");
        let decoded: T = minicbor::decode(&bytes).expect("decode");
        assert_eq!(decoded, value);
        bytes
    }

    #[test]
    fn hello_and_data_round_trip() {
        round_trip(hello());
        round_trip(SecureDataFrame {
            counter: 0,
            ciphertext: vec![1, 2, 3],
        });
        round_trip(SecureDataFrame {
            counter: u64::MAX,
            ciphertext: vec![],
        });
    }

    #[test]
    fn hello_keys_are_in_cde_order() {
        let bytes = round_trip(hello());
        let position = |key: &[u8]| {
            bytes
                .windows(key.len())
                .position(|w| w == key)
                .expect("key present")
        };
        assert!(position(b"type") < position(b"nonce"));
        assert!(position(b"nonce") < position(b"signature"));
        assert!(position(b"signature") < position(b"to-device"));
        assert!(position(b"to-device") < position(b"identity-key"));
        assert!(position(b"identity-key") < position(b"ephemeral-key"));
    }

    #[test]
    fn data_keys_are_in_cde_order() {
        let bytes = round_trip(SecureDataFrame {
            counter: 1,
            ciphertext: vec![7],
        });
        let position = |key: &[u8]| {
            bytes
                .windows(key.len())
                .position(|w| w == key)
                .expect("key present")
        };
        assert!(position(b"type") < position(b"counter"));
        assert!(position(b"counter") < position(b"ciphertext"));
    }

    #[test]
    fn hello_with_a_short_ephemeral_key_is_rejected() {
        let mut short = hello();
        short.ephemeral_key.pop();
        let bytes = minicbor::to_vec(&short).expect("encode");

        assert!(minicbor::decode::<SecureHelloFrame>(&bytes).is_err());
    }

    #[test]
    fn hello_with_a_long_nonce_is_rejected() {
        let mut long = hello();
        long.nonce.push(0);
        let bytes = minicbor::to_vec(&long).expect("encode");

        assert!(minicbor::decode::<SecureHelloFrame>(&bytes).is_err());
    }

    #[test]
    fn unknown_key_is_rejected() {
        // {"type": "secure-data", "counter": 1, "ciphertext": h'', "extra": 1}
        let mut bytes: Vec<u8> = vec![0xa4];
        bytes.extend_from_slice(&[0x64, b't', b'y', b'p', b'e', 0x6b]);
        bytes.extend_from_slice(b"secure-data");
        bytes.extend_from_slice(&[0x65, b'e', b'x', b't', b'r', b'a', 0x01]);
        bytes.extend_from_slice(&[0x67]);
        bytes.extend_from_slice(b"counter");
        bytes.push(0x01);
        bytes.extend_from_slice(&[0x6a]);
        bytes.extend_from_slice(b"ciphertext");
        bytes.push(0x40);

        assert!(minicbor::decode::<SecureDataFrame>(&bytes).is_err());
    }
}
