//! `data-domain.cddl` — the single-writer append-only oplog replication
//! envelope. Entries are opaque bytes to this layer, exactly as to the
//! wire: a domain implementing core/data defines its own entry schema in
//! its own application-level spec, never here.

use minicbor::{Decode, Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::identity::{device_id_from, DeviceId};
use crate::strict;

/// `data-have-frame = { type: "data-have", peer, head-seq }`.
///
/// CDE key order: `peer` (5; bytewise before `type`), `type` (5),
/// `head-seq` (9). `peer` names whose log is being asked about,
/// deliberately independent of which connection the frame travels over.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataHaveFrame {
    pub peer: DeviceId,
    pub head_seq: u64,
}

impl DataHaveFrame {
    pub const TYPE: &'static str = "data-have";
}

impl Encode<()> for DataHaveFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("peer")?.encode(self.peer)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("head-seq")?.u64(self.head_seq)?;
        e.ok()
    }
}

impl Decode<'_, ()> for DataHaveFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        data_have_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn data_have_from(d: &mut Decoder<'_>) -> Result<DataHaveFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut peer: Option<DeviceId> = None;
    let mut head_seq: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, DataHaveFrame::TYPE)?,
            "peer" => strict::set_once(&mut peer, device_id_from(d)?)?,
            "head-seq" => strict::set_once(&mut head_seq, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(DataHaveFrame {
        peer: peer.ok_or(DecodeError::MissingField("peer"))?,
        head_seq: head_seq.ok_or(DecodeError::MissingField("head-seq"))?,
    })
}

/// `data-request-frame = { type, peer, from-seq }`, `from-seq` an
/// exclusive lower bound. CDE key order: `peer` (5), `type` (5),
/// `from-seq` (9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataRequestFrame {
    pub peer: DeviceId,
    pub from_seq: u64,
}

impl DataRequestFrame {
    pub const TYPE: &'static str = "data-request";
}

impl Encode<()> for DataRequestFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(3)?;
        e.str("peer")?.encode(self.peer)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("from-seq")?.u64(self.from_seq)?;
        e.ok()
    }
}

impl Decode<'_, ()> for DataRequestFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        data_request_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn data_request_from(d: &mut Decoder<'_>) -> Result<DataRequestFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut peer: Option<DeviceId> = None;
    let mut from_seq: Option<u64> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, DataRequestFrame::TYPE)?,
            "peer" => strict::set_once(&mut peer, device_id_from(d)?)?,
            "from-seq" => strict::set_once(&mut from_seq, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(DataRequestFrame {
        peer: peer.ok_or(DecodeError::MissingField("peer"))?,
        from_seq: from_seq.ok_or(DecodeError::MissingField("from-seq"))?,
    })
}

/// `data-entries-frame = { type, peer, from-seq, entries }`.
///
/// The i-th entry (zero-based) carries sequence `from-seq + 1 + i`; a
/// receiver rejects a frame whose `from-seq` would leave a gap against
/// what it already holds for that peer — a receiver obligation, not a
/// wire constraint. CDE key order: `peer` (5), `type` (5), `entries` (8),
/// `from-seq` (9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DataEntriesFrame {
    pub peer: DeviceId,
    pub from_seq: u64,
    pub entries: Vec<Vec<u8>>,
}

impl DataEntriesFrame {
    pub const TYPE: &'static str = "data-entries";
}

impl Encode<()> for DataEntriesFrame {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        _ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(4)?;
        e.str("peer")?.encode(self.peer)?;
        e.str("type")?.str(Self::TYPE)?;
        e.str("entries")?.array(self.entries.len() as u64)?;
        for entry in &self.entries {
            e.bytes(entry)?;
        }
        e.str("from-seq")?.u64(self.from_seq)?;
        e.ok()
    }
}

impl Decode<'_, ()> for DataEntriesFrame {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        data_entries_from(d).map_err(minicbor::decode::Error::custom)
    }
}

pub(crate) fn data_entries_from(d: &mut Decoder<'_>) -> Result<DataEntriesFrame, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut peer: Option<DeviceId> = None;
    let mut from_seq: Option<u64> = None;
    let mut entries: Option<Vec<Vec<u8>>> = None;
    while let Some(key) = map.next_key(d)? {
        match key {
            "type" => strict::literal(d, DataEntriesFrame::TYPE)?,
            "peer" => strict::set_once(&mut peer, device_id_from(d)?)?,
            "from-seq" => strict::set_once(&mut from_seq, strict::uint_value(d)?)?,
            "entries" => {
                let count = strict::definite_array(d)?;
                let mut list = Vec::new();
                for _ in 0..count {
                    list.push(strict::bytes_value(d)?);
                }
                entries = Some(list);
            }
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }
    Ok(DataEntriesFrame {
        peer: peer.ok_or(DecodeError::MissingField("peer"))?,
        from_seq: from_seq.ok_or(DecodeError::MissingField("from-seq"))?,
        entries: entries.ok_or(DecodeError::MissingField("entries"))?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_sorts_before_type() {
        let frame = DataEntriesFrame {
            peer: DeviceId([0x11; 32]),
            from_seq: 100,
            entries: vec![vec![0xaa, 0xbb, 0xcc], vec![0xdd, 0xee, 0xff, 0x00]],
        };
        let bytes = minicbor::to_vec(&frame).expect("encode");
        let back: DataEntriesFrame = minicbor::decode(&bytes).expect("decode");
        assert_eq!(back, frame);
        // "peer" (5 encoded bytes) and "type" (5): bytewise p < t.
        let peer_at = bytes.windows(4).position(|w| w == b"peer").expect("peer");
        let type_at = bytes.windows(4).position(|w| w == b"type").expect("type");
        assert!(peer_at < type_at);
        // entries (8) before from-seq (9).
        let entries_at = bytes
            .windows(7)
            .position(|w| w == b"entries")
            .expect("entries");
        let from_at = bytes
            .windows(8)
            .position(|w| w == b"from-seq")
            .expect("from-seq");
        assert!(entries_at < from_at);
    }
}
