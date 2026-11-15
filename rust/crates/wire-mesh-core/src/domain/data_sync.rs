//! The core/data sync primitive (`spec/data-domain.cddl`): the have, request and entries exchange over a single-writer, append-only log held in a [`KeyValueStorage`], ported from `data-sync.ts`.
//!
//! It is deliberately that primitive alone. When to broadcast a `data-have`, which peers' logs to track and how to fan a catch-up out across candidate holders are application decisions this module has no opinion on. It guarantees that appending to one's own log is correct and monotonic, and that syncing another log never accepts a gap.
//!
//! What the caller must do. This module checks no authority: a `data-entries` frame is applied to whichever log it names, and the frame carries no proof of its author. The caller must therefore refuse a frame that names its own device (a peer could otherwise append bytes to this device's single-writer log) and one for a peer whose log it does not track. It must also serialise the applications of frames for one peer (`handle_data_entries` reads the head and writes it back with no exclusion, so two concurrent applications of the same `from-seq` both pass the check and the later write wins).
//!
//! A log lives under two kinds of key: `data/<device-id-hex>/head` holds the head sequence as decimal text and `data/<device-id-hex>/entry/<seq>` holds one opaque entry. The layout is shared with the TypeScript core, so a store written by either is read by the other.

use wire_mesh_wire::data::{DataEntriesFrame, DataHaveFrame, DataRequestFrame};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::Frame;

use crate::domain::mint::MAX_EXACT_INTEGER;
use crate::domain::room_path::device_id_to_hex;
use crate::ports::{CoreError, KeyValueStorage};

fn head_key(peer: &DeviceId) -> String {
    format!("data/{}/head", device_id_to_hex(peer))
}

fn entry_key(peer: &DeviceId, seq: u64) -> String {
    format!("data/{}/entry/{seq}", device_id_to_hex(peer))
}

/// The head sequence this store holds for `peer`'s log, or 0 when nothing is held. A head that is not a decimal integer, or is above [`MAX_EXACT_INTEGER`] (which the TypeScript cannot hold exactly, so no peer could be told it), is a storage fault, never read as 0, so a corrupt store cannot make the log look empty and be overwritten.
async fn read_head_seq(storage: &dyn KeyValueStorage, peer: &DeviceId) -> Result<u64, CoreError> {
    let Some(raw) = storage.get(&head_key(peer)).await? else {
        return Ok(0);
    };
    std::str::from_utf8(&raw)
        .ok()
        .filter(|text| is_plain_decimal(text))
        .and_then(|text| text.parse::<u64>().ok())
        .filter(|head| *head <= MAX_EXACT_INTEGER)
        .ok_or_else(|| {
            CoreError::Storage(format!(
                "the head of the log of {} is not a decimal integer of at most 2^53 - 1",
                device_id_to_hex(peer)
            ))
        })
}

/// Whether `text` is the plain decimal digits of a non-negative integer: no sign, no space, no leading zero (except `0` itself), nothing but ASCII digits. `str::parse` alone accepts a leading `+` and leading zeros, which the TypeScript core's strict parse refuses.
fn is_plain_decimal(text: &str) -> bool {
    match text.as_bytes() {
        [] => false,
        [b'0'] => true,
        [first, rest @ ..] => (b'1'..=b'9').contains(first) && rest.iter().all(u8::is_ascii_digit),
    }
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

/// Why [`append_own_entry`] appended nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppendError {
    /// The log already holds [`MAX_EXACT_INTEGER`] entries: the next sequence could not be announced to a peer that holds integers as doubles. Nothing was written.
    LogFull,
    /// The storage failed, or the stored head is not a decimal integer of at most [`MAX_EXACT_INTEGER`].
    Storage(CoreError),
}

impl From<CoreError> for AppendError {
    fn from(error: CoreError) -> Self {
        AppendError::Storage(error)
    }
}

impl std::fmt::Display for AppendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppendError::LogFull => {
                f.write_str("the log is full: its next sequence is above 2^53 - 1")
            }
            AppendError::Storage(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for AppendError {}

/// Appends `entry` to the log of `own` and returns the new sequence with the `data-have` frame announcing it. Only the local append and the head bookkeeping happen here: the caller decides when and to whom to send the frame.
///
/// The entry is written before the head, so a failure between the two leaves a head that does not cover it and the next append overwrites it.
///
/// # Errors
///
/// [`AppendError::LogFull`] when the log already holds [`MAX_EXACT_INTEGER`] entries, nothing written, and [`AppendError::Storage`] for a storage error.
pub async fn append_own_entry(
    storage: &dyn KeyValueStorage,
    own: &DeviceId,
    entry: Vec<u8>,
) -> Result<(u64, DataHaveFrame), AppendError> {
    let seq = read_head_seq(storage, own).await? + 1;
    if seq > MAX_EXACT_INTEGER {
        return Err(AppendError::LogFull);
    }
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

/// Handles an incoming `data-have`: `None` when this store already holds `frame.peer`'s log up to or past the announced head, otherwise the `data-request` that would catch it up from its own head. Whether to send that request is the caller's policy. A frame whose head is above [`MAX_EXACT_INTEGER`] is dropped unanswered (`None`): a TypeScript peer cannot hold the value, so the frame is not one any peer could send it on.
///
/// # Errors
///
/// A storage error.
pub async fn handle_data_have(
    storage: &dyn KeyValueStorage,
    frame: &DataHaveFrame,
) -> Result<Option<DataRequestFrame>, CoreError> {
    if frame.head_seq > MAX_EXACT_INTEGER {
        return Ok(None);
    }
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

/// Handles an incoming `data-request`: the entries this store holds for `frame.peer` after `frame.from_seq`, at most `limit` of them, or `None` when it holds none past that point (which includes a `frame.from_seq` above [`MAX_EXACT_INTEGER`], since no log reaches it). The responder need not be `frame.peer`: any holder of a replica may answer on the author's behalf.
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
    /// The frame was dropped unevaluated and nothing was written: `from-seq`, or the head the entries would reach, is above [`MAX_EXACT_INTEGER`], which a TypeScript peer cannot hold, so no peer could have sent or applied the frame.
    Rejected,
    /// `from-seq` did not equal this store's head, so nothing was written: ahead of it is a real gap, and behind it is a stale or replayed response already applied. Either way the caller re-issues a request from [`head_seq_for`].
    Gap,
}

/// Handles an incoming `data-entries`. The caller must refuse a frame naming its own device and serialise applications per peer (see the module doc). [`DataEntriesOutcome::Rejected`] when the frame reaches above [`MAX_EXACT_INTEGER`], otherwise persists the entries starting right after `from-seq`, but only when `from-seq` equals this store's head for `frame.peer` (the gap-rejection obligation of `data-domain.cddl`).
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
    let reaches = u64::try_from(frame.entries.len())
        .ok()
        .and_then(|count| frame.from_seq.checked_add(count));
    if reaches.is_none_or(|reaches| reaches > MAX_EXACT_INTEGER) {
        return Ok(DataEntriesOutcome::Rejected);
    }
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
    read_run(storage, peer, from_seq_exclusive.saturating_add(1), head).await
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
            Err(AppendError::Storage(CoreError::Storage(_)))
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

    #[tokio::test]
    async fn integers_above_the_exact_range_are_dropped_refused_or_faulted() {
        let beyond = MAX_EXACT_INTEGER + 1;
        let storage = MemoryStorage::new();
        append_own_entry(&storage, &OWN, b"a".to_vec())
            .await
            .expect("append");
        assert_eq!(
            handle_data_have(
                &storage,
                &DataHaveFrame {
                    peer: OWN,
                    head_seq: beyond
                }
            )
            .await,
            Ok(None)
        );
        assert_eq!(
            handle_data_request(
                &storage,
                &DataRequestFrame {
                    peer: OWN,
                    from_seq: beyond
                },
                1
            )
            .await,
            Ok(None)
        );
        assert_eq!(
            handle_data_entries(
                &storage,
                &DataEntriesFrame {
                    peer: PEER,
                    from_seq: beyond,
                    entries: vec![b"x".to_vec()]
                }
            )
            .await,
            Ok(DataEntriesOutcome::Rejected)
        );
        assert_eq!(
            handle_data_entries(
                &storage,
                &DataEntriesFrame {
                    peer: PEER,
                    from_seq: u64::MAX,
                    entries: vec![b"x".to_vec(), b"y".to_vec()]
                }
            )
            .await,
            Ok(DataEntriesOutcome::Rejected)
        );
        assert_eq!(storage.get(&head_key(&PEER)).await, Ok(None));
        assert_eq!(read_entries(&storage, &OWN, u64::MAX).await, Ok(vec![]));
    }

    #[tokio::test]
    async fn a_log_at_the_exact_limit_is_full_and_a_head_beyond_it_is_a_fault() {
        let storage = MemoryStorage::new();
        storage
            .set(&head_key(&OWN), MAX_EXACT_INTEGER.to_string().into_bytes())
            .await
            .expect("set");
        assert_eq!(
            append_own_entry(&storage, &OWN, b"x".to_vec()).await,
            Err(AppendError::LogFull)
        );
        assert!(storage
            .get(&entry_key(&OWN, MAX_EXACT_INTEGER + 1))
            .await
            .expect("get")
            .is_none());
        storage
            .set(
                &head_key(&PEER),
                (MAX_EXACT_INTEGER + 1).to_string().into_bytes(),
            )
            .await
            .expect("set");
        assert!(matches!(
            head_seq_for(&storage, &PEER).await,
            Err(CoreError::Storage(_))
        ));
    }

    /// A storage that fails every `set` from the `fail_at`-th one on (counting from 1), so a test can see what a failure part way leaves behind.
    struct FailingStorage {
        inner: MemoryStorage,
        sets: std::sync::atomic::AtomicUsize,
        fail_at: usize,
    }

    impl FailingStorage {
        fn new(fail_at: usize) -> Self {
            FailingStorage {
                inner: MemoryStorage::new(),
                sets: std::sync::atomic::AtomicUsize::new(0),
                fail_at,
            }
        }
    }

    #[async_trait::async_trait]
    impl KeyValueStorage for FailingStorage {
        async fn get(&self, key: &str) -> Result<Option<Vec<u8>>, CoreError> {
            self.inner.get(key).await
        }
        async fn set(&self, key: &str, value: Vec<u8>) -> Result<(), CoreError> {
            let n = self.sets.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            if n >= self.fail_at {
                return Err(CoreError::Storage("injected failure".to_owned()));
            }
            self.inner.set(key, value).await
        }
        async fn delete(&self, key: &str) -> Result<(), CoreError> {
            self.inner.delete(key).await
        }
        async fn keys(&self, prefix: &str) -> Result<Vec<String>, CoreError> {
            self.inner.keys(prefix).await
        }
    }

    /// The invariant of the write order: whatever a failure leaves, every sequence up to the head has its entry, so the head is never ahead of the entries.
    async fn assert_head_is_covered(storage: &MemoryStorage, peer: &DeviceId) {
        let head = head_seq_for(storage, peer).await.expect("head");
        for seq in 1..=head {
            assert!(
                storage
                    .get(&entry_key(peer, seq))
                    .await
                    .expect("get")
                    .is_some(),
                "the head {head} is ahead of the entry {seq}"
            );
        }
    }

    #[tokio::test]
    async fn a_failed_append_never_leaves_the_head_ahead_of_its_entry() {
        for fail_at in 1..=2 {
            let storage = FailingStorage::new(fail_at);
            assert!(append_own_entry(&storage, &OWN, b"a".to_vec())
                .await
                .is_err());
            assert_head_is_covered(&storage.inner, &OWN).await;
            assert_eq!(
                head_seq_for(&storage.inner, &OWN).await,
                Ok(0),
                "fail at {fail_at}"
            );
        }
    }

    #[tokio::test]
    async fn a_failed_application_of_entries_leaves_a_contiguous_prefix_the_head_does_not_cover() {
        let frame = DataEntriesFrame {
            peer: PEER,
            from_seq: 0,
            entries: vec![b"x".to_vec(), b"y".to_vec(), b"z".to_vec()],
        };
        for fail_at in 1..=4 {
            let storage = FailingStorage::new(fail_at);
            assert!(handle_data_entries(&storage, &frame).await.is_err());
            assert_head_is_covered(&storage.inner, &PEER).await;
            assert_eq!(
                head_seq_for(&storage.inner, &PEER).await,
                Ok(0),
                "fail at {fail_at}"
            );
            // What was written is a prefix, in order: entry n is held only when every entry before it is.
            let mut written = true;
            for seq in 1..=3u64 {
                let held = storage
                    .inner
                    .get(&entry_key(&PEER, seq))
                    .await
                    .expect("get")
                    .is_some();
                assert!(written || !held, "entry {seq} is held after a missing one");
                written = held;
            }
        }
    }
}
