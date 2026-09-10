//! `frame.cddl` — the top-level `$frame-variant` socket as one Rust enum.
//!
//! Exactly 21 variants, no federation frames: the federation link protocol
//! is retired (`spec/federation.cddl` defines no rules) and `core/federation`
//! is a reserved domain name that must never be advertised or negotiated —
//! enforced at handshake validation, not here, because no federation frame
//! exists to reject.
//!
//! A frame's kind is carried by the map's `type` key, CDDL's own
//! tagged-union mechanism, not an external `[type][body]` byte header.
//! Decoding is two-pass: the `type` discriminant is located first (it is
//! *not* necessarily the first key in stream order — a CDE-encoded
//! data-have frame starts with `peer`, which sorts before `type` bytewise
//! at equal encoded length), then the decoder rewinds and dispatches to
//! the per-family decoder.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::data::{
    data_entries_from, data_have_from, data_request_from, DataEntriesFrame, DataHaveFrame,
    DataRequestFrame,
};
use crate::error::DecodeError;
use crate::handshake::{handshake_from, HandshakeFrame};
use crate::management::{
    manage_request_from, manage_response_from, revocation_announce_from, ManageRequestFrame,
    ManageResponseFrame, RevocationAnnounceFrame,
};
use crate::streaming::{
    stream_ack_from, stream_data_from, stream_end_from, StreamAckFrame, StreamDataFrame,
    StreamEndFrame,
};
use crate::strict;
use crate::transport::{
    candidates_from, close_from, coordinator_from, gossip_from, observed_address_from, ping_from,
    relay_connect_from, relay_data_from, relay_inbound_from, relay_offer_from, sync_punch_from,
    CandidatesFrame, CloseFrame, CoordinatorFrame, GossipFrame, ObservedAddressFrame, PingFrame,
    RelayConnectFrame, RelayDataFrame, RelayInboundFrame, RelayOfferFrame, SyncPunchFrame,
};

/// The top-level frame socket: one variant per `$frame-variant` member.
///
/// `ManageRequest` is boxed: it carries an optional COSE_Sign1 token and a
/// command params payload, making it several times larger than every other
/// variant, and an unboxed copy would tax every `Frame` move on the hot
/// path for a cold-path size win.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Handshake(HandshakeFrame),
    Ping(PingFrame),
    Close(CloseFrame),
    Gossip(GossipFrame),
    Candidates(CandidatesFrame),
    SyncPunch(SyncPunchFrame),
    ObservedAddress(ObservedAddressFrame),
    RelayOffer(RelayOfferFrame),
    RelayConnect(RelayConnectFrame),
    RelayData(RelayDataFrame),
    RelayInbound(RelayInboundFrame),
    Coordinator(CoordinatorFrame),
    ManageRequest(Box<ManageRequestFrame>),
    ManageResponse(ManageResponseFrame),
    RevocationAnnounce(RevocationAnnounceFrame),
    StreamData(StreamDataFrame),
    StreamAck(StreamAckFrame),
    StreamEnd(StreamEndFrame),
    DataHave(DataHaveFrame),
    DataRequest(DataRequestFrame),
    DataEntries(DataEntriesFrame),
}

impl Frame {
    /// The literal carried in the map's `type` key.
    pub fn kind(&self) -> &'static str {
        match self {
            Frame::Handshake(_) => HandshakeFrame::TYPE,
            Frame::Ping(_) => PingFrame::TYPE,
            Frame::Close(_) => CloseFrame::TYPE,
            Frame::Gossip(_) => GossipFrame::TYPE,
            Frame::Candidates(_) => CandidatesFrame::TYPE,
            Frame::SyncPunch(_) => SyncPunchFrame::TYPE,
            Frame::ObservedAddress(_) => ObservedAddressFrame::TYPE,
            Frame::RelayOffer(_) => RelayOfferFrame::TYPE,
            Frame::RelayConnect(_) => RelayConnectFrame::TYPE,
            Frame::RelayData(_) => RelayDataFrame::TYPE,
            Frame::RelayInbound(_) => RelayInboundFrame::TYPE,
            Frame::Coordinator(_) => CoordinatorFrame::TYPE,
            Frame::ManageRequest(_) => ManageRequestFrame::TYPE,
            Frame::ManageResponse(_) => ManageResponseFrame::TYPE,
            Frame::RevocationAnnounce(_) => RevocationAnnounceFrame::TYPE,
            Frame::StreamData(_) => StreamDataFrame::TYPE,
            Frame::StreamAck(_) => StreamAckFrame::TYPE,
            Frame::StreamEnd(_) => StreamEndFrame::TYPE,
            Frame::DataHave(_) => DataHaveFrame::TYPE,
            Frame::DataRequest(_) => DataRequestFrame::TYPE,
            Frame::DataEntries(_) => DataEntriesFrame::TYPE,
        }
    }

    /// Apply the string-format validation rules that decoding cannot
    /// express: domain tiers on a handshake (including the distinct
    /// retired-`core/federation` rejection), capability-verb tiers and
    /// scope shape on a manage request. Everything else is enforced
    /// structurally by strict decode.
    pub fn validate(&self) -> Result<(), ValidationError> {
        match self {
            Frame::Handshake(frame) => frame.validate().map_err(ValidationError::Domain),
            Frame::ManageRequest(frame) => {
                crate::tokens::CapabilityVerb::validate(&frame.command.verb.0)
                    .map_err(ValidationError::Verb)?;
                frame.scope.validate().map_err(ValidationError::Scope)
            }
            _ => Ok(()),
        }
    }

    /// Strictly decode a frame from a complete byte string, rejecting
    /// trailing bytes after the frame.
    pub fn decode_bytes(bytes: &[u8]) -> Result<Self, DecodeError> {
        let mut d = Decoder::new(bytes);
        let frame = frame_from(&mut d)?;
        if d.position() != bytes.len() {
            return Err(DecodeError::TrailingBytes {
                consumed: d.position(),
                total: bytes.len(),
            });
        }
        Ok(frame)
    }

    /// Encode to bytes.
    pub fn encode_to_vec(&self) -> Vec<u8> {
        minicbor::to_vec(self).unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"))
    }
}

/// Validation failure surfaced by [`Frame::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationError {
    Domain(crate::handshake::DomainError),
    Verb(crate::tokens::VerbError),
    Scope(crate::tokens::ScopeError),
}

impl core::fmt::Display for ValidationError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ValidationError::Domain(e) => write!(f, "domain: {e}"),
            ValidationError::Verb(e) => write!(f, "capability verb: {e}"),
            ValidationError::Scope(e) => write!(f, "scope: {e}"),
        }
    }
}

impl std::error::Error for ValidationError {}

impl Encode<()> for Frame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        match self {
            Frame::Handshake(f) => f.encode(e, &mut ()),
            Frame::Ping(f) => f.encode(e, &mut ()),
            Frame::Close(f) => f.encode(e, &mut ()),
            Frame::Gossip(f) => f.encode(e, &mut ()),
            Frame::Candidates(f) => f.encode(e, &mut ()),
            Frame::SyncPunch(f) => f.encode(e, &mut ()),
            Frame::ObservedAddress(f) => f.encode(e, &mut ()),
            Frame::RelayOffer(f) => f.encode(e, &mut ()),
            Frame::RelayConnect(f) => f.encode(e, &mut ()),
            Frame::RelayData(f) => f.encode(e, &mut ()),
            Frame::RelayInbound(f) => f.encode(e, &mut ()),
            Frame::Coordinator(f) => f.encode(e, &mut ()),
            Frame::ManageRequest(f) => f.encode(e, &mut ()),
            Frame::ManageResponse(f) => f.encode(e, &mut ()),
            Frame::RevocationAnnounce(f) => f.encode(e, &mut ()),
            Frame::StreamData(f) => f.encode(e, &mut ()),
            Frame::StreamAck(f) => f.encode(e, &mut ()),
            Frame::StreamEnd(f) => f.encode(e, &mut ()),
            Frame::DataHave(f) => f.encode(e, &mut ()),
            Frame::DataRequest(f) => f.encode(e, &mut ()),
            Frame::DataEntries(f) => f.encode(e, &mut ()),
        }
    }
}

impl Decode<'_, ()> for Frame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        frame_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn frame_from(d: &mut Decoder<'_>) -> Result<Frame, DecodeError> {
    let start = d.position();
    let mut map = strict::MapDecoder::new(d)?;
    let mut kind: Option<String> = None;
    let mut type_seen = false;
    while let Some(key) = map.next_key(d)? {
        if key == "type" {
            if type_seen {
                return Err(DecodeError::DuplicateKey);
            }
            type_seen = true;
            kind = Some(strict::text_value(d)?);
        } else {
            d.skip().map_err(DecodeError::from_minicbor)?;
        }
    }
    let kind = kind.ok_or(DecodeError::MissingField("type"))?;
    d.set_position(start);
    match kind.as_str() {
        HandshakeFrame::TYPE => Ok(Frame::Handshake(handshake_from(d)?)),
        PingFrame::TYPE => Ok(Frame::Ping(ping_from(d)?)),
        CloseFrame::TYPE => Ok(Frame::Close(close_from(d)?)),
        GossipFrame::TYPE => Ok(Frame::Gossip(gossip_from(d)?)),
        CandidatesFrame::TYPE => Ok(Frame::Candidates(candidates_from(d)?)),
        SyncPunchFrame::TYPE => Ok(Frame::SyncPunch(sync_punch_from(d)?)),
        ObservedAddressFrame::TYPE => Ok(Frame::ObservedAddress(observed_address_from(d)?)),
        RelayOfferFrame::TYPE => Ok(Frame::RelayOffer(relay_offer_from(d)?)),
        RelayConnectFrame::TYPE => Ok(Frame::RelayConnect(relay_connect_from(d)?)),
        RelayDataFrame::TYPE => Ok(Frame::RelayData(relay_data_from(d)?)),
        RelayInboundFrame::TYPE => Ok(Frame::RelayInbound(relay_inbound_from(d)?)),
        CoordinatorFrame::TYPE => Ok(Frame::Coordinator(coordinator_from(d)?)),
        ManageRequestFrame::TYPE => Ok(Frame::ManageRequest(Box::new(manage_request_from(d)?))),
        ManageResponseFrame::TYPE => Ok(Frame::ManageResponse(manage_response_from(d)?)),
        RevocationAnnounceFrame::TYPE => {
            Ok(Frame::RevocationAnnounce(revocation_announce_from(d)?))
        }
        StreamDataFrame::TYPE => Ok(Frame::StreamData(stream_data_from(d)?)),
        StreamAckFrame::TYPE => Ok(Frame::StreamAck(stream_ack_from(d)?)),
        StreamEndFrame::TYPE => Ok(Frame::StreamEnd(stream_end_from(d)?)),
        DataHaveFrame::TYPE => Ok(Frame::DataHave(data_have_from(d)?)),
        DataRequestFrame::TYPE => Ok(Frame::DataRequest(data_request_from(d)?)),
        DataEntriesFrame::TYPE => Ok(Frame::DataEntries(data_entries_from(d)?)),
        other => Err(DecodeError::BadLiteral {
            expected: "a known frame type",
            found: other.to_owned(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_variant_reports_its_kind() {
        // One of each family, exercising the dispatch table end to end.
        let frames = [
            Frame::Handshake(crate::decode_exact::<HandshakeFrame>(
                &hex("a364747970656968616e647368616b6567646f6d61696e738169636f72652f646174616776657273696f6e01"),
            ).expect("handshake")),
            Frame::Ping(PingFrame),
            Frame::Close(CloseFrame::default()),
            Frame::Gossip(GossipFrame::default()),
            Frame::Candidates(CandidatesFrame::default()),
            Frame::SyncPunch(SyncPunchFrame { nonce: 1, deadline_unix_ms: 2 }),
            Frame::ObservedAddress(ObservedAddressFrame { address: "a".to_owned() }),
            Frame::RelayOffer(RelayOfferFrame::default()),
            Frame::RelayConnect(RelayConnectFrame { target_device: crate::identity::DeviceId([1; 32]) }),
            Frame::RelayData(RelayDataFrame { payload: vec![1] }),
            Frame::RelayInbound(RelayInboundFrame { source_device: crate::identity::DeviceId([1; 32]) }),
            Frame::Coordinator(CoordinatorFrame { term: 1, coordinator: crate::identity::DeviceId([1; 32]), capacity_hint: None }),
            Frame::ManageRequest(Box::new(ManageRequestFrame {
                request_id: 1,
                command: crate::management::ManageCommand {
                    verb: crate::tokens::CapabilityVerb("exec:pty".to_owned()),
                    params: crate::management::ManageParams::ExecList(crate::exec::ExecList),
                },
                scope: crate::tokens::CapabilityScope { kind: "folder".to_owned(), path: None },
                token: None,
            })),
            Frame::ManageResponse(ManageResponseFrame {
                request_id: 1,
                outcome: crate::management::ManageOutcome::Ok(crate::management::ManageOk::default()),
            }),
            Frame::RevocationAnnounce(RevocationAnnounceFrame::default()),
            Frame::StreamData(StreamDataFrame { session: crate::streaming::StreamSession(1), seq: 1, channel: "stdin".to_owned(), bytes: vec![] }),
            Frame::StreamAck(StreamAckFrame { session: crate::streaming::StreamSession(1), ack_seq: 0, window: 1 }),
            Frame::StreamEnd(StreamEndFrame { session: crate::streaming::StreamSession(1), exit_code: None, exit_signal: None }),
            Frame::DataHave(DataHaveFrame { peer: crate::identity::DeviceId([1; 32]), head_seq: 0 }),
            Frame::DataRequest(DataRequestFrame { peer: crate::identity::DeviceId([1; 32]), from_seq: 0 }),
            Frame::DataEntries(DataEntriesFrame { peer: crate::identity::DeviceId([1; 32]), from_seq: 0, entries: vec![] }),
        ];
        let expected_kinds = [
            "handshake",
            "ping",
            "close",
            "gossip",
            "candidates",
            "sync-punch",
            "observed-address",
            "relay-offer",
            "relay-connect",
            "relay-data",
            "relay-inbound",
            "coordinator",
            "manage-request",
            "manage-response",
            "revocation-announce",
            "stream-data",
            "stream-ack",
            "stream-end",
            "data-have",
            "data-request",
            "data-entries",
        ];
        for (frame, kind) in frames.iter().zip(expected_kinds) {
            assert_eq!(frame.kind(), kind);
            let bytes = frame.encode_to_vec();
            let back = Frame::decode_bytes(&bytes).expect("decode");
            assert_eq!(&back, frame, "round trip of {kind}");
            assert_eq!(back.kind(), kind);
        }
        // 21 variants, exactly, no federation.
        assert_eq!(frames.len(), 21);
    }

    #[test]
    fn decode_finds_type_even_when_not_first_key() {
        // A CDE-encoded data-have puts "peer" before "type" (equal encoded length, bytewise p < t); the discriminant scan must still find "type" in stream position 2. Build the bytes with the encoder itself so the fixture can never drift from what CDE produces.
        let frame = Frame::DataHave(DataHaveFrame {
            peer: crate::identity::DeviceId([0x11; 32]),
            head_seq: 100,
        });
        let bytes = frame.encode_to_vec();
        let type_at = bytes
            .windows(4)
            .position(|w| w == b"type")
            .expect("type key");
        let peer_at = bytes
            .windows(4)
            .position(|w| w == b"peer")
            .expect("peer key");
        assert!(peer_at < type_at, "the fixture must really put peer first");
        let back = Frame::decode_bytes(&bytes).expect("decode");
        assert_eq!(back, frame);
        match back {
            Frame::DataHave(f) => assert_eq!(f.head_seq, 100),
            other => panic!("expected data-have, got {:?}", other.kind()),
        }
    }

    #[test]
    fn unknown_frame_type_rejected() {
        let bytes = [0xa1, 0x64, b't', b'y', b'p', b'e', 0x63, b'f', b'o', b'o'];
        assert!(Frame::decode_bytes(&bytes).is_err());
    }

    #[test]
    fn trailing_bytes_rejected() {
        let mut bytes = Frame::Ping(PingFrame).encode_to_vec();
        bytes.push(0x01);
        assert!(Frame::decode_bytes(&bytes).is_err());
    }

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex digit"))
            .collect()
    }
}
