//! Handshake negotiation: the usable domain set for a connection is the
//! intersection of what both sides advertise, taken in the domain's own
//! comparable form so the negotiated set is independent of the order
//! either side listed its domains in.

use std::collections::BTreeSet;

use wire_mesh_wire::handshake::{DomainError, HandshakeFrame};

/// The protocol version this implementation speaks. A peer advertising a
/// higher version still negotiates down to `min(local, remote)`.
pub const SUPPORTED_PROTOCOL_VERSION: u64 = 1;

/// Why negotiation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandshakeError {
    /// One side advertised an invalid domain. `side` names which.
    InvalidDomain {
        side: &'static str,
        error: DomainError,
    },
    /// The negotiated minimum version is above what this implementation
    /// supports; degrade is impossible in this direction.
    UnsupportedVersion { negotiated: u64, supported: u64 },
}

impl core::fmt::Display for HandshakeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            HandshakeError::InvalidDomain { side, error } => {
                write!(f, "{side} handshake advertised an invalid domain: {error}")
            }
            HandshakeError::UnsupportedVersion {
                negotiated,
                supported,
            } => write!(
                f,
                "negotiated version {negotiated} is above the locally supported {supported}"
            ),
        }
    }
}

impl std::error::Error for HandshakeError {}

/// The outcome of a successful negotiation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NegotiationResult {
    /// `min(local, remote)`: mixed-version deployments degrade gracefully.
    pub version: u64,
    /// The intersection of both sides' advertised domains, sorted, so the
    /// result is independent of the order either side listed its domains
    /// in. Unknown domains are dropped, never assumed to mean anything.
    pub shared_domains: Vec<String>,
}

/// Negotiate the connection's protocol version and usable domain set from
/// both sides' handshake frames. Retired domains (notably
/// `core/federation`) are rejected distinctly, never silently negotiated.
pub fn negotiate(
    local: &HandshakeFrame,
    remote: &HandshakeFrame,
) -> Result<NegotiationResult, HandshakeError> {
    local
        .validate()
        .map_err(|error| HandshakeError::InvalidDomain {
            side: "local",
            error,
        })?;
    remote
        .validate()
        .map_err(|error| HandshakeError::InvalidDomain {
            side: "remote",
            error,
        })?;

    let version = local.version.0.min(remote.version.0);
    if version > SUPPORTED_PROTOCOL_VERSION {
        return Err(HandshakeError::UnsupportedVersion {
            negotiated: version,
            supported: SUPPORTED_PROTOCOL_VERSION,
        });
    }

    let local_domains: BTreeSet<&str> = local.domains.iter().map(|d| d.0.as_str()).collect();
    let remote_domains: BTreeSet<&str> = remote.domains.iter().map(|d| d.0.as_str()).collect();
    let shared_domains: Vec<String> = local_domains
        .intersection(&remote_domains)
        .map(|d| (*d).to_owned())
        .collect();

    Ok(NegotiationResult {
        version,
        shared_domains,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire_mesh_wire::handshake::{DomainId, ProtocolVersion};

    fn frame(domains: &[&str], version: u64) -> HandshakeFrame {
        HandshakeFrame {
            version: ProtocolVersion(version),
            domains: domains.iter().map(|d| DomainId((*d).to_owned())).collect(),
            params: None,
        }
    }

    #[test]
    fn negotiates_min_version_and_intersection_order_independently() {
        let a = frame(&["core/management", "core/exec", "core/data"], 1);
        let b = frame(&["core/data", "core/management"], 1);
        let result = negotiate(&a, &b).expect("negotiate");
        assert_eq!(result.version, 1);
        assert_eq!(
            result.shared_domains,
            vec!["core/data".to_owned(), "core/management".to_owned()]
        );

        // Listing order and duplicates on either side change nothing.
        let b_reordered = frame(&["core/management", "core/management", "core/data"], 1);
        assert_eq!(negotiate(&a, &b_reordered).expect("negotiate"), result);
    }

    #[test]
    fn mixed_versions_degrade_to_the_minimum() {
        let result =
            negotiate(&frame(&["core/data"], 1), &frame(&["core/data"], 3)).expect("negotiate");
        assert_eq!(result.version, 1);
    }

    #[test]
    fn retired_federation_is_never_negotiable() {
        let bad = frame(&["core/federation"], 1);
        let err = negotiate(&frame(&["core/data"], 1), &bad).unwrap_err();
        assert!(matches!(
            err,
            HandshakeError::InvalidDomain {
                side: "remote",
                error: DomainError::Retired(_)
            }
        ));
    }

    #[test]
    fn unknown_domains_are_dropped_not_rejected() {
        let result = negotiate(
            &frame(&["core/data", "example.com/extra"], 1),
            &frame(&["core/data"], 1),
        )
        .expect("negotiate");
        assert_eq!(result.shared_domains, vec!["core/data".to_owned()]);
    }
}
