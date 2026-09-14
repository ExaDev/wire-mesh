//! `bulk.cddl` — resumable, flow-controlled bulk transfer (wire-mesh#34/
//! #123). `bulk-open`/`bulk-resume`/`bulk-cancel` ride `manage-request-
//! frame`'s own untyped params catch-all (`ManageParams::Json`, the same
//! path `room-send`/`capability-request` already use) and need no typed
//! Rust struct here; the three frame kinds below are ordinary, closed
//! `$frame-variant` members, so — unlike the manage-command params — they
//! do need real typed structs the same way `stream-data-frame`/
//! `data-entries-frame` already do.
//!
//! `transfer-id` is durable per transfer, not per-connection: a chunk
//! keeps its `seq` no matter which connection eventually carries it, and
//! a fresh `bulk.resume` manage-command (not a new frame kind) is the
//! entire reconnection mechanism.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::strict;

/// `transfer-id = bstr .size 16`.
pub const TRANSFER_ID_BYTE_LENGTH: usize = 16;

/// `bulk-data-frame = { type, transfer-id, seq, bytes }`.
///
/// CDE key order: `seq` (4), `type` (5), `bytes` (6), `transfer-id` (12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkDataFrame {
    pub transfer_id: Vec<u8>,
    pub seq: u64,
    pub bytes: Vec<u8>,
}

impl BulkDataFrame {
    pub const TYPE: &'static str = "bulk-data";
}

impl Encode<()> for BulkDataFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(4)?;
        e.str("seq")?.u64(self.seq)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("bytes")?.bytes(&self.bytes)?;
        e.str("transfer-id")?.bytes(&self.transfer_id)?;
        e.ok()
    }
}

impl Decode<'_, ()> for BulkDataFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        bulk_data_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn bulk_data_from(d: &mut Decoder<'_>) -> Result<BulkDataFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut transfer_id: Option<Vec<u8>> = None;
    let mut seq: Option<u64> = None;
    let mut bytes: Option<Vec<u8>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, BulkDataFrame::TYPE)?,
            "transfer-id" => strict::set_once(&mut transfer_id, transfer_id_value(d)?)?,
            "seq" => strict::set_once(&mut seq, strict::uint_value(d)?)?,
            "bytes" => strict::set_once(&mut bytes, strict::bytes_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(BulkDataFrame {
        transfer_id: transfer_id.ok_or(DecodeError::MissingField("transfer-id"))?,
        seq: seq.ok_or(DecodeError::MissingField("seq"))?,
        bytes: bytes.ok_or(DecodeError::MissingField("bytes"))?,
    })
}

/// `bulk-ack-frame = { type, transfer-id, ack-seq, window }`.
///
/// CDE key order: `type` (5), `window` (7), `ack-seq` (8), `transfer-id`
/// (12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkAckFrame {
    pub transfer_id: Vec<u8>,
    /// The count of chunks durably persisted so far (equivalently, the
    /// seq the sender should send next) -- not "the highest index
    /// accepted", which has no way to express "nothing received yet"
    /// under uint's non-negative constraint.
    pub ack_seq: u64,
    /// Credit, in bytes, the receiver will accept past `ack_seq`.
    pub window: u64,
}

impl BulkAckFrame {
    pub const TYPE: &'static str = "bulk-ack";
}

impl Encode<()> for BulkAckFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(4)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("window")?.u64(self.window)?;
        e.str("ack-seq")?.u64(self.ack_seq)?;
        e.str("transfer-id")?.bytes(&self.transfer_id)?;
        e.ok()
    }
}

impl Decode<'_, ()> for BulkAckFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        bulk_ack_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn bulk_ack_from(d: &mut Decoder<'_>) -> Result<BulkAckFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut transfer_id: Option<Vec<u8>> = None;
    let mut ack_seq: Option<u64> = None;
    let mut window: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, BulkAckFrame::TYPE)?,
            "transfer-id" => strict::set_once(&mut transfer_id, transfer_id_value(d)?)?,
            "ack-seq" => strict::set_once(&mut ack_seq, strict::uint_value(d)?)?,
            "window" => strict::set_once(&mut window, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(BulkAckFrame {
        transfer_id: transfer_id.ok_or(DecodeError::MissingField("transfer-id"))?,
        ack_seq: ack_seq.ok_or(DecodeError::MissingField("ack-seq"))?,
        window: window.ok_or(DecodeError::MissingField("window"))?,
    })
}

/// `bulk-end-frame = { type, transfer-id, digest }`. Sent exactly once,
/// by the sender, once every chunk of the underlying source has been
/// transmitted -- deliberately independent of any other domain's own
/// lifecycle frame (e.g. a `core/exec` `stream-end-frame` signalling "the
/// process exited").
///
/// CDE key order: `type` (5), `digest` (7), `transfer-id` (12).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BulkEndFrame {
    pub transfer_id: Vec<u8>,
    pub digest: Vec<u8>,
}

impl BulkEndFrame {
    pub const TYPE: &'static str = "bulk-end";
}

impl Encode<()> for BulkEndFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("digest")?.bytes(&self.digest)?;
        e.str("transfer-id")?.bytes(&self.transfer_id)?;
        e.ok()
    }
}

impl Decode<'_, ()> for BulkEndFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        bulk_end_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn bulk_end_from(d: &mut Decoder<'_>) -> Result<BulkEndFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut transfer_id: Option<Vec<u8>> = None;
    let mut digest: Option<Vec<u8>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, BulkEndFrame::TYPE)?,
            "transfer-id" => strict::set_once(&mut transfer_id, transfer_id_value(d)?)?,
            "digest" => strict::set_once(&mut digest, strict::bytes_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(BulkEndFrame {
        transfer_id: transfer_id.ok_or(DecodeError::MissingField("transfer-id"))?,
        digest: digest.ok_or(DecodeError::MissingField("digest"))?,
    })
}

/// Decodes a `transfer-id` value, rejecting anything other than exactly
/// [`TRANSFER_ID_BYTE_LENGTH`] bytes -- the same strict-size obligation
/// `device_id_from` already enforces for `device-id`.
fn transfer_id_value(d: &mut Decoder<'_>) -> Result<Vec<u8>, DecodeError> {
    let bytes = strict::bytes_value(d)?;
    if bytes.len() != TRANSFER_ID_BYTE_LENGTH {
        return Err(DecodeError::InvalidLength {
            field: "transfer-id",
            expected: TRANSFER_ID_BYTE_LENGTH,
            found: bytes.len(),
        });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_transfer_id() -> Vec<u8> {
        vec![0xab; TRANSFER_ID_BYTE_LENGTH]
    }

    #[test]
    fn bulk_data_cde_order_and_round_trip() {
        let frame = BulkDataFrame {
            transfer_id: sample_transfer_id(),
            seq: 3,
            bytes: b"chunk".to_vec(),
        };
        let bytes = minicbor::to_vec(&frame).expect("encode");
        let back: BulkDataFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        let order: Vec<usize> = ["seq", "type", "bytes", "transfer-id"]
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
    fn bulk_ack_cde_order_and_round_trip() {
        let frame = BulkAckFrame {
            transfer_id: sample_transfer_id(),
            ack_seq: 9,
            window: 4096,
        };
        let bytes = minicbor::to_vec(&frame).expect("encode");
        let back: BulkAckFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        let order: Vec<usize> = ["type", "window", "ack-seq", "transfer-id"]
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
    fn bulk_end_cde_order_and_round_trip() {
        let frame = BulkEndFrame {
            transfer_id: sample_transfer_id(),
            digest: vec![0xcd; 32],
        };
        let bytes = minicbor::to_vec(&frame).expect("encode");
        let back: BulkEndFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        let order: Vec<usize> = ["type", "digest", "transfer-id"]
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
    fn bulk_data_rejects_a_transfer_id_of_the_wrong_length() {
        let mut e = minicbor::Encoder::new(Vec::new());
        e.map(4)
            .and_then(|e| e.str("seq"))
            .and_then(|e| e.u64(1))
            .and_then(|e| e.str("type"))
            .and_then(|e| e.str(BulkDataFrame::TYPE))
            .and_then(|e| e.str("bytes"))
            .and_then(|e| e.bytes(b"x"))
            .and_then(|e| e.str("transfer-id"))
            .and_then(|e| e.bytes(&[0u8; 4]))
            .expect("encode");
        let result: Result<BulkDataFrame, _> = minicbor::decode(e.writer());
        assert!(result.is_err());
    }
}
