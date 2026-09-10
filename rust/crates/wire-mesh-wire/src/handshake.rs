//! `handshake.cddl` — the first frame on a connection and the domain
//! registry.
//!
//! A domain is a capability a node advertises at connect time; `DomainId`
//! stays a validated string newtype because the union is open-ended regex
//! tiers, matching the TS core's string-plus-regex modelling. Validation
//! knows the four `core-domain-name` literals including the retired
//! `core/federation`: syntactically parseable, never valid to advertise,
//! reported with a distinct error so a caller can tell "typo" apart from
//! "deliberately retired".

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::strict;
use crate::value::{CanonicalMap, CborValue};

/// The four spec-owned core domain names, append-only per
/// `spec/registry/core-domains.md`. `core/federation` is retired: no
/// frames are defined for it and a peer must never advertise or negotiate
/// it, but the string stays reserved rather than becoming available for
/// reuse.
pub const CORE_DOMAINS: [&str; 4] = [
    "core/management",
    "core/exec",
    "core/data",
    "core/federation",
];

/// The retired core domain, reserved forever. Validation reports it
/// distinctly from other failures.
pub const RETIRED_DOMAIN: &str = "core/federation";

/// Why a domain string is not valid to advertise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DomainError {
    /// The string is the retired `core/federation` literal: parseable as a
    /// core domain, but a peer must never advertise it.
    Retired(String),
    /// The string matches no tier's grammar.
    Malformed(String),
}

impl core::fmt::Display for DomainError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            DomainError::Retired(d) => {
                write!(f, "domain {d:?} is retired and must never be advertised")
            }
            DomainError::Malformed(d) => write!(
                f,
                "domain {d:?} matches no core, namespaced, or private-use tier"
            ),
        }
    }
}

impl std::error::Error for DomainError {}

/// `protocol-version = uint`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolVersion(pub u64);

/// `domain-id = core-domain-name / namespaced-domain-id / private-use-domain-id`,
/// kept as a string newtype: the union is three regex tiers, not a closed
/// set, so a string carrying validated structure is the faithful model.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DomainId(pub String);

impl DomainId {
    /// Validate against the three registry tiers.
    ///
    /// Namespaced ids use the CDDL's own `.regexp`, which anchors at both
    /// ends: `"<registrant>/<local>"` where the registrant is a DNS name
    /// of at least two dot-separated labels (`[a-z0-9]` segments possibly
    /// with inner hyphens) and the local name is
    /// `[A-Za-z0-9_.-]+`. Private-use ids are `x-` prefixed.
    pub fn validate(domain: &str) -> Result<(), DomainError> {
        if CORE_DOMAINS.contains(&domain) {
            if domain == RETIRED_DOMAIN {
                return Err(DomainError::Retired(domain.to_owned()));
            }
            return Ok(());
        }
        if is_namespaced_domain(domain) || is_private_use_domain(domain) {
            return Ok(());
        }
        Err(DomainError::Malformed(domain.to_owned()))
    }
}

/// `namespaced-domain-id` grammar, component-wise rather than one regex so
/// each piece is independently testable against the registry's examples.
fn is_namespaced_domain(domain: &str) -> bool {
    let Some((registrant, local)) = domain.split_once('/') else {
        return false;
    };
    if local.is_empty()
        || !local
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
    {
        return false;
    }
    is_dotted_dns_name(registrant)
}

/// The registrant segment: at least two dot-separated labels (the CDDL
/// regex's `(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+` requires one repetition),
/// each label `[a-z0-9]` or `[a-z0-9]([a-z0-9-]*[a-z0-9])?`.
fn is_dotted_dns_name(name: &str) -> bool {
    let labels: Vec<&str> = name.split('.').collect();
    if labels.len() < 2 {
        return false;
    }
    labels.iter().all(|label| {
        let bytes = label.as_bytes();
        if bytes.is_empty() {
            return false;
        }
        if bytes.len() == 1 {
            // A single `[a-z0-9]` character is a valid label.
            return bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
        }
        let first_ok = bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit();
        let last_ok =
            bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit();
        let inner_ok = bytes[1..bytes.len() - 1]
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
        first_ok && last_ok && inner_ok
    })
}

/// `private-use-domain-id`: `x-[A-Za-z0-9_.-]+`, at least one character
/// after the prefix.
fn is_private_use_domain(domain: &str) -> bool {
    let Some(rest) = domain.strip_prefix("x-") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-')
}

/// `handshake-frame = { type: "handshake", version, domains, ? params }`.
///
/// CDE key order: `type` (5 encoded bytes), `params` (7), `domains` (9),
/// `version` (9; `domains` sorts before `version` bytewise on equal
/// length).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandshakeFrame {
    pub version: ProtocolVersion,
    pub domains: Vec<DomainId>,
    /// Forward-compatible extension bag, e.g. a future max-frame-size.
    pub params: Option<CanonicalMap<String, CborValue>>,
}

impl HandshakeFrame {
    pub const TYPE: &'static str = "handshake";

    /// Validate every advertised domain against the registry tiers. This is
    /// the frame-level validation step, deliberately separate from decode:
    /// the wire shape is valid with any text domains; whether a domain may
    /// be *advertised* is a domain-layer rule.
    pub fn validate(&self) -> Result<(), DomainError> {
        for domain in &self.domains {
            DomainId::validate(&domain.0)?;
        }
        Ok(())
    }
}

impl Encode<()> for HandshakeFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 3 + usize::from(self.params.is_some());
        e.map(len as u64)?;
        e.str("type")?.str(Self::TYPE)?;
        if let Some(params) = &self.params {
            e.str("params")?.map(params.len() as u64)?;
            for (k, v) in params.iter() {
                e.str(k)?;
                v.encode(e, &mut ())?;
            }
        }
        e.str("domains")?.array(self.domains.len() as u64)?;
        for domain in &self.domains {
            e.str(&domain.0)?;
        }
        e.str("version")?.u64(self.version.0)?;
        e.ok()
    }
}

impl Decode<'_, ()> for HandshakeFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        handshake_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn handshake_from(d: &mut Decoder<'_>) -> Result<HandshakeFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut version: Option<u64> = None;
    let mut domains: Option<Vec<DomainId>> = None;
    let mut params: Option<CanonicalMap<String, CborValue>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, HandshakeFrame::TYPE)?,
            "version" => strict::set_once(&mut version, strict::uint_value(d)?)?,
            "domains" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(DomainId(strict::text_value(d)?));
                }
                domains = Some(list);
            }
            "params" => {
                let mut inner = strict::MapDecoder::new(d)?;
                let mut map = CanonicalMap::new();
                while let Some(key) = inner.next_key(d)? {
                    let value = CborValue::decode_strict(d)?;
                    map.insert(key.to_owned(), value)?;
                }
                params = Some(map);
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(HandshakeFrame {
        version: ProtocolVersion(version.ok_or(DecodeError::MissingField("version"))?),
        domains: domains.ok_or(DecodeError::MissingField("domains"))?,
        params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_core() -> [&'static str; 3] {
        ["core/management", "core/exec", "core/data"]
    }

    #[test]
    fn core_domains_validate_except_retired_federation() {
        for domain in valid_core() {
            assert_eq!(DomainId::validate(domain), Ok(()), "{domain}");
        }
        assert_eq!(
            DomainId::validate(RETIRED_DOMAIN),
            Err(DomainError::Retired("core/federation".to_owned()))
        );
    }

    #[test]
    fn namespaced_tier_examples() {
        // The registry's own shape: registrant is a DNS name the registrant
        // already owns, so it needs at least two labels.
        for domain in [
            "example.com/rooms",
            "exadev.io/mesh",
            "a-b.example.co.uk/scope_name.v2",
            "4.example.com/x",
        ] {
            assert_eq!(DomainId::validate(domain), Ok(()), "{domain}");
        }
        for domain in [
            "example.com",        // no slash: not namespaced, not private-use, not core
            "example/rooms",      // single-label registrant is not a DNS name
            ".com/rooms",         // empty first label
            "example..com/rooms", // empty inner label
            "-example.com/rooms", // leading hyphen
            "example.com/",       // empty local name
            "Example.com/rooms",  // uppercase registrant
            "example.com/ro oms", // space in local name
        ] {
            assert_eq!(
                DomainId::validate(domain),
                Err(DomainError::Malformed(domain.to_owned())),
                "{domain}"
            );
        }
    }

    #[test]
    fn private_use_tier_examples() {
        for domain in ["x-lab", "x-anything_.-0", "x-1"] {
            assert_eq!(DomainId::validate(domain), Ok(()), "{domain}");
        }
        for domain in ["x-", "y-lab", "x-la b"] {
            assert_eq!(
                DomainId::validate(domain),
                Err(DomainError::Malformed(domain.to_owned())),
                "{domain}"
            );
        }
    }

    #[test]
    fn handshake_frame_round_trip() {
        let frame = HandshakeFrame {
            version: ProtocolVersion(1),
            domains: valid_core()
                .iter()
                .map(|d| DomainId((*d).to_owned()))
                .collect(),
            params: None,
        };
        let bytes = minicbor::to_vec(&frame).expect("encode");
        let back: HandshakeFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        // CDE order: type, domains, version (no params).
        let expected: Vec<u8> = [
            0xa3u8, 0x64, b't', b'y', b'p', b'e', 0x69, b'h', b'a', b'n', b'd', b's', b'h', b'a',
            b'k', b'e',
        ]
        .into_iter()
        .chain([0x67, b'd', b'o', b'm', b'a', b'i', b'n', b's', 0x83])
        .chain(valid_core().iter().flat_map(|d| {
            let mut out = vec![0x60 + d.len() as u8];
            out.extend_from_slice(d.as_bytes());
            out
        }))
        .chain([0x67, b'v', b'e', b'r', b's', b'i', b'o', b'n', 0x01])
        .collect();
        assert_eq!(bytes, expected);
    }

    #[test]
    fn handshake_params_round_trip() {
        let mut params = CanonicalMap::new();
        params
            .insert("max-frame-size".to_owned(), CborValue::UInt(65536))
            .expect("unique");
        let frame = HandshakeFrame {
            version: ProtocolVersion(1),
            domains: vec![DomainId("core/data".to_owned())],
            params: Some(params),
        };
        let bytes = minicbor::to_vec(&frame).expect("encode");
        let back: HandshakeFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        // CDE order with params present: type, params, domains, version.
        let without_params = minicbor::to_vec(&HandshakeFrame {
            params: None,
            ..frame.clone()
        })
        .expect("encode");
        assert!(bytes.len() > without_params.len());
        let params_at = bytes
            .windows(6)
            .position(|w| w == b"params")
            .expect("params key");
        let domains_at = bytes
            .windows(7)
            .position(|w| w == b"domains")
            .expect("domains key");
        assert!(params_at < domains_at);
    }

    #[test]
    fn handshake_rejects_unknown_keys_and_missing_domains() {
        // {"type": "handshake", "version": 1, "bogus": true}
        let mut bytes: Vec<u8> = [
            0xa3u8, 0x64, b't', b'y', b'p', b'e', 0x69, b'h', b'a', b'n', b'd', b's', b'h', b'a',
            b'k', b'e', 0x67, b'v', b'e', b'r', b's', b'i', b'o', b'n', 0x01, 0x66, b'b', b'o',
            b'g', b'u', b's', 0xf5,
        ]
        .to_vec();
        assert!(minicbor::decode::<HandshakeFrame>(&bytes).is_err());
        bytes.truncate(bytes.len() - 6);
        bytes[0] = 0xa2;
        // {"type": "handshake", "version": 1} — domains missing.
        assert!(minicbor::decode::<HandshakeFrame>(&bytes).is_err());
    }

    #[test]
    fn handshake_rejects_unsorted_params_keys() {
        // {"type": "handshake", "params": {"b": 1, "a": 2}, "domains": [], "version": 1}
        let bytes: Vec<u8> = [
            0xa4, 0x64, b't', b'y', b'p', b'e', 0x69, b'h', b'a', b'n', b'd', b's', b'h', b'a',
            b'k', b'e', 0x66, b'p', b'a', b'r', b'a', b'm', b's', 0xa2, 0x61, b'b', 0x01, 0x61,
            b'a', 0x02, 0x67, b'd', b'o', b'm', b'a', b'i', b'n', b's', 0x80, 0x67, b'v', b'e',
            b'r', b's', b'i', b'o', b'n', 0x01,
        ]
        .to_vec();
        let mut d = Decoder::new(&bytes);
        assert_eq!(handshake_from(&mut d), Err(DecodeError::UnsortedMapKeys));
    }
}
