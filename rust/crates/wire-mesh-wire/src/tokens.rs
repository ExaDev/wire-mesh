//! `tokens.cddl` — capability verbs, scopes, and signed capability tokens.
//!
//! [`CoseSign1`] is the literal RFC 9052 §4.2 four-element array, not a
//! bespoke struct, so signing and verification can use off-the-shelf COSE
//! maths over it. `protected` and `payload` stay opaque `Vec<u8>` on the
//! wire type: the nested `.cbor` content is parsed on demand by domain code
//! via [`CoseSign1::decode_protected`] / [`CoseSign1::decode_claims`],
//! which decode strictly and must re-encode identically under CDE (pinned
//! by tests against the frozen conformance vectors).

use minicbor::data::Type;
use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{DeviceId, IdentityKey};
use crate::strict;
use crate::value::{CanonicalMap, CborValue, CdeKey, CdeMapBuilder, HeaderLabel};

/// Why a capability verb is not valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerbError {
    /// No colon separating subsystem/registrant from action, or more than
    /// one.
    BadShape,
    /// The verb matches no tier's grammar.
    Malformed(String),
}

impl core::fmt::Display for VerbError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            VerbError::BadShape => write!(f, "a capability verb is '<subsystem>:<action>'"),
            VerbError::Malformed(v) => write!(
                f,
                "verb {v:?} matches no core, namespaced, or private-use tier"
            ),
        }
    }
}

impl std::error::Error for VerbError {}

/// `capability-verb = core-capability / namespaced-capability / private-use-capability`,
/// a validated string newtype like `DomainId`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CapabilityVerb(pub String);

impl CapabilityVerb {
    /// Validate against the three tiers from `tokens.cddl`.
    ///
    /// - core: `[a-z][a-z0-9-]*:[a-z][a-z0-9-]*`
    /// - namespaced: `[a-z0-9.-]+/[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+`
    /// - private-use: `x-[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+`
    pub fn validate(verb: &str) -> Result<(), VerbError> {
        let Some((head, action)) = verb.split_once(':') else {
            return Err(VerbError::BadShape);
        };
        let action_ok = |a: &str| {
            !a.is_empty()
                && a.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        };
        let loose_ok = |a: &str| {
            !a.is_empty()
                && a.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
        };
        // core tier
        let head_core_ok = |h: &str| {
            let bytes = h.as_bytes();
            !bytes.is_empty()
                && bytes[0].is_ascii_lowercase()
                && bytes[1..]
                    .iter()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        };
        if head_core_ok(head) && action_ok(action) {
            return Ok(());
        }
        // namespaced tier
        if let Some((registrant, local)) = head.split_once('/') {
            let registrant_ok = !registrant.is_empty()
                && registrant.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-'
                });
            if registrant_ok && loose_ok(local) && loose_ok(action) {
                return Ok(());
            }
        }
        // private-use tier
        if let Some(rest) = head.strip_prefix("x-") {
            if loose_ok(rest) && loose_ok(action) {
                return Ok(());
            }
        }
        Err(VerbError::Malformed(verb.to_owned()))
    }
}

/// Why a scope is not valid.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScopeError {
    /// `kind` is empty: a zero-length kind names no scope.
    EmptyKind,
    /// `path` is present but empty: an absent path already means the kind's
    /// whole-scope root, so a present-but-empty path is meaningless.
    EmptyPath,
}

impl core::fmt::Display for ScopeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ScopeError::EmptyKind => write!(f, "capability scope kind must be non-empty"),
            ScopeError::EmptyPath => write!(f, "capability scope path must be non-empty when present (absent means the whole-scope root)"),
        }
    }
}

impl std::error::Error for ScopeError {}

/// `capability-scope = { kind: tstr, ? path: tstr }`. `kind` is open on
/// purpose; `path` absent means the kind's whole-scope root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityScope {
    pub kind: String,
    pub path: Option<String>,
}

impl CapabilityScope {
    pub fn validate(&self) -> Result<(), ScopeError> {
        if self.kind.is_empty() {
            return Err(ScopeError::EmptyKind);
        }
        if self.path.as_deref() == Some("") {
            return Err(ScopeError::EmptyPath);
        }
        Ok(())
    }

    /// Does this scope narrow `parent` (same kind, path within the
    /// parent's subtree)? A delegated token's scope must satisfy this
    /// against its parent's scope; a root token has no parent and any
    /// scope.
    ///
    /// Comparison is on `/`-segment boundaries: `/work/sub` narrows
    /// `/work`, but `/workbook` does not despite the string prefix. A path
    /// containing a `.` or `..` segment never narrows anything: purely
    /// lexical comparison would let `/work/../org` pass under `/work` — a
    /// path that normalises outside the parent — so any relative segment
    /// fails the comparison wholesale. Fail closed rather than
    /// reimplementing path normalisation, matching the TS core's verifier.
    pub fn is_within(&self, parent: &CapabilityScope) -> bool {
        if self.kind != parent.kind {
            return false;
        }
        let Some(parent_path) = &parent.path else {
            return true;
        };
        let Some(path) = &self.path else {
            return false;
        };
        if has_relative_segment(path) || has_relative_segment(parent_path) {
            return false;
        }
        path == parent_path || path.starts_with(&format!("{parent_path}/"))
    }
}

/// True when the path contains a `.` or `..` segment. See
/// [`CapabilityScope::is_within`] for why such paths never narrow.
fn has_relative_segment(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment == "." || segment == "..")
}

impl Encode<()> for CapabilityScope {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 1 + usize::from(self.path.is_some());
        e.map(len as u64)?;
        e.str("kind")?.str(&self.kind)?;
        if let Some(path) = &self.path {
            e.str("path")?.str(path)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for CapabilityScope {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        scope_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn scope_from(d: &mut Decoder<'_>) -> Result<CapabilityScope, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut kind: Option<String> = None;
    let mut path: Option<String> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "kind" => strict::set_once(&mut kind, strict::text_value(d)?)?,
            "path" => strict::set_once(&mut path, strict::text_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(CapabilityScope {
        kind: kind.ok_or(DecodeError::MissingField("kind"))?,
        path,
    })
}

/// `cose-token-headers = { ? 1 => int, ? 4 => bstr, * cose-header-label => any }`.
///
/// The typed `alg`/`kid` fields are populated only from the *integer*
/// labels 1 and 4. A text "1"/"4" key is a distinct CBOR key from integer
/// 1/4 (they encode differently), so on decode it is preserved verbatim in
/// `extra` — which is also what makes re-encoding byte-exact for the
/// frozen vectors, whose protected headers carry the text-key form. The
/// [`CoseTokenHeaders::alg`] and [`CoseTokenHeaders::kid`] accessors accept
/// both forms.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CoseTokenHeaders {
    pub alg: Option<i64>,
    pub kid: Option<Vec<u8>>,
    pub extra: CanonicalMap<HeaderLabel, CborValue>,
}

impl CoseTokenHeaders {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `alg` header, accepting either key form: integer label 1 (the
    /// RFC 9052 form) or text "1" (the form the frozen vectors encode).
    pub fn alg(&self) -> Option<i64> {
        if let Some(alg) = self.alg {
            return Some(alg);
        }
        match self.extra.get(&HeaderLabel::Text("1".to_owned())) {
            Some(CborValue::Int(v)) => Some(*v),
            Some(CborValue::UInt(v)) => i64::try_from(*v).ok(),
            _ => None,
        }
    }

    /// The `kid` header, accepting either key form. Integer label 4 first.
    pub fn kid(&self) -> Option<&[u8]> {
        if let Some(kid) = &self.kid {
            return Some(kid);
        }
        match self.extra.get(&HeaderLabel::Text("4".to_owned())) {
            Some(CborValue::Bytes(b)) => Some(b),
            _ => None,
        }
    }
}

impl Encode<()> for CoseTokenHeaders {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        // Typed fields and the open tail must be ordered together by CDE
        // encoded-key order (an integer label 2 sorts between labels 1 and
        // 4; a one-char text label sorts after integer labels but before
        // longer ones), so assemble through the builder rather than
        // writing fields then tail.
        let mut builder = CdeMapBuilder::new();
        if let Some(alg) = self.alg {
            builder.push(&HeaderLabel::Int(HeaderLabel::ALG), &alg);
        }
        if let Some(kid) = &self.kid {
            builder.push_bytes(&HeaderLabel::Int(HeaderLabel::KID), kid);
        }
        for (label, value) in self.extra.iter() {
            let mut key_buf = Vec::new();
            let mut key_enc = Encoder::new(&mut key_buf);
            label
                .write_key(&mut key_enc)
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
            let mut value_buf = Vec::new();
            let mut value_enc = Encoder::new(&mut value_buf);
            value
                .encode(&mut value_enc, &mut ())
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
            builder.push_raw(key_buf, value_buf);
        }
        builder.write(e)
    }
}

impl Decode<'_, ()> for CoseTokenHeaders {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        headers_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn headers_from(d: &mut Decoder<'_>) -> Result<CoseTokenHeaders, DecodeError> {
    // Header labels are `int / tstr`, not the text keys MapDecoder reads, so this loop orders raw label encodings through KeyOrder directly.
    let n = strict::definite_map(d)?;
    let mut order = strict::KeyOrder::new();
    let mut headers = CoseTokenHeaders::new();
    for _ in 0..n {
        let label = HeaderLabel::decode_strict(d)?;
        order.push(&label.encoded())?;
        match label {
            HeaderLabel::Int(HeaderLabel::ALG) => {
                strict::set_once(&mut headers.alg, strict::int_value(d)?)?;
            }
            HeaderLabel::Int(HeaderLabel::KID) => {
                strict::set_once(&mut headers.kid, strict::bytes_value(d)?)?;
            }
            label => {
                let value = CborValue::decode_strict(d)?;
                headers.extra.insert(label, value)?;
            }
        }
    }
    Ok(headers)
}

/// The literal RFC 9052 §4.2 `COSE_Sign1` four-element array.
///
/// `protected` is the encoded protected-header map (the content of the
/// first array element's bstr), `payload` the signed content (`None` for
/// the CDDL's `bstr / nil` nil case; always `Some` for a capability
/// token), both opaque at this layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoseSign1 {
    pub protected: Vec<u8>,
    pub unprotected: CoseTokenHeaders,
    pub payload: Option<Vec<u8>>,
    pub signature: Vec<u8>,
}

impl CoseSign1 {
    /// Strictly decode a `COSE_Sign1` from a complete byte string,
    /// rejecting trailing bytes.
    pub fn decode_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut d = Decoder::new(bytes);
        let value = cose_sign1_from(&mut d)?;
        if d.position() != bytes.len() {
            return Err(DecodeError::TrailingBytes {
                consumed: d.position(),
                total: bytes.len(),
            });
        }
        Ok(value)
    }

    /// Encode to bytes.
    pub fn encode_to_vec(&self) -> Vec<u8> {
        minicbor::to_vec(self).unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"))
    }

    /// Parse the protected header map on demand. The frozen vectors' text
    /// "1"/"4" key quirk is preserved verbatim by [`CoseTokenHeaders`].
    pub fn decode_protected(&self) -> Result<CoseTokenHeaders, DecodeError> {
        let mut d = Decoder::new(&self.protected);
        let headers = headers_from(&mut d)?;
        if d.position() != self.protected.len() {
            return Err(DecodeError::TrailingBytes {
                consumed: d.position(),
                total: self.protected.len(),
            });
        }
        Ok(headers)
    }

    /// Parse the payload as `token-claims` on demand.
    pub fn decode_claims(&self) -> Result<TokenClaims, DecodeError> {
        let payload = self
            .payload
            .as_deref()
            .ok_or(DecodeError::Constraint("token payload is nil"))?;
        TokenClaims::decode_bytes(payload)
    }

    /// Parse the payload as `handle-claims` (discovery.cddl) on demand.
    pub fn decode_handle_claims(&self) -> Result<crate::discovery::HandleClaims, DecodeError> {
        let payload = self
            .payload
            .as_deref()
            .ok_or(DecodeError::Constraint("handle-record payload is nil"))?;
        crate::discovery::HandleClaims::decode_bytes(payload)
    }
}

impl Encode<()> for CoseSign1 {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.array(4)?;
        e.bytes(&self.protected)?;
        self.unprotected.encode(e, &mut ())?;
        match &self.payload {
            Some(payload) => e.bytes(payload)?,
            None => e.null()?,
        };
        e.bytes(&self.signature)?;
        e.ok()
    }
}

impl Decode<'_, ()> for CoseSign1 {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        cose_sign1_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn cose_sign1_from(d: &mut Decoder<'_>) -> Result<CoseSign1, DecodeError> {
    let arity = strict::definite_array(d)?;
    if arity != 4 {
        return Err(DecodeError::WrongArity {
            expected: 4,
            found: arity,
        });
    }
    let protected = strict::bytes_value(d)?;
    let unprotected = headers_from(d)?;
    let payload = match d.datatype().map_err(DecodeError::from_minicbor)? {
        Type::Bytes => Some(strict::bytes_value(d)?),
        Type::Null => {
            d.null().map_err(DecodeError::from_minicbor)?;
            None
        }
        other => {
            return Err(DecodeError::UnexpectedType {
                expected: "byte string or null payload",
                found: other.to_string(),
            })
        }
    };
    let signature = strict::bytes_value(d)?;
    Ok(CoseSign1 {
        protected,
        unprotected,
        payload,
        signature,
    })
}

/// `capability-token = cose-sign1`.
pub type CapabilityToken = CoseSign1;

/// `token-claims` — the signed payload of a capability token.
///
/// CDE key order over the full key set (typed fields plus the open `* tstr
/// => any` tail) is computed by the encoder: `scope` (6 encoded bytes),
/// `bearer`/`issuer`/`parent` (7), `expires` (8), `token-id` (9),
/// `capability`/`issuer-key`/`not-before` (11), with any extension claim
/// interleaved by its own encoded length.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenClaims {
    pub token_id: Vec<u8>,
    pub issuer: DeviceId,
    pub issuer_key: IdentityKey,
    pub bearer: DeviceId,
    pub capability: CapabilityVerb,
    pub scope: CapabilityScope,
    /// Unix ms.
    pub expires: u64,
    pub not_before: Option<u64>,
    /// `bstr .cbor capability-token` — a fully self-contained nested
    /// COSE_Sign1 of the parent token, opaque at this layer.
    pub parent: Option<Vec<u8>>,
    pub extra: CanonicalMap<String, CborValue>,
}

impl TokenClaims {
    /// Strictly decode from a complete byte string, rejecting trailing
    /// bytes.
    pub fn decode_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut d = Decoder::new(bytes);
        let claims = token_claims_from(&mut d)?;
        if d.position() != bytes.len() {
            return Err(DecodeError::TrailingBytes {
                consumed: d.position(),
                total: bytes.len(),
            });
        }
        Ok(claims)
    }

    /// Encode to bytes. Must reproduce the original payload bytes exactly
    /// for a CDE-encoded input; pinned by tests against the frozen
    /// conformance vectors.
    pub fn encode_to_vec(&self) -> Vec<u8> {
        minicbor::to_vec(self).unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"))
    }
}

impl Encode<()> for TokenClaims {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let mut builder = CdeMapBuilder::new();
        builder.push_bytes("token-id", &self.token_id);
        builder.push("issuer", &self.issuer);
        builder.push("issuer-key", &self.issuer_key);
        builder.push("bearer", &self.bearer);
        builder.push("capability", &self.capability.0.as_str());
        builder.push("scope", &self.scope);
        builder.push("expires", &self.expires);
        if let Some(not_before) = self.not_before {
            builder.push("not-before", &not_before);
        }
        if let Some(parent) = &self.parent {
            builder.push_bytes("parent", parent);
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

impl Decode<'_, ()> for TokenClaims {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        token_claims_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn token_claims_from(d: &mut Decoder<'_>) -> Result<TokenClaims, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut token_id: Option<Vec<u8>> = None;
    let mut issuer: Option<DeviceId> = None;
    let mut issuer_key: Option<IdentityKey> = None;
    let mut bearer: Option<DeviceId> = None;
    let mut capability: Option<String> = None;
    let mut scope: Option<CapabilityScope> = None;
    let mut expires: Option<u64> = None;
    let mut not_before: Option<u64> = None;
    let mut parent: Option<Vec<u8>> = None;
    let mut extra = CanonicalMap::new();
    while let Some(key) = map.next_key(d)? {
        match key {
            "token-id" => strict::set_once(&mut token_id, strict::bytes_value(d)?)?,
            "issuer" => strict::set_once(&mut issuer, crate::identity::device_id_from(d)?)?,
            "issuer-key" => {
                strict::set_once(&mut issuer_key, crate::identity::identity_key_from(d)?)?
            }
            "bearer" => strict::set_once(&mut bearer, crate::identity::device_id_from(d)?)?,
            "capability" => strict::set_once(&mut capability, strict::text_value(d)?)?,
            "scope" => strict::set_once(&mut scope, scope_from(d)?)?,
            "expires" => strict::set_once(&mut expires, strict::uint_value(d)?)?,
            "not-before" => strict::set_once(&mut not_before, strict::uint_value(d)?)?,
            "parent" => strict::set_once(&mut parent, strict::bytes_value(d)?)?,
            other => {
                let value = CborValue::decode_strict(d)?;
                extra.insert(other.to_owned(), value)?;
            }
        }
    }
    Ok(TokenClaims {
        token_id: token_id.ok_or(DecodeError::MissingField("token-id"))?,
        issuer: issuer.ok_or(DecodeError::MissingField("issuer"))?,
        issuer_key: issuer_key.ok_or(DecodeError::MissingField("issuer-key"))?,
        bearer: bearer.ok_or(DecodeError::MissingField("bearer"))?,
        capability: CapabilityVerb(capability.ok_or(DecodeError::MissingField("capability"))?),
        scope: scope.ok_or(DecodeError::MissingField("scope"))?,
        expires: expires.ok_or(DecodeError::MissingField("expires"))?,
        not_before,
        parent,
        extra,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_claims_rejects_duplicate_typed_key() {
        // { "expires": 1, "expires": 2 }: the repeated key is rejected as a
        // duplicate rather than silently taking the last value.
        let bytes = [
            0xa2, 0x67, b'e', b'x', b'p', b'i', b'r', b'e', b's', 0x01, 0x67, b'e', b'x', b'p',
            b'i', b'r', b'e', b's', 0x02,
        ];
        assert_eq!(
            TokenClaims::decode_bytes(&bytes),
            Err(DecodeError::DuplicateKey)
        );
    }

    #[test]
    fn token_claims_rejects_unsorted_keys() {
        // { "issuer": <id>, "bearer": <id> }: "bearer" (8 bytes) sorts
        // before "issuer" (9), so issuer-first is out of CDE order.
        let id = [0x11u8; 32];
        let mut bytes = vec![0xa2, 0x66];
        bytes.extend_from_slice(b"issuer");
        bytes.push(0x58);
        bytes.push(32);
        bytes.extend_from_slice(&id);
        bytes.push(0x66);
        bytes.extend_from_slice(b"bearer");
        bytes.push(0x58);
        bytes.push(32);
        bytes.extend_from_slice(&id);
        assert_eq!(
            TokenClaims::decode_bytes(&bytes),
            Err(DecodeError::UnsortedMapKeys)
        );
    }

    #[test]
    fn token_claims_rejects_non_minimal_integer_head() {
        // alg for a minimal -7 is the single byte 0x26; 0x38 0x26 is the
        // same value in a two-byte head, which CDE forbids.
        let mut bytes = vec![0xa2, 0x63];
        bytes.extend_from_slice(b"alg");
        bytes.extend_from_slice(&[0x38, 0x06]);
        bytes.push(0x6a);
        bytes.extend_from_slice(b"public-key");
        bytes.extend_from_slice(&[0x58, 0x41]);
        bytes.extend_from_slice(&[0x04; 65]);
        let mut d = Decoder::new(&bytes);
        assert_eq!(
            crate::identity::identity_key_from(&mut d),
            Err(DecodeError::NonMinimalHead)
        );
    }

    #[test]
    fn verb_tiers() {
        for verb in [
            "pin:write",
            "exec:pty",
            "exec:proc",
            "a-b:c-d",
            "example.com/rooms:list",
            "exa.dev/thing.v2:run",
            "a.b/c:x",
            "x-private:thing",
            "x-a_.-b:x_y.-z",
        ] {
            assert_eq!(CapabilityVerb::validate(verb), Ok(()), "{verb}");
        }
        for verb in [
            "nolons",
            "two:colons:here",
            "EXEC:pty",
            "exec:",
            ":exec",
            "exa.dev:run", // namespaced needs a '/' in the head
            "x-bad verb:thing",
            "-lead:action",
        ] {
            assert_ne!(CapabilityVerb::validate(verb), Ok(()), "{verb}");
        }
    }

    #[test]
    fn scope_within_narrows() {
        let root = CapabilityScope {
            kind: "folder".to_owned(),
            path: None,
        };
        let work = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/work".to_owned()),
        };
        let subdir = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/work/subdir".to_owned()),
        };
        let sibling = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/work-other".to_owned()),
        };
        let other_kind = CapabilityScope {
            kind: "node".to_owned(),
            path: Some("/work".to_owned()),
        };
        assert!(subdir.is_within(&work));
        assert!(work.is_within(&work));
        assert!(work.is_within(&root));
        assert!(
            !sibling.is_within(&work),
            "prefix must respect the segment boundary"
        );
        let escape = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/work/../org".to_owned()),
        };
        assert!(
            !escape.is_within(&work),
            "a relative segment normalises outside the parent: fail closed, not lexically"
        );
        let dot = CapabilityScope {
            kind: "folder".to_owned(),
            path: Some("/work/./sub".to_owned()),
        };
        assert!(!dot.is_within(&work), "'.' segments never narrow either");
        assert!(
            !root.is_within(&work),
            "root is wider than a path-scoped parent"
        );
        assert!(!subdir.is_within(&other_kind));
    }

    #[test]
    fn scope_validation() {
        assert_eq!(
            CapabilityScope {
                kind: "folder".to_owned(),
                path: None
            }
            .validate(),
            Ok(())
        );
        assert_eq!(
            CapabilityScope {
                kind: String::new(),
                path: None
            }
            .validate(),
            Err(ScopeError::EmptyKind)
        );
        assert_eq!(
            CapabilityScope {
                kind: "folder".to_owned(),
                path: Some(String::new())
            }
            .validate(),
            Err(ScopeError::EmptyPath)
        );
    }

    #[test]
    fn headers_accept_both_label_forms_but_reencode_only_what_was_there() {
        // Integer form round-trips as integer form.
        let headers = CoseTokenHeaders {
            alg: Some(-7),
            kid: Some(vec![0x11; 32]),
            extra: CanonicalMap::new(),
        };
        let bytes = minicbor::to_vec(&headers).expect("encode");
        let back: CoseTokenHeaders = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, headers);
        assert_eq!(bytes[1], 0x01, "alg encoded under integer label 1");

        // Text form decodes into extra, re-encodes as text, and is still readable through the accessors: {"1": -7, "4": h'11'*32}.
        let mut text_form: Vec<u8> = vec![0xa2, 0x61, b'1', 0x26, 0x61, b'4', 0x58, 0x20];
        text_form.extend(core::iter::repeat(0x11).take(32));
        let decoded: CoseTokenHeaders = minicbor::decode(&text_form).expect("decode");
        assert_eq!(decoded.alg(), Some(-7));
        assert_eq!(decoded.kid(), Some(vec![0x11; 32].as_slice()));
        assert_eq!(minicbor::to_vec(&decoded).expect("re-encode"), text_form);
    }

    #[test]
    fn cose_sign1_nil_payload_round_trip() {
        let cose = CoseSign1 {
            protected: vec![0xa0],
            unprotected: CoseTokenHeaders::new(),
            payload: None,
            signature: vec![0xff; 64],
        };
        let bytes = cose.encode_to_vec();
        assert_eq!(bytes[0], 0x84, "four-element array");
        let back = CoseSign1::decode_bytes(&bytes).expect("decode");
        assert_eq!(back, cose);
        // The nil payload encodes as 0xf6.
        assert!(bytes.contains(&0xf6));
    }

    #[test]
    fn cose_sign1_rejects_wrong_arity() {
        // Three-element array.
        let bytes = [0x83, 0x41, 0x01, 0xa0, 0x41, 0x02];
        assert!(CoseSign1::decode_bytes(&bytes).is_err());
        // Trailing bytes after the array.
        let mut with_trailer = CoseSign1 {
            protected: vec![0xa0],
            unprotected: CoseTokenHeaders::new(),
            payload: None,
            signature: vec![],
        }
        .encode_to_vec();
        with_trailer.push(0x01);
        assert!(CoseSign1::decode_bytes(&with_trailer).is_err());
    }

    #[test]
    fn token_claims_encode_matches_cde_interleaving() {
        // An extension claim with a 2-character key must sort before every
        // typed field of the frozen claims (whose shortest key, "scope",
        // encodes to 6 bytes) — impossible to express by writing typed
        // fields first and the tail after, which is why the encoder goes
        // through CdeMapBuilder.
        let mut extra = CanonicalMap::new();
        extra
            .insert("zz".to_owned(), CborValue::UInt(1))
            .expect("unique");
        let claims = TokenClaims {
            token_id: vec![1; 16],
            issuer: DeviceId([2; 32]),
            issuer_key: IdentityKey {
                alg: -8,
                public_key: vec![3; 32],
            },
            bearer: DeviceId([4; 32]),
            capability: CapabilityVerb("exec:pty".to_owned()),
            scope: CapabilityScope {
                kind: "folder".to_owned(),
                path: Some("/work".to_owned()),
            },
            expires: 42,
            not_before: None,
            parent: None,
            extra,
        };
        let bytes = claims.encode_to_vec();
        let decoded = TokenClaims::decode_bytes(&bytes).expect("decode");
        assert_eq!(decoded, claims);
        // Map arity 8, first key is the 3-byte-encoded "zz".
        assert_eq!(bytes[0], 0xa8);
        assert_eq!(&bytes[1..4], &[0x62, b'z', b'z']);
    }
}
