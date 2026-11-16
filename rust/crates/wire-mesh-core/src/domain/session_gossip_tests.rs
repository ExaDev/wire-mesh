//! Sessions that gossip, over a real TCP loopback pair: the self-advert on connect, the directory built from verified adverts, a gossip update with extensions, the unanswered handshake and the version answer. One test per rule the TypeScript session applies.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc as tokio_mpsc;
use wire_mesh_wire::management::{ManageCommand, ManageOutcome, ManageParams};
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb};
use wire_mesh_wire::transport::GossipFrame;
use wire_mesh_wire::value::{CanonicalMap, CborValue};
use wire_mesh_wire::Frame;

use super::*;
use crate::adapters::{NodeIdentity, TcpTransport};
use crate::domain::self_advert::{build_self_advert, compute_topology_peers, TopologyInputs};
use crate::ports::{OnConnection, Transport};

struct Fixed(AtomicU64);

impl Clock for Fixed {
    fn now_unix_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

async fn tcp_pair() -> (Box<dyn Connection>, Box<dyn Connection>) {
    let transport = TcpTransport::new();
    let (accepted_tx, mut accepted_rx) = tokio_mpsc::unbounded_channel::<Box<dyn Connection>>();
    let on_connection: OnConnection = Arc::new(move |connection| {
        let _ = accepted_tx.send(connection);
    });
    let guard = transport
        .listen("127.0.0.1:0", on_connection)
        .await
        .expect("listen");
    let bound = guard.address().parse::<SocketAddr>().expect("address");
    let dialled = transport
        .connect(&format!("127.0.0.1:{}", bound.port()))
        .await
        .expect("connect");
    let accepted = accepted_rx.recv().await.expect("accepted");
    // The listener must outlive the connection it handed out.
    std::mem::forget(guard);
    (dialled, accepted)
}

fn config(identity: &Arc<NodeIdentity>, seconds: u64, accepted: bool) -> GossipConfig {
    GossipConfig {
        identity: identity.clone(),
        clock: Arc::new(Fixed(AtomicU64::new(seconds * 1_000))),
        addresses: Vec::new(),
        accepted,
        handshake_timeout: Duration::from_millis(300),
    }
}

async fn gossiping(
    connection: Box<dyn Connection>,
    identity: &Arc<NodeIdentity>,
    seconds: u64,
    accepted: bool,
) -> (Session, mpsc::UnboundedReceiver<SessionEvent>) {
    Session::accept_with(
        connection,
        ["core/management".to_owned()],
        HandlerRegistry::new(),
        SessionOptions::new().gossiping(config(identity, seconds, accepted)),
    )
    .await
    .expect("accept")
}

async fn next_matching<T>(
    events: &mut mpsc::UnboundedReceiver<SessionEvent>,
    mut pick: impl FnMut(SessionEvent) -> Option<T>,
) -> T {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.expect("the session ended");
            if let Some(found) = pick(event) {
                return found;
            }
        }
    })
    .await
    .expect("the event did not arrive in time")
}

fn scope() -> CapabilityScope {
    CapabilityScope {
        kind: "folder".to_owned(),
        path: None,
    }
}

#[tokio::test]
async fn each_side_sends_its_own_advert_on_connect_and_learns_the_others() {
    let (a_conn, b_conn) = tcp_pair().await;
    let (a_id, b_id) = (
        Arc::new(NodeIdentity::generate_ed25519()),
        Arc::new(NodeIdentity::generate_ed25519()),
    );
    let (a, mut a_events) = gossiping(a_conn, &a_id, 100, false).await;
    let (b, mut b_events) = gossiping(b_conn, &b_id, 100, true).await;
    let seen_by_a = next_matching(&mut a_events, |event| match event {
        SessionEvent::DirectoryChanged { device } => Some(device),
        _ => None,
    })
    .await;
    let seen_by_b = next_matching(&mut b_events, |event| match event {
        SessionEvent::DirectoryChanged { device } => Some(device),
        _ => None,
    })
    .await;
    assert_eq!(seen_by_a, *b_id.device_id());
    assert_eq!(seen_by_b, *a_id.device_id());
    let directory = a.directory().await;
    assert_eq!(directory.len(), 1);
    assert_eq!(directory[0].device, *b_id.device_id());
    // The advert carries this crate's version and a topology.
    assert_eq!(
        directory[0]
            .advert
            .extra
            .get(&"wire-mesh/version".to_owned()),
        Some(&CborValue::Text(OWN_VERSION.to_owned()))
    );
    assert_eq!(b.directory().await[0].device, *a_id.device_id());
}

#[tokio::test]
async fn a_gossip_update_carries_its_extensions_and_a_refused_key_is_an_error_and_sends_nothing() {
    let (a_conn, b_conn) = tcp_pair().await;
    let (a_id, b_id) = (
        Arc::new(NodeIdentity::generate_ed25519()),
        Arc::new(NodeIdentity::generate_ed25519()),
    );
    let (a, _a_events) = gossiping(a_conn, &a_id, 100, false).await;
    let (b, mut b_events) = gossiping(b_conn, &b_id, 100, true).await;
    next_matching(&mut b_events, |event| match event {
        SessionEvent::DirectoryChanged { .. } => Some(()),
        _ => None,
    })
    .await;
    // Not domain-qualified: refused, and nothing is sent.
    assert!(a
        .send_gossip_update(vec![(
            "status".to_owned(),
            CborValue::Text("busy".to_owned())
        )])
        .await
        .is_err());
    assert!(a
        .send_gossip_update(vec![("topology/peers".to_owned(), CborValue::Null)])
        .await
        .is_err());
    // A later snapshot time and an extension: the directory entry is replaced in place.
    a.send_gossip_update(vec![(
        "presence/status".to_owned(),
        CborValue::Text("busy".to_owned()),
    )])
    .await
    .expect("sent");
    let advert = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let entry = b.directory().await.into_iter().next();
            if let Some(entry) = entry {
                if entry
                    .advert
                    .extra
                    .get(&"presence/status".to_owned())
                    .is_some()
                {
                    return entry.advert;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the update arrived");
    assert_eq!(
        advert.extra.get(&"presence/status".to_owned()),
        Some(&CborValue::Text("busy".to_owned()))
    );
}

#[tokio::test]
async fn an_advert_that_does_not_verify_is_refused_and_the_rest_of_its_frame_is_admitted() {
    let (a_conn, raw) = tcp_pair().await;
    let a_id = Arc::new(NodeIdentity::generate_ed25519());
    let (a, mut a_events) = gossiping(a_conn, &a_id, 100, false).await;
    let (good_id, bad_id) = (
        NodeIdentity::generate_ed25519(),
        NodeIdentity::generate_ed25519(),
    );
    let topology = compute_topology_peers(&TopologyInputs::default());
    let good = build_self_advert(&good_id, &[], 50, &[], &topology)
        .await
        .expect("advert");
    let mut bad = build_self_advert(&bad_id, &[], 50, &[], &topology)
        .await
        .expect("advert");
    bad.signature[0] ^= 0xff;
    raw.send(Frame::Gossip(GossipFrame {
        peers: vec![bad.clone(), good.clone()],
    }))
    .await
    .expect("sent");
    let refused = next_matching(&mut a_events, |event| match event {
        SessionEvent::AdvertRefused { device, reason } => Some((device, reason)),
        _ => None,
    })
    .await;
    assert_eq!(refused, (*bad_id.device_id(), "bad_signature"));
    let admitted = next_matching(&mut a_events, |event| match event {
        SessionEvent::DirectoryChanged { device } => Some(device),
        _ => None,
    })
    .await;
    assert_eq!(admitted, *good_id.device_id());
    let directory = a.directory().await;
    assert_eq!(directory.len(), 1);
    assert_eq!(directory[0].device, *good_id.device_id());
}

#[tokio::test]
async fn a_peer_that_never_sends_a_handshake_is_reported_once_and_the_session_carries_on() {
    let (a_conn, _silent) = tcp_pair().await;
    let a_id = Arc::new(NodeIdentity::generate_ed25519());
    let (a, mut a_events) = gossiping(a_conn, &a_id, 100, false).await;
    next_matching(&mut a_events, |event| match event {
        SessionEvent::HandshakeUnanswered => Some(()),
        _ => None,
    })
    .await;
    assert!(a.directory().await.is_empty());
}

#[tokio::test]
async fn a_peer_that_answers_its_handshake_is_not_reported_unanswered() {
    let (a_conn, b_conn) = tcp_pair().await;
    let (a_id, b_id) = (
        Arc::new(NodeIdentity::generate_ed25519()),
        Arc::new(NodeIdentity::generate_ed25519()),
    );
    let (_a, mut a_events) = gossiping(a_conn, &a_id, 100, false).await;
    let (_b, _b_events) = gossiping(b_conn, &b_id, 100, true).await;
    // Past the handshake timeout, no unanswered event has arrived among the ones that did.
    tokio::time::sleep(Duration::from_millis(600)).await;
    let mut kinds = Vec::new();
    while let Ok(event) = a_events.try_recv() {
        kinds.push(event);
    }
    assert!(kinds
        .iter()
        .any(|event| matches!(event, SessionEvent::HandshakeNegotiated { .. })));
    assert!(!kinds
        .iter()
        .any(|event| matches!(event, SessionEvent::HandshakeUnanswered)));
}

#[tokio::test]
async fn version_get_is_answered_by_every_session_with_this_crates_version() {
    let (a_conn, b_conn) = tcp_pair().await;
    // Neither side registers anything: the version is answered without a handler.
    let (a, _a_events) = Session::accept(
        a_conn,
        ["core/management".to_owned()],
        HandlerRegistry::new(),
    )
    .await
    .expect("accept");
    let (_b, _b_events) = Session::accept(
        b_conn,
        ["core/management".to_owned()],
        HandlerRegistry::new(),
    )
    .await
    .expect("accept");
    let mut params = CanonicalMap::new();
    params
        .insert("verb".to_owned(), CborValue::Text("version.get".to_owned()))
        .expect("unique");
    let outcome = a
        .send_manage_request(
            ManageCommand {
                verb: CapabilityVerb("core:version".to_owned()),
                params: ManageParams::Json(params),
            },
            scope(),
            None,
            Some(Duration::from_secs(5)),
        )
        .await
        .expect("an outcome");
    let ManageOutcome::Ok(ok) = outcome else {
        panic!("not answered: {outcome:?}");
    };
    assert_eq!(
        ok.extra.get(&"version".to_owned()),
        Some(&CborValue::Text(OWN_VERSION.to_owned()))
    );
}

#[tokio::test]
async fn a_session_that_does_not_gossip_ignores_gossip_and_cannot_send_it() {
    let (a_conn, raw) = tcp_pair().await;
    let (a, mut a_events) = Session::accept(
        a_conn,
        ["core/management".to_owned()],
        HandlerRegistry::new(),
    )
    .await
    .expect("accept");
    let identity = NodeIdentity::generate_ed25519();
    let advert = build_self_advert(
        &identity,
        &[],
        50,
        &[],
        &compute_topology_peers(&TopologyInputs::default()),
    )
    .await
    .expect("advert");
    raw.send(Frame::Gossip(GossipFrame {
        peers: vec![advert],
    }))
    .await
    .expect("sent");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(a.directory().await.is_empty());
    while let Ok(event) = a_events.try_recv() {
        assert!(!matches!(event, SessionEvent::DirectoryChanged { .. }));
    }
    assert!(a.send_gossip_update(Vec::new()).await.is_err());
}
