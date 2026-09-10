//! Error types for the wire codec.

use core::fmt;

/// Failure to decode a wire value.
///
/// Decoding is strict by design: it rejects unknown map keys, wrong map
/// arity, indefinite-length items (RFC 8949 4.2 core deterministic encoding
/// requires definite lengths), non-minimal head widths, map keys out of CDE
/// order (including duplicates), floats, tags, non-32-byte device-ids, bad
/// enum literals, and trailing bytes after a top-level item — so any input
/// that decodes also re-encodes to the identical bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// A map key that no CDDL rule in the corresponding family defines.
    UnknownKey(String),
    /// A mandatory field of a map is absent.
    MissingField(&'static str),
    /// A map or array head declared a different arity than the rule allows.
    WrongArity { expected: u64, found: u64 },
    /// An indefinite-length item where CDE requires a definite one.
    IndefiniteLength,
    /// A duplicate key within a single map.
    DuplicateKey,
    /// A head (integer, string, bytes, map, or array) not in shortest CBOR
    /// form, which RFC 8949 4.2.1 core deterministic encoding requires.
    NonMinimalHead,
    /// Map keys not in RFC 8949 4.2.1 core deterministic order
    /// (encoded-length first, then bytewise).
    UnsortedMapKeys,
    /// A value of the wrong CBOR type or shape for the field.
    UnexpectedType {
        expected: &'static str,
        found: String,
    },
    /// A fixed-size field (e.g. `device-id`) of the wrong byte length.
    InvalidLength {
        field: &'static str,
        expected: usize,
        found: usize,
    },
    /// An enum literal that is not part of the closed union.
    BadLiteral {
        expected: &'static str,
        found: String,
    },
    /// Bytes remained after the top-level item.
    TrailingBytes { consumed: usize, total: usize },
    /// A bool/uint/int constraint from the CDDL failed on the decoded value.
    Constraint(&'static str),
    /// Anything else, including malformed CBOR from the underlying decoder.
    Malformed(String),
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::UnknownKey(k) => write!(f, "unknown map key {k:?}"),
            DecodeError::MissingField(name) => write!(f, "missing mandatory field {name:?}"),
            DecodeError::WrongArity { expected, found } => {
                write!(f, "expected {expected} items, found {found}")
            }
            DecodeError::IndefiniteLength => {
                write!(
                    f,
                    "indefinite-length item rejected (CDE requires definite lengths)"
                )
            }
            DecodeError::DuplicateKey => write!(f, "duplicate map key"),
            DecodeError::NonMinimalHead => {
                write!(
                    f,
                    "head not in shortest form (CDE requires minimal-width encodings)"
                )
            }
            DecodeError::UnsortedMapKeys => {
                write!(
                    f,
                    "map keys not in CDE order (encoded-length first, then bytewise)"
                )
            }
            DecodeError::UnexpectedType { expected, found } => {
                write!(f, "expected {expected}, found {found}")
            }
            DecodeError::InvalidLength {
                field,
                expected,
                found,
            } => {
                write!(f, "field {field} must be {expected} bytes, found {found}")
            }
            DecodeError::BadLiteral { expected, found } => {
                write!(f, "expected literal {expected}, found {found}")
            }
            DecodeError::TrailingBytes { consumed, total } => {
                write!(
                    f,
                    "{consumed} of {total} bytes consumed, trailing bytes remain"
                )
            }
            DecodeError::Constraint(what) => write!(f, "constraint violated: {what}"),
            DecodeError::Malformed(msg) => write!(f, "malformed CBOR: {msg}"),
        }
    }
}

impl std::error::Error for DecodeError {}

impl DecodeError {
    /// Map an underlying `minicbor` decode error into a [`DecodeError`].
    pub fn from_minicbor(err: minicbor::decode::Error) -> Self {
        DecodeError::Malformed(err.to_string())
    }
}

/// Failure to encode a wire value.
///
/// Encoding a well-formed wire value cannot fail in practice (the types make
/// invalid states unrepresentable); this type exists so the codec's entry
/// points can surface writer errors without panicking.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EncodeError {
    /// The underlying writer failed.
    Write(String),
}

impl fmt::Display for EncodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EncodeError::Write(msg) => write!(f, "write failed: {msg}"),
        }
    }
}

impl std::error::Error for EncodeError {}

impl From<minicbor::encode::Error<std::io::Error>> for EncodeError {
    fn from(err: minicbor::encode::Error<std::io::Error>) -> Self {
        EncodeError::Write(err.to_string())
    }
}
