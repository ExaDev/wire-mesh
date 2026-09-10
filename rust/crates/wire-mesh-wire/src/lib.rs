//! `wire-mesh-wire` — the CDDL model and canonical CBOR codec for the
//! wire-mesh protocol, the Rust analogue of the TypeScript core's
//! generated layer plus its cbor2 encode/decode.
//!
//! One hand-written struct or enum per CDDL rule family (cddl.js emits
//! only TypeScript/Zod, so there is no generator; the 26 frozen
//! conformance vectors in `conformance/` are the cross-language pin, and
//! per-family unit tests derived from `spec/*.cddl` are the drift
//! mitigation). Every type implements `minicbor` `Encode`/`Decode` with:
//!
//! - **CDE by construction** — map keys are written in RFC 8949 4.2.1
//!   order (encoded length first, then bytewise), integer heads are
//!   minimal-length, lengths are always definite. Open maps go through
//!   [`value::CanonicalMap`], closed-key structs through encode statements
//!   whose order is pinned by tests, and mixed typed-plus-tail maps
//!   through [`value::CdeMapBuilder`].
//! - **Strict decode** — unknown keys, wrong arity, indefinite lengths,
//!   floats, tags, duplicate keys, unsorted keys, non-minimal heads,
//!   non-32-byte device-ids, bad enum literals, and trailing bytes are
//!   all rejected, so non-canonical
//!   input cannot decode only to re-encode differently.
//!
//! The crate is `alloc`-only with no async, crypto, or serde dependencies:
//! the codec layer stays portable to embedded and WASM targets, and any
//! crypto lives behind `wire-mesh-core`'s `Identity` port.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod data;
pub mod discovery;
pub mod error;
pub mod exec;
pub mod frame;
pub mod handshake;
pub mod identity;
pub mod management;
pub mod streaming;
pub mod strict;
pub mod tokens;
pub mod transport;
pub mod value;
pub mod webrtc;

pub use error::{DecodeError, EncodeError};
pub use frame::{Frame, ValidationError};

use minicbor::Decoder;

/// Decode a frame from a complete byte string (strict, rejects trailing
/// bytes).
pub fn decode_frame(bytes: &[u8]) -> Result<Frame, DecodeError> {
    Frame::decode_bytes(bytes)
}

/// Encode a frame to canonical CBOR bytes.
pub fn encode_frame(frame: &Frame) -> Vec<u8> {
    frame.encode_to_vec()
}

/// Encode a value with the crate's `()` encoding context, as the codec's
/// generic entry point for standalone structures (a COSE_Sign1, token
/// claims) rather than frames.
pub fn to_vec<T: minicbor::Encode<()>>(value: &T) -> Vec<u8> {
    minicbor::to_vec(value).unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"))
}

/// Strictly decode a value of any wire type from a complete byte string.
pub fn decode_exact<'b, T: minicbor::Decode<'b, ()>>(bytes: &'b [u8]) -> Result<T, DecodeError> {
    let mut d = Decoder::new(bytes);
    let value = T::decode(&mut d, &mut ()).map_err(DecodeError::from_minicbor)?;
    if d.position() != bytes.len() {
        return Err(DecodeError::TrailingBytes {
            consumed: d.position(),
            total: bytes.len(),
        });
    }
    Ok(value)
}

/// Re-exported so downstream crates can implement `CdeKey` for their own
/// open-map key types without depending on minicbor directly.
pub use minicbor;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_points_round_trip() {
        let frame = Frame::Ping(crate::transport::PingFrame);
        let bytes = encode_frame(&frame);
        assert_eq!(decode_frame(&bytes).expect("decode"), frame);
        assert!(decode_frame(&{
            let mut with_trailer = bytes.clone();
            with_trailer.extend_from_slice(&[0x00]);
            with_trailer
        })
        .is_err());
    }

    #[test]
    fn decode_exact_rejects_trailing() {
        let bytes = to_vec(&crate::identity::DeviceId([1; 32]));
        let mut with_trailer = bytes.clone();
        with_trailer.push(0x01);
        assert!(decode_exact::<crate::identity::DeviceId>(&bytes).is_ok());
        assert!(decode_exact::<crate::identity::DeviceId>(&with_trailer).is_err());
    }

    #[test]
    fn indefinite_length_map_rejected() {
        // 0xbf 0x64 "type" 0x64 "ping" 0xff — an indefinite-length ping.
        let bytes: Vec<u8> = [
            0xbfu8, 0x64, b't', b'y', b'p', b'e', 0x64, b'p', b'i', b'n', b'g', 0xff,
        ]
        .to_vec();
        assert!(decode_frame(&bytes).is_err());
    }
}
