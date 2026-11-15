//! Topology introspection (wire-mesh#180), ported from `topology.ts`: assembling a connection graph from every device's self-reported `topology/peers` gossip extension, and the on-demand `topology.get` manage-command that answers with a live, cache-bust read.
//!
//! `topology:get` is deliberately ungated: no token or scope is checked anywhere here.

use std::time::Duration;

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::introspection::{TopologyGet, TopologyGetOk, TopologyPeers};
use wire_mesh_wire::management::{ManageCommand, ManageOutcome, ManageParams};
use wire_mesh_wire::minicbor;
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb};
use wire_mesh_wire::transport::PeerAdvert;

use crate::domain::path_trace::ManageRequestSender;
use crate::ports::CoreError;

/// The registered capability `topology.get` is carried under.
pub const TOPOLOGY_GET_CAPABILITY: &str = "topology:get";

/// The gossip extension key topology self-advertisement is carried under in a peer-advert.
pub const TOPOLOGY_PEERS_GOSSIP_KEY: &str = "topology/peers";

/// The scope of `topology:get`: fixed and uninteresting for an ungated, whole-node query.
fn topology_scope() -> CapabilityScope {
    CapabilityScope {
        kind: "node".to_owned(),
        path: None,
    }
}

/// The `topology.get` manage-command: the outer verb is the registered `topology:get` capability.
#[must_use]
pub fn build_topology_get_command() -> ManageCommand {
    ManageCommand {
        verb: CapabilityVerb(TOPOLOGY_GET_CAPABILITY.to_owned()),
        params: ManageParams::TopologyGet(TopologyGet),
    }
}

/// A peer-advert's own `topology/peers` extension, or `None` for anything absent or malformed: an older peer's advert carries no topology yet, and a malformed one is no different from an absent one to a consumer building a best-effort graph.
#[must_use]
pub fn read_topology_peers(advert: &PeerAdvert) -> Option<TopologyPeers> {
    let raw = advert.extra.get(&TOPOLOGY_PEERS_GOSSIP_KEY.to_owned())?;
    let bytes = minicbor::to_vec(raw).ok()?;
    minicbor::decode::<TopologyPeers>(&bytes).ok()
}

/// One device of a peer directory and the latest peer-advert heard from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectoryEntry {
    pub device: DeviceId,
    pub advert: PeerAdvert,
}

/// One edge of the assembled graph, attributed to whichever device's own advert reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopologyEdge {
    /// `from` holds a direct connection to `to`.
    Direct { from: DeviceId, to: DeviceId },
    /// `from` holds a relay pairing with `to`, through `via` when known.
    Relay {
        from: DeviceId,
        to: DeviceId,
        via: Option<DeviceId>,
    },
}

/// The assembled graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopologyGraph {
    /// Every device of the directory, whether or not it self-reported any topology.
    pub nodes: Vec<DeviceId>,
    pub edges: Vec<TopologyEdge>,
}

/// Assembles a best-effort connection graph from a directory of peer-adverts: a direct edge for each of a device's own connections, a relay edge for each pairing it holds and the hub it is reached through when known. Directed and unreconciled by design: two devices reporting the same connection from either end produce two edges, since merging them would need a judgement about which side to trust, and keeping both surfaces an asymmetric or stale view instead of hiding it.
#[must_use]
pub fn assemble_topology_graph(directory: &[DirectoryEntry]) -> TopologyGraph {
    let nodes = directory.iter().map(|entry| entry.device).collect();
    let mut edges = Vec::new();
    for entry in directory {
        let Some(topology) = read_topology_peers(&entry.advert) else {
            continue;
        };
        for to in topology.direct {
            edges.push(TopologyEdge::Direct {
                from: entry.device,
                to,
            });
        }
        for relayed in topology.relayed {
            edges.push(TopologyEdge::Relay {
                from: entry.device,
                to: relayed.device,
                via: relayed.via,
            });
        }
    }
    TopologyGraph { nodes, edges }
}

/// Why [`send_topology_get`] produced no peers.
#[derive(Debug)]
pub enum TopologyGetError {
    /// The request could not be sent or its connection ended.
    Send(CoreError),
    /// The peer answered with a `manage-error`, here is its code.
    Refused { code: String },
    /// The outcome was `ok` but had no well-formed `peers`.
    Malformed,
}

impl std::fmt::Display for TopologyGetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TopologyGetError::Send(error) => write!(f, "topology.get could not be sent: {error}"),
            TopologyGetError::Refused { code } => write!(f, "topology.get was refused ({code})"),
            TopologyGetError::Malformed => f.write_str("topology.get response was malformed"),
        }
    }
}

impl std::error::Error for TopologyGetError {}

/// Sends `topology.get` and resolves with the peer's own live [`TopologyPeers`], read from the `peers` field of the `manage-ok`: the on-demand counterpart to a possibly stale gossiped extension.
///
/// # Errors
///
/// [`TopologyGetError`]: the request could not be sent, the peer answered with an error, or the answer had no well-formed `peers`.
pub async fn send_topology_get(
    sender: &dyn ManageRequestSender,
    timeout: Option<Duration>,
) -> Result<TopologyPeers, TopologyGetError> {
    let outcome = sender
        .send_manage_request(
            build_topology_get_command(),
            topology_scope(),
            None,
            timeout,
        )
        .await
        .map_err(TopologyGetError::Send)?;
    match outcome {
        ManageOutcome::Error(error) => Err(TopologyGetError::Refused { code: error.code }),
        ManageOutcome::Ok(ok) => TopologyGetOk::from_ok(&ok)
            .map(|answer| answer.peers)
            .map_err(|_| TopologyGetError::Malformed),
    }
}

/// Where a node's live topology comes from: the connections and pairings it holds right now.
pub trait TopologySource: Send + Sync {
    fn topology_peers(&self) -> TopologyPeers;
}

/// Answers an incoming `topology.get` from a [`TopologySource`], ungated: the request's scope and token are not read, as the spec states the verb needs no grant (topology is not a secret, and the same list is already carried in the `topology/peers` extension of an advert). Registering this handler therefore tells any connected peer, authenticated or not, the set of devices the node is connected to or relays for, as it stands when the request arrives; an embedder that does not want that does not register it, and bounding how often a peer may ask is the embedder's. Register it under [`TOPOLOGY_GET_CAPABILITY`] in a `HandlerRegistry`. A request whose params are not `topology.get` is answered `manage-error { code: "malformed" }`, since reaching this handler at all means the caller believed it was one.
#[cfg(feature = "net")]
pub struct TopologyGetHandler<S: TopologySource> {
    source: S,
}

#[cfg(feature = "net")]
impl<S: TopologySource> TopologyGetHandler<S> {
    #[must_use]
    pub fn new(source: S) -> Self {
        TopologyGetHandler { source }
    }
}

#[cfg(feature = "net")]
#[async_trait::async_trait]
impl<S: TopologySource> crate::domain::session::ManageRequestHandler for TopologyGetHandler<S> {
    async fn handle(
        &self,
        request: crate::domain::session::IncomingManageRequest,
    ) -> ManageOutcome {
        if !matches!(request.command.params, ManageParams::TopologyGet(_)) {
            return ManageOutcome::Error(wire_mesh_wire::management::ManageError {
                code: "malformed".to_owned(),
                message: None,
            });
        }
        ManageOutcome::Ok(
            TopologyGetOk {
                peers: self.source.topology_peers(),
                extra: wire_mesh_wire::Extra::new(),
            }
            .into_ok(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire_mesh_wire::identity::IdentityKey;
    use wire_mesh_wire::introspection::RelayedPeer;
    use wire_mesh_wire::value::{CanonicalMap, CborValue};

    fn advert(device: DeviceId, topology: Option<&TopologyPeers>) -> PeerAdvert {
        let mut extra = CanonicalMap::new();
        if let Some(topology) = topology {
            let bytes = minicbor::to_vec(topology).expect("encode");
            let value = minicbor::decode::<CborValue>(&bytes).expect("a value");
            extra
                .insert(TOPOLOGY_PEERS_GOSSIP_KEY.to_owned(), value)
                .expect("unique");
        }
        PeerAdvert {
            device,
            addresses: vec![],
            snapshot_seconds: 0,
            identity_key: IdentityKey {
                alg: -8,
                public_key: vec![0; 32],
            },
            signature: vec![0; 64],
            extra,
        }
    }

    #[test]
    fn every_device_is_a_node_and_only_reporting_ones_have_edges() {
        let a = DeviceId([1; 32]);
        let b = DeviceId([2; 32]);
        let c = DeviceId([3; 32]);
        let reported = TopologyPeers {
            direct: vec![b],
            relayed: vec![RelayedPeer {
                device: c,
                via: Some(b),
            }],
        };
        let graph = assemble_topology_graph(&[
            DirectoryEntry {
                device: a,
                advert: advert(a, Some(&reported)),
            },
            DirectoryEntry {
                device: b,
                advert: advert(b, None),
            },
        ]);
        assert_eq!(graph.nodes, vec![a, b]);
        assert_eq!(
            graph.edges,
            vec![
                TopologyEdge::Direct { from: a, to: b },
                TopologyEdge::Relay {
                    from: a,
                    to: c,
                    via: Some(b)
                },
            ]
        );
    }

    #[test]
    fn a_malformed_extension_reads_as_absent() {
        let a = DeviceId([1; 32]);
        let mut bad = advert(a, None);
        bad.extra
            .insert(
                TOPOLOGY_PEERS_GOSSIP_KEY.to_owned(),
                CborValue::Text("nope".to_owned()),
            )
            .expect("unique");
        assert_eq!(read_topology_peers(&bad), None);
    }
}
