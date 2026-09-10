//! Shared strict-decode helpers used by every wire module's hand-written
//! `Decode` implementation.

use minicbor::data::Type;
use minicbor::Decoder;

use crate::error::DecodeError;

/// A definite-length map head. Indefinite maps are rejected: RFC 8949 4.2
/// core deterministic encoding requires definite lengths, and a decoder
/// that accepted them would let non-canonical input decode fine but
/// re-encode differently, breaking byte-exactness.
pub(crate) fn definite_map(d: &mut Decoder<'_>) -> Result<u64, DecodeError> {
    d.map()
        .map_err(DecodeError::from_minicbor)?
        .ok_or(DecodeError::IndefiniteLength)
}

/// A definite-length array head. See [`definite_map`].
pub(crate) fn definite_array(d: &mut Decoder<'_>) -> Result<u64, DecodeError> {
    d.array()
        .map_err(DecodeError::from_minicbor)?
        .ok_or(DecodeError::IndefiniteLength)
}

/// A map key, which every wire-mesh frame and structure writes as text.
pub(crate) fn text_key<'b>(d: &mut Decoder<'b>) -> Result<&'b str, DecodeError> {
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::String => d.str().map_err(DecodeError::from_minicbor),
        other => Err(DecodeError::UnexpectedType {
            expected: "text map key",
            found: other.to_string(),
        }),
    }
}

/// A text-string value.
pub(crate) fn text_value(d: &mut Decoder<'_>) -> Result<String, DecodeError> {
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::String => Ok(d.str().map_err(DecodeError::from_minicbor)?.to_owned()),
        other => Err(DecodeError::UnexpectedType {
            expected: "text string",
            found: other.to_string(),
        }),
    }
}

/// A byte-string value.
pub(crate) fn bytes_value(d: &mut Decoder<'_>) -> Result<Vec<u8>, DecodeError> {
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::Bytes => Ok(d.bytes().map_err(DecodeError::from_minicbor)?.to_vec()),
        other => Err(DecodeError::UnexpectedType {
            expected: "byte string",
            found: other.to_string(),
        }),
    }
}

/// An unsigned integer value (any minimal head width).
pub(crate) fn uint_value(d: &mut Decoder<'_>) -> Result<u64, DecodeError> {
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => d.u64().map_err(DecodeError::from_minicbor),
        other => Err(DecodeError::UnexpectedType {
            expected: "unsigned integer",
            found: other.to_string(),
        }),
    }
}

/// A signed-or-unsigned integer value within i64 range.
pub(crate) fn int_value(d: &mut Decoder<'_>) -> Result<i64, DecodeError> {
    match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::U8 | Type::U16 | Type::U32 | Type::U64 => {
            let v = d.u64().map_err(DecodeError::from_minicbor)?;
            i64::try_from(v)
                .map_err(|_| DecodeError::Constraint("integer above i64::MAX where int expected"))
        }
        Type::I8 | Type::I16 | Type::I32 | Type::I64 | Type::Int => {
            d.i64().map_err(DecodeError::from_minicbor)
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
