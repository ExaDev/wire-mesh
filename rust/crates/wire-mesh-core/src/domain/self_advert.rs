//! This node's own signed advert and the topology it advertises: the mirror of the TypeScript `buildSelfAdvert` and `computeTopologyPeers`.
//!
//! Every advert carries this crate's own version under [`CORE_VERSION_GOSSIP_KEY`] and the current topology under `topology/peers`, recomputed on every call, never cached, since the connection and the pairings change between one advert and the next. A caller's extensions are validated first ([`validate_gossip_extensions`]), so none can shadow a mandatory field, the topology or the version.

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::introspection::{RelayedPeer, TopologyPeers};
use wire_mesh_wire::transport::PeerAdvert;
use wire_mesh_wire::value::{CanonicalMap, CborValue};

use crate::domain::gossip_extensions::{
    validate_gossip_extensions, RefusedExtension, CORE_VERSION_GOSSIP_KEY,
};
use crate::domain::mint::MAX_EXACT_INTEGER;
use crate::domain::peer_advert::sign_peer_advert;
use crate::domain::topology::TOPOLOGY_PEERS_GOSSIP_KEY;
use crate::ports::{CoreError, Identity};

/// This crate's own version, as every self-advert and the `version.get` answer report it. It is read when this crate is compiled, so it is the version `cargo publish` ships, with none of the staleness the TypeScript has to avoid by reading its manifest at run time.
pub const OWN_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The earliest time, in Unix seconds (the start of 2001), a self-advert's clock may read. A clock that reads earlier is not a wall clock (a monotonic clock counts from the process start and gives a few seconds), and an advert stamped with it would look older than every advert a hub holds and be ignored without a sign.
pub const EARLIEST_PLAUSIBLE_SECONDS: u64 = 978_307_200;

/// What a self-advert's topology is computed from.
#[derive(Debug, Clone, Default)]
pub struct TopologyInputs {
    /// The transport-authenticated direct peer, when the transport gives one. It takes priority over `first_advertised_peer`. The connection port has no peer-identity accessor and the only adapter, plain TCP, authenticates nobody, so a session passes `None`.
    pub authenticated_peer: Option<DeviceId>,
    /// The device named by the first advert this session applied to its directory. Trusted only when `accepted`: a dial-side session may end up naming a merely relayed third device. It is a first-heard assumption and no proof: on an accepted connection a peer that first sends a genuine, correctly signed advert of another device (one it has seen) makes this node's self-adverts name that device as the direct peer, an edge that does not exist. The topology is not secret and names only devices whose adverts the peer holds, so this misstates the graph and grants nothing; an authenticating transport removes it by supplying `authenticated_peer`.
    pub first_advertised_peer: Option<DeviceId>,
    /// Whether this connection was accepted (not dialled), where `first_advertised_peer` is structurally sound.
    pub accepted: bool,
    /// Every device this connection holds a relay pairing with.
    pub relayed: Vec<DeviceId>,
}

/// This node's current topology: the direct peer, when it can be honestly known, and every relay pairing, each named with the hub it is reached through when that is known.
#[must_use]
pub fn compute_topology_peers(inputs: &TopologyInputs) -> TopologyPeers {
    let direct = inputs.authenticated_peer.or(if inputs.accepted {
        inputs.first_advertised_peer
    } else {
        None
    });
    TopologyPeers {
        direct: direct.into_iter().collect(),
        relayed: inputs
            .relayed
            .iter()
            .map(|device| RelayedPeer {
                device: *device,
                via: direct,
            })
            .collect(),
    }
}

/// Why a self-advert could not be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelfAdvertError {
    /// An extension key was refused.
    Extension(RefusedExtension),
    /// The clock reads a time a TypeScript peer cannot hold exactly as `snapshot-seconds`.
    ClockOutOfRange,
    /// The clock reads a time before [`EARLIEST_PLAUSIBLE_SECONDS`]: it is not a wall clock.
    ClockImplausible,
    /// The advert could not be signed.
    Signing(CoreError),
}

impl std::fmt::Display for SelfAdvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SelfAdvertError::Extension(refused) => write!(f, "{refused}"),
            SelfAdvertError::ClockOutOfRange => {
                f.write_str("the clock reads a time beyond what a peer can hold exactly")
            }
            SelfAdvertError::ClockImplausible => {
                f.write_str("the clock reads a time before 2001, so it is not a wall clock")
            }
            SelfAdvertError::Signing(error) => write!(f, "the advert could not be signed: {error}"),
        }
    }
}

impl std::error::Error for SelfAdvertError {}

fn topology_value(topology: &TopologyPeers) -> CborValue {
    let bytes = minicbor::to_vec(topology)
        .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
    let mut decoder = minicbor::Decoder::new(&bytes);
    CborValue::decode_strict(&mut decoder)
        .unwrap_or_else(|_| unreachable!("a topology this crate encoded decodes as a CBOR value"))
}

/// Builds and signs this node's own advert: its device, `addresses`, `now_seconds` as `snapshot-seconds`, its identity key, the caller's `extensions` (validated), this crate's version and `topology`.
///
/// # Errors
///
/// [`SelfAdvertError::Extension`] for a refused extension key, [`SelfAdvertError::ClockOutOfRange`] when `now_seconds` is above 2^53 - 1, [`SelfAdvertError::ClockImplausible`] when it is before [`EARLIEST_PLAUSIBLE_SECONDS`], and [`SelfAdvertError::Signing`] when the identity cannot sign.
pub async fn build_self_advert(
    identity: &dyn Identity,
    addresses: &[String],
    now_seconds: u64,
    extensions: &[(String, CborValue)],
    topology: &TopologyPeers,
) -> Result<PeerAdvert, SelfAdvertError> {
    validate_gossip_extensions(extensions.iter().map(|(key, _)| key.as_str()))
        .map_err(SelfAdvertError::Extension)?;
    if now_seconds > MAX_EXACT_INTEGER {
        return Err(SelfAdvertError::ClockOutOfRange);
    }
    if now_seconds < EARLIEST_PLAUSIBLE_SECONDS {
        return Err(SelfAdvertError::ClockImplausible);
    }
    let mut extra = CanonicalMap::new();
    for (key, value) in extensions {
        // A key given twice keeps the later value, as an object literal does in the TypeScript.
        let _ = extra.remove(key);
        extra.insert(key.clone(), value.clone()).map_err(|_| {
            SelfAdvertError::Signing(CoreError::Wire("a duplicate extension key".to_owned()))
        })?;
    }
    extra
        .insert(
            CORE_VERSION_GOSSIP_KEY.to_owned(),
            CborValue::Text(OWN_VERSION.to_owned()),
        )
        .map_err(|_| {
            SelfAdvertError::Signing(CoreError::Wire("a duplicate version key".to_owned()))
        })?;
    extra
        .insert(
            TOPOLOGY_PEERS_GOSSIP_KEY.to_owned(),
            topology_value(topology),
        )
        .map_err(|_| {
            SelfAdvertError::Signing(CoreError::Wire("a duplicate topology key".to_owned()))
        })?;
    let mut advert = PeerAdvert {
        device: *identity.device_id(),
        addresses: addresses.to_vec(),
        snapshot_seconds: i64::try_from(now_seconds)
            .map_err(|_| SelfAdvertError::ClockOutOfRange)?,
        identity_key: identity.identity_key().clone(),
        signature: Vec::new(),
        extra,
    };
    sign_peer_advert(identity, &mut advert)
        .await
        .map_err(SelfAdvertError::Signing)?;
    Ok(advert)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::NodeIdentity;
    use crate::domain::gossip_extensions::ExtensionRefusal;
    use crate::domain::peer_advert::{verify_peer_advert, PeerAdvertVerdict};

    fn device(n: u8) -> DeviceId {
        DeviceId([n; 32])
    }

    #[test]
    fn the_topology_names_the_authenticated_peer_first_and_the_first_advertised_one_only_when_accepted(
    ) {
        let inputs = TopologyInputs {
            authenticated_peer: Some(device(1)),
            first_advertised_peer: Some(device(2)),
            accepted: false,
            relayed: vec![device(3)],
        };
        let topology = compute_topology_peers(&inputs);
        assert_eq!(topology.direct, vec![device(1)]);
        assert_eq!(
            topology.relayed,
            vec![RelayedPeer {
                device: device(3),
                via: Some(device(1))
            }]
        );
        let dialled = compute_topology_peers(&TopologyInputs {
            authenticated_peer: None,
            ..inputs.clone()
        });
        assert!(dialled.direct.is_empty());
        assert_eq!(
            dialled.relayed,
            vec![RelayedPeer {
                device: device(3),
                via: None
            }]
        );
        let accepted = compute_topology_peers(&TopologyInputs {
            authenticated_peer: None,
            accepted: true,
            ..inputs
        });
        assert_eq!(accepted.direct, vec![device(2)]);
    }

    #[tokio::test]
    async fn a_self_advert_verifies_and_carries_the_version_and_the_topology() {
        let identity = NodeIdentity::generate_ed25519();
        let topology = compute_topology_peers(&TopologyInputs {
            authenticated_peer: Some(device(1)),
            relayed: vec![device(3)],
            ..TopologyInputs::default()
        });
        let advert = build_self_advert(
            &identity,
            &["127.0.0.1:1".to_owned()],
            1_700_000_000,
            &[],
            &topology,
        )
        .await
        .expect("an advert");
        assert_eq!(
            verify_peer_advert(&identity, &advert).await,
            PeerAdvertVerdict::Valid
        );
        assert_eq!(advert.device, *identity.device_id());
        assert_eq!(advert.snapshot_seconds, 1_700_000_000);
        assert_eq!(
            advert.extra.get(&CORE_VERSION_GOSSIP_KEY.to_owned()),
            Some(&CborValue::Text(OWN_VERSION.to_owned()))
        );
        assert_eq!(
            crate::domain::topology::read_topology_peers(&advert),
            Some(topology)
        );
    }

    #[tokio::test]
    async fn an_extension_that_would_shadow_a_field_or_the_version_is_refused_before_anything_is_signed(
    ) {
        let identity = NodeIdentity::generate_ed25519();
        let topology = TopologyPeers::default();
        for (key, refusal) in [
            ("device", ExtensionRefusal::ReservedField),
            ("topology/peers", ExtensionRefusal::SessionManaged),
            ("wire-mesh/version", ExtensionRefusal::ReservedVersion),
            ("plain", ExtensionRefusal::NotDomainQualified),
        ] {
            let result = build_self_advert(
                &identity,
                &[],
                1,
                &[(key.to_owned(), CborValue::Text("x".to_owned()))],
                &topology,
            )
            .await;
            assert_eq!(
                result.err(),
                Some(SelfAdvertError::Extension(RefusedExtension {
                    key: key.to_owned(),
                    refusal
                })),
                "{key}"
            );
        }
    }

    #[tokio::test]
    async fn a_clock_beyond_the_exact_integers_builds_no_advert() {
        let identity = NodeIdentity::generate_ed25519();
        let topology = TopologyPeers::default();
        assert!(
            build_self_advert(&identity, &[], MAX_EXACT_INTEGER, &[], &topology)
                .await
                .is_ok()
        );
        assert_eq!(
            build_self_advert(&identity, &[], MAX_EXACT_INTEGER + 1, &[], &topology)
                .await
                .err(),
            Some(SelfAdvertError::ClockOutOfRange)
        );
    }

    #[tokio::test]
    async fn a_clock_that_is_not_a_wall_clock_builds_no_advert() {
        let identity = NodeIdentity::generate_ed25519();
        let topology = TopologyPeers::default();
        assert!(
            build_self_advert(&identity, &[], EARLIEST_PLAUSIBLE_SECONDS, &[], &topology)
                .await
                .is_ok()
        );
        for seconds in [0, 3, EARLIEST_PLAUSIBLE_SECONDS - 1] {
            assert_eq!(
                build_self_advert(&identity, &[], seconds, &[], &topology)
                    .await
                    .err(),
                Some(SelfAdvertError::ClockImplausible),
                "{seconds}"
            );
        }
    }
}
