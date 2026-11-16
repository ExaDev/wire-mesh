//! Validation of the extension bag a caller hands to a gossip update, the mirror of the TypeScript `validateGossipExtensions`: a pure function of the keys, with no dependency on session state.
//!
//! A key is refused when it would shadow one of a peer-advert's own mandatory fields, when it is one the session manages itself (`topology/peers`) or one this crate reserves for its own version, or when it is not domain-qualified as `<domain>/<field>` in lowercase kebab-case, which is what keeps two independent applications that share one gossip tail from silently overwriting each other's keys (`spec/CONVENTIONS.md`).

use crate::domain::topology::TOPOLOGY_PEERS_GOSSIP_KEY;

/// The gossip extension key this crate injects into every self-advert to report its own version, reserved so a caller can never also supply it.
pub const CORE_VERSION_GOSSIP_KEY: &str = "wire-mesh/version";

/// The peer-advert fields the session sets itself, which an extension may never shadow.
pub const RESERVED_PEER_ADVERT_KEYS: [&str; 5] = [
    "device",
    "addresses",
    "snapshot-seconds",
    "identity-key",
    "signature",
];

/// Why an extension key was refused, named as the conformance vectors name it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionRefusal {
    /// The key is one of the peer-advert's own mandatory fields.
    ReservedField,
    /// The key is `topology/peers`, which the session computes.
    SessionManaged,
    /// The key is the one reserved for this crate's own version.
    ReservedVersion,
    /// The key is not `<domain>/<field>` in lowercase kebab-case.
    NotDomainQualified,
}

impl ExtensionRefusal {
    /// The name the conformance vectors use for this refusal.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            ExtensionRefusal::ReservedField => "reserved_field",
            ExtensionRefusal::SessionManaged => "session_managed",
            ExtensionRefusal::ReservedVersion => "reserved_version",
            ExtensionRefusal::NotDomainQualified => "not_domain_qualified",
        }
    }
}

/// A refused key and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefusedExtension {
    pub key: String,
    pub refusal: ExtensionRefusal,
}

impl std::fmt::Display for RefusedExtension {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.refusal {
            ExtensionRefusal::ReservedField => write!(
                f,
                "the extension key \"{}\" collides with a mandatory peer-advert field",
                self.key
            ),
            ExtensionRefusal::SessionManaged => write!(
                f,
                "the extension key \"{}\" collides with a session-managed gossip field",
                self.key
            ),
            ExtensionRefusal::ReservedVersion => write!(
                f,
                "the extension key \"{}\" is reserved for wire-mesh-core's own self-reported version",
                self.key
            ),
            ExtensionRefusal::NotDomainQualified => write!(
                f,
                "the extension key \"{}\" must be domain-qualified as \"<domain>/<field>\" (for example \"presence/status\")",
                self.key
            ),
        }
    }
}

impl std::error::Error for RefusedExtension {}

/// Whether `part` is lowercase kebab-case: a letter, then letters, digits and hyphens, all lowercase.
fn is_kebab(part: &str) -> bool {
    let mut bytes = part.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Whether `key` is `<domain>/<field>`, each side lowercase kebab-case.
fn is_domain_qualified(key: &str) -> bool {
    key.split_once('/')
        .is_some_and(|(domain, field)| is_kebab(domain) && is_kebab(field))
}

/// Checks each key of an extension bag in the order given. The first key that fails is the refusal; for one key the checks run in the order reserved field, session-managed, reserved version, domain qualification.
///
/// # Errors
///
/// The first [`RefusedExtension`].
pub fn validate_gossip_extensions<'a>(
    keys: impl IntoIterator<Item = &'a str>,
) -> Result<(), RefusedExtension> {
    for key in keys {
        let refusal = if RESERVED_PEER_ADVERT_KEYS.contains(&key) {
            Some(ExtensionRefusal::ReservedField)
        } else if key == TOPOLOGY_PEERS_GOSSIP_KEY {
            Some(ExtensionRefusal::SessionManaged)
        } else if key == CORE_VERSION_GOSSIP_KEY {
            Some(ExtensionRefusal::ReservedVersion)
        } else if !is_domain_qualified(key) {
            Some(ExtensionRefusal::NotDomainQualified)
        } else {
            None
        };
        if let Some(refusal) = refusal {
            return Err(RefusedExtension {
                key: key.to_owned(),
                refusal,
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(keys: &[&str]) -> Option<(String, ExtensionRefusal)> {
        validate_gossip_extensions(keys.iter().copied())
            .err()
            .map(|refused| (refused.key, refused.refusal))
    }

    #[test]
    fn each_reason_names_its_own_refusal() {
        for key in RESERVED_PEER_ADVERT_KEYS {
            assert_eq!(
                refusal(&[key]),
                Some((key.to_owned(), ExtensionRefusal::ReservedField))
            );
        }
        assert_eq!(
            refusal(&["topology/peers"]),
            Some((
                "topology/peers".to_owned(),
                ExtensionRefusal::SessionManaged
            ))
        );
        assert_eq!(
            refusal(&["wire-mesh/version"]),
            Some((
                "wire-mesh/version".to_owned(),
                ExtensionRefusal::ReservedVersion
            ))
        );
        for key in [
            "status",
            "Presence/status",
            "presence/Status",
            "a/b/c",
            "/x",
            "x/",
            "1a/b",
            "a_b/c",
            "",
        ] {
            assert_eq!(
                refusal(&[key]),
                Some((key.to_owned(), ExtensionRefusal::NotDomainQualified)),
                "{key:?}"
            );
        }
    }

    #[test]
    fn domain_qualified_keys_are_accepted_and_the_first_bad_key_is_the_one_named() {
        assert_eq!(refusal(&["presence/status", "app-1/x-y2"]), None);
        assert_eq!(
            refusal(&["presence/status", "device", "status"]),
            Some(("device".to_owned(), ExtensionRefusal::ReservedField))
        );
        // A key that merely contains a reserved name is an ordinary key.
        assert_eq!(refusal(&["device/status", "wire-mesh/versions"]), None);
        assert_eq!(refusal(&[]), None);
    }
}
