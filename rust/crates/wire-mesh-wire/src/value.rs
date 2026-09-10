//! A small purpose-built CBOR DOM for every CDDL `any` and open-map position
//! in the wire-mesh schema: handshake `params`, manage-ok's open tail,
//! token-claims extension claims, cose-token-headers extra labels, and the
//! `$manage-command-params` catch-all.
//!
//! The DOM exists because the schema's open positions must round-trip
//! byte-exactly under RFC 8949 4.2 core deterministic encoding (CDE), whose
//! map key order is length-first-then-bytewise on the *encoded* key. A plain
//! `BTreeMap<String, _>` lexicographic order is not that order (`"b"` sorts
//! before `"ab"` bytewise but after it length-first), and header labels can
//! be integers, whose one-byte encodings sort before every two-byte text
//! key. [`CanonicalMap`] therefore keeps entries sorted by encoded key
//! length first, then bytewise on the encoded key, computed via
//! [`CdeKey::encoded`].

use minicbor::data::Type;
use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;

/// Head (type-and-argument) length in bytes of a CBOR integer argument
/// `n` encoded with a minimal-length argument, per RFC 8949 4.2.1.
/// Referenced by tests to pin that hand-computed head lengths match what
/// minicbor actually writes.
#[cfg(test)]
const fn minimal_head_len(n: u64) -> usize {
    if n < 24 {
        1
    } else if n < 0x100 {
        2
    } else if n < 0x1_0000 {
        3
    } else if n < 0x1_0000_0000 {
        5
    } else {
        9
    }
}

/// The encoded bytes of a map key, used for CDE ordering and equality.
pub trait CdeKey {
    /// Append the full CBOR encoding of this key (head and any content) to
    /// `out`.
    fn write_key<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
    ) -> Result<(), minicbor::encode::Error<W::Error>>;

    /// Full encoded key bytes. Allocated only when ordering maps by key;
    /// all wire-mesh open maps are small.
    fn encoded(&self) -> Vec<u8> {
        let mut buf = Vec::new();
        let mut e = Encoder::new(&mut buf);
        // Every CdeKey impl writes a single definite-length head plus
        // content and cannot fail on a Vec writer.
        self.write_key(&mut e)
            .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        buf
    }
}

/// RFC 8949 4.2.1 core deterministic ordering of two encoded keys:
/// shorter encoded key first, then bytewise.
fn cde_cmp(a: &[u8], b: &[u8]) -> core::cmp::Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

impl CdeKey for String {
    fn write_key<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.str(self).map(|_| ())
    }
}

impl CdeKey for str {
    fn write_key<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.str(self).map(|_| ())
    }
}

impl CdeKey for minicbor::data::Int {
    fn write_key<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.int(*self).map(|_| ())
    }
}

/// A COSE header map label: `int / tstr` per `tokens.cddl`'s
/// `cose-header-label`. Integer labels 1 and 4 are the RFC 9052 `alg` and
/// `kid` labels; a *text* "1"/"4" is a distinct key from integer 1/4 (they
/// encode differently), and both forms are accepted on decode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeaderLabel {
    Int(i64),
    Text(String),
}

impl HeaderLabel {
    /// The RFC 9052 common header label `alg` (1).
    pub const ALG: i64 = 1;
    /// The RFC 9052 common header label `kid` (4).
    pub const KID: i64 = 4;

    /// Decode a header label, rejecting every CBOR type outside
    /// `int / tstr`.
    pub fn decode_strict(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        match d.datatype().map_err(DecodeError::from_minicbor)? {
            Type::U8 | Type::U16 | Type::U32 | Type::U64 => {
                let v = d.u64().map_err(DecodeError::from_minicbor)?;
                i64::try_from(v)
                    .map(HeaderLabel::Int)
                    .map_err(|_| DecodeError::Constraint("header label out of i64 range"))
            }
            Type::I8 | Type::I16 | Type::I32 | Type::I64 | Type::Int => Ok(HeaderLabel::Int(
                d.i64().map_err(DecodeError::from_minicbor)?,
            )),
            Type::String => Ok(HeaderLabel::Text(
                d.str().map_err(DecodeError::from_minicbor)?.to_owned(),
            )),
            other => Err(DecodeError::UnexpectedType {
                expected: "int or tstr header label",
                found: other.to_string(),
            }),
        }
    }
}

impl CdeKey for HeaderLabel {
    fn write_key<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        match self {
            HeaderLabel::Int(v) => e.i64(*v).map(|_| ()),
            HeaderLabel::Text(s) => e.str(s).map(|_| ()),
        }
    }
}

/// A map whose entries are kept in RFC 8949 4.2.1 core deterministic
/// encoded-key order (encoded length first, then bytewise), so encoding is
/// canonical by construction.
///
/// Inserting a duplicate key is an error rather than a replace: duplicate
/// keys are not valid CBOR, let alone valid CDE, and silently replacing
/// would let a non-canonical input decode without complaint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalMap<K, V> {
    entries: Vec<(K, V)>,
}

/// Unconditional (no `K: Default` bound): an empty map is default for any
/// key type, including `HeaderLabel` and `CborValue`, which have no
/// natural default of their own.
impl<K, V> Default for CanonicalMap<K, V> {
    fn default() -> Self {
        CanonicalMap {
            entries: Vec::new(),
        }
    }
}

impl<K: CdeKey, V> CanonicalMap<K, V> {
    pub fn new() -> Self {
        CanonicalMap {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Insert `key`/`value`, keeping CDE order. Errors on a duplicate key.
    pub fn insert(&mut self, key: K, value: V) -> Result<(), DecodeError> {
        let encoded = key.encoded();
        let idx = self
            .entries
            .binary_search_by(|(k, _)| cde_cmp(&k.encoded(), &encoded));
        match idx {
            Ok(_) => Err(DecodeError::DuplicateKey),
            Err(pos) => {
                self.entries.insert(pos, (key, value));
                Ok(())
            }
        }
    }

    /// Look up an exact key.
    pub fn get(&self, key: &K) -> Option<&V> {
        let encoded = key.encoded();
        self.entries
            .binary_search_by(|(k, _)| cde_cmp(&k.encoded(), &encoded))
            .ok()
            .map(|idx| &self.entries[idx].1)
    }

    /// Iterate entries in CDE order.
    pub fn iter(&self) -> core::slice::Iter<'_, (K, V)> {
        self.entries.iter()
    }
}

impl<K: CdeKey, V> IntoIterator for CanonicalMap<K, V> {
    type Item = (K, V);
    type IntoIter = std::vec::IntoIter<(K, V)>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.into_iter()
    }
}

/// Builds a CBOR map from typed fields plus optional open-tail entries,
/// ordering the result by CDE encoded-key order regardless of insertion
/// order.
///
/// This is the encode-side counterpart of [`CanonicalMap`] for structures
/// whose values are typed (a `DeviceId`, an `IdentityKey`, a nested map)
/// rather than [`CborValue`]s: each field is encoded into a scratch buffer,
/// the buffers are sorted by their encoded keys, and the whole map is
/// written in one pass. Used wherever a CDDL rule pairs mandatory fields
/// with a `* tstr => any` or `* cose-header-label => any` tail, where a
/// fixed field write order could not be CDE by construction (a two-byte
/// extension key sorts before "expires", a text "1" label after integer 1).
pub struct CdeMapBuilder {
    entries: Vec<(Vec<u8>, Vec<u8>)>,
}

impl Default for CdeMapBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl CdeMapBuilder {
    pub fn new() -> Self {
        CdeMapBuilder {
            entries: Vec::new(),
        }
    }

    /// Add a field. The value is encoded immediately into a scratch buffer.
    pub fn push<K: CdeKey + ?Sized, V: Encode<()> + ?Sized>(&mut self, key: &K, value: &V) {
        let mut buf = Vec::new();
        let mut e = Encoder::new(&mut buf);
        // Vec writes are infallible and every wire Encode impl can only
        // fail through its writer.
        value
            .encode(&mut e, &mut ())
            .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        self.entries.push((key.encoded(), buf));
    }

    /// Add a byte-string field. Distinct from [`push`](Self::push) because
    /// minicbor deliberately has no `Encode` impl for `&[u8]` as a byte
    /// string (its generic slice impls encode `[T]` as a CBOR array), so
    /// byte-valued fields must go through `Encoder::bytes` explicitly.
    pub fn push_bytes<K: CdeKey + ?Sized>(&mut self, key: &K, value: &[u8]) {
        let mut buf = Vec::new();
        Encoder::new(&mut buf)
            .bytes(value)
            .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        self.entries.push((key.encoded(), buf));
    }

    /// Add an already-encoded open-tail entry.
    pub fn push_raw(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.entries.push((key, value));
    }

    /// Write the assembled map in CDE key order.
    pub fn write<W: minicbor::encode::Write>(
        self,
        e: &mut Encoder<W>,
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let mut entries = self.entries;
        entries.sort_by(|(a, _), (b, _)| cde_cmp(a, b));
        e.map(entries.len() as u64)?;
        for (key, value) in &entries {
            e.writer_mut()
                .write_all(key)
                .map_err(minicbor::encode::Error::write)?;
            e.writer_mut()
                .write_all(value)
                .map_err(minicbor::encode::Error::write)?;
        }
        e.ok()
    }
}

/// The CBOR value DOM for `any` positions.
///
/// Covers exactly the value space any wire-mesh structure can contain:
/// null, bool, definite integers, byte strings, text strings, arrays, and
/// maps. Floats, tags, `undefined`, and indefinite-length items are
/// rejected on decode (they appear nowhere in the schema and cannot be
/// re-encoded canonically from this DOM), which keeps decode/encode
/// byte-exact for every well-formed CDE input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CborValue {
    Null,
    Bool(bool),
    /// A negative-or-i64-range integer. Always encoded with a minimal head.
    Int(i64),
    /// A non-negative integer, including values above `i64::MAX`.
    UInt(u64),
    Bytes(Vec<u8>),
    Text(String),
    Array(Vec<CborValue>),
    Map(CanonicalMap<CborValue, CborValue>),
}

impl CdeKey for CborValue {
    fn write_key<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        self.encode(e, &mut ()).map(|_| ())
    }
}

impl CborValue {
    /// Decode a `CborValue` with strict CDE-shape rules.
    pub fn decode_strict(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let ty = d.datatype().map_err(DecodeError::from_minicbor)?;
        match ty {
            Type::Null => {
                d.null().map_err(DecodeError::from_minicbor)?;
                Ok(CborValue::Null)
            }
            Type::Bool => Ok(CborValue::Bool(d.bool().map_err(DecodeError::from_minicbor)?)),
            Type::U8 | Type::U16 | Type::U32 | Type::U64 => {
                Ok(CborValue::UInt(d.u64().map_err(DecodeError::from_minicbor)?))
            }
            Type::I8 | Type::I16 | Type::I32 | Type::I64 | Type::Int => {
                Ok(CborValue::Int(d.i64().map_err(DecodeError::from_minicbor)?))
            }
            Type::Bytes => Ok(CborValue::Bytes(
                d.bytes().map_err(DecodeError::from_minicbor)?.to_vec(),
            )),
            Type::String => Ok(CborValue::Text(
                d.str().map_err(DecodeError::from_minicbor)?.to_owned(),
            )),
            Type::Array => {
                let n = d.array().map_err(DecodeError::from_minicbor)?.ok_or(DecodeError::IndefiniteLength)?;
                let mut items = Vec::with_capacity(usize::try_from(n).map_err(|_| DecodeError::Constraint("array too large"))?);
                for _ in 0..n {
                    items.push(CborValue::decode_strict(d)?);
                }
                Ok(CborValue::Array(items))
            }
            Type::Map => {
                let n = d.map().map_err(DecodeError::from_minicbor)?.ok_or(DecodeError::IndefiniteLength)?;
                let mut map = CanonicalMap::new();
                for _ in 0..n {
                    let key = CborValue::decode_strict(d)?;
                    let value = CborValue::decode_strict(d)?;
                    map.insert(key, value)?;
                }
                Ok(CborValue::Map(map))
            }
            other => Err(DecodeError::UnexpectedType {
                expected: "a CDE-compatible CBOR value (no floats, tags, undefined, or indefinite lengths)",
                found: other.to_string(),
            }),
        }
    }
}

impl Encode<()> for CborValue {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        match self {
            CborValue::Null => e.null()?.ok(),
            CborValue::Bool(b) => e.bool(*b)?.ok(),
            CborValue::Int(v) => e.i64(*v)?.ok(),
            CborValue::UInt(v) => e.u64(*v)?.ok(),
            CborValue::Bytes(b) => e.bytes(b)?.ok(),
            CborValue::Text(s) => e.str(s)?.ok(),
            CborValue::Array(items) => {
                e.array(items.len() as u64)?;
                for item in items {
                    item.encode(e, &mut ())?;
                }
                e.ok()
            }
            CborValue::Map(map) => {
                e.map(map.len() as u64)?;
                for (k, v) in map.iter() {
                    k.encode(e, &mut ())?;
                    v.encode(e, &mut ())?;
                }
                e.ok()
            }
        }
    }
}

impl Decode<'_, ()> for CborValue {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        CborValue::decode_strict(d).map_err(minicbor::decode::Error::custom)
    }
}

/// A helper for building text-keyed canonical maps in tests and downstream
/// code without repeating the fallible-insert dance for known-unique keys.
impl FromIterator<(String, CborValue)> for CanonicalMap<String, CborValue> {
    fn from_iter<T: IntoIterator<Item = (String, CborValue)>>(iter: T) -> Self {
        let mut map: CanonicalMap<String, CborValue> = CanonicalMap::new();
        for (k, v) in iter {
            // FromIterator has no way to report a duplicate; a duplicate here is a programming error in the caller building a literal map, so keep the last value rather than panic.
            let encoded = k.encoded();
            match map
                .entries
                .binary_search_by(|(key, _)| cde_cmp(&key.encoded(), &encoded))
            {
                Ok(idx) => map.entries[idx].1 = v,
                Err(pos) => map.entries.insert(pos, (k, v)),
            }
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode_value(v: &CborValue) -> Vec<u8> {
        minicbor::to_vec(v).expect("encoding a CborValue to a Vec cannot fail")
    }

    /// CDE orders map keys by encoded length first, then bytewise on the
    /// encoded key. "b" encodes to 2 bytes and "a-longer-text-key" to 18,
    /// so "b" sorts first regardless of lexicographic position; a plain
    /// BTreeMap would agree here but diverge on int-vs-text labels and on
    /// multi-byte text heads, which `int_labels_sort_before_text_labels`
    /// pins separately.
    #[test]
    fn canonical_map_orders_length_first() {
        let mut map = CanonicalMap::new();
        map.insert("a-longer-text-key".to_owned(), CborValue::UInt(1))
            .expect("unique keys");
        map.insert("b".to_owned(), CborValue::UInt(2))
            .expect("unique keys");
        let keys: Vec<&String> = map.iter().map(|(k, _)| k).collect();
        assert_eq!(keys, [&"b".to_owned(), &"a-longer-text-key".to_owned()]);
    }

    #[test]
    fn canonical_map_rejects_duplicates() {
        let mut map = CanonicalMap::new();
        map.insert("x".to_owned(), CborValue::UInt(1))
            .expect("unique keys");
        assert_eq!(
            map.insert("x".to_owned(), CborValue::UInt(2)),
            Err(DecodeError::DuplicateKey)
        );
    }

    #[test]
    fn int_labels_sort_before_text_labels() {
        let mut map: CanonicalMap<HeaderLabel, CborValue> = CanonicalMap::new();
        map.insert(HeaderLabel::Text("1".to_owned()), CborValue::Int(-7))
            .expect("unique keys");
        map.insert(HeaderLabel::Text("zz".to_owned()), CborValue::UInt(1))
            .expect("unique keys");
        map.insert(HeaderLabel::Int(1), CborValue::Int(-7))
            .expect("unique keys");
        let encoded: Vec<u8> = {
            let mut buf = Vec::new();
            let mut e = Encoder::new(&mut buf);
            for (k, v) in map.iter() {
                k.write_key(&mut e).expect("write");
                v.encode(&mut e, &mut ()).expect("write");
            }
            buf
        };
        // Integer label 1 encodes as a single 0x01 byte and sorts first, before the two-byte text keys (0x61 '1' and 0x62 'z' 'z').
        assert_eq!(
            encoded,
            vec![0x01, 0x26, 0x61, b'1', 0x26, 0x62, b'z', b'z', 0x01]
        );
    }

    #[test]
    fn cbor_value_round_trips_nested_map() {
        let mut inner = CanonicalMap::new();
        inner
            .insert(
                CborValue::Text("k".to_owned()),
                CborValue::Bytes(vec![1, 2, 3]),
            )
            .expect("unique");
        let value = CborValue::Map({
            let mut outer = CanonicalMap::new();
            outer
                .insert(CborValue::Text("nested".to_owned()), CborValue::Map(inner))
                .expect("unique");
            outer
                .insert(CborValue::UInt(42), CborValue::Null)
                .expect("unique");
            outer
        });
        let bytes = encode_value(&value);
        let back: CborValue = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, value);
        assert_eq!(encode_value(&back), bytes);
    }

    #[test]
    fn cbor_value_rejects_floats_tags_and_indefinites() {
        // 0xf9 0x3c 0x00 = float16 1.0
        assert!(minicbor::decode::<CborValue>(&[0xf9, 0x3c, 0x00]).is_err());
        // 0xc0 0x01 = tag 0 on 1
        assert!(minicbor::decode::<CborValue>(&[0xc0, 0x01]).is_err());
        // 0x9f 0x01 0xff = indefinite array
        assert!(minicbor::decode::<CborValue>(&[0x9f, 0x01, 0xff]).is_err());
        // 0xf7 = undefined
        assert!(minicbor::decode::<CborValue>(&[0xf7]).is_err());
    }

    #[test]
    fn uint_above_i64_max_round_trips() {
        let value = CborValue::UInt(u64::MAX);
        let bytes = encode_value(&value);
        assert_eq!(bytes[0], 0x1b);
        let back: CborValue = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, value);
    }

    #[test]
    fn minimal_head_len_matches_minicbor() {
        for n in [
            0u64,
            23,
            24,
            255,
            256,
            65535,
            65536,
            u32::MAX as u64,
            u32::MAX as u64 + 1,
            u64::MAX,
        ] {
            let mut buf = Vec::new();
            Encoder::new(&mut buf).u64(n).expect("write");
            assert_eq!(buf.len(), minimal_head_len(n), "head length for {n}");
        }
    }
}
