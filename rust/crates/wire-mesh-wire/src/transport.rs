//! `transport.cddl` — domain-independent frames every peer speaks
//! regardless of the negotiated capability set: liveness, peer discovery,
//! NAT traversal, relay, and the redesigned gossiped coordinator-election
//! claim.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{device_id_from, DeviceId};
use crate::strict;

/// `ping-frame = { type: "ping" }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PingFrame;

impl PingFrame {
    pub const TYPE: &'static str = "ping";
}

impl Encode<()> for PingFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(1)?;
        e.str("type")?.str(Self::TYPE)?;
        e.ok()
    }
}

impl Decode<'_, ()> for PingFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        ping_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn ping_from(d: &mut Decoder<'_>) -> Result<PingFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, PingFrame::TYPE)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(PingFrame)
}

/// `close-frame = { type: "close", ? reason }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CloseFrame {
    pub reason: Option<String>,
}

impl CloseFrame {
    pub const TYPE: &'static str = "close";
}

impl Encode<()> for CloseFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 1 + usize::from(self.reason.is_some());
        e.map(len as u64)?;
        e.str("type")?.str(Self::TYPE)?;
        if let Some(reason) = &self.reason {
            e.str("reason")?.str(reason)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for CloseFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        close_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn close_from(d: &mut Decoder<'_>) -> Result<CloseFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut reason: Option<String> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, CloseFrame::TYPE)?,
            "reason" => strict::set_once(&mut reason, strict::text_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(CloseFrame { reason })
}

/// `peer-advert = { device, addresses, snapshot-seconds }`.
///
/// CDE key order: `device` (7), `addresses` (10), `snapshot-seconds` (18).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerAdvert {
    pub device: DeviceId,
    /// `host:port` strings.
    pub addresses: Vec<String>,
    /// Unix-seconds snapshot time.
    pub snapshot_seconds: i64,
}

impl Encode<()> for PeerAdvert {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("device")?.encode(self.device)?;
        e.str("addresses")?.array(self.addresses.len() as u64)?;
        for address in &self.addresses {
            e.str(address)?;
        }
        e.str("snapshot-seconds")?.i64(self.snapshot_seconds)?;
        e.ok()
    }
}

impl Decode<'_, ()> for PeerAdvert {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        peer_advert_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn peer_advert_from(d: &mut Decoder<'_>) -> Result<PeerAdvert, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut device: Option<DeviceId> = None;
    let mut addresses: Option<Vec<String>> = None;
    let mut snapshot_seconds: Option<i64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "device" => strict::set_once(&mut device, device_id_from(d)?)?,
            "addresses" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(strict::text_value(d)?);
                }
                addresses = Some(list);
            }
            "snapshot-seconds" => strict::set_once(&mut snapshot_seconds, strict::int_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(PeerAdvert {
        device: device.ok_or(DecodeError::MissingField("device"))?,
        addresses: addresses.ok_or(DecodeError::MissingField("addresses"))?,
        snapshot_seconds: snapshot_seconds.ok_or(DecodeError::MissingField("snapshot-seconds"))?,
    })
}

/// `gossip-frame = { type: "gossip", peers }`. CDE key order: `type` (5),
/// `peers` (8).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GossipFrame {
    pub peers: Vec<PeerAdvert>,
}

impl GossipFrame {
    pub const TYPE: &'static str = "gossip";
}

impl Encode<()> for GossipFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("peers")?.array(self.peers.len() as u64)?;
        for peer in &self.peers {
            peer.encode(e, &mut ())?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for GossipFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        gossip_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn gossip_from(d: &mut Decoder<'_>) -> Result<GossipFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut peers: Option<Vec<PeerAdvert>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, GossipFrame::TYPE)?,
            "peers" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(peer_advert_from(d)?);
                }
                peers = Some(list);
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(GossipFrame {
        peers: peers.ok_or(DecodeError::MissingField("peers"))?,
    })
}

/// `candidate-kind = "host" / "server-reflexive" / "relayed"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CandidateKind {
    Host,
    ServerReflexive,
    Relayed,
}

impl CandidateKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            CandidateKind::Host => "host",
            CandidateKind::ServerReflexive => "server-reflexive",
            CandidateKind::Relayed => "relayed",
        }
    }
}

impl Encode<()> for CandidateKind {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.str(self.as_str())?.ok()
    }
}

impl Decode<'_, ()> for CandidateKind {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        let found = strict::text_value(d).map_err(minicbor::decode::Error::custom)?;
        match found.as_str() {
            "host" => Ok(CandidateKind::Host),
            "server-reflexive" => Ok(CandidateKind::ServerReflexive),
            "relayed" => Ok(CandidateKind::Relayed),
            other => Err(minicbor::decode::Error::custom(DecodeError::BadLiteral {
                expected: "host | server-reflexive | relayed",
                found: other.to_owned(),
            })),
        }
    }
}

/// `wire-candidate = { address, kind, priority }`. CDE key order: `kind`
/// (5), `address` (8), `priority` (9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireCandidate {
    /// `ip:port`.
    pub address: String,
    pub kind: CandidateKind,
    pub priority: u64,
}

impl Encode<()> for WireCandidate {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("kind")?.encode(self.kind)?;
        e.str("address")?.str(&self.address)?;
        e.str("priority")?.u64(self.priority)?;
        e.ok()
    }
}

impl Decode<'_, ()> for WireCandidate {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        wire_candidate_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn wire_candidate_from(d: &mut Decoder<'_>) -> Result<WireCandidate, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut address: Option<String> = None;
    let mut kind: Option<CandidateKind> = None;
    let mut priority: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "address" => strict::set_once(&mut address, strict::text_value(d)?)?,
            "kind" => {
                kind = Some(
                    CandidateKind::decode(d, &mut ())
                        .map_err(|e| DecodeError::Malformed(e.to_string()))?,
                )
            }
            "priority" => strict::set_once(&mut priority, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(WireCandidate {
        address: address.ok_or(DecodeError::MissingField("address"))?,
        kind: kind.ok_or(DecodeError::MissingField("kind"))?,
        priority: priority.ok_or(DecodeError::MissingField("priority"))?,
    })
}

/// `candidates-frame = { type: "candidates", candidates }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CandidatesFrame {
    pub candidates: Vec<WireCandidate>,
}

impl CandidatesFrame {
    pub const TYPE: &'static str = "candidates";
}

impl Encode<()> for CandidatesFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("candidates")?.array(self.candidates.len() as u64)?;
        for candidate in &self.candidates {
            candidate.encode(e, &mut ())?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for CandidatesFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        candidates_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn candidates_from(d: &mut Decoder<'_>) -> Result<CandidatesFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut candidates: Option<Vec<WireCandidate>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, CandidatesFrame::TYPE)?,
            "candidates" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(wire_candidate_from(d)?);
                }
                candidates = Some(list);
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(CandidatesFrame {
        candidates: candidates.ok_or(DecodeError::MissingField("candidates"))?,
    })
}

/// `sync-punch-frame = { type, nonce, deadline-unix-ms }`. CDE key order:
/// `type` (5), `nonce` (6), `deadline-unix-ms` (18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncPunchFrame {
    pub nonce: u64,
    pub deadline_unix_ms: u64,
}

impl SyncPunchFrame {
    pub const TYPE: &'static str = "sync-punch";
}

impl Encode<()> for SyncPunchFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("nonce")?.u64(self.nonce)?;
        e.str("deadline-unix-ms")?.u64(self.deadline_unix_ms)?;
        e.ok()
    }
}

impl Decode<'_, ()> for SyncPunchFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        sync_punch_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn sync_punch_from(d: &mut Decoder<'_>) -> Result<SyncPunchFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut nonce: Option<u64> = None;
    let mut deadline_unix_ms: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, SyncPunchFrame::TYPE)?,
            "nonce" => strict::set_once(&mut nonce, strict::uint_value(d)?)?,
            "deadline-unix-ms" => strict::set_once(&mut deadline_unix_ms, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(SyncPunchFrame {
        nonce: nonce.ok_or(DecodeError::MissingField("nonce"))?,
        deadline_unix_ms: deadline_unix_ms.ok_or(DecodeError::MissingField("deadline-unix-ms"))?,
    })
}

/// `observed-address-frame = { type, address }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservedAddressFrame {
    pub address: String,
}

impl ObservedAddressFrame {
    pub const TYPE: &'static str = "observed-address";
}

impl Encode<()> for ObservedAddressFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("address")?.str(&self.address)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ObservedAddressFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        observed_address_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn observed_address_from(
    d: &mut Decoder<'_>,
) -> Result<ObservedAddressFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut address: Option<String> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, ObservedAddressFrame::TYPE)?,
            "address" => strict::set_once(&mut address, strict::text_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(ObservedAddressFrame {
        address: address.ok_or(DecodeError::MissingField("address"))?,
    })
}

/// `relay-offer-frame = { type, addresses }`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RelayOfferFrame {
    pub addresses: Vec<String>,
}

impl RelayOfferFrame {
    pub const TYPE: &'static str = "relay-offer";
}

impl Encode<()> for RelayOfferFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("addresses")?.array(self.addresses.len() as u64)?;
        for address in &self.addresses {
            e.str(address)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for RelayOfferFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        relay_offer_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn relay_offer_from(d: &mut Decoder<'_>) -> Result<RelayOfferFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut addresses: Option<Vec<String>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, RelayOfferFrame::TYPE)?,
            "addresses" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(strict::text_value(d)?);
                }
                addresses = Some(list);
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(RelayOfferFrame {
        addresses: addresses.ok_or(DecodeError::MissingField("addresses"))?,
    })
}

/// `relay-connect-frame = { type, target-device }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayConnectFrame {
    pub target_device: DeviceId,
}

impl RelayConnectFrame {
    pub const TYPE: &'static str = "relay-connect";
}

impl Encode<()> for RelayConnectFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("target-device")?.encode(self.target_device)?;
        e.ok()
    }
}

impl Decode<'_, ()> for RelayConnectFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        relay_connect_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn relay_connect_from(d: &mut Decoder<'_>) -> Result<RelayConnectFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut target_device: Option<DeviceId> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, RelayConnectFrame::TYPE)?,
            "target-device" => strict::set_once(&mut target_device, device_id_from(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(RelayConnectFrame {
        target_device: target_device.ok_or(DecodeError::MissingField("target-device"))?,
    })
}

/// `relay-data-frame = { type, payload, ? to-device, ? from-device }`. The
/// payload is ciphertext established one layer above the transport; this
/// layer never interprets it. `to-device`/`from-device` disambiguate which
/// pairing a frame belongs to when a connection holds more than one relay
/// pairing at once; a connection with exactly one pairing may omit
/// `to-device`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayDataFrame {
    pub payload: Vec<u8>,
    pub to_device: Option<DeviceId>,
    pub from_device: Option<DeviceId>,
}

impl RelayDataFrame {
    pub const TYPE: &'static str = "relay-data";
}

impl Encode<()> for RelayDataFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let field_count = 2 + self.to_device.is_some() as u64 + self.from_device.is_some() as u64;
        e.map(field_count)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("payload")?.bytes(&self.payload)?;
        if let Some(to_device) = self.to_device {
            e.str("to-device")?.encode(to_device)?;
        }
        if let Some(from_device) = self.from_device {
            e.str("from-device")?.encode(from_device)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for RelayDataFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        relay_data_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn relay_data_from(d: &mut Decoder<'_>) -> Result<RelayDataFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut payload: Option<Vec<u8>> = None;
    let mut to_device: Option<DeviceId> = None;
    let mut from_device: Option<DeviceId> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, RelayDataFrame::TYPE)?,
            "payload" => strict::set_once(&mut payload, strict::bytes_value(d)?)?,
            "to-device" => strict::set_once(&mut to_device, device_id_from(d)?)?,
            "from-device" => strict::set_once(&mut from_device, device_id_from(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(RelayDataFrame {
        payload: payload.ok_or(DecodeError::MissingField("payload"))?,
        to_device,
        from_device,
    })
}

/// `relay-inbound-frame = { type, source-device }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayInboundFrame {
    pub source_device: DeviceId,
}

impl RelayInboundFrame {
    pub const TYPE: &'static str = "relay-inbound";
}

impl Encode<()> for RelayInboundFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(2)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("source-device")?.encode(self.source_device)?;
        e.ok()
    }
}

impl Decode<'_, ()> for RelayInboundFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        relay_inbound_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn relay_inbound_from(d: &mut Decoder<'_>) -> Result<RelayInboundFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut source_device: Option<DeviceId> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, RelayInboundFrame::TYPE)?,
            "source-device" => strict::set_once(&mut source_device, device_id_from(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(RelayInboundFrame {
        source_device: source_device.ok_or(DecodeError::MissingField("source-device"))?,
    })
}

/// `coordinator-frame = { type: "coordinator", term, coordinator, ? capacity-hint }`.
///
/// The redesigned gossiped election claim: `term` is a monotonically
/// increasing epoch a peer raises when claiming the introduction/
/// rendezvous role; a higher term always supersedes a lower one, and equal
/// terms break by lowest device-id — a receiver obligation, not a wire
/// constraint. CDE key order: `term` (5; bytewise before `type`), `type`
/// (5), `coordinator` (12), `capacity-hint` (14).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordinatorFrame {
    pub term: u64,
    pub coordinator: DeviceId,
    pub capacity_hint: Option<u64>,
}

impl CoordinatorFrame {
    pub const TYPE: &'static str = "coordinator";
}

impl Encode<()> for CoordinatorFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len = 3 + usize::from(self.capacity_hint.is_some());
        e.map(len as u64)?;
        e.str("term")?.u64(self.term)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("coordinator")?.encode(self.coordinator)?;
        if let Some(hint) = self.capacity_hint {
            e.str("capacity-hint")?.u64(hint)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for CoordinatorFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        coordinator_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn coordinator_from(d: &mut Decoder<'_>) -> Result<CoordinatorFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut term: Option<u64> = None;
    let mut coordinator: Option<DeviceId> = None;
    let mut capacity_hint: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, CoordinatorFrame::TYPE)?,
            "term" => strict::set_once(&mut term, strict::uint_value(d)?)?,
            "coordinator" => strict::set_once(&mut coordinator, device_id_from(d)?)?,
            "capacity-hint" => strict::set_once(&mut capacity_hint, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(CoordinatorFrame {
        term: term.ok_or(DecodeError::MissingField("term"))?,
        coordinator: coordinator.ok_or(DecodeError::MissingField("coordinator"))?,
        capacity_hint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_frame_rejects_unsorted_keys() {
        // { "reason": "b", "type": "close" }: "type" (5 bytes) sorts before
        // "reason" (7), so reason-first is out of CDE order.
        let bytes = [
            0xa2, 0x66, b'r', b'e', b'a', b's', b'o', b'n', 0x61, b'b', 0x64, b't', b'y', b'p',
            b'e', 0x65, b'c', b'l', b'o', b's', b'e',
        ];
        let mut d = Decoder::new(&bytes);
        assert_eq!(close_from(&mut d), Err(DecodeError::UnsortedMapKeys));
    }

    fn round_trip<T>(value: T) -> Vec<u8>
    where
        T: Encode<()> + PartialEq + core::fmt::Debug + for<'a> Decode<'a, ()>,
    {
        let bytes = minicbor::to_vec(&value).expect("encode");
        let back: T = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, value, "round trip");
        bytes
    }

    #[test]
    fn ping_encodes_exactly() {
        let bytes = round_trip(PingFrame);
        assert_eq!(
            bytes,
            [0xa1, 0x64, b't', b'y', b'p', b'e', 0x64, b'p', b'i', b'n', b'g']
        );
    }

    #[test]
    fn close_reason_after_type() {
        let bytes = round_trip(CloseFrame {
            reason: Some("bye".to_owned()),
        });
        // type (5 encoded bytes) before reason (9).
        let type_at = bytes
            .windows(4)
            .position(|w| w == b"type")
            .expect("type key");
        let reason_at = bytes
            .windows(6)
            .position(|w| w == b"reason")
            .expect("reason key");
        assert!(type_at < reason_at);
    }

    #[test]
    fn peer_advert_cde_order() {
        let bytes = round_trip(PeerAdvert {
            device: DeviceId([1; 32]),
            addresses: vec!["203.0.113.5:4433".to_owned()],
            snapshot_seconds: 1861833600,
        });
        let device_at = bytes
            .windows(6)
            .position(|w| w == b"device")
            .expect("device key");
        let addresses_at = bytes
            .windows(9)
            .position(|w| w == b"addresses")
            .expect("addresses key");
        let snapshot_at = bytes
            .windows(16)
            .position(|w| w == b"snapshot-seconds")
            .expect("snapshot key");
        assert!(device_at < addresses_at && addresses_at < snapshot_at);
    }

    #[test]
    fn candidate_kind_literals() {
        assert_eq!(CandidateKind::Host.as_str(), "host");
        let bytes = round_trip(WireCandidate {
            address: "198.51.100.2:7000".to_owned(),
            kind: CandidateKind::Relayed,
            priority: 10,
        });
        // kind (5) before address (8) before priority (9).
        let kind_at = bytes
            .windows(4)
            .position(|w| w == b"kind")
            .expect("kind key");
        let address_at = bytes
            .windows(7)
            .position(|w| w == b"address")
            .expect("address key");
        let priority_at = bytes
            .windows(8)
            .position(|w| w == b"priority")
            .expect("priority key");
        assert!(kind_at < address_at && address_at < priority_at);
        let bad: Result<CandidateKind, _> = minicbor::decode(&[0x6d, b'p', b'e', b'e', b'r']);
        assert!(bad.is_err());
    }

    #[test]
    fn coordinator_term_before_type_before_coordinator() {
        let bytes = round_trip(CoordinatorFrame {
            term: 3,
            coordinator: DeviceId([0x11; 32]),
            capacity_hint: Some(64),
        });
        let term_at = bytes
            .windows(4)
            .position(|w| w == b"term")
            .expect("term key");
        let type_at = bytes
            .windows(4)
            .position(|w| w == b"type")
            .expect("type key");
        let coord_at = bytes
            .windows(11)
            .position(|w| w == b"coordinator")
            .expect("coordinator key");
        let hint_at = bytes
            .windows(13)
            .position(|w| w == b"capacity-hint")
            .expect("hint key");
        assert!(term_at < type_at && type_at < coord_at && coord_at < hint_at);
        assert_eq!(bytes[0], 0xa4);
    }

    #[test]
    fn relay_frames_round_trip() {
        round_trip(RelayOfferFrame {
            addresses: vec!["relay.example.com:4433".to_owned()],
        });
        round_trip(RelayConnectFrame {
            target_device: DeviceId([2; 32]),
        });
        round_trip(RelayDataFrame {
            payload: vec![9, 9, 9],
            to_device: None,
            from_device: None,
        });
        round_trip(RelayDataFrame {
            payload: vec![9, 9, 9],
            to_device: Some(DeviceId([4; 32])),
            from_device: Some(DeviceId([5; 32])),
        });
        round_trip(RelayInboundFrame {
            source_device: DeviceId([3; 32]),
        });
    }

    #[test]
    fn unknown_key_rejected() {
        // {"type": "ping", "extra": 1}
        let bytes: Vec<u8> = [
            0xa2u8, 0x64, b't', b'y', b'p', b'e', 0x64, b'p', b'i', b'n', b'g', 0x65, b'e', b'x',
            b't', b'r', b'a', 0x01,
        ]
        .to_vec();
        assert!(minicbor::decode::<PingFrame>(&bytes).is_err());
    }
}
