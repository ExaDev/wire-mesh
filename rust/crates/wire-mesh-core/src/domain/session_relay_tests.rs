//! Sessions that reach each other through a relay hub, over an in-memory hub that forwards `relay-data` between paired devices, stamps the sender as a real hub does, and records every frame it sees. One test per rule the TypeScript session applies to relay traffic.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_core::Stream;
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_stream::wrappers::UnboundedReceiverStream;
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::{ManageCommand, ManageOk, ManageOutcome, ManageResponseFrame};
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb};
use wire_mesh_wire::transport::{RelayDataFrame, RelayInboundFrame};
use wire_mesh_wire::value::CanonicalMap;
use wire_mesh_wire::{decode_frame, encode_frame, Frame};

use super::*;
use crate::adapters::NodeIdentity;
use crate::domain::relay_channels::{RelayChannels, RelayOptions};
use crate::domain::relay_client::{HubLink, RelayClient};
use crate::ports::{Clock, Identity};

/// What the hub does with the frames its nodes send.
struct Hub {
    /// Every frame any node sent to the hub, with the sender.
    seen: Mutex<Vec<(DeviceId, Frame)>>,
    /// The channel into each node.
    nodes: Mutex<HashMap<DeviceId, mpsc::UnboundedSender<Frame>>>,
    /// Pairings, symmetric.
    pairs: Mutex<HashMap<DeviceId, Vec<DeviceId>>>,
    /// When set, every forwarded `relay-data` is stamped with this device instead of its sender.
    stamp_as: Mutex<Option<DeviceId>>,
}

impl Hub {
    fn new() -> Arc<Self> {
        Arc::new(Hub {
            seen: Mutex::new(Vec::new()),
            nodes: Mutex::new(HashMap::new()),
            pairs: Mutex::new(HashMap::new()),
            stamp_as: Mutex::new(None),
        })
    }

    fn handle(&self, from: DeviceId, frame: Frame) {
        self.seen.lock().expect("lock").push((from, frame.clone()));
        match frame {
            Frame::RelayConnect(connect) => {
                let mut pairs = self.pairs.lock().expect("lock");
                for (a, b) in [(from, connect.target_device), (connect.target_device, from)] {
                    let held = pairs.entry(a).or_default();
                    if !held.contains(&b) {
                        held.push(b);
                    }
                }
                drop(pairs);
                self.deliver(
                    connect.target_device,
                    Frame::RelayInbound(RelayInboundFrame {
                        source_device: from,
                        target_device: None,
                    }),
                );
            }
            Frame::RelayData(data) => {
                let Some(to) = data.to_device else { return };
                let paired = self
                    .pairs
                    .lock()
                    .expect("lock")
                    .get(&from)
                    .is_some_and(|held| held.contains(&to));
                if !paired {
                    return;
                }
                let stamp = (*self.stamp_as.lock().expect("lock")).unwrap_or(from);
                self.deliver(
                    to,
                    Frame::RelayData(RelayDataFrame {
                        payload: data.payload,
                        to_device: Some(to),
                        from_device: Some(stamp),
                    }),
                );
            }
            _ => {}
        }
    }

    fn deliver(&self, to: DeviceId, frame: Frame) {
        if let Some(node) = self.nodes.lock().expect("lock").get(&to) {
            let _ = node.send(frame);
        }
    }

    /// The `relay-connect` frames a device sent.
    fn connects_from(&self, device: &DeviceId) -> usize {
        self.seen
            .lock()
            .expect("lock")
            .iter()
            .filter(|(from, frame)| from == device && matches!(frame, Frame::RelayConnect(_)))
            .count()
    }
}

struct HubConnection {
    from: DeviceId,
    hub: Arc<Hub>,
    inbound: Option<mpsc::UnboundedReceiver<Frame>>,
}

#[async_trait::async_trait]
impl Connection for HubConnection {
    async fn send(&self, frame: Frame) -> Result<(), CoreError> {
        self.hub.handle(self.from, frame);
        Ok(())
    }

    fn receive(&mut self) -> Result<Pin<Box<dyn Stream<Item = Frame> + Send>>, CoreError> {
        let inbound = self
            .inbound
            .take()
            .ok_or_else(|| CoreError::Transport("already taken".to_owned()))?;
        Ok(Box::pin(UnboundedReceiverStream::new(inbound)))
    }

    async fn close(&mut self) -> Result<(), CoreError> {
        self.hub.nodes.lock().expect("lock").remove(&self.from);
        Ok(())
    }
}

struct Zero;

impl Clock for Zero {
    fn now_unix_ms(&self) -> u64 {
        0
    }
}

struct Node {
    id: DeviceId,
    session: Session,
    events: mpsc::UnboundedReceiver<SessionEvent>,
}

/// Answers `relay:echo` and counts how many requests reached it.
struct Counting(Arc<Mutex<usize>>);

#[async_trait::async_trait]
impl ManageRequestHandler for Counting {
    async fn handle(&self, _request: IncomingManageRequest) -> ManageOutcome {
        *self.0.lock().expect("lock") += 1;
        ManageOutcome::Ok(ManageOk {
            extra: CanonicalMap::new(),
        })
    }
}

/// Never answers, so a request to it stays waiting.
struct Hanging;

#[async_trait::async_trait]
impl ManageRequestHandler for Hanging {
    async fn handle(&self, _request: IncomingManageRequest) -> ManageOutcome {
        std::future::pending().await
    }
}

async fn node(hub: &Arc<Hub>, answered: &Arc<Mutex<usize>>) -> Node {
    let identity = Arc::new(NodeIdentity::generate_ed25519());
    let id = *identity.device_id();
    let (to_node, inbound) = mpsc::unbounded_channel();
    hub.nodes.lock().expect("lock").insert(id, to_node);
    let connection = Box::new(HubConnection {
        from: id,
        hub: Arc::clone(hub),
        inbound: Some(inbound),
    });
    let registry = HandlerRegistry::new()
        .register("relay:echo", Arc::new(Counting(Arc::clone(answered))))
        .register("relay:hang", Arc::new(Hanging));
    let (session, events) = Session::accept_relayed(
        connection,
        ["core/management".to_owned()],
        registry,
        move |link: Arc<dyn HubLink>| {
            let channels = Arc::new(RelayChannels::new(
                identity,
                RelayClient::hello_sender(Arc::clone(&link)),
                Arc::new(Zero),
                RelayOptions::default(),
            ));
            Arc::new(RelayClient::new(link, channels))
        },
    )
    .await
    .expect("accept");
    Node {
        id,
        session,
        events,
    }
}

fn echo() -> ManageCommand {
    let mut params = CanonicalMap::new();
    params
        .insert(
            "verb".to_owned(),
            wire_mesh_wire::value::CborValue::Text("relay:echo".to_owned()),
        )
        .expect("unique key");
    ManageCommand {
        verb: CapabilityVerb("relay:echo".to_owned()),
        params: wire_mesh_wire::management::ManageParams::Json(params),
    }
}

fn scope() -> CapabilityScope {
    CapabilityScope {
        kind: "folder".to_owned(),
        path: None,
    }
}

/// Runs `future` for at most a few seconds, so a rule that stops holding fails a test by name instead of hanging it.
async fn within<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(10), future)
        .await
        .expect("the call did not finish in time")
}

async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

fn is_ok(outcome: &ManageOutcome) -> bool {
    assert!(
        matches!(outcome, ManageOutcome::Ok(_)),
        "the outcome was {outcome:?}"
    );
    true
}

#[tokio::test]
async fn a_request_through_the_hub_is_answered_by_the_target_and_the_hub_sees_only_hellos_and_ciphertext(
) {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = node(&hub, &answered_b).await;
    let outcome = a
        .session
        .send_manage_request_via(b.id, echo(), scope(), None, Some(Duration::from_secs(5)))
        .await
        .expect("answered");
    assert!(is_ok(&outcome));
    assert_eq!(*answered_b.lock().expect("lock"), 1);
    assert_eq!(hub.connects_from(&a.id), 1);
    // Every relay-data the hub saw is a hello or sealed data, never a frame in the clear.
    for (_, frame) in hub.seen.lock().expect("lock").iter() {
        if let Frame::RelayData(data) = frame {
            assert!(matches!(
                decode_frame(&data.payload),
                Ok(Frame::SecureHello(_) | Frame::SecureData(_))
            ));
        }
    }
}

#[tokio::test]
async fn a_second_request_to_the_same_target_sends_no_second_relay_connect() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = node(&hub, &answered_b).await;
    for _ in 0..2 {
        let outcome = a
            .session
            .send_manage_request_via(b.id, echo(), scope(), None, Some(Duration::from_secs(5)))
            .await
            .expect("answered");
        assert!(is_ok(&outcome));
    }
    assert_eq!(hub.connects_from(&a.id), 1);
    assert_eq!(*answered_b.lock().expect("lock"), 2);
}

/// A device that is not a session: a relay client the test drives by hand, to send frames a session never would.
struct Raw {
    id: DeviceId,
    client: Arc<RelayClient>,
}

async fn raw(hub: &Arc<Hub>) -> Raw {
    let identity = Arc::new(NodeIdentity::generate_ed25519());
    let id = *identity.device_id();
    let (to_node, mut inbound) = mpsc::unbounded_channel();
    hub.nodes.lock().expect("lock").insert(id, to_node);
    let link: Arc<dyn HubLink> = Arc::new(ConnectionLink(Arc::new(AsyncMutex::new(Box::new(
        HubConnection {
            from: id,
            hub: Arc::clone(hub),
            inbound: None,
        },
    )))));
    let channels = Arc::new(RelayChannels::new(
        identity,
        RelayClient::hello_sender(Arc::clone(&link)),
        Arc::new(Zero),
        RelayOptions::default(),
    ));
    let client = Arc::new(RelayClient::new(link, channels));
    let pump = Arc::clone(&client);
    tokio::spawn(async move {
        while let Some(frame) = inbound.recv().await {
            pump.on_frame(&frame).await;
        }
    });
    Raw { id, client }
}

fn response(request_id: u64) -> Frame {
    Frame::ManageResponse(ManageResponseFrame {
        request_id,
        outcome: ManageOutcome::Ok(ManageOk {
            extra: CanonicalMap::new(),
        }),
    })
}

#[tokio::test]
async fn a_response_from_a_device_the_request_did_not_go_to_leaves_it_waiting() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = raw(&hub).await;
    let c = raw(&hub).await;
    // The request goes to b, who stays silent. c, who holds a channel with a of its own, answers request-id 0 on it.
    let asking = a.session.send_manage_request_via(
        b.id,
        echo(),
        scope(),
        None,
        Some(Duration::from_millis(1500)),
    );
    let forging = async {
        settle().await;
        within(c.client.send_to(a.id, &response(0), SealPurpose::Request))
            .await
            .expect("sent");
    };
    let (outcome, ()) = tokio::join!(asking, forging);
    match outcome.expect("an outcome") {
        ManageOutcome::Error(error) => assert_eq!(error.code, "timeout"),
        ManageOutcome::Ok(_) => panic!("a response from another device resolved the request"),
    }
    let _ = answered_b;
}

#[tokio::test]
async fn a_response_from_the_device_the_request_went_to_resolves_it() {
    let hub = Hub::new();
    let answered_a = Arc::default();
    let a = node(&hub, &answered_a).await;
    let b = raw(&hub).await;
    let asking = a.session.send_manage_request_via(
        b.id,
        echo(),
        scope(),
        None,
        Some(Duration::from_secs(5)),
    );
    let answering = async {
        settle().await;
        within(b.client.send_to(a.id, &response(0), SealPurpose::Reply))
            .await
            .expect("sent");
    };
    let (outcome, ()) = tokio::join!(asking, answering);
    assert!(is_ok(&outcome.expect("an outcome")));
}

#[tokio::test]
async fn a_timeout_forgets_the_pairing_so_the_next_request_pairs_afresh() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = node(&hub, &answered_b).await;
    // b is unreachable: its hub channel is gone, so a's request times out.
    let held = hub.nodes.lock().expect("lock").remove(&b.id);
    let outcome = a
        .session
        .send_manage_request_via(
            b.id,
            echo(),
            scope(),
            None,
            Some(Duration::from_millis(300)),
        )
        .await
        .expect("an outcome");
    assert!(matches!(outcome, ManageOutcome::Error(ref e) if e.code == "timeout"));
    assert_eq!(hub.connects_from(&a.id), 1);
    if let Some(held) = held {
        hub.nodes.lock().expect("lock").insert(b.id, held);
    }
    let outcome = a
        .session
        .send_manage_request_via(b.id, echo(), scope(), None, Some(Duration::from_secs(5)))
        .await
        .expect("answered");
    assert!(is_ok(&outcome));
    assert_eq!(hub.connects_from(&a.id), 2);
}

#[tokio::test]
async fn a_hub_that_stamps_another_device_makes_every_frame_open_under_nothing() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = node(&hub, &answered_b).await;
    *hub.stamp_as.lock().expect("lock") = Some(DeviceId([9; 32]));
    let outcome = a
        .session
        .send_manage_request_via(
            b.id,
            echo(),
            scope(),
            None,
            Some(Duration::from_millis(400)),
        )
        .await
        .expect("an outcome");
    assert!(matches!(outcome, ManageOutcome::Error(ref e) if e.code == "timeout"));
    assert_eq!(*answered_b.lock().expect("lock"), 0);
}

#[tokio::test]
async fn a_plaintext_manage_request_in_relay_data_is_never_answered() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = node(&hub, &answered_b).await;
    // a pairs with b so the hub would forward, then sends a manage-request in the clear inside relay-data.
    within(a.session.send_data_frame_via(
        b.id,
        DataFrame::Have(wire_mesh_wire::data::DataHaveFrame {
            peer: DeviceId([7; 32]),
            head_seq: 1,
        }),
    ))
    .await
    .expect("sent");
    settle().await;
    let plain = Frame::ManageRequest(Box::new(ManageRequestFrame {
        request_id: 77,
        command: echo(),
        scope: scope(),
        token: None,
    }));
    let connection = HubConnection {
        from: a.id,
        hub: Arc::clone(&hub),
        inbound: None,
    };
    connection
        .send(Frame::RelayData(RelayDataFrame {
            payload: encode_frame(&plain),
            to_device: Some(b.id),
            from_device: None,
        }))
        .await
        .expect("sent");
    settle().await;
    assert_eq!(*answered_b.lock().expect("lock"), 0);
}

#[tokio::test]
async fn a_core_data_frame_through_the_hub_arrives_as_the_device_its_channel_authenticated() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let mut b = node(&hub, &answered_b).await;
    let have = wire_mesh_wire::data::DataHaveFrame {
        peer: DeviceId([7; 32]),
        head_seq: 4,
    };
    within(
        a.session
            .send_data_frame_via(b.id, DataFrame::Have(have.clone())),
    )
    .await
    .expect("sent");
    let event = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(SessionEvent::RelayedData { from, frame, .. }) = b.events.recv().await {
                return (from, frame);
            }
        }
    })
    .await
    .expect("an event");
    assert_eq!(event, (a.id, DataFrame::Have(have)));
}

#[tokio::test]
async fn closing_the_session_ends_a_relayed_request_that_is_waiting_for_its_answer() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = Arc::new(node(&hub, &answered_a).await);
    let b = node(&hub, &answered_b).await;
    let mut command = echo();
    command.verb = CapabilityVerb("relay:hang".to_owned());
    let asking = {
        let a = Arc::clone(&a);
        let target = b.id;
        tokio::spawn(async move {
            a.session
                .send_manage_request_via(target, command, scope(), None, None)
                .await
        })
    };
    settle().await;
    settle().await;
    a.session.close().await.expect("closed");
    let outcome = tokio::time::timeout(Duration::from_secs(5), asking)
        .await
        .expect("the request ended")
        .expect("task");
    assert!(outcome.is_err());
}

#[tokio::test]
async fn no_request_id_above_the_exact_integers_is_minted() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = node(&hub, &answered_b).await;
    a.session
        .next_request_id
        .store(MAX_EXACT_INTEGER, Ordering::SeqCst);
    let last = a
        .session
        .send_manage_request_via(b.id, echo(), scope(), None, Some(Duration::from_secs(5)))
        .await
        .expect("the largest exact id is minted");
    assert!(is_ok(&last));
    let beyond = a
        .session
        .send_manage_request_via(
            b.id,
            echo(),
            scope(),
            None,
            Some(Duration::from_millis(200)),
        )
        .await;
    assert!(beyond.is_err());
}

#[tokio::test]
async fn a_direct_response_carrying_the_id_of_a_relayed_request_leaves_it_waiting() {
    let hub = Hub::new();
    let answered_a = Arc::default();
    let a = node(&hub, &answered_a).await;
    let silent = raw(&hub).await;
    let asking = a.session.send_manage_request_via(
        silent.id,
        echo(),
        scope(),
        None,
        Some(Duration::from_millis(1500)),
    );
    let forging = async {
        settle().await;
        // The hub itself, or anything on the connection, sends a manage-response directly with the id the relayed request holds.
        hub.deliver(a.id, response(0));
    };
    let (outcome, ()) = tokio::join!(asking, forging);
    match within(async { outcome }).await.expect("an outcome") {
        ManageOutcome::Error(error) => assert_eq!(error.code, "timeout"),
        ManageOutcome::Ok(_) => panic!("a direct response resolved a relayed request"),
    }
}

#[tokio::test]
async fn a_direct_response_resolves_a_direct_request_and_a_relayed_one_does_not() {
    let hub = Hub::new();
    let answered_a = Arc::default();
    let a = node(&hub, &answered_a).await;
    let asking = a
        .session
        .send_manage_request(echo(), scope(), None, Some(Duration::from_secs(5)));
    let answering = async {
        settle().await;
        hub.deliver(a.id, response(0));
    };
    let (outcome, ()) = tokio::join!(asking, answering);
    assert!(is_ok(&within(async { outcome }).await.expect("an outcome")));
}

#[tokio::test]
async fn relay_frames_reach_the_relay_client_so_a_relayed_request_is_answered() {
    let hub = Hub::new();
    let (answered_a, answered_b) = (Arc::default(), Arc::new(Mutex::new(0)));
    let a = node(&hub, &answered_a).await;
    let b = node(&hub, &answered_b).await;
    let outcome = within(a.session.send_manage_request_via(
        b.id,
        echo(),
        scope(),
        None,
        Some(Duration::from_secs(5)),
    ))
    .await
    .expect("an outcome");
    assert!(is_ok(&outcome), "relay frames were not handled");
}

#[tokio::test]
async fn a_cancelled_relayed_request_leaves_no_entry_behind() {
    let hub = Hub::new();
    let answered_a = Arc::default();
    let a = Arc::new(node(&hub, &answered_a).await);
    let silent = raw(&hub).await;
    let asking = {
        let a = Arc::clone(&a);
        let target = silent.id;
        tokio::spawn(async move {
            a.session
                .send_manage_request_via(target, echo(), scope(), None, None)
                .await
        })
    };
    settle().await;
    assert_eq!(a.session.pending.lock().expect("lock").len(), 1);
    asking.abort();
    let _ = asking.await;
    assert!(a.session.pending.lock().expect("lock").is_empty());
}
