//! The session side of a relay: the pairings a connection holds with a hub, the end-to-end secure channels that ride them ([`RelayChannels`]), and what a frame from the hub means. The hub forwards `relay-data` payloads between paired devices as an opaque byte pipe and never holds a key: what rides a payload is only a secure channel's hello or sealed data (`spec/secure-channel.cddl`), so a hub sees ciphertext and can alter or drop a frame but not read or forge one.
//!
//! The rules are those of the relay half of the TypeScript `createMeshSession`: a `relay-connect` is sent once per target (it has no acknowledgement, and the hub gives no notice when a pairing is lost, so a pairing is forgotten when a request through it times out), `relay-inbound` is how the target role learns who dialled it, a `relay-data` payload that is neither a hello nor sealed data is dropped, and only a manage-request, manage-response or core/data frame that opened under a channel is acted on, always as coming from the device that channel authenticated, never from the `from-device` the hub stamped.
//!
//! The connection to the hub is behind [`HubLink`], so the module has no transport. The pairings it holds are bounded ([`MAX_OWN_PAIRINGS`] and [`MAX_INBOUND_PAIRINGS`]), since a hub is not trusted to bound them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::transport::{RelayConnectFrame, RelayDataFrame};
use wire_mesh_wire::{decode_frame, encode_frame, Frame};

use crate::domain::relay_channels::{RelayChannels, RelayError, SealPurpose};
use crate::ports::CoreError;

/// The connection to the hub, as far as the relay needs it: sending one frame.
#[async_trait::async_trait]
pub trait HubLink: Send + Sync {
    /// Sends `frame` to the hub over the connection this client is paired on.
    async fn send(&self, frame: Frame) -> Result<(), CoreError>;
}

/// Why [`RelayClient::send_to`] sent nothing, or not all of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelaySendError {
    /// The secure channel could not seal the frame.
    Channel(RelayError),
    /// The hub connection refused a frame.
    Link(CoreError),
}

impl std::fmt::Display for RelaySendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelaySendError::Channel(error) => write!(f, "{error}"),
            RelaySendError::Link(error) => write!(f, "the hub connection failed: {error}"),
        }
    }
}

impl std::error::Error for RelaySendError {}

/// What a frame from the hub yielded for the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayEvent {
    /// A frame that opened under a peer's secure channel and may be acted on: a manage-request, a manage-response or a core/data frame.
    Frame {
        /// The device the channel authenticated. The `from-device` the hub stamped only chose which channel to try.
        from: DeviceId,
        /// The device the `relay-data` was explicitly addressed to, for a caller fronting several local devices behind one hub connection.
        to_device: Option<DeviceId>,
        /// The opened frame.
        frame: Frame,
    },
}

/// The most pairings this side made itself that one hub connection holds. A pairing is made by this side's own `relay-connect`, so what fills this table is this side's own volume of requests to distinct devices, and reaching the bound is the caller's own doing: a request beyond it is an error. A pairing is one 32-byte device-id and a sequence number in a hash table, about 64 bytes with the table's overhead, so a full table is about 64 KiB.
pub const MAX_OWN_PAIRINGS: usize = 1024;

/// The most pairings a hub told this side about (a `relay-inbound`) that one connection holds. A hub is not trusted to bound them, and an honest hub that fronts many devices sends one for each device that dials this side. Such a pairing only saves a redundant `relay-connect` (a second one is idempotent at the hub), so beyond the bound the oldest is dropped, no request is ever refused for it, and the drop is reported as a local fault. About 64 KiB at the bound, as for [`MAX_OWN_PAIRINGS`].
pub const MAX_INBOUND_PAIRINGS: usize = 1024;

/// The pairings of one hub connection: those this side made (`own`) and those a hub announced (`inbound`), each bounded on its own so that neither can keep the other from growing. Membership is a hash lookup, and the order the pairings were made in is kept for [`RelayClient::paired`].
#[derive(Debug, Default)]
struct Pairings {
    own: HashMap<DeviceId, u64>,
    inbound: HashMap<DeviceId, u64>,
    next: u64,
}

// The tables are hash tables, so membership never walks a list: a change of either to a linear structure stops this from compiling.
const _: fn(&Pairings) = |pairings| {
    let _: &HashMap<DeviceId, u64> = &pairings.own;
    let _: &HashMap<DeviceId, u64> = &pairings.inbound;
};

impl Pairings {
    fn has(&self, device: &DeviceId) -> bool {
        self.own.contains_key(device) || self.inbound.contains_key(device)
    }

    fn take_order(&mut self) -> u64 {
        let order = self.next;
        self.next += 1;
        order
    }

    /// Records a pairing this side made. A device already paired stays as it is. `false` when this side already holds [`MAX_OWN_PAIRINGS`] of its own.
    fn add_own(&mut self, device: DeviceId) -> bool {
        if self.has(&device) {
            return true;
        }
        if self.own.len() >= MAX_OWN_PAIRINGS {
            return false;
        }
        let order = self.take_order();
        self.own.insert(device, order);
        true
    }

    /// Records a pairing a hub announced. A device already paired stays as it is. At [`MAX_INBOUND_PAIRINGS`] the oldest announced pairing is dropped to make room, and its device is returned.
    fn add_inbound(&mut self, device: DeviceId) -> Option<DeviceId> {
        if self.has(&device) {
            return None;
        }
        let dropped = if self.inbound.len() >= MAX_INBOUND_PAIRINGS {
            let oldest = self
                .inbound
                .iter()
                .min_by_key(|(_, order)| **order)
                .map(|(device, _)| *device);
            if let Some(oldest) = oldest {
                self.inbound.remove(&oldest);
            }
            oldest
        } else {
            None
        };
        let order = self.take_order();
        self.inbound.insert(device, order);
        dropped
    }

    fn remove(&mut self, device: &DeviceId) {
        self.own.remove(device);
        self.inbound.remove(device);
    }

    fn clear(&mut self) {
        self.own.clear();
        self.inbound.clear();
    }

    /// Every paired device in the order the pairings were made.
    fn in_order(&self) -> Vec<DeviceId> {
        let mut all: Vec<(&u64, &DeviceId)> = self
            .own
            .iter()
            .chain(self.inbound.iter())
            .map(|(device, order)| (order, device))
            .collect();
        all.sort_unstable();
        all.into_iter().map(|(_, device)| *device).collect()
    }
}

/// Whether a frame may be acted on after it opened under a channel: only what obligation 5 of the spec lets travel in one.
fn is_actionable(frame: &Frame) -> bool {
    matches!(
        frame,
        Frame::ManageRequest(_)
            | Frame::ManageResponse(_)
            | Frame::DataHave(_)
            | Frame::DataRequest(_)
            | Frame::DataEntries(_)
    )
}

/// The relay half of a session over one hub connection.
pub struct RelayClient {
    link: Arc<dyn HubLink>,
    channels: Arc<RelayChannels>,
    pairings: Mutex<Pairings>,
}

impl RelayClient {
    /// A client sending through `link`, with its secure channels in `channels` (whose hello sender must put a hello on the same connection, as [`RelayClient::hello_sender`] does).
    #[must_use]
    pub fn new(link: Arc<dyn HubLink>, channels: Arc<RelayChannels>) -> Self {
        RelayClient {
            link,
            channels,
            pairings: Mutex::new(Pairings::default()),
        }
    }

    fn pairings(&self) -> MutexGuard<'_, Pairings> {
        match self.pairings.lock() {
            Ok(guard) => guard,
            // A panic elsewhere left the set as the last complete change made it.
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    /// Every device this connection holds a pairing with, in establishment order, in either role.
    #[must_use]
    pub fn paired(&self) -> Vec<DeviceId> {
        self.pairings().in_order()
    }

    /// Whether this connection holds a pairing with `device`.
    #[must_use]
    pub fn is_paired(&self, device: &DeviceId) -> bool {
        self.pairings().has(device)
    }

    /// Establishes a `relay-connect` pairing to `target` if there is none, whether one was made by an earlier request or the target dialled this side first. A `relay-connect` has no acknowledgement, so the pairing is recorded once the frame is sent.
    ///
    /// # Errors
    ///
    /// The hub connection's error when the frame could not be sent (no pairing is recorded then), and a [`CoreError::Transport`] when this side already holds [`MAX_OWN_PAIRINGS`] pairings of its own. A pairing a hub announced never makes this fail.
    pub async fn ensure_pairing(&self, target: DeviceId) -> Result<(), CoreError> {
        if self.is_paired(&target) {
            return Ok(());
        }
        if self.pairings().own.len() >= MAX_OWN_PAIRINGS {
            return Err(CoreError::Transport(format!(
                "this side already holds {MAX_OWN_PAIRINGS} pairings of its own on the connection"
            )));
        }
        self.link
            .send(Frame::RelayConnect(RelayConnectFrame {
                target_device: target,
                source_device: None,
            }))
            .await?;
        self.pairings().add_own(target);
        Ok(())
    }

    /// Seals `frame` for `target` on its secure channel and sends every sealed copy to the hub as `relay-data` addressed to `target`. A request pairs first when there is no pairing and marks the target chosen; a reply answers a frame the target sent, so it pairs nothing (a device that sent a frame through the hub is paired already, and one that is not has no pairing for the hub to deliver on).
    ///
    /// # Errors
    ///
    /// [`RelaySendError`] when the pairing could not be made, the channel refuses the frame, or the hub connection refuses a copy.
    pub async fn send_to(
        &self,
        target: DeviceId,
        frame: &Frame,
        purpose: SealPurpose,
    ) -> Result<(), RelaySendError> {
        if purpose == SealPurpose::Request {
            self.ensure_pairing(target)
                .await
                .map_err(RelaySendError::Link)?;
        }
        let sealed = self
            .channels
            .seal(target, frame, purpose)
            .await
            .map_err(RelaySendError::Channel)?;
        for copy in sealed {
            self.link
                .send(Frame::RelayData(RelayDataFrame {
                    payload: encode_frame(&Frame::SecureData(copy)),
                    to_device: Some(target),
                    from_device: None,
                }))
                .await
                .map_err(RelaySendError::Link)?;
        }
        Ok(())
    }

    /// Handles a frame received from the hub, and returns what the session should act on. `relay-inbound` records the device that dialled this side; `relay-data` carrying a hello is completed by the secure channels and one carrying sealed data is opened, yielding a frame only if it opened and is one a channel may carry; every other frame, and any payload that is neither, is ignored here.
    pub async fn on_frame(&self, frame: &Frame) -> Vec<RelayEvent> {
        match frame {
            Frame::RelayInbound(inbound) => {
                let dropped = self.pairings().add_inbound(inbound.source_device);
                if let Some(oldest) = dropped {
                    // A hub names more devices than this connection remembers: the oldest announced pairing is forgotten (a later request to it sends one more, idempotent, relay-connect) and the owner is told.
                    self.channels.report_fault(
                        &CoreError::Transport(format!(
                            "a relay-inbound displaced the oldest of the {MAX_INBOUND_PAIRINGS} pairings a hub announced"
                        )),
                        Some(oldest),
                    );
                }
                Vec::new()
            }
            Frame::RelayData(data) => self.on_relay_data(data).await,
            _ => Vec::new(),
        }
    }

    async fn on_relay_data(&self, data: &RelayDataFrame) -> Vec<RelayEvent> {
        // What rides the payload is a secure channel's hello or sealed data; anything else, including a plaintext manage-request, is dropped.
        let Ok(inner) = decode_frame(&data.payload) else {
            return Vec::new();
        };
        match inner {
            Frame::SecureHello(hello) => {
                self.channels.apply_hello(&hello, data.from_device).await;
                Vec::new()
            }
            Frame::SecureData(sealed) => match self.channels.open(&sealed, data.from_device) {
                Some(opened) if is_actionable(&opened.frame) => vec![RelayEvent::Frame {
                    from: opened.from,
                    to_device: data.to_device,
                    frame: opened.frame,
                }],
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// Forgets the pairing with `target` and its secure channel, so the next request to it establishes a fresh pairing. The hub gives no notice when a pairing is lost (the target reconnected, or the hub restarted), so a request that timed out is the only sign this side has.
    pub fn forget(&self, target: &DeviceId) {
        self.pairings().remove(target);
        self.channels.forget(target);
    }

    /// Forgets every pairing and abandons every secure channel: a pairing is state the hub holds for one connection, so a session that gets a new connection starts with none.
    pub fn reset(&self, reason: &str) {
        self.pairings().clear();
        self.channels.reset(reason);
    }

    /// A [`HelloSender`](crate::domain::relay_channels::HelloSender) that wraps each hello as `relay-data` addressed to the peer and sends it through `link`: what a [`RelayChannels`] built for this client sends its hellos with.
    #[must_use]
    pub fn hello_sender(
        link: Arc<dyn HubLink>,
    ) -> Arc<dyn crate::domain::relay_channels::HelloSender> {
        Arc::new(WrappedHello { link })
    }
}

struct WrappedHello {
    link: Arc<dyn HubLink>,
}

#[async_trait::async_trait]
impl crate::domain::relay_channels::HelloSender for WrappedHello {
    async fn send_hello(
        &self,
        peer: &DeviceId,
        hello: &wire_mesh_wire::secure_channel::SecureHelloFrame,
    ) -> Result<(), CoreError> {
        self.link
            .send(Frame::RelayData(RelayDataFrame {
                payload: encode_frame(&Frame::SecureHello(hello.clone())),
                to_device: Some(*peer),
                from_device: None,
            }))
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::NodeIdentity;
    use crate::domain::relay_channels::RelayOptions;
    use crate::ports::{Clock, Identity};
    use std::sync::atomic::{AtomicU64, Ordering};
    use wire_mesh_wire::data::DataHaveFrame;
    use wire_mesh_wire::transport::{PingFrame, RelayInboundFrame};

    struct ManualClock(AtomicU64);

    impl Clock for ManualClock {
        fn now_unix_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    /// A hub link that keeps what it was sent, so a test plays the hub.
    #[derive(Default)]
    struct Wire(Mutex<Vec<Frame>>);

    #[async_trait::async_trait]
    impl HubLink for Wire {
        async fn send(&self, frame: Frame) -> Result<(), CoreError> {
            self.0.lock().expect("lock").push(frame);
            Ok(())
        }
    }

    impl Wire {
        fn take(&self) -> Vec<Frame> {
            std::mem::take(&mut *self.0.lock().expect("lock"))
        }
    }

    struct Node {
        id: DeviceId,
        client: Arc<RelayClient>,
        wire: Arc<Wire>,
    }

    fn node(clock: &Arc<ManualClock>) -> Node {
        let identity = Arc::new(NodeIdentity::generate_ed25519());
        let id = *identity.device_id();
        let wire = Arc::new(Wire::default());
        let link: Arc<dyn HubLink> = wire.clone();
        let channels = Arc::new(RelayChannels::new(
            identity,
            RelayClient::hello_sender(link.clone()),
            clock.clone(),
            RelayOptions::default(),
        ));
        Node {
            id,
            client: Arc::new(RelayClient::new(link, channels)),
            wire,
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

    /// What the hub does for a frame `from` sent: the `relay-data` it holds goes to the device it names, stamped with the sender.
    fn forwarded(from: &DeviceId, frame: Frame) -> Option<(DeviceId, Frame)> {
        match frame {
            Frame::RelayData(mut data) => {
                let to = data.to_device?;
                data.from_device = Some(*from);
                Some((to, Frame::RelayData(data)))
            }
            _ => None,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_request_pairs_once_and_everything_sent_is_a_hello_or_ciphertext_to_the_target() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (node(&clock), node(&clock));
        let sending = {
            let client = a.client.clone();
            let to = b.id;
            tokio::spawn(async move { client.send_to(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        let first = a.wire.take();
        assert!(matches!(&first[0], Frame::RelayConnect(connect) if connect.target_device == b.id));
        assert!(a.client.is_paired(&b.id));
        // The hello goes out as relay-data to the target, and nothing else yet.
        assert_eq!(first.len(), 2);
        let Frame::RelayData(hello) = &first[1] else {
            panic!("expected relay-data");
        };
        assert_eq!(hello.to_device, Some(b.id));
        assert!(matches!(
            decode_frame(&hello.payload),
            Ok(Frame::SecureHello(_))
        ));
        sending.abort();
        // A second request to the same target sends no second relay-connect.
        let again = {
            let client = a.client.clone();
            let to = b.id;
            tokio::spawn(async move { client.send_to(to, &have(2), SealPurpose::Request).await })
        };
        settle().await;
        assert!(a
            .wire
            .take()
            .iter()
            .all(|frame| !matches!(frame, Frame::RelayConnect(_))));
        again.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_request_reaches_the_target_as_the_device_its_channel_authenticated() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (node(&clock), node(&clock));
        let sending = {
            let client = a.client.clone();
            let to = b.id;
            tokio::spawn(async move { client.send_to(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        // b learns it was dialled, then receives a's hello through the hub and answers it.
        b.client
            .on_frame(&Frame::RelayInbound(RelayInboundFrame {
                source_device: a.id,
                target_device: None,
            }))
            .await;
        assert!(b.client.is_paired(&a.id));
        let hello = a
            .wire
            .take()
            .into_iter()
            .find_map(|frame| forwarded(&a.id, frame))
            .expect("a hello for b")
            .1;
        assert!(b.client.on_frame(&hello).await.is_empty());
        settle().await;
        let answer = b
            .wire
            .take()
            .into_iter()
            .find_map(|frame| forwarded(&b.id, frame))
            .expect("b's answer")
            .1;
        assert!(a.client.on_frame(&answer).await.is_empty());
        settle().await;
        sending.await.expect("task").expect("sent");
        let sealed = a
            .wire
            .take()
            .into_iter()
            .rev()
            .find_map(|frame| forwarded(&a.id, frame))
            .expect("sealed data for b")
            .1;
        // The hub stamps a different device than the channel proves: the event names the device the channel authenticated.
        let Frame::RelayData(mut data) = sealed else {
            panic!("relay-data");
        };
        data.from_device = Some(a.id);
        let events = b.client.on_frame(&Frame::RelayData(data)).await;
        assert_eq!(
            events,
            vec![RelayEvent::Frame {
                from: a.id,
                to_device: Some(b.id),
                frame: have(1),
            }]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_relay_data_payload_that_is_not_a_hello_or_sealed_data_is_dropped() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let b = node(&clock);
        let intruder = DeviceId([9; 32]);
        for plaintext in [
            Frame::DataHave(DataHaveFrame {
                peer: DeviceId([7; 32]),
                head_seq: 1,
            }),
            Frame::Ping(PingFrame),
        ] {
            let events = b
                .client
                .on_frame(&Frame::RelayData(RelayDataFrame {
                    payload: encode_frame(&plaintext),
                    to_device: None,
                    from_device: Some(intruder),
                }))
                .await;
            assert!(events.is_empty());
        }
        let garbage = b
            .client
            .on_frame(&Frame::RelayData(RelayDataFrame {
                payload: vec![0xff, 0x00],
                to_device: None,
                from_device: Some(intruder),
            }))
            .await;
        assert!(garbage.is_empty());
        assert!(b.wire.take().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn forgetting_a_target_and_resetting_clear_the_pairings() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let a = node(&clock);
        let (first, second) = (DeviceId([1; 32]), DeviceId([2; 32]));
        a.client.ensure_pairing(first).await.expect("pair");
        a.client.ensure_pairing(second).await.expect("pair");
        assert_eq!(a.client.paired(), vec![first, second]);
        a.client.forget(&first);
        assert_eq!(a.client.paired(), vec![second]);
        // The next request to it pairs afresh.
        a.wire.take();
        a.client.ensure_pairing(first).await.expect("pair");
        assert_eq!(a.wire.take().len(), 1);
        a.client.reset("the connection changed");
        assert!(a.client.paired().is_empty());
    }

    /// Opens a channel between `a` (asking) and `b`, through the hub, and returns the sealed frames `a` sends next.
    async fn open_channel(a: &Node, b: &Node) {
        let sending = {
            let client = a.client.clone();
            let to = b.id;
            tokio::spawn(async move { client.send_to(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        let hello = a
            .wire
            .take()
            .into_iter()
            .find_map(|frame| forwarded(&a.id, frame))
            .expect("a hello")
            .1;
        b.client.on_frame(&hello).await;
        settle().await;
        let answer = b
            .wire
            .take()
            .into_iter()
            .find_map(|frame| forwarded(&b.id, frame))
            .expect("an answer")
            .1;
        a.client.on_frame(&answer).await;
        settle().await;
        sending.await.expect("task").expect("sent");
        a.wire.take();
    }

    /// The `relay-data` the hub would deliver for the frames `from` sent last.
    fn delivered(from: &Node) -> Vec<Frame> {
        from.wire
            .take()
            .into_iter()
            .filter_map(|frame| forwarded(&from.id, frame))
            .map(|(_, frame)| frame)
            .collect()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_frame_a_channel_may_not_carry_is_dropped_even_when_it_opens() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (node(&clock), node(&clock));
        open_channel(&a, &b).await;
        // A ping sealed on the channel opens, and is still not acted on.
        a.client
            .send_to(b.id, &Frame::Ping(PingFrame), SealPurpose::Request)
            .await
            .expect("sent");
        for frame in delivered(&a) {
            assert!(b.client.on_frame(&frame).await.is_empty());
        }
        // A manage-response is.
        a.client
            .send_to(b.id, &have(2), SealPurpose::Request)
            .await
            .expect("sent");
        let events: Vec<RelayEvent> = {
            let mut all = Vec::new();
            for frame in delivered(&a) {
                all.extend(b.client.on_frame(&frame).await);
            }
            all
        };
        assert_eq!(events.len(), 1);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_sender_is_the_device_the_channel_authenticated_and_not_the_one_the_hub_stamped() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (node(&clock), node(&clock));
        open_channel(&a, &b).await;
        a.client
            .send_to(b.id, &have(3), SealPurpose::Request)
            .await
            .expect("sent");
        let Frame::RelayData(mut data) = delivered(&a).remove(0) else {
            panic!("relay-data");
        };
        // The hub stamps another device: the channel for that device does not exist, so nothing opens.
        data.from_device = Some(DeviceId([9; 32]));
        assert!(b
            .client
            .on_frame(&Frame::RelayData(data.clone()))
            .await
            .is_empty());
        // Stamped with the real sender it opens, and names the sender the channel authenticated.
        data.from_device = Some(a.id);
        let events = b.client.on_frame(&Frame::RelayData(data)).await;
        assert!(matches!(&events[..], [RelayEvent::Frame { from, .. }] if *from == a.id));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_hello_through_relay_data_is_completed_only_with_the_stamped_sender() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (node(&clock), node(&clock));
        let sending = {
            let client = a.client.clone();
            let to = b.id;
            tokio::spawn(async move { client.send_to(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        let Frame::RelayData(mut data) = a
            .wire
            .take()
            .into_iter()
            .find_map(|frame| forwarded(&a.id, frame))
            .expect("a hello")
            .1
        else {
            panic!("relay-data");
        };
        data.from_device = None;
        b.client.on_frame(&Frame::RelayData(data.clone())).await;
        settle().await;
        assert!(b.wire.take().is_empty());
        data.from_device = Some(a.id);
        b.client.on_frame(&Frame::RelayData(data)).await;
        settle().await;
        assert_eq!(b.wire.take().len(), 1);
        sending.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_request_through_an_existing_inbound_pairing_sends_no_relay_connect() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (node(&clock), node(&clock));
        a.client
            .on_frame(&Frame::RelayInbound(RelayInboundFrame {
                source_device: b.id,
                target_device: None,
            }))
            .await;
        let sending = {
            let client = a.client.clone();
            let to = b.id;
            tokio::spawn(async move { client.send_to(to, &have(1), SealPurpose::Request).await })
        };
        settle().await;
        assert!(a
            .wire
            .take()
            .iter()
            .all(|frame| !matches!(frame, Frame::RelayConnect(_))));
        sending.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_pairing_that_could_not_be_sent_is_not_recorded() {
        struct Refusing;

        #[async_trait::async_trait]
        impl HubLink for Refusing {
            async fn send(&self, _frame: Frame) -> Result<(), CoreError> {
                Err(CoreError::Transport("no connection".to_owned()))
            }
        }
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let identity = Arc::new(NodeIdentity::generate_ed25519());
        let link: Arc<dyn HubLink> = Arc::new(Refusing);
        let channels = Arc::new(RelayChannels::new(
            identity,
            RelayClient::hello_sender(link.clone()),
            clock,
            RelayOptions::default(),
        ));
        let client = RelayClient::new(link, channels);
        let target = DeviceId([5; 32]);
        assert!(client.ensure_pairing(target).await.is_err());
        assert!(!client.is_paired(&target));
    }

    fn device_number(n: usize) -> DeviceId {
        let mut bytes = [0u8; 32];
        bytes[..8].copy_from_slice(&(n as u64).to_be_bytes());
        DeviceId(bytes)
    }

    fn inbound(device: DeviceId) -> Frame {
        Frame::RelayInbound(RelayInboundFrame {
            source_device: device,
            target_device: None,
        })
    }

    /// A node whose faults are collected.
    fn node_with_faults(clock: &Arc<ManualClock>) -> (Node, Arc<Mutex<Vec<String>>>) {
        let identity = Arc::new(NodeIdentity::generate_ed25519());
        let id = *identity.device_id();
        let wire = Arc::new(Wire::default());
        let link: Arc<dyn HubLink> = wire.clone();
        let faults: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = Arc::clone(&faults);
        let channels = Arc::new(RelayChannels::new(
            identity,
            RelayClient::hello_sender(link.clone()),
            clock.clone(),
            RelayOptions {
                on_fault: Some(Arc::new(move |report| {
                    sink.lock().expect("lock").push(report.fault.error);
                })),
                ..RelayOptions::default()
            },
        ));
        (
            Node {
                id,
                client: Arc::new(RelayClient::new(link, channels)),
                wire,
            },
            faults,
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn announced_pairings_stop_growing_at_the_bound_and_displace_the_oldest_one_over() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, faults) = node_with_faults(&clock);
        for n in 0..MAX_INBOUND_PAIRINGS - 1 {
            a.client.on_frame(&inbound(device_number(n))).await;
        }
        assert_eq!(a.client.paired().len(), MAX_INBOUND_PAIRINGS - 1);
        assert!(faults.lock().expect("lock").is_empty());
        // At the bound: the last one still fits, nothing is displaced.
        a.client
            .on_frame(&inbound(device_number(MAX_INBOUND_PAIRINGS - 1)))
            .await;
        assert_eq!(a.client.paired().len(), MAX_INBOUND_PAIRINGS);
        assert!(faults.lock().expect("lock").is_empty());
        // One over: the table does not grow, the oldest is the one dropped, and the owner is told.
        let beyond = device_number(MAX_INBOUND_PAIRINGS);
        a.client.on_frame(&inbound(beyond)).await;
        assert_eq!(a.client.paired().len(), MAX_INBOUND_PAIRINGS);
        assert!(a.client.is_paired(&beyond));
        assert!(!a.client.is_paired(&device_number(0)));
        assert!(a.client.is_paired(&device_number(1)));
        assert_eq!(faults.lock().expect("lock").len(), 1);
        // A device that is paired already is not a new pairing, at the bound or not.
        a.client.on_frame(&inbound(device_number(1))).await;
        assert_eq!(a.client.paired().len(), MAX_INBOUND_PAIRINGS);
        assert!(a.client.is_paired(&device_number(1)));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_full_table_of_announced_pairings_never_keeps_this_side_from_initiating() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, _faults) = node_with_faults(&clock);
        for n in 0..MAX_INBOUND_PAIRINGS + 5 {
            a.client.on_frame(&inbound(device_number(n))).await;
        }
        a.wire.take();
        let target = device_number(MAX_INBOUND_PAIRINGS + 1_000);
        a.client.ensure_pairing(target).await.expect("pairs");
        assert!(a.client.is_paired(&target));
        let sent = a.wire.take();
        assert!(
            matches!(&sent[..], [Frame::RelayConnect(connect)] if connect.target_device == target)
        );
        // Announced pairings arriving after do not displace the one this side made.
        for n in 0..MAX_INBOUND_PAIRINGS + 5 {
            a.client
                .on_frame(&inbound(device_number(MAX_INBOUND_PAIRINGS + 2_000 + n)))
                .await;
        }
        assert!(a.client.is_paired(&target));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn this_sides_own_pairings_are_counted_apart_and_refused_at_their_own_bound() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, _faults) = node_with_faults(&clock);
        // Announced pairings do not count against the own bound.
        for n in 0..MAX_INBOUND_PAIRINGS {
            a.client.on_frame(&inbound(device_number(n))).await;
        }
        for n in 0..MAX_OWN_PAIRINGS {
            a.client
                .ensure_pairing(device_number(100_000 + n))
                .await
                .expect("one of this side's own");
        }
        assert_eq!(
            a.client.paired().len(),
            MAX_INBOUND_PAIRINGS + MAX_OWN_PAIRINGS
        );
        // One over this side's own bound is its own doing: an error, and no relay-connect.
        a.wire.take();
        let beyond = device_number(500_000);
        assert!(a.client.ensure_pairing(beyond).await.is_err());
        assert!(!a.client.is_paired(&beyond));
        assert!(a.wire.take().is_empty());
        // A device announced already needs no relay-connect and no room.
        a.client
            .ensure_pairing(device_number(3))
            .await
            .expect("already paired");
        assert!(a.wire.take().is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_pairing_is_forgotten_and_the_order_of_the_rest_is_kept() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, _faults) = node_with_faults(&clock);
        for n in 0..4 {
            a.client.on_frame(&inbound(device_number(n))).await;
        }
        a.client
            .ensure_pairing(device_number(10))
            .await
            .expect("pairs");
        a.client.on_frame(&inbound(device_number(4))).await;
        a.client.forget(&device_number(1));
        assert_eq!(
            a.client.paired(),
            vec![
                device_number(0),
                device_number(2),
                device_number(3),
                device_number(10),
                device_number(4),
            ]
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_reply_to_a_device_that_is_not_paired_sends_no_relay_connect() {
        let clock = Arc::new(ManualClock(AtomicU64::new(0)));
        let (a, b) = (node(&clock), node(&clock));
        let replying = {
            let client = a.client.clone();
            let to = b.id;
            tokio::spawn(async move { client.send_to(to, &have(1), SealPurpose::Reply).await })
        };
        settle().await;
        let sent = a.wire.take();
        assert!(sent
            .iter()
            .all(|frame| !matches!(frame, Frame::RelayConnect(_))));
        assert!(!a.client.is_paired(&b.id));
        replying.abort();
    }

    #[test]
    fn the_table_refuses_an_own_pairing_at_its_own_bound_whatever_the_caller_checked() {
        let mut table = Pairings::default();
        for n in 0..MAX_OWN_PAIRINGS {
            assert!(table.add_own(device_number(n)));
        }
        assert!(!table.add_own(device_number(MAX_OWN_PAIRINGS)));
        assert!(
            table.add_own(device_number(0)),
            "a device already paired is not a new pairing"
        );
        assert_eq!(table.own.len(), MAX_OWN_PAIRINGS);
        // Announced pairings neither count against it nor are displaced by it.
        assert_eq!(table.add_inbound(device_number(1_000_000)), None);
        assert_eq!(table.own.len(), MAX_OWN_PAIRINGS);
    }
}
