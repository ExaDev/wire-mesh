//! The secure channels a session holds with the devices it reaches through a relay (`spec/secure-channel.cddl`), one entry per peer, and the state machine that opens them: when to start a handshake, whose hello completes which, when a new channel replaces the current one, and which channel a received frame belongs to. The rules are those of the TypeScript `createRelayChannels`; `secure_channel` is the crypto, and the transport is behind [`HelloSender`], so this module has none.
//!
//! A hello never replaces a channel by itself. It builds a candidate beside the current channel, and the candidate takes over only once a frame from the peer opens under it, which only a holder of the candidate's other ephemeral secret can produce. A side that has a handshake of its own outstanding with a peer completes a received hello against it instead of answering, so two sides that both hold channels never answer each other without end.
//!
//! The state is behind one lock that is never held across an `await`: every decision is made on the state as it is when its section runs, and a section that follows an `await` re-reads what it depends on, as the TypeScript does after each of its own.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::watch;
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::secure_channel::{SecureDataFrame, SecureHelloFrame};
use wire_mesh_wire::Frame;

use crate::domain::fault_report::{FaultReporter, Report};
use crate::domain::room_path::device_id_to_hex;
use crate::domain::secure_channel::{
    begin_handshake, establish_channel_shared, is_usable_ephemeral_key, verify_hello, OpenError,
    PendingHandshake, SealError, SecureChannel, VerifiedHello, VerifyHelloError,
};
use crate::ports::{Clock, CoreError, Identity};

/// How long a peer may take to answer a hello, and the window every other rule here is measured in: a handshake is outstanding for this long, a replaced channel may still open frames that were in flight for this long, and an entry younger than this is never reused.
pub const HANDSHAKE_WINDOW_MS: u64 = 3_000;

/// The most channels one handshake builds. An honest handshake yields one fresh hello for this side's ephemeral key. A second arises in exactly one honest case: the peer restarted while this side's hello was in flight and its new hello also arrived. A third is never honest, so beyond this a hello is dropped.
pub const CANDIDATES_PER_HANDSHAKE: usize = 2;

/// The most handshakes this side leaves pending for its own sends at once. A local resource budget: peers cannot reach it, only what the local application sends to. Past it the oldest pending handshake is dropped and whoever awaits it is told.
pub const MAX_PENDING_HANDSHAKES: usize = 256;

/// The most entries held for peers this side never sent anything to. A memory and CPU budget for peers this side did not choose; no safety property depends on its value, since peers this side chose are outside it.
pub const MAX_UNSOLICITED_PEERS: usize = 64;

/// What a sealed frame is for: a request is this side choosing to talk to the peer, a reply answers a frame that peer sent and does not make the peer chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealPurpose {
    /// This side chose to talk to the peer, which makes the peer chosen for good. A consumer must not seal a request in reaction to a frame from a peer it did not choose.
    Request,
    /// An answer to a frame the peer sent.
    Reply,
}

/// A frame that opened under a peer's channel, with the peer that channel authenticated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenedFrame {
    pub frame: Frame,
    pub from: DeviceId,
}

/// Why [`RelayChannels::seal`] sealed nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayError {
    /// A reply to a peer this side never chose, and no entry can be given it.
    NoChannel,
    /// The handshake or the entry the call was waiting on was dropped: a reset, a lost pairing, a bound, or a failed hello.
    Abandoned(String),
    /// This side's own handshake could not be signed or its hello could not be sent.
    Handshake(CoreError),
    /// The channel refused the frame. A channel whose send counter is spent is forgotten, so the next send starts a new handshake.
    Seal(SealError),
}

impl std::fmt::Display for RelayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayError::NoChannel => f.write_str("there is no channel with this peer"),
            RelayError::Abandoned(why) => f.write_str(why),
            RelayError::Handshake(error) => write!(f, "the handshake failed: {error}"),
            RelayError::Seal(error) => write!(f, "the channel could not seal the frame: {error}"),
        }
    }
}

impl std::error::Error for RelayError {}

/// Puts a hello on the wire for a peer. Fails when there is no connection to put it on.
#[async_trait::async_trait]
pub trait HelloSender: Send + Sync {
    /// Sends `hello`, addressed to `peer`, through the relay.
    async fn send_hello(&self, peer: &DeviceId, hello: &SecureHelloFrame) -> Result<(), CoreError>;
}

/// Where each new handshake's ephemeral key pair and nonce come from. [`OsHandshakes`] draws them from the operating system; conformance supplies fixed ones so a scenario is deterministic.
#[async_trait::async_trait]
pub trait HandshakeSource: Send + Sync {
    /// Begins a handshake with `peer`, signing its hello with `identity`.
    async fn begin(
        &self,
        identity: &dyn Identity,
        peer: DeviceId,
    ) -> Result<PendingHandshake, CoreError>;
}

/// The handshakes of a real session: a fresh ephemeral key and nonce from the operating system each time.
#[derive(Debug, Clone, Copy, Default)]
pub struct OsHandshakes;

#[async_trait::async_trait]
impl HandshakeSource for OsHandshakes {
    async fn begin(
        &self,
        identity: &dyn Identity,
        peer: DeviceId,
    ) -> Result<PendingHandshake, CoreError> {
        begin_handshake(identity, peer).await
    }
}

/// A failure local to this side, told to the owner through the fault reporter: an identity port that failed to check or sign, a hello that could not be sent, a channel that could not be established. Never anything a peer did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFault {
    /// The failure, as text.
    pub error: String,
    /// The peer the failing hello or send was for, when it is known by then.
    pub peer: Option<DeviceId>,
}

/// What a fault report goes to: the report, with how many reports for the same peer were withheld since the last one.
pub type FaultCallback = Arc<dyn Fn(Report<LocalFault>) + Send + Sync>;

/// What a [`RelayChannels`] is built from besides its identity, sender and clock.
#[derive(Clone, Default)]
pub struct RelayOptions {
    /// Told of local faults, through the fault reporter: at most one report per peer per interval, with the number withheld, and at most the reporter's budget across all peers per interval. Reports held back at the end of an interval are delivered by [`RelayChannels::deliver_due_faults`].
    pub on_fault: Option<FaultCallback>,
    /// Where each new handshake's ephemeral key pair and nonce come from. Defaults to [`OsHandshakes`].
    pub handshakes: Option<Arc<dyn HandshakeSource>>,
    /// Where each channel's send counter starts: only for tests that must reach the counter's bound.
    #[cfg(any(test, feature = "conformance"))]
    pub first_send_counter: Option<u64>,
}

struct Candidate {
    channel: SecureChannel,
    remote_key: Vec<u8>,
}

struct Current {
    channel: SecureChannel,
    remote_key: Vec<u8>,
    confirmed: bool,
}

struct Replaced {
    channel: SecureChannel,
    remote_key: Vec<u8>,
    until: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Sent {
    Pending,
    Delivered,
    Failed(CoreError),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
    Initiated,
    Answered,
}

/// This side's own hello to one peer, from the moment it is begun until a candidate is confirmed or the window passes.
struct Handshake {
    id: u64,
    origin: Origin,
    sent_at: u64,
    /// This side's half, once it is signed. Shared by every candidate the handshake builds.
    pending: Option<Arc<PendingHandshake>>,
    /// Told whenever `pending` is set; dropping the handshake wakes whoever waits on it.
    pending_signal: watch::Sender<bool>,
    cands: Vec<Candidate>,
    /// Settles once the hello has gone out, and fails if it could not be signed or sent.
    sent: watch::Sender<Sent>,
    /// Set when the window passed with nothing from the peer, so the handshake no longer suppresses answers.
    expired: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct Signal {
    generation: u64,
    failure: Option<String>,
}

/// Everything held for one peer. The fields change only through the methods, so each transition has one place.
struct PeerChannels {
    peer: DeviceId,
    /// The order the entry was made in, so ties between equally old entries break as insertion order does.
    seq: u64,
    chosen: bool,
    last_used: u64,
    /// The current channel: sealing goes through it and only it.
    current: Option<Current>,
    /// The channel the current one replaced, which may still open frames that were in flight but never seals.
    replaced: Option<Replaced>,
    hs: Option<Handshake>,
    /// The candidates of a handshake that ended without confirming either of two, which together serve as the channel until a frame opens under one.
    pool: Vec<Candidate>,
    waiters: watch::Sender<Signal>,
}

fn authentic<T>(outcome: &Result<T, OpenError>) -> bool {
    // An authentic frame whose plaintext is not a frame still proves the sender holds the keys.
    matches!(outcome, Ok(_) | Err(OpenError::Undecodable(_)))
}

impl PeerChannels {
    fn new(peer: DeviceId, seq: u64, now: u64) -> Self {
        PeerChannels {
            peer,
            seq,
            chosen: false,
            last_used: now,
            current: None,
            replaced: None,
            hs: None,
            pool: Vec::new(),
            waiters: watch::channel(Signal::default()).0,
        }
    }

    /// True when `key` is the remote ephemeral key of anything held for the peer.
    fn holds_key(&self, key: &[u8]) -> bool {
        let held = self
            .current
            .iter()
            .map(|current| current.remote_key.as_slice())
            .chain(self.replaced.iter().map(|r| r.remote_key.as_slice()))
            .chain(
                self.hs
                    .iter()
                    .flat_map(|hs| hs.cands.iter())
                    .map(|cand| cand.remote_key.as_slice()),
            )
            .chain(self.pool.iter().map(|cand| cand.remote_key.as_slice()));
        held.into_iter().any(|held| held == key)
    }

    /// Whether this side's handshake with the peer is outstanding: sent less than a window ago, and neither confirmed nor ended.
    fn outstanding(&self, now: u64) -> bool {
        self.hs
            .as_ref()
            .is_some_and(|hs| !hs.expired && now < hs.sent_at.saturating_add(HANDSHAKE_WINDOW_MS))
    }

    /// Applies whatever the passing of time has ended: the replaced channel after its window, and a handshake after its window. Checked on every event, so no timer is needed.
    fn expire(&mut self, now: u64) {
        if self.replaced.as_ref().is_some_and(|r| now >= r.until) {
            self.replaced = None;
        }
        let Some(hs) = self.hs.as_mut() else {
            return;
        };
        if hs.expired || now < hs.sent_at.saturating_add(HANDSHAKE_WINDOW_MS) {
            return;
        }
        if self.current.is_some() {
            // Nothing confirmed a candidate: the current channel stays.
            self.hs = None;
        } else if hs.cands.is_empty() {
            hs.expired = true;
        } else if hs.cands.len() == 1 {
            if let Some(mut taken) = self.hs.take() {
                if let Some(only) = taken.cands.pop() {
                    self.current = Some(Current {
                        channel: only.channel,
                        remote_key: only.remote_key,
                        confirmed: false,
                    });
                }
            }
        } else if let Some(mut taken) = self.hs.take() {
            self.pool = std::mem::take(&mut taken.cands);
        }
    }

    /// A frame opened under `cand`: it becomes the current channel, the channel it replaces may open in-flight frames for a window, and every other candidate goes.
    fn confirm(&mut self, cand: Candidate, now: u64) {
        if let Some(current) = self.current.take() {
            self.replaced = Some(Replaced {
                channel: current.channel,
                remote_key: current.remote_key,
                until: now.saturating_add(HANDSHAKE_WINDOW_MS),
            });
        }
        self.current = Some(Current {
            channel: cand.channel,
            remote_key: cand.remote_key,
            confirmed: true,
        });
        self.hs = None;
        self.pool.clear();
    }

    fn is_empty(&self) -> bool {
        self.current.is_none()
            && self.replaced.is_none()
            && self.hs.is_none()
            && self.pool.is_empty()
    }

    /// Wakes every sealer waiting for a channel to exist.
    fn release_waiters(&self) {
        self.waiters.send_modify(|signal| {
            signal.generation += 1;
            signal.failure = None;
        });
    }

    /// Fails every sealer waiting for a channel to exist.
    fn reject_waiters(&self, why: &str) {
        self.waiters.send_modify(|signal| {
            signal.generation += 1;
            signal.failure = Some(why.to_owned());
        });
    }
}

struct Inner {
    peers: HashMap<DeviceId, PeerChannels>,
    next_seq: u64,
    next_handshake: u64,
    /// The latest reading the clock has given, which the time never goes below.
    latest: u64,
    reporter: FaultReporter<LocalFault>,
}

/// The secure channels of one session. Cheap to share: every method takes `&self`.
pub struct RelayChannels {
    identity: Arc<dyn Identity>,
    sender: Arc<dyn HelloSender>,
    clock: Arc<dyn Clock>,
    handshakes: Arc<dyn HandshakeSource>,
    on_fault: Option<FaultCallback>,
    #[cfg(any(test, feature = "conformance"))]
    first_send_counter: Option<u64>,
    inner: Mutex<Inner>,
}

/// Removes the handshake it guards when the call that began it is dropped before it was sent, so a cancelled send leaves no handshake that nothing completes.
struct StartGuard<'a> {
    channels: &'a RelayChannels,
    peer: DeviceId,
    id: u64,
    armed: bool,
}

impl Drop for StartGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let mut inner = self.channels.lock();
            inner.drop_handshake(
                &self.peer,
                self.id,
                &CoreError::Transport("the handshake was cancelled".to_owned()),
            );
        }
    }
}

enum StartFailure {
    /// The handshake could not be signed.
    Signing(CoreError),
    /// The hello could not be sent. Already reported when the handshake was an answer.
    Sending(CoreError),
    /// The handshake was dropped while it was being signed.
    Dropped,
}

impl Inner {
    fn time(&mut self, clock: &dyn Clock) -> u64 {
        self.latest = self.latest.max(clock.now_unix_ms());
        self.latest
    }

    fn prune(&mut self, peer: &DeviceId) {
        if self
            .peers
            .get(peer)
            .is_some_and(|entry| entry.is_empty() && !entry.chosen)
        {
            self.peers.remove(peer);
        }
    }

    /// Ends this side's handshake `id` with the peer, leaving every channel as it is, and tells whoever waits for a channel when there is none to wait for.
    fn drop_handshake(&mut self, peer: &DeviceId, id: u64, error: &CoreError) {
        let Some(entry) = self.peers.get_mut(peer) else {
            return;
        };
        if entry.hs.as_ref().map(|hs| hs.id) != Some(id) {
            return;
        }
        if let Some(hs) = entry.hs.take() {
            hs.sent.send_replace(Sent::Failed(error.clone()));
        }
        if entry.current.is_none() && entry.pool.is_empty() {
            entry.reject_waiters(&error.to_string());
        }
        self.prune(peer);
    }

    /// Drops every handshake that is waiting for its first answer beyond [`MAX_PENDING_HANDSHAKES`], oldest first.
    fn enforce_pending_bound(&mut self, keep: &DeviceId) {
        let pending: Vec<&PeerChannels> = self
            .peers
            .values()
            .filter(|entry| {
                entry.current.is_none()
                    && entry
                        .hs
                        .as_ref()
                        .is_some_and(|hs| hs.origin == Origin::Initiated && hs.cands.is_empty())
            })
            .collect();
        let excess = pending.len().saturating_sub(MAX_PENDING_HANDSHAKES);
        let mut others: Vec<(u64, u64, DeviceId, u64)> = pending
            .iter()
            .filter(|entry| entry.peer != *keep)
            .filter_map(|entry| {
                entry
                    .hs
                    .as_ref()
                    .map(|hs| (hs.sent_at, entry.seq, entry.peer, hs.id))
            })
            .collect();
        others.sort_unstable_by_key(|(sent_at, seq, _, _)| (*sent_at, *seq));
        for (_, _, peer, id) in others.into_iter().take(excess) {
            self.drop_handshake(
                &peer,
                id,
                &CoreError::Transport(
                    "the handshake was dropped to make room for others".to_owned(),
                ),
            );
        }
    }

    /// The entry of a peer this side never sent anything to that may be reused now. An entry is reused only once it is older than the window, so answers cannot outpace the turnover of slots.
    fn reusable_entry(&self, now: u64) -> Option<DeviceId> {
        self.peers
            .values()
            .filter(|entry| {
                !entry.chosen && now.saturating_sub(entry.last_used) >= HANDSHAKE_WINDOW_MS
            })
            .min_by_key(|entry| (entry.last_used, entry.seq))
            .map(|entry| entry.peer)
    }

    fn slot_is_free(&self) -> bool {
        self.peers.values().filter(|entry| !entry.chosen).count() < MAX_UNSOLICITED_PEERS
    }

    /// Whether a peer this side never sent anything to could be given an entry now, changing nothing.
    fn slot_available(&self, now: u64) -> bool {
        self.slot_is_free() || self.reusable_entry(now).is_some()
    }

    /// Makes room for a peer this side never sent anything to.
    fn reserve_unsolicited_slot(&mut self, now: u64) -> bool {
        if self.slot_is_free() {
            return true;
        }
        let Some(victim) = self.reusable_entry(now) else {
            return false;
        };
        self.discard(&victim, "the entry was dropped to make room for others");
        true
    }

    fn discard(&mut self, peer: &DeviceId, why: &str) {
        if let Some(entry) = self.peers.remove(peer) {
            if let Some(hs) = &entry.hs {
                hs.sent
                    .send_replace(Sent::Failed(CoreError::Transport(why.to_owned())));
            }
            entry.reject_waiters(why);
        }
    }

    fn entry_for(&mut self, peer: DeviceId, now: u64) -> &mut PeerChannels {
        let next = self.next_seq;
        let created = !self.peers.contains_key(&peer);
        if created {
            self.next_seq += 1;
        }
        self.peers
            .entry(peer)
            .or_insert_with(|| PeerChannels::new(peer, next, now))
    }

    /// Registers this side's own hello to `peer` at once, before it is signed, so a hello arriving meanwhile completes it instead of starting another.
    fn begin_own(&mut self, peer: &DeviceId, origin: Origin, now: u64) -> u64 {
        let id = self.next_handshake;
        self.next_handshake += 1;
        if let Some(entry) = self.peers.get_mut(peer) {
            entry.hs = Some(Handshake {
                id,
                origin,
                sent_at: now,
                pending: None,
                pending_signal: watch::channel(false).0,
                cands: Vec::new(),
                sent: watch::channel(Sent::Pending).0,
                expired: false,
            });
        }
        id
    }
}

impl RelayChannels {
    /// The channels of a session whose identity is `identity`, sending hellos through `sender` and reading time from `clock`: milliseconds from any origin, never meant to be set backwards; a clock that steps backwards is held at the latest reading it has given until it passes it, so a step back lengthens every window by the size of the step and breaks no rule.
    #[must_use]
    pub fn new(
        identity: Arc<dyn Identity>,
        sender: Arc<dyn HelloSender>,
        clock: Arc<dyn Clock>,
        options: RelayOptions,
    ) -> Self {
        RelayChannels {
            identity,
            sender,
            clock,
            handshakes: options.handshakes.unwrap_or_else(|| Arc::new(OsHandshakes)),
            on_fault: options.on_fault,
            #[cfg(any(test, feature = "conformance"))]
            first_send_counter: options.first_send_counter,
            inner: Mutex::new(Inner {
                peers: HashMap::new(),
                next_seq: 0,
                next_handshake: 0,
                latest: 0,
                reporter: FaultReporter::new(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(guard) => guard,
            // A panic elsewhere left the state as the last complete section made it, which is the state every decision here reads.
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn deliver(&self, reports: Vec<Report<LocalFault>>) {
        if let Some(callback) = &self.on_fault {
            for report in reports {
                callback(report);
            }
        }
    }

    fn report_fault(&self, error: &CoreError, peer: Option<DeviceId>) {
        let reports = {
            let mut inner = self.lock();
            let now = inner.time(&*self.clock);
            let source = peer.as_ref().map(device_id_to_hex).unwrap_or_default();
            inner.reporter.report(
                now,
                &source,
                LocalFault {
                    error: error.to_string(),
                    peer,
                },
            )
        };
        self.deliver(reports);
    }

    /// Delivers the fault reports whose interval has ended since they were held back, and returns when the next one is due (on the clock these channels were built with), if any. The reporter owns no timer, so a held report waits until this is called: call it when the time the last call returned has come.
    pub fn deliver_due_faults(&self) -> Option<u64> {
        let (reports, next) = {
            let mut inner = self.lock();
            let now = inner.time(&*self.clock);
            let reports = inner.reporter.due(now);
            (reports, inner.reporter.next_due())
        };
        self.deliver(reports);
        next
    }

    fn establish(
        &self,
        pending: &PendingHandshake,
        verified: VerifiedHello,
    ) -> Option<SecureChannel> {
        #[cfg(any(test, feature = "conformance"))]
        if let Some(first) = self.first_send_counter {
            return crate::domain::secure_channel::establish_channel_at(pending, verified, first)
                .ok();
        }
        establish_channel_shared(pending, verified).ok()
    }

    /// Seals one frame for `peer`, starting a handshake when there is no channel and none is outstanding. Yields one sealed frame, or one per candidate channel while this side has no established channel and holds several, which the peer opens at most one of. A request marks the peer chosen for good.
    ///
    /// # Errors
    ///
    /// [`RelayError`] when no channel can be had or the channel refuses the frame.
    pub async fn seal(
        &self,
        peer: DeviceId,
        frame: &Frame,
        purpose: SealPurpose,
    ) -> Result<Vec<SecureDataFrame>, RelayError> {
        {
            let mut inner = self.lock();
            let now = inner.time(&*self.clock);
            if !inner.peers.contains_key(&peer) {
                if purpose == SealPurpose::Reply && !inner.reserve_unsolicited_slot(now) {
                    return Err(RelayError::NoChannel);
                }
                inner.entry_for(peer, now);
            }
            if purpose == SealPurpose::Request {
                if let Some(entry) = inner.peers.get_mut(&peer) {
                    entry.chosen = true;
                }
            }
        }
        self.seal_for(peer, frame).await
    }

    async fn seal_for(
        &self,
        peer: DeviceId,
        frame: &Frame,
    ) -> Result<Vec<SecureDataFrame>, RelayError> {
        enum Step {
            Start(u64),
            WaitSent(u64, watch::Receiver<Sent>),
            Wait(watch::Receiver<Signal>),
        }
        let mut sent_known: Option<u64> = None;
        loop {
            let step = {
                let mut inner = self.lock();
                let now = inner.time(&*self.clock);
                let Some(entry) = inner.peers.get_mut(&peer) else {
                    return Err(RelayError::Abandoned(
                        "the entry was dropped to make room for others".to_owned(),
                    ));
                };
                entry.expire(now);
                entry.last_used = now;
                if let Some(current) = entry.current.as_mut() {
                    return match current.channel.seal(frame) {
                        Ok(data) => Ok(vec![data]),
                        Err(error) => {
                            // A channel whose send counter is spent can seal nothing more. Forgetting it makes the next send to this peer start a new handshake, with a fresh counter, instead of failing for good.
                            if error == SealError::CounterExhausted {
                                entry.current = None;
                            }
                            Err(RelayError::Seal(error))
                        }
                    };
                }
                if !entry.pool.is_empty() {
                    return entry
                        .pool
                        .iter_mut()
                        .map(|cand| cand.channel.seal(frame).map_err(RelayError::Seal))
                        .collect();
                }
                match entry.hs.as_mut() {
                    None => {
                        let id = inner.begin_own(&peer, Origin::Initiated, now);
                        inner.enforce_pending_bound(&peer);
                        Step::Start(id)
                    }
                    Some(hs) if !hs.cands.is_empty() => {
                        if sent_known == Some(hs.id) {
                            return hs
                                .cands
                                .iter_mut()
                                .map(|cand| cand.channel.seal(frame).map_err(RelayError::Seal))
                                .collect();
                        }
                        Step::WaitSent(hs.id, hs.sent.subscribe())
                    }
                    Some(_) => Step::Wait(entry.waiters.subscribe()),
                }
            };
            match step {
                Step::Start(id) => match self.start_handshake(peer, id, Origin::Initiated).await {
                    Ok(()) | Err(StartFailure::Dropped) => {}
                    Err(StartFailure::Signing(error) | StartFailure::Sending(error)) => {
                        return Err(RelayError::Handshake(error));
                    }
                },
                Step::WaitSent(id, mut sent) => {
                    // The hello this side answered with is out before anything is sealed under the channel it makes.
                    let settled = sent.wait_for(|state| *state != Sent::Pending).await;
                    match settled.map(|state| state.clone()) {
                        Ok(Sent::Failed(error)) => return Err(RelayError::Handshake(error)),
                        Ok(_) => sent_known = Some(id),
                        // The handshake ended without a verdict on the hello: look again.
                        Err(_) => {}
                    }
                }
                Step::Wait(mut signal) => {
                    if signal.changed().await.is_err() {
                        return Err(RelayError::Abandoned("the entry was dropped".to_owned()));
                    }
                    if let Some(why) = signal.borrow().failure.clone() {
                        return Err(RelayError::Abandoned(why));
                    }
                }
            }
        }
    }

    /// Signs and sends this side's own hello of handshake `id`, which is already registered.
    async fn start_handshake(
        &self,
        peer: DeviceId,
        id: u64,
        origin: Origin,
    ) -> Result<(), StartFailure> {
        let mut guard = StartGuard {
            channels: self,
            peer,
            id,
            armed: true,
        };
        let begun = self.handshakes.begin(&*self.identity, peer).await;
        let pending = match begun {
            Ok(pending) => Arc::new(pending),
            Err(error) => {
                guard.armed = false;
                self.lock().drop_handshake(&peer, id, &error);
                return Err(StartFailure::Signing(error));
            }
        };
        {
            let mut inner = self.lock();
            let Some(hs) = inner
                .peers
                .get_mut(&peer)
                .and_then(|entry| entry.hs.as_mut())
                .filter(|hs| hs.id == id)
            else {
                guard.armed = false;
                return Err(StartFailure::Dropped);
            };
            hs.pending = Some(Arc::clone(&pending));
            hs.pending_signal.send_replace(true);
        }
        if let Err(error) = self.sender.send_hello(&peer, pending.hello()).await {
            guard.armed = false;
            self.lock().drop_handshake(&peer, id, &error);
            if origin == Origin::Answered {
                self.report_fault(&error, Some(peer));
            }
            return Err(StartFailure::Sending(error));
        }
        guard.armed = false;
        let inner = self.lock();
        if let Some(hs) = inner
            .peers
            .get(&peer)
            .and_then(|entry| entry.hs.as_ref())
            .filter(|hs| hs.id == id)
        {
            hs.sent.send_replace(Sent::Delivered);
        }
        Ok(())
    }

    /// Waits until this side's half of handshake `id` is signed, or the handshake is gone.
    async fn pending_of(&self, peer: &DeviceId, id: u64) -> Option<Arc<PendingHandshake>> {
        loop {
            let mut ready = {
                let inner = self.lock();
                let hs = inner
                    .peers
                    .get(peer)
                    .and_then(|entry| entry.hs.as_ref())
                    .filter(|hs| hs.id == id)?;
                if let Some(pending) = &hs.pending {
                    return Some(Arc::clone(pending));
                }
                hs.pending_signal.subscribe()
            };
            // Ends when the half is set, or the handshake is dropped and its sender with it.
            if ready.changed().await.is_err() {
                let inner = self.lock();
                return inner
                    .peers
                    .get(peer)
                    .and_then(|entry| entry.hs.as_ref())
                    .filter(|hs| hs.id == id)
                    .and_then(|hs| hs.pending.clone());
            }
        }
    }

    /// Builds the channel `verified` makes with handshake `id`, and holds it as a candidate.
    async fn add_candidate(&self, peer: &DeviceId, id: u64, verified: VerifiedHello) {
        let Some(pending) = self.pending_of(peer, id).await else {
            return;
        };
        let remote_key = verified.hello().ephemeral_key.clone();
        // The error `establish` discards cannot occur on this path: an unusable ephemeral key is dropped by `accept_hello` before any state changes, a nonce of the wrong length is a `BadSignature` of `verify_hello`, and a mismatch between the verified hello and this handshake cannot arise, since the handshake was begun for the very device whose hello was verified (the entry is keyed by it). If it did occur, no candidate is built and the handshake ends with its window.
        let channel = self.establish(&pending, verified);
        let mut inner = self.lock();
        let Some(entry) = inner.peers.get_mut(peer) else {
            return;
        };
        let held = entry.holds_key(&remote_key);
        let Some(hs) = entry.hs.as_mut().filter(|hs| hs.id == id) else {
            return;
        };
        let Some(channel) = channel else {
            return;
        };
        if hs.cands.len() >= CANDIDATES_PER_HANDSHAKE || held {
            return;
        }
        hs.cands.push(Candidate {
            channel,
            remote_key,
        });
        entry.release_waiters();
    }

    /// Handles a hello received through a relay pairing, `claimed_from` being the `from-device` the relay stamped. The hello is dropped, changing nothing and sending nothing, unless the device-id its identity-key hashes to is `claimed_from`, its signature verifies, its ephemeral key is usable and is not one this side already holds for that peer. Otherwise it is completed against this side's own outstanding handshake with that peer, or, when there is none, answered with a hello of this side's own. Either way it yields a candidate beside any current channel; nothing is replaced until a frame opens under the candidate. Nothing that happens while handling a hello reaches the peer: a failure of this side is reported through the fault reporter and abandons only the handshake it was part of.
    pub async fn apply_hello(&self, hello: &SecureHelloFrame, claimed_from: Option<DeviceId>) {
        let Some(claimed) = claimed_from else {
            return;
        };
        // The cheapest checks first, and before any signature is verified: the hello must come from the pairing of the device it names, and must not repeat a key already held for that device.
        let sender = self
            .identity
            .derive_device_id(&hello.identity_key.public_key);
        if sender != claimed {
            return;
        }
        {
            let mut inner = self.lock();
            let now = inner.time(&*self.clock);
            let held = inner.peers.get_mut(&sender);
            if let Some(entry) = held {
                entry.expire(now);
                if entry.holds_key(&hello.ephemeral_key) {
                    return;
                }
                // Nor may it reach a signature check when no answer to it is possible: the handshake it would join already has its candidates.
                if entry.outstanding(now)
                    && entry
                        .hs
                        .as_ref()
                        .is_some_and(|hs| hs.cands.len() >= CANDIDATES_PER_HANDSHAKE)
                {
                    return;
                }
            } else if !inner.slot_available(now) {
                // Or this side has no entry to give a peer it did not choose.
                return;
            }
        }
        if let Err(error) = self.accept_hello(hello, sender).await {
            self.report_fault(&error, Some(sender));
        }
    }

    async fn accept_hello(
        &self,
        hello: &SecureHelloFrame,
        sender: DeviceId,
    ) -> Result<(), CoreError> {
        let verified = match verify_hello(&*self.identity, hello).await {
            Ok(verified) => verified,
            Err(VerifyHelloError::Refused(_refusal)) => return Ok(()),
            Err(VerifyHelloError::Port(error)) => return Err(error),
        };
        if !is_usable_ephemeral_key(&hello.ephemeral_key) {
            return Ok(());
        }
        // Everything above waited; what follows decides on the state as it is now.
        enum Decision {
            Drop,
            Join(Option<u64>),
            Answer(u64),
        }
        let decision = {
            let mut inner = self.lock();
            let now = inner.time(&*self.clock);
            let joined = inner.peers.get_mut(&sender).map(|entry| {
                entry.expire(now);
                if entry.holds_key(&hello.ephemeral_key) {
                    return Some(Decision::Drop);
                }
                if entry.outstanding(now) {
                    let join = entry.hs.as_ref().and_then(|hs| {
                        (hs.cands.len() < CANDIDATES_PER_HANDSHAKE).then_some(hs.id)
                    });
                    return Some(Decision::Join(join));
                }
                None
            });
            match joined {
                Some(Some(decision)) => decision,
                Some(None) | None => {
                    if !inner.peers.contains_key(&sender) {
                        if !inner.reserve_unsolicited_slot(now) {
                            return Ok(());
                        }
                        inner.entry_for(sender, now);
                    }
                    let id = inner.begin_own(&sender, Origin::Answered, now);
                    if let Some(entry) = inner.peers.get_mut(&sender) {
                        entry.last_used = now;
                    }
                    Decision::Answer(id)
                }
            }
        };
        let own = match decision {
            Decision::Drop => return Ok(()),
            Decision::Join(join) => {
                if let Some(id) = join {
                    self.add_candidate(&sender, id, verified).await;
                }
                return Ok(());
            }
            Decision::Answer(id) => id,
        };
        match self.start_handshake(sender, own, Origin::Answered).await {
            Ok(()) => {}
            // A failure to send was reported when it happened, and the handshake is gone.
            Err(StartFailure::Sending(_) | StartFailure::Dropped) => return Ok(()),
            Err(StartFailure::Signing(error)) => return Err(error),
        }
        self.add_candidate(&sender, own, verified).await;
        Ok(())
    }

    /// Opens sealed data received through a relay pairing. `claimed_from` is the `from-device` the relay stamped, which only picks the entry to try; the result is `None` unless the frame opens under one of that entry's channels, and names the peer that channel authenticated. A frame that opens under a candidate makes it the current channel. The trial decryptions of one call run under the module's one lock, so a peer that sends many frames that open under no channel makes every other peer wait on it; a lock per peer is the improvement if this module carries volume from peers that are not trusted.
    pub fn open(
        &self,
        data: &SecureDataFrame,
        claimed_from: Option<DeviceId>,
    ) -> Option<OpenedFrame> {
        let claimed = claimed_from?;
        let mut inner = self.lock();
        let now = inner.time(&*self.clock);
        let entry = inner.peers.get_mut(&claimed)?;
        entry.expire(now);
        if let Some(current) = entry.current.as_mut() {
            let outcome = current.channel.open(data);
            if authentic(&outcome) {
                current.confirmed = true;
                let from = current.channel.peer().device_id;
                entry.last_used = now;
                return outcome.ok().map(|frame| OpenedFrame { frame, from });
            }
        }
        // The current one, then the candidates, in order.
        let hs_count = entry.hs.as_ref().map_or(0, |hs| hs.cands.len());
        let total = hs_count + entry.pool.len();
        for index in 0..total {
            let cand = if index < hs_count {
                entry.hs.as_mut().and_then(|hs| hs.cands.get_mut(index))
            } else {
                entry.pool.get_mut(index - hs_count)
            };
            let Some(cand) = cand else { continue };
            let outcome = cand.channel.open(data);
            if !authentic(&outcome) {
                continue;
            }
            let from = cand.channel.peer().device_id;
            // Confirmation: the peer holds the candidate's other secret.
            let taken = if index < hs_count {
                entry.hs.as_mut().map(|hs| hs.cands.remove(index))
            } else {
                Some(entry.pool.remove(index - hs_count))
            };
            if let Some(taken) = taken {
                entry.confirm(taken, now);
            }
            entry.last_used = now;
            return outcome.ok().map(|frame| OpenedFrame { frame, from });
        }
        if let Some(replaced) = entry.replaced.as_mut() {
            if now < replaced.until {
                let from = replaced.channel.peer().device_id;
                return replaced
                    .channel
                    .open(data)
                    .ok()
                    .map(|frame| OpenedFrame { frame, from });
            }
        }
        None
    }

    /// Forgets every peer, abandoning handshakes still waiting: channels are tied to the connection they were set up on.
    pub fn reset(&self, reason: &str) {
        let mut inner = self.lock();
        let peers: Vec<DeviceId> = inner.peers.keys().copied().collect();
        for peer in peers {
            inner.discard(&peer, reason);
        }
    }

    /// Forgets one peer, so the next request to it starts afresh. A candidate channel the peer has not yet confirmed is kept, so that a frame from the peer under it still opens; a handshake with no candidate is dropped.
    pub fn forget(&self, peer: &DeviceId) {
        let mut inner = self.lock();
        let Some(entry) = inner.peers.get_mut(peer) else {
            return;
        };
        let candidates = entry.hs.as_ref().map_or(0, |hs| hs.cands.len()) + entry.pool.len();
        if candidates == 0 {
            inner.discard(peer, "the relay pairing was lost");
            return;
        }
        // A candidate the peer may still confirm stays: it is not a statement about the channel that failed, and a frame from the peer under it is how the two sides meet again.
        entry.current = None;
        entry.replaced = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::NodeIdentity;
    use std::sync::atomic::{AtomicU64, Ordering};
    use wire_mesh_wire::data::DataHaveFrame;

    struct ManualClock(AtomicU64);

    impl ManualClock {
        fn advance(&self, ms: u64) {
            self.0.fetch_add(ms, Ordering::SeqCst);
        }
    }

    impl Clock for ManualClock {
        fn now_unix_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    /// Collects every hello a side sends, and can be told to fail.
    #[derive(Default)]
    struct Outbox {
        hellos: Mutex<Vec<(DeviceId, SecureHelloFrame)>>,
        fail: Mutex<bool>,
    }

    #[async_trait::async_trait]
    impl HelloSender for Outbox {
        async fn send_hello(
            &self,
            peer: &DeviceId,
            hello: &SecureHelloFrame,
        ) -> Result<(), CoreError> {
            if *self.fail.lock().expect("lock") {
                return Err(CoreError::Transport("no connection".to_owned()));
            }
            self.hellos
                .lock()
                .expect("lock")
                .push((*peer, hello.clone()));
            Ok(())
        }
    }

    impl Outbox {
        fn take(&self) -> Vec<(DeviceId, SecureHelloFrame)> {
            std::mem::take(&mut *self.hellos.lock().expect("lock"))
        }
    }

    struct Side {
        id: DeviceId,
        channels: Arc<RelayChannels>,
        outbox: Arc<Outbox>,
    }

    fn side(clock: &Arc<ManualClock>) -> Side {
        let identity = Arc::new(NodeIdentity::generate_ed25519());
        let id = *identity.device_id();
        let outbox = Arc::new(Outbox::default());
        let channels = Arc::new(RelayChannels::new(
            identity,
            outbox.clone(),
            clock.clone(),
            RelayOptions::default(),
        ));
        Side {
            id,
            channels,
            outbox,
        }
    }

    fn have(head_seq: u64) -> Frame {
        Frame::DataHave(DataHaveFrame {
            peer: DeviceId([7; 32]),
            head_seq,
        })
    }

    async fn settle() {
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
    }

    /// Both sides end up with a channel: `a` sends a request, `b` answers it, and `a` completes against the answer.
    async fn establish(a: &Side, b: &Side) -> (SecureHelloFrame, SecureHelloFrame) {
        let sealing = {
            let channels = a.channels.clone();
            let to = b.id;
            tokio::spawn(async move { channels.seal(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        let from_a = a.outbox.take().remove(0).1;
        b.channels.apply_hello(&from_a, Some(a.id)).await;
        let from_b = b.outbox.take().remove(0).1;
        a.channels.apply_hello(&from_b, Some(b.id)).await;
        let sealed = sealing.await.expect("task").expect("sealed");
        assert_eq!(sealed.len(), 1);
        let opened = b.channels.open(&sealed[0], Some(a.id)).expect("opens");
        assert_eq!(opened.frame, have(1));
        assert_eq!(opened.from, a.id);
        (from_a, from_b)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_request_opens_a_channel_in_both_directions() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (side(&clock), side(&clock));
        establish(&a, &b).await;
        let reply = b
            .channels
            .seal(a.id, &have(2), SealPurpose::Reply)
            .await
            .expect("reply");
        let opened = a.channels.open(&reply[0], Some(b.id)).expect("opens");
        assert_eq!((opened.frame, opened.from), (have(2), b.id));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_hello_beside_an_established_channel_only_makes_a_candidate_until_a_frame_opens_under_it(
    ) {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (side(&clock), side(&clock));
        establish(&a, &b).await;
        // A reply from b confirms the channel at a, and two more are still in flight when b starts over.
        let confirming = b
            .channels
            .seal(a.id, &have(9), SealPurpose::Reply)
            .await
            .expect("seal");
        assert!(a.channels.open(&confirming[0], Some(b.id)).is_some());
        let first = b
            .channels
            .seal(a.id, &have(10), SealPurpose::Reply)
            .await
            .expect("seal");
        let second = b
            .channels
            .seal(a.id, &have(11), SealPurpose::Reply)
            .await
            .expect("seal");
        // b loses its channel and sends a request, which starts a handshake with a new ephemeral key.
        b.channels.forget(&a.id);
        let sealing = {
            let channels = b.channels.clone();
            let to = a.id;
            tokio::spawn(async move { channels.seal(to, &have(3), SealPurpose::Request).await })
        };
        settle().await;
        let hellos = b.outbox.take();
        assert_eq!(hellos.len(), 1);
        a.channels.apply_hello(&hellos[0].1, Some(b.id)).await;
        // a answered once and holds a candidate, and it still seals under the channel it had.
        let answers = a.outbox.take();
        assert_eq!(answers.len(), 1);
        let under_old = a
            .channels
            .seal(b.id, &have(4), SealPurpose::Reply)
            .await
            .expect("seal");
        assert_eq!(under_old.len(), 1);
        b.channels.apply_hello(&answers[0].1, Some(a.id)).await;
        let from_b = sealing.await.expect("task").expect("sealed");
        // The frame b sealed under the new channel confirms it at a, which replaces the old one.
        let opened = a.channels.open(&from_b[0], Some(b.id)).expect("opens");
        assert_eq!(opened.frame, have(3));
        // The channel a had opens a frame that was in flight for one window, and never seals.
        assert!(a.channels.open(&first[0], Some(b.id)).is_some());
        clock.advance(HANDSHAKE_WINDOW_MS - 1);
        assert!(a.channels.open(&second[0], Some(b.id)).is_some());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_replaced_channel_stops_opening_frames_once_its_window_has_passed() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (side(&clock), side(&clock));
        establish(&a, &b).await;
        let confirming = b
            .channels
            .seal(a.id, &have(9), SealPurpose::Reply)
            .await
            .expect("seal");
        assert!(a.channels.open(&confirming[0], Some(b.id)).is_some());
        let inflight = b
            .channels
            .seal(a.id, &have(10), SealPurpose::Reply)
            .await
            .expect("seal");
        b.channels.forget(&a.id);
        let sealing = {
            let channels = b.channels.clone();
            let to = a.id;
            tokio::spawn(async move { channels.seal(to, &have(3), SealPurpose::Request).await })
        };
        settle().await;
        a.channels
            .apply_hello(&b.outbox.take()[0].1, Some(b.id))
            .await;
        b.channels
            .apply_hello(&a.outbox.take()[0].1, Some(a.id))
            .await;
        let from_b = sealing.await.expect("task").expect("sealed");
        assert!(a.channels.open(&from_b[0], Some(b.id)).is_some());
        clock.advance(HANDSHAKE_WINDOW_MS);
        assert!(a.channels.open(&inflight[0], Some(b.id)).is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_hello_stamped_with_another_device_or_none_is_dropped_and_changes_nothing() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (side(&clock), side(&clock));
        let sealing = {
            let channels = a.channels.clone();
            let to = b.id;
            tokio::spawn(async move { channels.seal(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        let hellos = a.outbox.take();
        b.channels
            .apply_hello(&hellos[0].1, Some(DeviceId([9; 32])))
            .await;
        b.channels.apply_hello(&hellos[0].1, None).await;
        assert!(b.outbox.take().is_empty());
        sealing.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_hello_repeating_a_key_held_for_the_peer_is_dropped_and_answered_by_nothing() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (side(&clock), side(&clock));
        let (_, from_b) = establish(&a, &b).await;
        a.channels.apply_hello(&from_b, Some(b.id)).await;
        assert!(a.outbox.take().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_failed_send_of_an_answer_is_reported_once_per_interval_and_leaves_no_handshake() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let reports: Arc<Mutex<Vec<Report<LocalFault>>>> = Arc::default();
        let identity = Arc::new(NodeIdentity::generate_ed25519());
        let own = *identity.device_id();
        let outbox = Arc::new(Outbox::default());
        *outbox.fail.lock().expect("lock") = true;
        let sink = reports.clone();
        let channels = RelayChannels::new(
            identity,
            outbox.clone(),
            clock.clone(),
            RelayOptions {
                on_fault: Some(Arc::new(move |report| {
                    sink.lock().expect("lock").push(report);
                })),
                ..RelayOptions::default()
            },
        );
        let remote = NodeIdentity::generate_ed25519();
        let remote_id = *remote.device_id();
        let hello = begin_handshake(&remote, own).await.expect("begin");
        channels.apply_hello(hello.hello(), Some(remote_id)).await;
        channels.apply_hello(hello.hello(), Some(remote_id)).await;
        {
            let told = reports.lock().expect("lock");
            assert_eq!(told.len(), 1);
            assert_eq!(told[0].fault.peer, Some(remote_id));
            assert_eq!(told[0].suppressed, 0);
        }
        // Nothing was sent and no handshake is left, so the same hello is answered again once sending works.
        assert!(outbox.take().is_empty());
        *outbox.fail.lock().expect("lock") = false;
        channels.apply_hello(hello.hello(), Some(remote_id)).await;
        assert_eq!(outbox.take().len(), 1);
        // The second failure was withheld, and the next report says so.
        assert_eq!(
            channels.deliver_due_faults(),
            Some(FAULT_REPORT_INTERVAL_MS_FOR_TEST)
        );
        clock.advance(FAULT_REPORT_INTERVAL_MS_FOR_TEST);
        assert_eq!(channels.deliver_due_faults(), None);
        let told = reports.lock().expect("lock");
        assert_eq!(told.len(), 2);
        assert_eq!(told[1].suppressed, 0);
    }

    const FAULT_REPORT_INTERVAL_MS_FOR_TEST: u64 =
        crate::domain::fault_report::FAULT_REPORT_INTERVAL_MS;

    #[tokio::test(flavor = "current_thread")]
    async fn the_pending_handshakes_are_bounded_and_the_oldest_is_told() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let a = side(&clock);
        let mut sealing = Vec::new();
        for index in 0..=MAX_PENDING_HANDSHAKES {
            let channels = a.channels.clone();
            let to = DeviceId([u8::try_from(index % 256).expect("byte"); 32]);
            let seed = u8::try_from(index / 256).expect("byte");
            let mut raw = [seed; 32];
            raw[0] = u8::try_from(index % 256).expect("byte");
            let to = if seed == 0 { to } else { DeviceId(raw) };
            sealing.push(tokio::spawn(async move {
                channels.seal(to, &have(1), SealPurpose::Request).await
            }));
            clock.advance(1);
            settle().await;
        }
        let first = sealing.remove(0).await.expect("task");
        assert!(matches!(first, Err(RelayError::Abandoned(_))));
        for task in sealing {
            task.abort();
        }
    }

    /// An identity that counts the signature checks asked of it.
    struct Counting {
        inner: NodeIdentity,
        verifies: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl Identity for Counting {
        fn device_id(&self) -> &DeviceId {
            self.inner.device_id()
        }

        fn identity_key(&self) -> &wire_mesh_wire::identity::IdentityKey {
            self.inner.identity_key()
        }

        async fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
            self.inner.sign(message).await
        }

        async fn verify(
            &self,
            key: &wire_mesh_wire::identity::IdentityKey,
            message: &[u8],
            signature: &[u8],
        ) -> Result<bool, CoreError> {
            self.verifies.fetch_add(1, Ordering::SeqCst);
            self.inner.verify(key, message, signature).await
        }

        fn derive_device_id(&self, public_key: &[u8]) -> DeviceId {
            self.inner.derive_device_id(public_key)
        }
    }

    fn counting_side(clock: &Arc<ManualClock>) -> (Side, Arc<Counting>) {
        let identity = Arc::new(Counting {
            inner: NodeIdentity::generate_ed25519(),
            verifies: std::sync::atomic::AtomicUsize::new(0),
        });
        let id = *identity.device_id();
        let outbox = Arc::new(Outbox::default());
        let channels = Arc::new(RelayChannels::new(
            identity.clone(),
            outbox.clone(),
            clock.clone(),
            RelayOptions::default(),
        ));
        (
            Side {
                id,
                channels,
                outbox,
            },
            identity,
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_hello_repeating_a_held_key_is_dropped_before_its_signature_is_checked() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, counted) = counting_side(&clock);
        let b = side(&clock);
        let (_, from_b) = {
            let sealing = {
                let channels = b.channels.clone();
                let to = a.id;
                tokio::spawn(async move { channels.seal(to, &have(1), SealPurpose::Request).await })
            };
            settle().await;
            let hello = b.outbox.take().remove(0).1;
            a.channels.apply_hello(&hello, Some(b.id)).await;
            sealing.abort();
            (hello.clone(), hello)
        };
        let before = counted.verifies.load(Ordering::SeqCst);
        a.channels.apply_hello(&from_b, Some(b.id)).await;
        assert_eq!(counted.verifies.load(Ordering::SeqCst), before);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hellos_from_one_identity_stop_costing_a_signature_check_once_its_handshake_has_its_candidates(
    ) {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, counted) = counting_side(&clock);
        let remote = NodeIdentity::generate_ed25519();
        let sealing = {
            let channels = a.channels.clone();
            let to = *remote.device_id();
            tokio::spawn(async move { channels.seal(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        for _ in 0..CANDIDATES_PER_HANDSHAKE {
            let hello = begin_handshake(&remote, a.id).await.expect("begin");
            a.channels
                .apply_hello(hello.hello(), Some(*remote.device_id()))
                .await;
        }
        let before = counted.verifies.load(Ordering::SeqCst);
        let beyond = begin_handshake(&remote, a.id).await.expect("begin");
        a.channels
            .apply_hello(beyond.hello(), Some(*remote.device_id()))
            .await;
        assert_eq!(counted.verifies.load(Ordering::SeqCst), before);
        sealing.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn hellos_from_many_identities_stop_costing_a_signature_check_once_the_unsolicited_entries_are_taken(
    ) {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, counted) = counting_side(&clock);
        for _ in 0..MAX_UNSOLICITED_PEERS {
            let remote = NodeIdentity::generate_ed25519();
            let hello = begin_handshake(&remote, a.id).await.expect("begin");
            a.channels
                .apply_hello(hello.hello(), Some(*remote.device_id()))
                .await;
        }
        assert_eq!(a.outbox.take().len(), MAX_UNSOLICITED_PEERS);
        let before = counted.verifies.load(Ordering::SeqCst);
        let remote = NodeIdentity::generate_ed25519();
        let hello = begin_handshake(&remote, a.id).await.expect("begin");
        a.channels
            .apply_hello(hello.hello(), Some(*remote.device_id()))
            .await;
        assert_eq!(counted.verifies.load(Ordering::SeqCst), before);
        assert!(a.outbox.take().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_channel_whose_send_counter_is_spent_is_replaced_by_a_new_handshake() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let make = |clock: &Arc<ManualClock>| {
            let identity = Arc::new(NodeIdentity::generate_ed25519());
            let id = *identity.device_id();
            let outbox = Arc::new(Outbox::default());
            let channels = Arc::new(RelayChannels::new(
                identity,
                outbox.clone(),
                clock.clone(),
                RelayOptions {
                    first_send_counter: Some(u64::MAX),
                    ..RelayOptions::default()
                },
            ));
            Side {
                id,
                channels,
                outbox,
            }
        };
        let (a, b) = (make(&clock), make(&clock));
        establish(&a, &b).await;
        // A reply from b confirms the channel at a, whose counter the request already took the last value of.
        let reply = b
            .channels
            .seal(a.id, &have(9), SealPurpose::Reply)
            .await
            .expect("reply");
        assert!(a.channels.open(&reply[0], Some(b.id)).is_some());
        let spent = a.channels.seal(b.id, &have(2), SealPurpose::Request).await;
        assert_eq!(spent, Err(RelayError::Seal(SealError::CounterExhausted)));
        // The spent channel is forgotten, so the next send starts a handshake of its own.
        let sealing = {
            let channels = a.channels.clone();
            let to = b.id;
            tokio::spawn(async move { channels.seal(to, &have(3), SealPurpose::Request).await })
        };
        settle().await;
        assert_eq!(a.outbox.take().len(), 1);
        sealing.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_clock_that_steps_backwards_is_held_at_its_latest_reading_so_a_window_is_never_cut_short(
    ) {
        let clock = Arc::new(ManualClock(AtomicU64::new(10_000)));
        let a = side(&clock);
        let first = NodeIdentity::generate_ed25519();
        let hello = begin_handshake(&first, a.id).await.expect("begin");
        a.channels
            .apply_hello(hello.hello(), Some(*first.device_id()))
            .await;
        assert_eq!(a.outbox.take().len(), 1);
        // The time steps back by 10 seconds. A handshake begun now is dated by the latest reading, not by this one.
        clock.0.store(0, Ordering::SeqCst);
        let second = NodeIdentity::generate_ed25519();
        let hello = begin_handshake(&second, a.id).await.expect("begin");
        a.channels
            .apply_hello(hello.hello(), Some(*second.device_id()))
            .await;
        assert_eq!(a.outbox.take().len(), 1);
        // A whole window later by the clock's own reading, the held time has not moved, so the handshake is still outstanding and a further hello joins it as a candidate instead of being answered.
        clock.advance(HANDSHAKE_WINDOW_MS);
        let another = begin_handshake(&second, a.id).await.expect("begin");
        a.channels
            .apply_hello(another.hello(), Some(*second.device_id()))
            .await;
        assert!(a.outbox.take().is_empty());
    }

    /// An identity whose verification gives up the thread a few times, so two hellos handled at once interleave at the signature check.
    struct Yielding(NodeIdentity);

    #[async_trait::async_trait]
    impl Identity for Yielding {
        fn device_id(&self) -> &DeviceId {
            self.0.device_id()
        }

        fn identity_key(&self) -> &wire_mesh_wire::identity::IdentityKey {
            self.0.identity_key()
        }

        async fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
            self.0.sign(message).await
        }

        async fn verify(
            &self,
            key: &wire_mesh_wire::identity::IdentityKey,
            message: &[u8],
            signature: &[u8],
        ) -> Result<bool, CoreError> {
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            self.0.verify(key, message, signature).await
        }

        fn derive_device_id(&self, public_key: &[u8]) -> DeviceId {
            self.0.derive_device_id(public_key)
        }
    }

    /// Handshakes whose signing gives up the thread a few times, so a hello can arrive while this side's own is still being made.
    struct SlowHandshakes;

    #[async_trait::async_trait]
    impl HandshakeSource for SlowHandshakes {
        async fn begin(
            &self,
            identity: &dyn Identity,
            peer: DeviceId,
        ) -> Result<PendingHandshake, CoreError> {
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
            begin_handshake(identity, peer).await
        }
    }

    fn side_with(
        clock: &Arc<ManualClock>,
        identity: Arc<dyn Identity>,
        options: RelayOptions,
    ) -> Side {
        let id = *identity.device_id();
        let outbox = Arc::new(Outbox::default());
        let channels = Arc::new(RelayChannels::new(
            identity,
            outbox.clone(),
            clock.clone(),
            options,
        ));
        Side {
            id,
            channels,
            outbox,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_same_hello_handled_twice_at_once_is_answered_once_and_builds_one_candidate() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let a = side_with(
            &clock,
            Arc::new(Yielding(NodeIdentity::generate_ed25519())),
            RelayOptions::default(),
        );
        let remote = NodeIdentity::generate_ed25519();
        let remote_id = *remote.device_id();
        let begun = begin_handshake(&remote, a.id).await.expect("begin");
        let hello = begun.hello().clone();
        tokio::join!(
            a.channels.apply_hello(&hello, Some(remote_id)),
            a.channels.apply_hello(&hello, Some(remote_id)),
        );
        assert_eq!(a.outbox.take().len(), 1);
        let sealed = a
            .channels
            .seal(remote_id, &have(1), SealPurpose::Reply)
            .await
            .expect("seal");
        assert_eq!(sealed.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_same_hello_joining_a_handshake_still_being_made_adds_one_candidate() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let a = side_with(
            &clock,
            Arc::new(NodeIdentity::generate_ed25519()),
            RelayOptions {
                handshakes: Some(Arc::new(SlowHandshakes)),
                ..RelayOptions::default()
            },
        );
        let remote = NodeIdentity::generate_ed25519();
        let remote_id = *remote.device_id();
        let sealing = {
            let channels = a.channels.clone();
            tokio::spawn(async move {
                channels
                    .seal(remote_id, &have(1), SealPurpose::Request)
                    .await
            })
        };
        // The handshake is registered and still being signed when both copies of the hello arrive.
        tokio::task::yield_now().await;
        let begun = begin_handshake(&remote, a.id).await.expect("begin");
        let hello = begun.hello().clone();
        tokio::join!(
            a.channels.apply_hello(&hello, Some(remote_id)),
            a.channels.apply_hello(&hello, Some(remote_id)),
        );
        let sealed = sealing.await.expect("task").expect("sealed");
        assert_eq!(sealed.len(), 1);
    }

    /// An identity whose first verification waits for the test to release it, so a hello can be held between its early checks and the state it decides on afterwards.
    struct Gated {
        inner: NodeIdentity,
        gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    }

    #[async_trait::async_trait]
    impl Identity for Gated {
        fn device_id(&self) -> &DeviceId {
            self.inner.device_id()
        }

        fn identity_key(&self) -> &wire_mesh_wire::identity::IdentityKey {
            self.inner.identity_key()
        }

        async fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
            self.inner.sign(message).await
        }

        async fn verify(
            &self,
            key: &wire_mesh_wire::identity::IdentityKey,
            message: &[u8],
            signature: &[u8],
        ) -> Result<bool, CoreError> {
            let waiting = self.gate.lock().expect("lock").take();
            if let Some(waiting) = waiting {
                let _ = waiting.await;
            }
            self.inner.verify(key, message, signature).await
        }

        fn derive_device_id(&self, public_key: &[u8]) -> DeviceId {
            self.inner.derive_device_id(public_key)
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_hello_whose_key_became_held_while_its_signature_was_checked_is_not_answered() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (release, gate) = tokio::sync::oneshot::channel();
        let a = side_with(
            &clock,
            Arc::new(Gated {
                inner: NodeIdentity::generate_ed25519(),
                gate: Mutex::new(Some(gate)),
            }),
            RelayOptions::default(),
        );
        let b = side(&clock);
        let sealing = {
            let channels = b.channels.clone();
            let to = a.id;
            tokio::spawn(async move { channels.seal(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        let hello = b.outbox.take().remove(0).1;
        // The first copy passes the early checks and waits in its signature check.
        let held = {
            let channels = a.channels.clone();
            let hello = hello.clone();
            let from = b.id;
            tokio::spawn(async move { channels.apply_hello(&hello, Some(from)).await })
        };
        settle().await;
        // The second copy is answered, and the frame b seals under the channel confirms the candidate, which holds the key as the current channel.
        a.channels.apply_hello(&hello, Some(b.id)).await;
        let answer = a.outbox.take();
        assert_eq!(answer.len(), 1);
        b.channels.apply_hello(&answer[0].1, Some(a.id)).await;
        let sealed = sealing.await.expect("task").expect("sealed");
        assert!(a.channels.open(&sealed[0], Some(b.id)).is_some());
        // The handshake is over, so nothing outstanding makes the first copy a join: it must be dropped for its key.
        release.send(()).expect("the first copy is waiting");
        held.await.expect("task");
        assert!(a.outbox.take().is_empty());
    }
}
