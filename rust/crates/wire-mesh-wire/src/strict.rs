//! Shared strict-decode helpers used by every wire module's hand-written
//! `Decode` implementation.
//!
//! Two layers of canonicality are enforced here, matching what the
//! TypeScript side gets from cbor2's `cdeDecodeOptions` so both
//! implementations accept exactly the same byte strings:
//!
//! - **Shortest-form heads**: every integer, text, byte-string, map, and
//!   array head read through these helpers must use the minimal encoding
//!   width for its argument (RFC 8949 4.2.1), detected via the decoder
//!   position delta across the head.
//! - **Sorted map keys**: [`MapDecoder`] iterates a map's entries and
//!   rejects any key that does not sort strictly after its predecessor in
//!   CDE order (encoded-length first, then bytewise), which also rejects
//!   duplicates with a dedicated error.

use core::cmp::Ordering;

use minicbor::data::Type;
use minicbor::Decoder;

use crate::error::DecodeError;

/// RFC 8949 4.2.1 core deterministic ordering of two encoded byte strings:
/// shorter first, then bytewise.
pub(crate) fn cde_order(a: &[u8], b: &[u8]) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

/// The minimal CBOR head width for an unsigned argument.
fn minimal_uint_head_len(v: u64) -> usize {
    match v {
        0..=23 => 1,
        24..=0xFF => 2,
        0x100..=0xFFFF => 3,
        0x1_0000..=0xFFFF_FFFF => 5,
        _ => 9,
    }
}

/// The minimal CBOR head width for a signed value: negatives encode as
/// major type 1 with argument `-1 - v`.
fn minimal_int_head_len(v: i64) -> usize {
    if v >= 0 {
        minimal_uint_head_len(v as u64)
    } else {
        let argument = (v as u64).wrapping_neg().wrapping_sub(1);
        minimal_uint_head_len(argument)
    }
}

/// Reject a head that occupied more bytes than its minimal form.
fn check_head_width(width: usize, minimal: usize) -> Result<(), DecodeError> {
    if width == minimal {
        Ok(())
    } else {
        Err(DecodeError::NonMinimalHead)
    }
}

/// A definite-length map head with a minimal-width argument. Indefinite
/// maps are rejected: RFC 8949 4.2 core deterministic encoding requires
/// definite lengths, and a decoder that accepted them would let
/// non-canonical input decode fine but re-encode differently, breaking
/// byte-exactness.
pub(crate) fn definite_map(d: &mut Decoder<'_>) -> Result<u64, DecodeError> {
    let before = d.position();
    let n = d
        .map()
        .map_err(DecodeError::from_minicbor)?
        .ok_or(DecodeError::IndefiniteLength)?;
    check_head_width(d.position() - before, minimal_uint_head_len(n))?;
    Ok(n)
}

/// A definite-length array head with a minimal-width argument. See
/// [`definite_map`].
pub(crate) fn definite_array(d: &mut Decoder<'_>) -> Result<u64, DecodeError> {
    let before = d.position();
    let n = d
        .array()
        .map_err(DecodeError::from_minicbor)?
        .ok_or(DecodeError::IndefiniteLength)?;
    check_head_width(d.position() - before, minimal_uint_head_len(n))?;
    Ok(n)
}

/// A map key, which every wire-mesh frame and structure writes as text.
/// The key's length head must be minimal.
pub(crate) fn text_key<'b>(d: &mut Decoder<'b>) -> Result<&'b str, DecodeError> {
    let before = d.position();
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::String => {
            let key = d.str().map_err(DecodeError::from_minicbor)?;
            check_head_width(
                d.position() - before - key.len(),
                minimal_uint_head_len(key.len() as u64),
            )?;
            Ok(key)
        }
        other => Err(DecodeError::UnexpectedType {
            expected: "text map key",
            found: other.to_string(),
        }),
    }
}

/// A text-string value with a minimal-width length head.
pub(crate) fn text_value(d: &mut Decoder<'_>) -> Result<String, DecodeError> {
    let before = d.position();
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::String => {
            let value = d.str().map_err(DecodeError::from_minicbor)?.to_owned();
            check_head_width(
                d.position() - before - value.len(),
                minimal_uint_head_len(value.len() as u64),
            )?;
            Ok(value)
        }
        other => Err(DecodeError::UnexpectedType {
            expected: "text string",
            found: other.to_string(),
        }),
    }
}

/// A byte-string value with a minimal-width length head.
pub(crate) fn bytes_value(d: &mut Decoder<'_>) -> Result<Vec<u8>, DecodeError> {
    let before = d.position();
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::Bytes => {
            let value = d.bytes().map_err(DecodeError::from_minicbor)?.to_vec();
            check_head_width(
                d.position() - before - value.len(),
                minimal_uint_head_len(value.len() as u64),
            )?;
            Ok(value)
        }
        other => Err(DecodeError::UnexpectedType {
            expected: "byte string",
            found: other.to_string(),
        }),
    }
}

/// An unsigned integer value in minimal-head form.
pub(crate) fn uint_value(d: &mut Decoder<'_>) -> Result<u64, DecodeError> {
    let before = d.position();
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => {
            let v = d.u64().map_err(DecodeError::from_minicbor)?;
            check_head_width(d.position() - before, minimal_uint_head_len(v))?;
            Ok(v)
        }
        other => Err(DecodeError::UnexpectedType {
            expected: "unsigned integer",
            found: other.to_string(),
        }),
    }
}

/// A signed-or-unsigned integer value within i64 range, in minimal-head
/// form.
pub(crate) fn int_value(d: &mut Decoder<'_>) -> Result<i64, DecodeError> {
    let before = d.position();
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => {
            let v = d.u64().map_err(DecodeError::from_minicbor)?;
            check_head_width(d.position() - before, minimal_uint_head_len(v))?;
            i64::try_from(v)
                .map_err(|_| DecodeError::Constraint("integer above i64::MAX where int expected"))
        }
        Type::I8 | Type::I16 | Type::I32 | Type::I64 | Type::Int => {
            let v = d.i64().map_err(DecodeError::from_minicbor)?;
            check_head_width(d.position() - before, minimal_int_head_len(v))?;
            Ok(v)
        }
        other => Err(DecodeError::UnexpectedType {
            expected: "integer",
            found: other.to_string(),
        }),
    }
}

/// The literal string discriminant of a field, e.g. frame `type` or the
/// `result` of a manage outcome.
pub(crate) fn literal(d: &mut Decoder<'_>, expected: &'static str) -> Result<(), DecodeError> {
    let found = text_value(d)?;
    if found == expected {
        Ok(())
    } else {
        Err(DecodeError::BadLiteral { expected, found })
    }
}

/// Set an optional map field, rejecting a second occurrence of the same
/// key with the dedicated duplicate error. Map-key ordering already makes
/// duplicates unreachable ([`MapDecoder`]); this guard keeps the error
/// precise at the field that repeated.
pub(crate) fn set_once<T>(slot: &mut Option<T>, value: T) -> Result<(), DecodeError> {
    if slot.is_some() {
        return Err(DecodeError::DuplicateKey);
    }
    *slot = Some(value);
    Ok(())
}

/// The canonical (minimal-head) CBOR encoding of a text string, used to
/// order map keys without allocating a `CdeKey`.
pub(crate) fn encoded_text(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() + 1);
    push_head(&mut out, 0x60, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
    out
}

/// Append a minimal CBOR head for `major << 5` with the given argument.
pub(crate) fn push_head(out: &mut Vec<u8>, major_byte: u8, argument: u64) {
    let m = major_byte & 0xE0;
    match minimal_uint_head_len(argument) {
        1 => out.push(m | argument as u8),
        2 => {
            out.push(m | 24);
            out.push(argument as u8);
        }
        3 => {
            out.push(m | 25);
            out.extend_from_slice(&(argument as u16).to_be_bytes());
        }
        5 => {
            out.push(m | 26);
            out.extend_from_slice(&(argument as u32).to_be_bytes());
        }
        _ => {
            out.push(m | 27);
            out.extend_from_slice(&argument.to_be_bytes());
        }
    }
}

/// Tracks one map's key order, rejecting a key that does not sort strictly
/// after its predecessor in RFC 8949 4.2.1 CDE order (encoded-length
/// first, then bytewise). A repeated key is reported as a duplicate rather
/// than a misordering, the clearer name for that case.
pub(crate) struct KeyOrder {
    prev: Option<Vec<u8>>,
}

impl KeyOrder {
    pub(crate) fn new() -> Self {
        KeyOrder { prev: None }
    }

    pub(crate) fn push(&mut self, encoded_key: &[u8]) -> Result<(), DecodeError> {
        if let Some(prev) = &self.prev {
            match cde_order(prev, encoded_key) {
                Ordering::Less => {}
                Ordering::Equal => return Err(DecodeError::DuplicateKey),
                Ordering::Greater => return Err(DecodeError::UnsortedMapKeys),
            }
        }
        self.prev = Some(encoded_key.to_vec());
        Ok(())
    }
}

/// Iterates one map's entries, enforcing CDE key order (and with it
/// uniqueness) across every key read. Every closed-struct `*_from` loop
/// and the open-map DOM decoder go through this, so a map whose keys are
/// not in the exact order the encoder would write them cannot decode.
pub(crate) struct MapDecoder {
    remaining: u64,
    order: KeyOrder,
}

impl MapDecoder {
    pub(crate) fn new(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        Ok(MapDecoder {
            remaining: definite_map(d)?,
            order: KeyOrder::new(),
        })
    }

    /// The next text key, or `None` when the map is exhausted.
    pub(crate) fn next_key<'b>(
        &mut self,
        d: &mut Decoder<'b>,
    ) -> Result<Option<&'b str>, DecodeError> {
        if self.remaining == 0 {
            return Ok(None);
        }
        self.remaining -= 1;
        let key = text_key(d)?;
        self.order.push(&encoded_text(key))?;
        Ok(Some(key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_head_len_table() {
        assert_eq!(minimal_uint_head_len(0), 1);
        assert_eq!(minimal_uint_head_len(23), 1);
        assert_eq!(minimal_uint_head_len(24), 2);
        assert_eq!(minimal_uint_head_len(0xFF), 2);
        assert_eq!(minimal_uint_head_len(0x100), 3);
        assert_eq!(minimal_uint_head_len(0xFFFF), 3);
        assert_eq!(minimal_uint_head_len(0x1_0000), 5);
        assert_eq!(minimal_uint_head_len(0xFFFF_FFFF), 5);
        assert_eq!(minimal_uint_head_len(0x1_0000_0000), 9);
        assert_eq!(minimal_int_head_len(-1), 1);
        assert_eq!(minimal_int_head_len(-24), 1);
        assert_eq!(minimal_int_head_len(-25), 2);
        assert_eq!(minimal_int_head_len(-256), 2);
        assert_eq!(minimal_int_head_len(-257), 3);
    }

    #[test]
    fn non_minimal_uint_head_rejected() {
        // 0x18 0x05 is a two-byte head for the value 5, whose minimal form
        // is the single byte 0x05.
        let mut d = Decoder::new(&[0x18, 0x05]);
        assert_eq!(uint_value(&mut d), Err(DecodeError::NonMinimalHead));
        let mut d = Decoder::new(&[0x05]);
        assert_eq!(uint_value(&mut d), Ok(5));
    }

    #[test]
    fn non_minimal_map_head_rejected() {
        // A two-byte head declaring a 1-entry map.
        let mut d = Decoder::new(&[0xB8, 0x01]);
        assert_eq!(definite_map(&mut d), Err(DecodeError::NonMinimalHead));
        let mut d = Decoder::new(&[0xA1]);
        assert_eq!(definite_map(&mut d), Ok(1));
    }

    #[test]
    fn non_minimal_string_head_rejected() {
        // A two-byte head declaring a 1-byte text string ("a").
        let mut d = Decoder::new(&[0x78, 0x01, b'a']);
        assert_eq!(text_value(&mut d), Err(DecodeError::NonMinimalHead));
        let mut d = Decoder::new(&[0x61, b'a']);
        assert_eq!(text_value(&mut d), Ok("a".to_owned()));
    }

    #[test]
    fn key_order_rejects_duplicates_and_misordering() {
        let mut order = KeyOrder::new();
        assert_eq!(order.push(b"\x63\x61\x62\x63"), Ok(())); // "abc"
        assert_eq!(
            order.push(b"\x63\x61\x62\x63"),
            Err(DecodeError::DuplicateKey)
        );
        assert_eq!(
            order.push(b"\x62\x7a\x7a"), // "zz", shorter: sorts before "abc"
            Err(DecodeError::UnsortedMapKeys)
        );
        assert_eq!(order.push(b"\x64\x61\x62\x63\x64"), Ok(())); // "abcd"
    }

    #[test]
    fn map_decoder_rejects_unsorted_keys() {
        // { "b": 1, "a": 2 } — "a" is shorter, so it must come first.
        let bytes = [0xA2, 0x61, b'b', 0x01, 0x61, b'a', 0x02];
        let mut d = Decoder::new(&bytes);
        let mut m = MapDecoder::new(&mut d).expect("map head");
        assert_eq!(m.next_key(&mut d), Ok(Some("b")));
        assert_eq!(uint_value(&mut d), Ok(1)); // consume "b"'s value
        assert_eq!(m.next_key(&mut d), Err(DecodeError::UnsortedMapKeys));
    }
}
