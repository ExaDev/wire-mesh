//! The typed core/management introspection verbs (`spec/management.cddl`): `path.trace` and `topology.get` as `$manage-command-params` members, `path-trace-ok` and the `topology.get` answer as typed views of a `manage-ok`, and `topology-peers`, the value both the answer and the gossiped `topology/peers` extension of a peer-advert carry.
//!
//! `path-trace` and `topology-get` are closed maps of the `verb` alone. `path-trace-ok` and the topology answer end in the open tail `* tstr => any`, so each carries an `extra` map and re-encodes to the bytes it was read from. `topology-peers` is a closed map.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{device_id_from, DeviceId};
use crate::management::{ManageOk, ManageOutcome};
use crate::open_tail::{ok_conversions, params_codec, push_extra, read_ok, Extra};
use crate::strict;
use crate::value::{CdeKey, CdeMapBuilder};

/// `path-trace = { verb: "path.trace" }`. Ungated: it names no capability, and the outer `manage-command.verb` is the registered wire identifier `path:trace`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PathTrace;

impl PathTrace {
    pub const VERB: &'static str = "path.trace";
}

impl Encode<()> for PathTrace {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(1)?;
        e.str("verb")?.str(Self::VERB)?;
        e.ok()
    }
}

impl PathTrace {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut map = strict::MapDecoder::new(d)?;
        let mut saw_verb = false;
        while let Some(key) = map.next_key(d)? {
            match key {
                "verb" => {
                    strict::literal(d, Self::VERB)?;
                    saw_verb = true;
                }
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
        }
        if !saw_verb {
            return Err(DecodeError::MissingField("verb"));
        }
        Ok(PathTrace)
    }
}

/// `topology-get = { verb: "topology.get" }`. Ungated, like `version.get`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TopologyGet;

impl TopologyGet {
    pub const VERB: &'static str = "topology.get";
}

impl Encode<()> for TopologyGet {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(1)?;
        e.str("verb")?.str(Self::VERB)?;
        e.ok()
    }
}

impl TopologyGet {
    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut map = strict::MapDecoder::new(d)?;
        let mut saw_verb = false;
        while let Some(key) = map.next_key(d)? {
            match key {
                "verb" => {
                    strict::literal(d, Self::VERB)?;
                    saw_verb = true;
                }
                other => return Err(DecodeError::UnknownKey(other.to_owned())),
            }
        }
        if !saw_verb {
            return Err(DecodeError::MissingField("verb"));
        }
        Ok(TopologyGet)
    }
}

/// `path-trace-ok = { result: "ok", relayed: bool, ? "hub-address": tstr, * tstr => any }`: the receiver's own knowledge of whether the request arrived through a hub and, if so, the address it dialled to reach it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTraceOk {
    pub relayed: bool,
    pub hub_address: Option<String>,
    pub extra: Extra,
}

impl PathTraceOk {
    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("result", "ok");
        builder.push("relayed", &self.relayed);
        if let Some(address) = &self.hub_address {
            builder.push("hub-address", address);
        }
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut relayed = None;
        let mut hub_address = None;
        let extra = read_ok(d, &mut |d, key| {
            match key {
                "relayed" => strict::set_once(&mut relayed, bool_value(d)?)?,
                "hub-address" => strict::set_once(&mut hub_address, strict::text_value(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(PathTraceOk {
            relayed: relayed.ok_or(DecodeError::MissingField("relayed"))?,
            hub_address,
            extra,
        })
    }
}

params_codec!(PathTraceOk);
ok_conversions!(PathTraceOk);

fn bool_value(d: &mut Decoder<'_>) -> Result<bool, DecodeError> {
    d.bool().map_err(DecodeError::from_minicbor)
}

/// One relay pairing a node holds: the device reached and, when known, the hub it is reached through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayedPeer {
    pub device: DeviceId,
    pub via: Option<DeviceId>,
}

/// `topology-peers = { direct: [* device-id], relayed: [* { device: device-id, ? via: device-id }] }`: which peers a node holds a direct connection to and which relay pairings it holds. A closed map, and each relayed entry is a closed map too.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TopologyPeers {
    pub direct: Vec<DeviceId>,
    pub relayed: Vec<RelayedPeer>,
}

impl Encode<()> for RelayedPeer {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let mut builder = CdeMapBuilder::new();
        builder.push("device", &self.device);
        if let Some(via) = &self.via {
            builder.push("via", via);
        }
        builder.write(e)
    }
}

fn relayed_peer_from(d: &mut Decoder<'_>) -> Result<RelayedPeer, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut device = None;
    let mut via = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "device" => strict::set_once(&mut device, device_id_from(d)?)?,
            "via" => strict::set_once(&mut via, device_id_from(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(RelayedPeer {
        device: device.ok_or(DecodeError::MissingField("device"))?,
        via,
    })
}

impl Encode<()> for TopologyPeers {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let mut builder = CdeMapBuilder::new();
        let mut direct = Vec::new();
        let mut enc = Encoder::new(&mut direct);
        enc.array(self.direct.len() as u64)
            .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        for device in &self.direct {
            device
                .encode(&mut enc, &mut ())
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        }
        builder.push_raw("direct".encoded(), direct);
        let mut relayed = Vec::new();
        let mut enc = Encoder::new(&mut relayed);
        enc.array(self.relayed.len() as u64)
            .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        for peer in &self.relayed {
            peer.encode(&mut enc, &mut ())
                .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
        }
        builder.push_raw("relayed".encoded(), relayed);
        builder.write(e)
    }
}

pub(crate) fn topology_peers_from(d: &mut Decoder<'_>) -> Result<TopologyPeers, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut direct = None;
    let mut relayed = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "direct" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(device_id_from(d)?);
                }
                strict::set_once(&mut direct, list)?;
            }
            "relayed" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(relayed_peer_from(d)?);
                }
                strict::set_once(&mut relayed, list)?;
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(TopologyPeers {
        direct: direct.ok_or(DecodeError::MissingField("direct"))?,
        relayed: relayed.ok_or(DecodeError::MissingField("relayed"))?,
    })
}

impl Decode<'_, ()> for TopologyPeers {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        topology_peers_from(d).map_err(minicbor::decode::Error::custom)
    }
}

/// The answer to `topology.get`: `manage-ok` extended with `peers: topology-peers`, the live answer (the gossiped extension of a peer-advert is the cheap, possibly stale one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TopologyGetOk {
    pub peers: TopologyPeers,
    pub extra: Extra,
}

impl TopologyGetOk {
    fn build(&self) -> CdeMapBuilder {
        let mut builder = CdeMapBuilder::new();
        builder.push("result", "ok");
        builder.push("peers", &self.peers);
        push_extra(&mut builder, &self.extra);
        builder
    }

    pub(crate) fn from_map(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let mut peers = None;
        let extra = read_ok(d, &mut |d, key| {
            match key {
                "peers" => strict::set_once(&mut peers, topology_peers_from(d)?)?,
                _ => return Ok(false),
            }
            Ok(true)
        })?;
        Ok(TopologyGetOk {
            peers: peers.ok_or(DecodeError::MissingField("peers"))?,
            extra,
        })
    }
}

params_codec!(TopologyGetOk);
ok_conversions!(TopologyGetOk);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topology_peers_round_trips_in_cde_order() {
        let peers = TopologyPeers {
            direct: vec![DeviceId([1; 32])],
            relayed: vec![
                RelayedPeer {
                    device: DeviceId([2; 32]),
                    via: Some(DeviceId([3; 32])),
                },
                RelayedPeer {
                    device: DeviceId([4; 32]),
                    via: None,
                },
            ],
        };
        let bytes = minicbor::to_vec(&peers).expect("encode");
        assert_eq!(
            minicbor::decode::<TopologyPeers>(&bytes).expect("decode"),
            peers
        );
    }

    /// The generated TypeScript schemas strip a key beyond a closed CDDL map instead of refusing it, so no vector pins the refusal: this decoder is the strict one, and these hold it to the spec.
    #[test]
    fn closed_maps_refuse_a_key_beyond_the_rule() {
        let mut bytes = Vec::new();
        let mut e = Encoder::new(&mut bytes);
        e.map(2).expect("map");
        e.str("note").expect("key").str("x").expect("value");
        e.str("verb")
            .expect("key")
            .str("path.trace")
            .expect("value");
        assert!(matches!(
            PathTrace::from_map(&mut Decoder::new(&bytes)),
            Err(DecodeError::UnknownKey(_))
        ));

        let mut bytes = Vec::new();
        let mut e = Encoder::new(&mut bytes);
        e.map(3).expect("map");
        e.str("extra").expect("key").u8(1).expect("value");
        e.str("direct").expect("key").array(0).expect("array");
        e.str("relayed").expect("key").array(0).expect("array");
        assert!(matches!(
            topology_peers_from(&mut Decoder::new(&bytes)),
            Err(DecodeError::UnknownKey(_))
        ));

        let mut bytes = Vec::new();
        let mut e = Encoder::new(&mut bytes);
        e.map(2).expect("map");
        e.str("hub").expect("key").u8(1).expect("value");
        e.str("device")
            .expect("key")
            .encode(DeviceId([1; 32]))
            .expect("device");
        assert!(matches!(
            relayed_peer_from(&mut Decoder::new(&bytes)),
            Err(DecodeError::UnknownKey(_))
        ));
    }
}
