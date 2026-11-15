//! The core/data sync primitive (`spec/data-domain.cddl`): the have, request and entries exchange over a single-writer, append-only log held in a [`KeyValueStorage`], ported from `data-sync.ts`.
//!
//! It is deliberately that primitive alone. When to broadcast a `data-have`, which peers' logs to track and how to fan a catch-up out across candidate holders are application decisions this module has no opinion on. It guarantees that appending to one's own log is correct and monotonic, and that syncing another log never accepts a gap.
//!
//! A log lives under two kinds of key: `data/<device-id-hex>/head` holds the head sequence as decimal text and `data/<device-id-hex>/entry/<seq>` holds one opaque entry. The layout is shared with the TypeScript core, so a store written by either is read by the other.

use wire_mesh_wire::data::{DataEntriesFrame, DataHaveFrame, DataRequestFrame};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::Frame;

use crate::domain::room_path::device_id_to_hex;
use crate::ports::{CoreError, KeyValueStorage};

fn head_key(peer: &DeviceId) -> String {
    format!("data/{}/head", device_id_to_hex(peer))
}

fn entry_key(peer: &DeviceId, seq: u64) -> String {
    format!("data/{}/entry/{seq}", device_id_to_hex(peer))
}

/// The head sequence this store holds for `peer`'s log, or 0 when nothing is held. A head that is not a decimal integer is a storage fault, never read as 0, so a corrupt store cannot make the log look empty and be overwritten.
async fn read_head_seq(storage: &dyn KeyValueStorage, peer: &DeviceId) -> Result<u64, CoreError> {
    let Some(raw) = storage.get(&head_key(peer)).await? else {
        return Ok(0);
    };
    std::str::from_utf8(&raw)
        .ok()
        .and_then(|text| text.parse::<u64>().ok())
        .ok_or_else(|| {
            CoreError::Storage(format!(
                "the head of the log of {} is not a decimal integer",
                device_id_to_hex(peer)
            ))
        })
}

async fn write_head_seq(
    storage: &dyn KeyValueStorage,
    peer: &DeviceId,
    seq: u64,
) -> Result<(), CoreError> {
    storage
        .set(&head_key(peer), seq.to_string().into_bytes())
        .await
}

/// The head sequence this store holds for `peer`'s log: the own log when `peer` is this device, a replica otherwise (any store may hold and answer for a peer's log, and nothing here tells the two apart). 0 means nothing is held yet.
///
/// # Errors
///
/// A storage error, including a head that is not a decimal integer.
pub async fn head_seq_for(
    storage: &dyn KeyValueStorage,
    peer: &DeviceId,
) -> Result<u64, CoreError> {
    read_head_seq(storage, peer).await
}

/// Appends `entry` to the log of `own` and returns the new sequence with the `data-have` frame announcing it. Only the local append and the head bookkeeping happen here: the caller decides when and to whom to send the frame.
///
/// The entry is written before the head, so a failure between the two leaves a head that does not cover it and the next append overwrites it.
///
/// # Errors
///
/// A storage error.
pub async fn append_own_entry(
    storage: &dyn KeyValueStorage,
    own: &DeviceId,
    entry: Vec<u8>,
) -> Result<(u64, DataHaveFrame), CoreError> {
    let seq = read_head_seq(storage, own).await? + 1;
    storage.set(&entry_key(own, seq), entry).await?;
    write_head_seq(storage, own, seq).await?;
    Ok((
        seq,
        DataHaveFrame {
            peer: *own,
            head_seq: seq,
        },
    ))
}

/// Handles an incoming `data-have`: `None` when this store already holds `frame.peer`'s log up to or past the announced head, otherwise the `data-request` that would catch it up from its own head. Whether to send that request is the caller's policy.
///
/// # Errors
///
/// A storage error.
pub async fn handle_data_have(
    storage: &dyn KeyValueStorage,
    frame: &DataHaveFrame,
) -> Result<Option<DataRequestFrame>, CoreError> {
    let head = read_head_seq(storage, &frame.peer).await?;
    if head >= frame.head_seq {
        return Ok(None);
    }
    Ok(Some(DataRequestFrame {
        peer: frame.peer,
        from_seq: head,
    }))
}

/// The entries stored for `peer` from sequence `first` to `last` inclusive, read in order and cut at the first hole. A hole is a record missing from a range the head claims is held, which cannot happen while the two key kinds stay consistent, and stopping there beats returning a run with a silent gap. Keys past a hole are never read.
async fn read_run(
    storage: &dyn KeyValueStorage,
    peer: &DeviceId,
    first: u64,
    last: u64,
) -> Result<Vec<Vec<u8>>, CoreError> {
    let mut run = Vec::new();
    let mut seq = first;
    while seq <= last {
        let Some(entry) = storage.get(&entry_key(peer, seq)).await? else {
            break;
        };
        run.push(entry);
        seq += 1;
    }
    Ok(run)
}

/// Handles an incoming `data-request`: the entries this store holds for `frame.peer` after `frame.from_seq`, at most `limit` of them, or `None` when it holds none past that point. The responder need not be `frame.peer`: any holder of a replica may answer on the author's behalf.
///
/// # Errors
///
/// A storage error.
pub async fn handle_data_request(
    storage: &dyn KeyValueStorage,
    frame: &DataRequestFrame,
    limit: u64,
) -> Result<Option<DataEntriesFrame>, CoreError> {
    let head = read_head_seq(storage, &frame.peer).await?;
    if head <= frame.from_seq {
        return Ok(None);
    }
    let last = head.min(frame.from_seq.saturating_add(limit));
    let entries = read_run(storage, &frame.peer, frame.from_seq + 1, last).await?;
    if entries.is_empty() {
        return Ok(None);
    }
    Ok(Some(DataEntriesFrame {
        peer: frame.peer,
        from_seq: frame.from_seq,
        entries,
    }))
}

/// What [`handle_data_entries`] concluded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataEntriesOutcome {
    /// The entries were persisted and the head advanced.
    Applied,
    /// `from-seq` did not equal this store's head, so nothing was written: ahead of it is a real gap, and behind it is a stale or replayed response already applied. Either way the caller re-issues a request from [`head_seq_for`].
    Gap,
}

/// Handles an incoming `data-entries`: persists the entries starting right after `from-seq`, but only when `from-seq` equals this store's head for `frame.peer` (the gap-rejection obligation of `data-domain.cddl`).
///
/// Entries are written in ascending order and the head last, so a failure part way leaves a contiguous prefix the head does not yet cover.
///
/// # Errors
///
/// A storage error.
pub async fn handle_data_entries(
    storage: &dyn KeyValueStorage,
    frame: &DataEntriesFrame,
) -> Result<DataEntriesOutcome, CoreError> {
    let head = read_head_seq(storage, &frame.peer).await?;
    if frame.from_seq != head {
        return Ok(DataEntriesOutcome::Gap);
    }
    let mut seq = frame.from_seq;
    for entry in &frame.entries {
        seq += 1;
        storage
            .set(&entry_key(&frame.peer, seq), entry.clone())
            .await?;
    }
    write_head_seq(storage, &frame.peer, seq).await?;
    Ok(DataEntriesOutcome::Applied)
}

/// The entries this store holds for `peer` after `from_seq_exclusive`, in sequence order: the local read side of [`append_own_entry`] and [`handle_data_entries`], for replaying a log directly rather than syncing it.
///
/// # Errors
///
/// A storage error.
pub async fn read_entries(
    storage: &dyn KeyValueStorage,
    peer: &DeviceId,
    from_seq_exclusive: u64,
) -> Result<Vec<Vec<u8>>, CoreError> {
    let head = read_head_seq(storage, peer).await?;
    read_run(storage, peer, from_seq_exclusive + 1, head).await
}

/// A frame of the core/data domain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataFrame {
    Have(DataHaveFrame),
    Request(DataRequestFrame),
    Entries(DataEntriesFrame),
}

/// The data frame a [`Frame`] is, or `None` for every other kind: what the TypeScript `isDataFrame` narrows to.
#[must_use]
pub fn data_frame(frame: &Frame) -> Option<DataFrame> {
    match frame {
        Frame::DataHave(f) => Some(DataFrame::Have(f.clone())),
        Frame::DataRequest(f) => Some(DataFrame::Request(f.clone())),
        Frame::DataEntries(f) => Some(DataFrame::Entries(f.clone())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::MemoryStorage;

    const OWN: DeviceId = DeviceId([1; 32]);
    const PEER: DeviceId = DeviceId([2; 32]);

    #[tokio::test]
    async fn the_log_layout_is_the_one_the_typescript_core_writes() {
        let storage = MemoryStorage::new();
        append_own_entry(&storage, &OWN, b"x".to_vec())
            .await
            .expect("append");
        let hex = device_id_to_hex(&OWN);
        assert_eq!(
            storage.get(&format!("data/{hex}/head")).await.expect("get"),
            Some(b"1".to_vec())
        );
        assert_eq!(
            storage
                .get(&format!("data/{hex}/entry/1"))
                .await
                .expect("get"),
            Some(b"x".to_vec())
        );
    }

    #[tokio::test]
    async fn a_head_that_is_not_a_decimal_integer_is_a_storage_fault_and_nothing_is_overwritten() {
        let storage = MemoryStorage::new();
        let key = head_key(&OWN);
        storage.set(&key, b"abc".to_vec()).await.expect("set");
        assert!(matches!(
            append_own_entry(&storage, &OWN, b"x".to_vec()).await,
            Err(CoreError::Storage(_))
        ));
        assert_eq!(storage.get(&key).await.expect("get"), Some(b"abc".to_vec()));
        assert!(storage
            .get(&entry_key(&OWN, 1))
            .await
            .expect("get")
            .is_none());
    }

    #[tokio::test]
    async fn a_request_limit_that_would_overflow_is_capped_at_the_head() {
        let storage = MemoryStorage::new();
        append_own_entry(&storage, &OWN, b"a".to_vec())
            .await
            .expect("append");
        let reply = handle_data_request(
            &storage,
            &DataRequestFrame {
                peer: OWN,
                from_seq: 0,
            },
            u64::MAX,
        )
        .await
        .expect("request")
        .expect("entries");
        assert_eq!(reply.entries, vec![b"a".to_vec()]);
    }

    #[test]
    fn data_frame_names_only_the_three_data_kinds() {
        let have = Frame::DataHave(DataHaveFrame {
            peer: PEER,
            head_seq: 3,
        });
        assert_eq!(
            data_frame(&have),
            Some(DataFrame::Have(DataHaveFrame {
                peer: PEER,
                head_seq: 3
            }))
        );
        assert_eq!(
            data_frame(&Frame::DataRequest(DataRequestFrame {
                peer: PEER,
                from_seq: 1
            })),
            Some(DataFrame::Request(DataRequestFrame {
                peer: PEER,
                from_seq: 1
            }))
        );
        assert_eq!(
            data_frame(&Frame::DataEntries(DataEntriesFrame {
                peer: PEER,
                from_seq: 0,
                entries: vec![]
            })),
            Some(DataFrame::Entries(DataEntriesFrame {
                peer: PEER,
                from_seq: 0,
                entries: vec![]
            }))
        );
    }
}
