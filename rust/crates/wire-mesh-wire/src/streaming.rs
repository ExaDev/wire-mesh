//! `streaming.cddl` — the generic credit-window streaming/backpressure
//! pattern, reusable by any capability domain that carries a live byte
//! stream (core/exec's stdio today).
//!
//! A consumer advertises a credit window; the producer must never send
//! past `ack_seq + window`, so a slow consumer throttles the producer
//! rather than the node buffering unboundedly. `session` is opaque and
//! scoped to one connection. `stream-end` is sent exactly once, on the
//! session's terminal exit, and is not credit-gated: it carries no
//! sequence number and is routed without an ack.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::strict;

/// `stream-session = uint`, opaque, scoped to one connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Default)]
pub struct StreamSession(pub u64);

/// `stream-data-frame = { type, session, seq, channel, bytes }`.
///
/// CDE key order: `seq` (4), `type` (5), `bytes` (6), `channel` (8),
/// `session` (8; bytewise after `channel`). `seq` is per-session
/// monotonic, for ordering and ack; `channel` is a domain-defined tag
/// (core/exec's "stdin"/"stdout"/"stderr").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamDataFrame {
    pub session: StreamSession,
    pub seq: u64,
    pub channel: String,
    pub bytes: Vec<u8>,
}

impl StreamDataFrame {
    pub const TYPE: &'static str = "stream-data";
}

impl Encode<()> for StreamDataFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(5)?;
        e.str("seq")?.u64(self.seq)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("bytes")?.bytes(&self.bytes)?;
        e.str("channel")?.str(&self.channel)?;
        e.str("session")?.u64(self.session.0)?;
        e.ok()
    }
}

impl Decode<'_, ()> for StreamDataFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        stream_data_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn stream_data_from(d: &mut Decoder<'_>) -> Result<StreamDataFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut session: Option<u64> = None;
    let mut seq: Option<u64> = None;
    let mut channel: Option<String> = None;
    let mut bytes: Option<Vec<u8>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, StreamDataFrame::TYPE)?,
            "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
            "seq" => strict::set_once(&mut seq, strict::uint_value(d)?)?,
            "channel" => strict::set_once(&mut channel, strict::text_value(d)?)?,
            "bytes" => strict::set_once(&mut bytes, strict::bytes_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(StreamDataFrame {
        session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
        seq: seq.ok_or(DecodeError::MissingField("seq"))?,
        channel: channel.ok_or(DecodeError::MissingField("channel"))?,
        bytes: bytes.ok_or(DecodeError::MissingField("bytes"))?,
    })
}

/// `stream-ack-frame = { type, session, ack-seq, window }`.
///
/// CDE key order: `type` (5), `window` (7), `ack-seq` (8; bytewise before
/// `session`), `session` (8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamAckFrame {
    pub session: StreamSession,
    /// Highest contiguous sequence accepted.
    pub ack_seq: u64,
    /// Credit, in bytes, the consumer will accept past `ack_seq`.
    pub window: u64,
}

impl StreamAckFrame {
    pub const TYPE: &'static str = "stream-ack";
}

impl Encode<()> for StreamAckFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(4)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("window")?.u64(self.window)?;
        e.str("ack-seq")?.u64(self.ack_seq)?;
        e.str("session")?.u64(self.session.0)?;
        e.ok()
    }
}

impl Decode<'_, ()> for StreamAckFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        stream_ack_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn stream_ack_from(d: &mut Decoder<'_>) -> Result<StreamAckFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut session: Option<u64> = None;
    let mut ack_seq: Option<u64> = None;
    let mut window: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, StreamAckFrame::TYPE)?,
            "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
            "ack-seq" => strict::set_once(&mut ack_seq, strict::uint_value(d)?)?,
            "window" => strict::set_once(&mut window, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(StreamAckFrame {
        session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
        ack_seq: ack_seq.ok_or(DecodeError::MissingField("ack-seq"))?,
        window: window.ok_or(DecodeError::MissingField("window"))?,
    })
}

/// `stream-end-frame = { type, session, ? exit-code, ? exit-signal }`.
///
/// CDE key order: `type` (5), `session` (8), `exit-code` (11),
/// `exit-signal` (13).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StreamEndFrame {
    pub session: StreamSession,
    pub exit_code: Option<i64>,
    pub exit_signal: Option<i64>,
}

impl StreamEndFrame {
    pub const TYPE: &'static str = "stream-end";
}

impl Encode<()> for StreamEndFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        let len =
            2 + usize::from(self.exit_code.is_some()) + usize::from(self.exit_signal.is_some());
        e.map(len as u64)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("session")?.u64(self.session.0)?;
        if let Some(code) = self.exit_code {
            e.str("exit-code")?.i64(code)?;
        }
        if let Some(signal) = self.exit_signal {
            e.str("exit-signal")?.i64(signal)?;
        }
        e.ok()
    }
}

impl Decode<'_, ()> for StreamEndFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        stream_end_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn stream_end_from(d: &mut Decoder<'_>) -> Result<StreamEndFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut session: Option<u64> = None;
    let mut exit_code: Option<i64> = None;
    let mut exit_signal: Option<i64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, StreamEndFrame::TYPE)?,
            "session" => strict::set_once(&mut session, strict::uint_value(d)?)?,
            "exit-code" => strict::set_once(&mut exit_code, strict::int_value(d)?)?,
            "exit-signal" => strict::set_once(&mut exit_signal, strict::int_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(StreamEndFrame {
        session: StreamSession(session.ok_or(DecodeError::MissingField("session"))?),
        exit_code,
        exit_signal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_data_cde_order() {
        let frame = StreamDataFrame {
            session: StreamSession(7),
            seq: 2,
            channel: "stdout".to_owned(),
            bytes: b"chunk".to_vec(),
        };
        let bytes = minicbor::to_vec(&frame).expect("encode");
        let back: StreamDataFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        // seq (4 encoded bytes), type (5), bytes (6), channel (8; bytewise before session), session (8).
        let order: Vec<usize> = ["seq", "type", "bytes", "channel", "session"]
            .iter()
            .map(|k| {
                bytes
                    .windows(k.len())
                    .position(|w| w == k.as_bytes())
                    .expect("key present")
            })
            .collect();
        let mut sorted = order.clone();
        sorted.sort_unstable();
        assert_eq!(
            order, sorted,
            "keys must appear in ascending encoded-length order"
        );
    }

    #[test]
    fn stream_ack_window_before_ack_seq() {
        let frame = StreamAckFrame {
            session: StreamSession(1),
            ack_seq: 5,
            window: 4096,
        };
        let bytes = minicbor::to_vec(frame).expect("encode");
        let back: StreamAckFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        let window_at = bytes
            .windows(6)
            .position(|w| w == b"window")
            .expect("window");
        let ack_at = bytes
            .windows(7)
            .position(|w| w == b"ack-seq")
            .expect("ack-seq");
        let session_at = bytes
            .windows(7)
            .position(|w| w == b"session")
            .expect("session");
        assert!(window_at < ack_at && ack_at < session_at);
    }

    #[test]
    fn stream_end_optional_fields() {
        let frame = StreamEndFrame {
            session: StreamSession(7),
            exit_code: Some(0),
            exit_signal: None,
        };
        let bytes = minicbor::to_vec(frame).expect("encode");
        assert_eq!(bytes[0], 0xa3);
        let back: StreamEndFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
    }
}
