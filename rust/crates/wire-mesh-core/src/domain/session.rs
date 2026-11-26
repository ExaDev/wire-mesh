//! The Rust node/session runtime (wire-mesh#173): the concurrent
//! counterpart to the TypeScript core's `mesh-session.ts`, built on
//! Rust's own idiom for a stateful, event-driven dispatch loop -- tasks
//! and channels -- rather than a port of `mesh-session.ts`'s
//! async-iterable shape. See wire-mesh#173's own issue body for the
//! design decision and why the two sides deliberately diverge in API
//! shape while matching protocol behaviour: same frames sent and
//! received, same state machine.
//!
//! Scope, matching the issue: wrap an already-established [`Connection`]
//! (dialled or accepted -- the post-connect protocol handshake is
//! symmetric either way, so this has no dial/reconnect logic of its own),
//! perform the handshake exchange, dispatch incoming manage-requests to
//! handlers registered per capability verb, emit connection lifecycle
//! events, and support sending a manage-request (awaiting its correlated
//! response, with an optional timeout) and sending a data frame. A
//! session over a connection to a relay hub also reaches devices through
//! relay pairings (`Session::accept_relayed`). Gossip directory and
//! revocation-announcement handling are deliberately out of scope -- #171's threshold coordinator/participant
//! handlers, this issue's own stated consumer, need none of them.

use core::future::poll_fn;
use core::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use core::time::Duration;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};

use futures_core::Stream;
use tokio::sync::{mpsc, oneshot, Mutex as AsyncMutex};
use tokio::task::AbortHandle;
use wire_mesh_wire::handshake::{DomainId, HandshakeFrame, ProtocolVersion};
use wire_mesh_wire::management::{
    ManageCommand, ManageError, ManageOk, ManageOutcome, ManageParams, ManageRequestFrame,
    ManageResponseFrame,
};
use wire_mesh_wire::tokens::{CapabilityScope, CoseSign1};
use wire_mesh_wire::value::{CanonicalMap, CborValue};
use wire_mesh_wire::Frame;

use wire_mesh_wire::identity::DeviceId;

use crate::domain::gossip_directory::{AdvertOutcome, GossipDirectory};
use crate::domain::handshake::{negotiate, SUPPORTED_PROTOCOL_VERSION};
use crate::domain::mint::MAX_EXACT_INTEGER;
use crate::domain::relay_channels::SealPurpose;
use crate::domain::relay_client::{HubLink, RelayClient, RelayEvent};
use crate::domain::self_advert::{
    build_self_advert, compute_topology_peers, SelfAdvertError, TopologyInputs, OWN_VERSION,
};
use crate::domain::topology::DirectoryEntry;
use crate::ports::{Clock, Connection, CoreError, Identity};

/// A connection shared between the dispatch loop (which reads frames)
/// and every caller of `send_manage_request`/`send_data_frame` (which
/// write them) -- `send`/`close` only need shared, not exclusive, logical
/// ownership of the connection's *lifetime*, but `Connection::close` is
/// `&mut self`, so a lock is the simplest correct way to share one
/// `Box<dyn Connection>` across tasks without unsafe aliasing.
type SharedConnection = Arc<AsyncMutex<Box<dyn Connection>>>;

/// A caller awaiting one `send_manage_request`'s correlated response, or
/// being told the connection ended (or was closed locally) before one
/// arrived -- see `send_manage_request`'s own doc comment for why this is
/// `Result` rather than always resolving an outcome: a disconnect is a
/// transport-level failure (surfaced as `Err`), while a timeout is a
/// protocol-level, expected outcome (surfaced as
/// `Ok(ManageOutcome::Error { code: "timeout", .. })`), mirroring
/// `mesh-session.ts`'s own reject-on-disconnect/resolve-on-timeout split.
type PendingReply = Result<ManageOutcome, String>;
/// A request waiting for its answer, with the device the answer must come from: `None` for a request sent directly over the connection, and the target for one sent through a relay pairing, so a peer cannot answer a request meant for another (as the TypeScript `applyManageResponse` checks).
struct PendingEntry {
    reply: oneshot::Sender<PendingReply>,
    via: Option<DeviceId>,
}

type PendingMap = Arc<StdMutex<HashMap<u64, PendingEntry>>>;

/// One manage-request this session received from its peer, handed to
/// whichever [`ManageRequestHandler`] is registered for its command's
/// verb.
#[derive(Debug)]
pub struct IncomingManageRequest {
    pub request_id: u64,
    pub command: ManageCommand,
    pub scope: CapabilityScope,
    pub token: Option<CoseSign1>,
}

/// A handler for every manage-request whose command carries one specific
/// capability verb, registered against a [`HandlerRegistry`]. Returning
/// an outcome directly (rather than TS's callback-style `respond()`) is
/// possible because Rust handlers are registered up front rather than
/// pulled one at a time off an iterator -- the real registration
/// mechanism `mesh-session.ts` itself never had, and the gap wire-mesh#173
/// exists to close.
#[async_trait::async_trait]
pub trait ManageRequestHandler: Send + Sync {
    async fn handle(&self, request: IncomingManageRequest) -> ManageOutcome;
}

/// Maps a capability verb (`ManageCommand.verb`, e.g.
/// `"exadev.io/threshold:sign"`) to the handler that owns every command
/// shape carried under it. A manage-request whose verb has no registered
/// handler gets an explicit `manage-error { code: "unknown-verb" }`
/// response -- loud and immediate, never a silently-dropped frame the
/// sender is left waiting forever for.
#[derive(Default)]
pub struct HandlerRegistry {
    handlers: HashMap<String, Arc<dyn ManageRequestHandler>>,
}

impl HandlerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `handler` for `verb`, replacing whatever was previously
    /// registered for that same verb. Consuming/returning `Self` gives a
    /// builder-style call chain (`HandlerRegistry::new().register(...).register(...)`).
    #[must_use]
    pub fn register(
        mut self,
        verb: impl Into<String>,
        handler: Arc<dyn ManageRequestHandler>,
    ) -> Self {
        self.handlers.insert(verb.into(), handler);
        self
    }

    fn get(&self, verb: &str) -> Option<Arc<dyn ManageRequestHandler>> {
        self.handlers.get(verb).cloned()
    }
}

/// The core/version domain's version-get verb (issue #179), answered with this crate's actual, currently-compiled version: `CARGO_PKG_VERSION` is resolved from `Cargo.toml`'s own `version.workspace = true` at compile time, so there is no build-versus-publish staleness risk, unlike the TypeScript core, which has to read its `package.json` at run time.
///
/// Every session answers a manage-request whose params carry the verb `version.get` itself, bypassing the registry, as the TypeScript `applyManageRequest` does. This handler is for a consumer that registers the version under a capability verb of its own (`HandlerRegistry::new().register("core:version", Arc::new(VersionHandler))`); it answers every request it is given with the same version.
pub struct VersionHandler;

#[async_trait::async_trait]
impl ManageRequestHandler for VersionHandler {
    async fn handle(&self, _request: IncomingManageRequest) -> ManageOutcome {
        let mut extra = CanonicalMap::new();
        // A single insert into a map that was just created empty can never hit CanonicalMap::insert's own only failure case (a duplicate key), so there is nothing for this to meaningfully handle -- discarded rather than unwrapped/expected, since this crate denies both outside tests.
        let _ = extra.insert(
            "version".to_owned(),
            CborValue::Text(env!("CARGO_PKG_VERSION").to_owned()),
        );
        ManageOutcome::Ok(ManageOk { extra })
    }
}

/// A `core/data` frame `send_data_frame` can send directly over a
/// session's own connection -- the transport half of an application's
/// own noticeboard replication policy, mirroring
/// `mesh-session.ts`'s own `sendDataFrame` union parameter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DataFrame {
    Have(wire_mesh_wire::data::DataHaveFrame),
    Request(wire_mesh_wire::data::DataRequestFrame),
    Entries(wire_mesh_wire::data::DataEntriesFrame),
}

impl DataFrame {
    fn into_frame(self) -> Frame {
        match self {
            DataFrame::Have(f) => Frame::DataHave(f),
            DataFrame::Request(f) => Frame::DataRequest(f),
            DataFrame::Entries(f) => Frame::DataEntries(f),
        }
    }
}

/// A connection/session lifecycle event, delivered on the receiver
/// `Session::accept` hands back alongside the `Session` itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    /// The peer's handshake negotiated successfully.
    HandshakeNegotiated {
        version: u64,
        shared_domains: Vec<String>,
    },
    /// The peer's handshake was received but negotiation failed (version
    /// this implementation cannot support, or an invalid domain on
    /// either side).
    HandshakeRejected { reason: String },
    /// A `core/data` frame that arrived through a relay pairing and opened under the secure channel of `from`, the device that channel authenticated. `to_device` is the device the `relay-data` was explicitly addressed to, for a caller fronting several local devices behind one hub connection. A data frame that arrives directly over the connection is not delivered here.
    RelayedData {
        from: DeviceId,
        to_device: Option<DeviceId>,
        frame: DataFrame,
    },
    /// A gossiped advert entered the peer directory (as a new device, or in place of an older advert).
    DirectoryChanged { device: DeviceId },
    /// Adverts of one gossip frame were refused: one did not verify, its time or size is out of range, or the directory is full. One refused advert says nothing about the others of its frame, which are applied. A frame produces one event whatever its number of refusals (a hub can put thousands of forged adverts in a frame at no cost to itself, and an event per advert would grow this session's unbounded queue with them): `first` and `reason` are those of the first refusal and `count` is how many the frame had.
    AdvertsRefused {
        first: DeviceId,
        reason: &'static str,
        count: usize,
    },
    /// The peer sent no handshake within the handshake timeout. A relay-only hub never sends one, which is a state to report and not an error: the session carries on.
    HandshakeUnanswered,
    /// The connection ended, whether the peer closed it, the underlying
    /// transport failed, or `Session::close` was called locally.
    Disconnected { reason: String },
}

/// How long a session waits for the peer's handshake before it reports [`SessionEvent::HandshakeUnanswered`]: the same 3 s the TypeScript session waits.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

/// What a session needs to take part in gossip: to sign its own advert, read the time, say where it can be reached and whether the connection was accepted. Without it a session ignores gossip frames, as the runtime did before.
pub struct GossipConfig {
    /// Signs this node's own advert and verifies the adverts it receives.
    pub identity: Arc<dyn Identity>,
    /// The time the advert's `snapshot-seconds` is read from: a wall clock (Unix milliseconds). A clock that reads before 2001, such as a monotonic one, fails the session's first advert with an error instead of producing adverts every hub ignores.
    pub clock: Arc<dyn Clock>,
    /// The `host:port` addresses this node can be reached on directly; none for a node that cannot accept connections.
    pub addresses: Vec<String>,
    /// Whether this connection was accepted and not dialled, which decides whether the first advertised peer may be taken as the direct peer.
    pub accepted: bool,
    /// How long to wait for the peer's handshake. [`HANDSHAKE_TIMEOUT`] unless a test needs another.
    pub handshake_timeout: Duration,
}

/// Builds the relay client of a session from the link the session sends through.
type RelayBuilder = Box<dyn FnOnce(Arc<dyn HubLink>) -> Arc<RelayClient> + Send>;

/// What a session is built from besides its connection, domains and handlers.
#[derive(Default)]
pub struct SessionOptions {
    relay: Option<RelayBuilder>,
    gossip: Option<GossipConfig>,
}

impl SessionOptions {
    /// Options for a plain session.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A session over a connection to a relay hub: `relay` is given the link the session sends through and returns the relay client the session then drives.
    #[must_use]
    pub fn relayed(
        mut self,
        relay: impl FnOnce(Arc<dyn HubLink>) -> Arc<RelayClient> + Send + 'static,
    ) -> Self {
        self.relay = Some(Box::new(relay));
        self
    }

    /// A session that takes part in gossip.
    #[must_use]
    pub fn gossiping(mut self, gossip: GossipConfig) -> Self {
        self.gossip = Some(gossip);
        self
    }
}

/// The gossip state of a session: its configuration, the directory it builds, and the first peer an advert named.
struct GossipState {
    config: GossipConfig,
    directory: AsyncMutex<GossipDirectory>,
    first_advertised: StdMutex<Option<DeviceId>>,
}

impl GossipState {
    async fn self_advert(
        &self,
        relay: Option<&Arc<RelayClient>>,
        extensions: &[(String, CborValue)],
    ) -> Result<wire_mesh_wire::transport::PeerAdvert, SelfAdvertError> {
        let first = *self
            .first_advertised
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let topology = compute_topology_peers(&TopologyInputs {
            // The connection port names no authenticated peer (the only adapter, plain TCP, authenticates nobody), so the first-heard rule in `TopologyInputs` applies.
            authenticated_peer: None,
            first_advertised_peer: first,
            accepted: self.config.accepted,
            relayed: relay.map(|relay| relay.paired()).unwrap_or_default(),
        });
        let seconds = self.config.clock.now_unix_ms() / 1_000;
        build_self_advert(
            &*self.config.identity,
            &self.config.addresses,
            seconds,
            extensions,
            &topology,
        )
        .await
    }
}

async fn next_frame(stream: &mut Pin<Box<dyn Stream<Item = Frame> + Send>>) -> Option<Frame> {
    poll_fn(|cx| stream.as_mut().poll_next(cx)).await
}

async fn send_frame(connection: &SharedConnection, frame: Frame) -> Result<(), CoreError> {
    connection.lock().await.send(frame).await
}

fn reject_all_pending(pending: &PendingMap, reason: &str) {
    let mut entries: Vec<PendingEntry> = {
        let mut map = pending.lock().unwrap_or_else(|e| e.into_inner());
        map.drain().map(|(_, entry)| entry).collect()
    };
    for entry in entries.drain(..) {
        let _ = entry.reply.send(Err(reason.to_owned()));
    }
}

/// Resolves the request `request_id` with `outcome`, if it is waiting for an answer from where this one came: `from` is `None` for a response that arrived directly and the device the secure channel authenticated for one that arrived through a relay pairing. A response from anywhere else leaves the request waiting.
fn resolve_pending(
    pending: &PendingMap,
    request_id: u64,
    from: Option<DeviceId>,
    outcome: ManageOutcome,
) {
    let entry = {
        let mut map = pending.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&request_id) {
            Some(held) if held.via == from => map.remove(&request_id),
            _ => None,
        }
    };
    if let Some(entry) = entry {
        let _ = entry.reply.send(Ok(outcome));
    }
}

/// Removes a request's entry from the pending map when the call that made it ends, however it ends: an answer, a timeout, an error, or the caller dropping the future. Without it a cancelled call leaves its entry behind for the life of the session.
struct PendingGuard {
    pending: PendingMap,
    request_id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        map.remove(&self.request_id);
    }
}

/// The connection of a session as the relay's link to the hub.
struct ConnectionLink(SharedConnection);

#[async_trait::async_trait]
impl HubLink for ConnectionLink {
    async fn send(&self, frame: Frame) -> Result<(), CoreError> {
        send_frame(&self.0, frame).await
    }
}

/// The params verb of the core/version domain's version-get command.
const VERSION_GET_VERB: &str = "version.get";

/// Answers one incoming manage-request with the handler registered for its verb, or `unknown-verb`.
async fn answer(
    registry: &HandlerRegistry,
    request_id: u64,
    command: ManageCommand,
    scope: CapabilityScope,
    token: Option<CoseSign1>,
) -> ManageOutcome {
    // The core/version domain's version-get is answered by every session and bypasses the registry, as in the TypeScript: it is deliberately unauthenticated and carries nothing but this crate's own version.
    if let ManageParams::Json(params) = &command.params {
        if params.get(&"verb".to_owned()) == Some(&CborValue::Text(VERSION_GET_VERB.to_owned())) {
            let mut extra = CanonicalMap::new();
            let _ = extra.insert(
                "version".to_owned(),
                CborValue::Text(OWN_VERSION.to_owned()),
            );
            return ManageOutcome::Ok(ManageOk { extra });
        }
    }
    let verb = command.verb.0.clone();
    match registry.get(&verb) {
        Some(handler) => {
            handler
                .handle(IncomingManageRequest {
                    request_id,
                    command,
                    scope,
                    token,
                })
                .await
        }
        None => ManageOutcome::Error(ManageError {
            code: "unknown-verb".to_owned(),
            message: Some(verb),
        }),
    }
}

/// Drives the dispatch loop for as long as the connection's inbound
/// stream yields frames: negotiates the handshake (once -- a second
/// handshake frame is ignored, mirroring `mesh-session.ts`'s own
/// `if (handshake.status !== "pending") return`), resolves pending
/// `send_manage_request` calls against a matching `manage-response`, and
/// spawns one task per incoming `manage-request` so a slow handler never
/// blocks reading further frames off the same connection. Frame kinds
/// outside this runtime's stated scope (gossip, relay, revocation,
/// ping/close) are read (so the stream keeps advancing) but otherwise
/// ignored.
#[allow(clippy::too_many_arguments)]
async fn run_dispatch_loop(
    mut inbound: Pin<Box<dyn Stream<Item = Frame> + Send>>,
    connection: SharedConnection,
    pending: PendingMap,
    registry: Arc<HandlerRegistry>,
    events_tx: mpsc::UnboundedSender<SessionEvent>,
    local_handshake: HandshakeFrame,
    closed: Arc<AtomicBool>,
    relay: Option<Arc<RelayClient>>,
    gossip: Option<Arc<GossipState>>,
    handshake_settled_flag: Arc<AtomicBool>,
) {
    let mut handshake_settled = false;
    while let Some(frame) = next_frame(&mut inbound).await {
        match frame {
            Frame::Handshake(remote) => {
                if handshake_settled {
                    continue;
                }
                handshake_settled = true;
                handshake_settled_flag.store(true, Ordering::SeqCst);
                match negotiate(&local_handshake, &remote) {
                    Ok(result) => {
                        let _ = events_tx.send(SessionEvent::HandshakeNegotiated {
                            version: result.version,
                            shared_domains: result.shared_domains,
                        });
                    }
                    Err(error) => {
                        let _ = events_tx.send(SessionEvent::HandshakeRejected {
                            reason: error.to_string(),
                        });
                    }
                }
            }
            Frame::ManageResponse(ManageResponseFrame {
                request_id,
                outcome,
            }) => resolve_pending(&pending, request_id, None, outcome),
            Frame::ManageRequest(request) => {
                let ManageRequestFrame {
                    request_id,
                    command,
                    scope,
                    token,
                } = *request;
                let registry = Arc::clone(&registry);
                let connection = Arc::clone(&connection);
                tokio::spawn(async move {
                    let outcome = answer(&registry, request_id, command, scope, token).await;
                    let response = Frame::ManageResponse(ManageResponseFrame {
                        request_id,
                        outcome,
                    });
                    let _ = send_frame(&connection, response).await;
                });
            }
            Frame::Gossip(gossiped) => {
                let Some(gossip) = gossip.as_ref() else {
                    continue;
                };
                // Verified here, never taken on the sender's word: an advert reaching this session was very often forwarded by a hub or a gateway.
                let outcomes = gossip
                    .directory
                    .lock()
                    .await
                    .apply(&*gossip.config.identity, &gossiped)
                    .await;
                // One event per distinct device changed and one for all the refusals, so a frame's size does not set the number of events.
                let mut changed: Vec<DeviceId> = Vec::new();
                let mut refused: Option<(DeviceId, &'static str, usize)> = None;
                for outcome in outcomes {
                    match outcome {
                        AdvertOutcome::Admitted(device) => {
                            gossip
                                .first_advertised
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .get_or_insert(device);
                            if !changed.contains(&device) {
                                changed.push(device);
                            }
                        }
                        AdvertOutcome::Older(_) => {}
                        AdvertOutcome::Refused(device, why) => {
                            refused = Some(match refused {
                                None => (device, why.as_str(), 1),
                                Some((first, reason, count)) => (first, reason, count + 1),
                            });
                        }
                    }
                }
                for device in changed {
                    let _ = events_tx.send(SessionEvent::DirectoryChanged { device });
                }
                if let Some((first, reason, count)) = refused {
                    let _ = events_tx.send(SessionEvent::AdvertsRefused {
                        first,
                        reason,
                        count,
                    });
                }
            }
            Frame::RelayInbound(_) | Frame::RelayData(_) => {
                let Some(relay) = relay.as_ref() else {
                    continue;
                };
                for RelayEvent::Frame {
                    from,
                    to_device,
                    frame,
                } in relay.on_frame(&frame).await
                {
                    match frame {
                        Frame::ManageResponse(ManageResponseFrame {
                            request_id,
                            outcome,
                        }) => resolve_pending(&pending, request_id, Some(from), outcome),
                        Frame::ManageRequest(request) => {
                            let ManageRequestFrame {
                                request_id,
                                command,
                                scope,
                                token,
                            } = *request;
                            let registry = Arc::clone(&registry);
                            let relay = Arc::clone(relay);
                            tokio::spawn(async move {
                                let outcome =
                                    answer(&registry, request_id, command, scope, token).await;
                                let response = Frame::ManageResponse(ManageResponseFrame {
                                    request_id,
                                    outcome,
                                });
                                // A reply answers a frame the peer sent, so it never makes the peer chosen.
                                let _ = relay.send_to(from, &response, SealPurpose::Reply).await;
                            });
                        }
                        Frame::DataHave(f) => {
                            let _ = events_tx.send(SessionEvent::RelayedData {
                                from,
                                to_device,
                                frame: DataFrame::Have(f),
                            });
                        }
                        Frame::DataRequest(f) => {
                            let _ = events_tx.send(SessionEvent::RelayedData {
                                from,
                                to_device,
                                frame: DataFrame::Request(f),
                            });
                        }
                        Frame::DataEntries(f) => {
                            let _ = events_tx.send(SessionEvent::RelayedData {
                                from,
                                to_device,
                                frame: DataFrame::Entries(f),
                            });
                        }
                        _ => {}
                    }
                }
            }
            // Out of scope for this runtime (gossip directory, revocation
            // announcements, ping/close housekeeping)
            // -- observed so the stream keeps advancing, never acted on.
            _ => {}
        }
    }
    closed.store(true, Ordering::SeqCst);
    reject_all_pending(&pending, "connection closed before a response arrived");
    if let Some(relay) = &relay {
        relay.reset("the connection ended");
    }
    let _ = events_tx.send(SessionEvent::Disconnected {
        reason: "the peer's connection ended".to_owned(),
    });
}

/// A live session over one [`Connection`]: the runtime this crate
/// otherwise lacked (wire-mesh#173). Built by [`Session::accept`], which
/// works identically whether the connection was dialled
/// (`Transport::connect`) or accepted (a `Transport::listen` callback) --
/// the post-connect protocol handshake is symmetric either way, and this
/// runtime has no dial/reconnect logic of its own to distinguish the two.
pub struct Session {
    connection: SharedConnection,
    next_request_id: AtomicU64,
    pending: PendingMap,
    dispatch_abort: AbortHandle,
    events_tx: mpsc::UnboundedSender<SessionEvent>,
    closed: Arc<AtomicBool>,
    relay: Option<Arc<RelayClient>>,
    gossip: Option<Arc<GossipState>>,
}

impl Session {
    /// Wires up an already-established connection: sends this side's own
    /// handshake, then starts the dispatch loop (spawned as a background
    /// task) that negotiates the peer's answering handshake, dispatches
    /// incoming manage-requests to `registry`, and resolves outstanding
    /// `send_manage_request` calls. Returns the session together with
    /// the receiver its lifecycle events arrive on.
    pub async fn accept(
        connection: Box<dyn Connection>,
        local_domains: impl IntoIterator<Item = String>,
        registry: HandlerRegistry,
    ) -> Result<(Session, mpsc::UnboundedReceiver<SessionEvent>), CoreError> {
        Self::accept_with(connection, local_domains, registry, SessionOptions::new()).await
    }

    /// [`Session::accept`] for a connection to a relay hub: `relay` is given the link the session sends through (build the secure channels' hello sender from it with [`RelayClient::hello_sender`]) and returns the relay client the session then drives. Frames that arrive as `relay-inbound` or `relay-data` go to it, and [`Session::send_manage_request_via`] and [`Session::send_data_frame_via`] send through it.
    ///
    /// # Errors
    ///
    /// As [`Session::accept`].
    pub async fn accept_relayed(
        connection: Box<dyn Connection>,
        local_domains: impl IntoIterator<Item = String>,
        registry: HandlerRegistry,
        relay: impl FnOnce(Arc<dyn HubLink>) -> Arc<RelayClient> + Send + 'static,
    ) -> Result<(Session, mpsc::UnboundedReceiver<SessionEvent>), CoreError> {
        Self::accept_with(
            connection,
            local_domains,
            registry,
            SessionOptions::new().relayed(relay),
        )
        .await
    }

    /// [`Session::accept`] with every option: a relay client, gossip, or both. A session that gossips sends its own signed advert right after its handshake, verifies and keeps the adverts it receives in a directory ([`Session::directory`]), and sends a fresh advert with caller extensions on [`Session::send_gossip_update`].
    ///
    /// # Errors
    ///
    /// As [`Session::accept`], and a [`CoreError::Crypto`] when the first advert could not be built or signed.
    pub async fn accept_with(
        connection: Box<dyn Connection>,
        local_domains: impl IntoIterator<Item = String>,
        registry: HandlerRegistry,
        options: SessionOptions,
    ) -> Result<(Session, mpsc::UnboundedReceiver<SessionEvent>), CoreError> {
        let SessionOptions { relay, gossip } = options;
        let mut connection = connection;
        let inbound = connection.receive()?;
        let shared: SharedConnection = Arc::new(AsyncMutex::new(connection));
        let relay = relay.map(|make| make(Arc::new(ConnectionLink(Arc::clone(&shared)))));

        let local_handshake = HandshakeFrame {
            version: ProtocolVersion(SUPPORTED_PROTOCOL_VERSION),
            domains: local_domains.into_iter().map(DomainId).collect(),
            params: None,
        };
        send_frame(&shared, Frame::Handshake(local_handshake.clone())).await?;

        let gossip = gossip.map(|config| {
            Arc::new(GossipState {
                config,
                directory: AsyncMutex::new(GossipDirectory::new()),
                first_advertised: StdMutex::new(None),
            })
        });
        if let Some(gossip) = &gossip {
            // The node's own advert follows its handshake, as in the TypeScript, so a hub can route to it.
            let advert = gossip
                .self_advert(relay.as_ref(), &[])
                .await
                .map_err(|error| CoreError::Crypto(error.to_string()))?;
            send_frame(
                &shared,
                Frame::Gossip(wire_mesh_wire::transport::GossipFrame {
                    peers: vec![advert],
                }),
            )
            .await?;
        }

        let pending: PendingMap = Arc::new(StdMutex::new(HashMap::new()));
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));
        let handshake_settled = Arc::new(AtomicBool::new(false));

        if let Some(gossip) = &gossip {
            // A relay-only hub never sends a handshake: that is a state to report, not an error.
            let waiting = Arc::clone(&handshake_settled);
            let ended = Arc::clone(&closed);
            let events = events_tx.clone();
            let timeout = gossip.config.handshake_timeout;
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                if !waiting.load(Ordering::SeqCst) && !ended.load(Ordering::SeqCst) {
                    let _ = events.send(SessionEvent::HandshakeUnanswered);
                }
            });
        }

        let task = tokio::spawn(run_dispatch_loop(
            inbound,
            Arc::clone(&shared),
            Arc::clone(&pending),
            Arc::new(registry),
            events_tx.clone(),
            local_handshake,
            Arc::clone(&closed),
            relay.clone(),
            gossip.clone(),
            handshake_settled,
        ));

        Ok((
            Session {
                connection: shared,
                next_request_id: AtomicU64::new(0),
                pending,
                dispatch_abort: task.abort_handle(),
                events_tx,
                closed,
                relay,
                gossip,
            },
            events_rx,
        ))
    }

    /// The peer directory built from the gossip received so far: the latest verified advert per device, in the order devices were first heard. Empty for a session that does not gossip.
    pub async fn directory(&self) -> Vec<DirectoryEntry> {
        match &self.gossip {
            Some(gossip) => gossip.directory.lock().await.entries().to_vec(),
            None => Vec::new(),
        }
    }

    /// Sends a fresh signed advert of this node with `extensions` merged in, the way a gossiped fact (a presence status, a policy) is kept live over a connection's lifetime. Every key is validated first ([`crate::domain::gossip_extensions`]): none may shadow a mandatory field, the topology or the version.
    ///
    /// # Errors
    ///
    /// A [`CoreError::Crypto`] naming a refused extension key or an advert that could not be built, a [`CoreError::Transport`] when the session is closed, has no gossip, or the frame could not be sent.
    pub async fn send_gossip_update(
        &self,
        extensions: Vec<(String, CborValue)>,
    ) -> Result<(), CoreError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CoreError::Transport("session is closed".to_owned()));
        }
        let gossip = self
            .gossip
            .as_ref()
            .ok_or_else(|| CoreError::Transport("this session does not gossip".to_owned()))?;
        let advert = gossip
            .self_advert(self.relay.as_ref(), &extensions)
            .await
            .map_err(|error| match error {
                SelfAdvertError::Extension(refused) => CoreError::Crypto(refused.to_string()),
                other => CoreError::Crypto(other.to_string()),
            })?;
        send_frame(
            &self.connection,
            Frame::Gossip(wire_mesh_wire::transport::GossipFrame {
                peers: vec![advert],
            }),
        )
        .await
    }

    /// Sends a manage-request and resolves with the matching
    /// manage-response's outcome, correlated by request-id. When
    /// `timeout` is given, elapsing it resolves
    /// `Ok(ManageOutcome::Error { code: "timeout", .. })` rather than
    /// waiting forever, mirroring `sendManageRequest`'s own `timeoutMs`.
    /// A connection that ends (peer disconnect, or a local
    /// [`Session::close`]) before a response arrives resolves `Err`, not
    /// an outcome -- unlike a timeout, a lost connection is not an
    /// ordinary protocol-level answer the peer chose to give.
    pub async fn send_manage_request(
        &self,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<CoseSign1>,
        timeout: Option<Duration>,
    ) -> Result<ManageOutcome, CoreError> {
        self.request(None, command, scope, token, timeout).await
    }

    /// [`Session::send_manage_request`] to `target`, a device reached through a relay pairing: the request is sealed on `target`'s secure channel and sent as `relay-data`, and only an answer that arrives through that same channel resolves it, so a peer cannot answer a request meant for another. A timeout also forgets the pairing and the channel, since the hub gives no notice when a pairing is lost and a request that timed out is the only sign this side has. Dropping the returned future cancels the request: its entry is removed, and an answer that arrives later is ignored.
    ///
    /// # Errors
    ///
    /// As [`Session::send_manage_request`], and a [`CoreError::Transport`] when the session was accepted without a relay or the request could not be sealed or sent.
    pub async fn send_manage_request_via(
        &self,
        target: DeviceId,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<CoseSign1>,
        timeout: Option<Duration>,
    ) -> Result<ManageOutcome, CoreError> {
        self.request(Some(target), command, scope, token, timeout)
            .await
    }

    async fn request(
        &self,
        target: Option<DeviceId>,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<CoseSign1>,
        timeout: Option<Duration>,
    ) -> Result<ManageOutcome, CoreError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CoreError::Transport("session is closed".to_owned()));
        }
        let relay = match target {
            Some(_) => Some(
                self.relay
                    .as_ref()
                    .ok_or_else(|| CoreError::Transport("this session has no relay".to_owned()))?,
            ),
            None => None,
        };
        let request_id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        // A request-id above 2^53 - 1 is not one a TypeScript peer can hold exactly, so none is minted.
        if request_id > MAX_EXACT_INTEGER {
            return Err(CoreError::Transport(
                "the session has used every request-id a peer can hold".to_owned(),
            ));
        }
        let (tx, rx) = oneshot::channel::<PendingReply>();
        {
            let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
            map.insert(
                request_id,
                PendingEntry {
                    reply: tx,
                    via: target,
                },
            );
        }
        let _guard = PendingGuard {
            pending: Arc::clone(&self.pending),
            request_id,
        };
        let frame = Frame::ManageRequest(Box::new(ManageRequestFrame {
            request_id,
            command,
            scope,
            token,
        }));
        // Sending can itself wait (a relayed request waits for its secure channel), so the timeout covers the send and the wait for the answer together, as the TypeScript `Promise.race` does.
        let exchange = async {
            let sent = match (target, relay) {
                (Some(target), Some(relay)) => relay
                    .send_to(target, &frame, SealPurpose::Request)
                    .await
                    .map_err(|error| CoreError::Transport(error.to_string())),
                _ => send_frame(&self.connection, frame).await,
            };
            match sent {
                Ok(()) => Ok(rx.await),
                Err(error) => Err(error),
            }
        };
        let outcome = match timeout {
            None => exchange.await,
            Some(duration) => match tokio::time::timeout(duration, exchange).await {
                Ok(result) => result,
                Err(_elapsed) => {
                    let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                    map.remove(&request_id);
                    drop(map);
                    if let (Some(target), Some(relay)) = (target, relay) {
                        relay.forget(&target);
                    }
                    return Ok(ManageOutcome::Error(ManageError {
                        code: "timeout".to_owned(),
                        message: None,
                    }));
                }
            },
        };
        let outcome = match outcome {
            Ok(received) => received,
            Err(error) => {
                let mut map = self.pending.lock().unwrap_or_else(|e| e.into_inner());
                map.remove(&request_id);
                return Err(error);
            }
        };

        match outcome {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(reason)) => Err(CoreError::Transport(reason)),
            // The sender was dropped without sending -- this runtime
            // always sends a reply on disconnect (see
            // `reject_all_pending`) and on a resolved response, so this
            // arm is only reachable if the dispatch task itself panicked.
            Err(_recv_error) => Err(CoreError::Transport(
                "connection closed before a response arrived".to_owned(),
            )),
        }
    }

    /// Announces this node to the hub the connection reaches: sends a `gossip` frame carrying `advert`, which the caller built for its own device and signed with `sign_peer_advert`. A hub ignores a `relay-connect` and a `relay-data` from a connection that has not announced itself, so a node that dials or is dialled through a hub announces first.
    ///
    /// # Errors
    ///
    /// A [`CoreError::Transport`] when the session is closed or the frame could not be sent.
    pub async fn announce(
        &self,
        advert: wire_mesh_wire::transport::PeerAdvert,
    ) -> Result<(), CoreError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CoreError::Transport("session is closed".to_owned()));
        }
        send_frame(
            &self.connection,
            Frame::Gossip(wire_mesh_wire::transport::GossipFrame {
                peers: vec![advert],
            }),
        )
        .await
    }

    /// Sends one `core/data` frame to `target`, a device reached through a relay pairing, sealed on its secure channel. The call waits for the channel to exist, as the TypeScript `sendDataFrame` does, and has no timeout of its own: a caller that must not wait without limit wraps it in one.
    ///
    /// # Errors
    ///
    /// A [`CoreError::Transport`] when the session is closed, was accepted without a relay, or the frame could not be sealed or sent.
    pub async fn send_data_frame_via(
        &self,
        target: DeviceId,
        frame: DataFrame,
    ) -> Result<(), CoreError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CoreError::Transport("session is closed".to_owned()));
        }
        let relay = self
            .relay
            .as_ref()
            .ok_or_else(|| CoreError::Transport("this session has no relay".to_owned()))?;
        relay
            .send_to(target, &frame.into_frame(), SealPurpose::Request)
            .await
            .map_err(|error| CoreError::Transport(error.to_string()))
    }

    /// Sends one `core/data` frame directly over this session's own
    /// connection.
    pub async fn send_data_frame(&self, frame: DataFrame) -> Result<(), CoreError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CoreError::Transport("session is closed".to_owned()));
        }
        send_frame(&self.connection, frame.into_frame()).await
    }

    /// Closes the underlying connection, rejects every
    /// `send_manage_request` call still awaiting a response, and stops
    /// the dispatch loop. Idempotent: closing an already-closed session
    /// is a no-op.
    pub async fn close(&self) -> Result<(), CoreError> {
        if self.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        self.dispatch_abort.abort();
        reject_all_pending(&self.pending, "connection closed before a response arrived");
        if let Some(relay) = &self.relay {
            relay.reset("the session closed before the channel was ready");
        }
        let _ = self.events_tx.send(SessionEvent::Disconnected {
            reason: "closed locally".to_owned(),
        });
        self.connection.lock().await.close().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::TcpTransport;
    use crate::ports::{OnConnection, Transport};
    use std::net::SocketAddr;
    use tokio::sync::mpsc as tokio_mpsc;
    use wire_mesh_wire::data::DataHaveFrame;
    use wire_mesh_wire::identity::DeviceId;
    use wire_mesh_wire::management::ManageOk;
    use wire_mesh_wire::tokens::CapabilityVerb;
    use wire_mesh_wire::value::CanonicalMap;

    /// Binds a fresh TCP loopback pair -- one side accepted via
    /// `Transport::listen`, the other dialled via `Transport::connect` --
    /// so every test below exercises the runtime over a real connection,
    /// never a hand-rolled test double.
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
        let bound = guard
            .address()
            .parse::<SocketAddr>()
            .expect("tcp reports a parseable host:port address");
        let dialled = transport
            .connect(&format!("127.0.0.1:{}", bound.port()))
            .await
            .expect("connect");
        let accepted = accepted_rx.recv().await.expect("accepted connection");
        (dialled, accepted)
    }

    fn scope() -> CapabilityScope {
        CapabilityScope {
            kind: "folder".to_owned(),
            path: None,
        }
    }

    struct EchoHandler;

    #[async_trait::async_trait]
    impl ManageRequestHandler for EchoHandler {
        async fn handle(&self, request: IncomingManageRequest) -> ManageOutcome {
            let mut extra = CanonicalMap::new();
            extra
                .insert(
                    "echoed-request-id".to_owned(),
                    wire_mesh_wire::value::CborValue::UInt(request.request_id),
                )
                .expect("unique key");
            ManageOutcome::Ok(ManageOk { extra })
        }
    }

    /// Builds a `ManageCommand` whose params are the open `Json` catch-all
    /// -- which itself requires an inner `"verb"` key (`manage_params_from`
    /// looks for one to pick a decode arm, and the closed arms all fail to
    /// match an arbitrary test verb), distinct from `command.verb` itself,
    /// the outer *capability* verb this session dispatches handlers by.
    fn json_command(verb: &str) -> ManageCommand {
        let mut params = CanonicalMap::new();
        params
            .insert(
                "verb".to_owned(),
                wire_mesh_wire::value::CborValue::Text(verb.to_owned()),
            )
            .expect("unique key");
        ManageCommand {
            verb: CapabilityVerb(verb.to_owned()),
            params: wire_mesh_wire::management::ManageParams::Json(params),
        }
    }

    #[tokio::test]
    async fn accepting_both_sides_negotiates_the_shared_domain() {
        let (a, b) = tcp_pair().await;
        let (session_a, mut events_a) = Session::accept(
            a,
            ["core/management".to_owned(), "core/exec".to_owned()],
            HandlerRegistry::new(),
        )
        .await
        .expect("accept a");
        let (session_b, mut events_b) = Session::accept(
            b,
            ["core/exec".to_owned(), "core/data".to_owned()],
            HandlerRegistry::new(),
        )
        .await
        .expect("accept b");

        let event_a = events_a.recv().await.expect("event a");
        let event_b = events_b.recv().await.expect("event b");
        assert_eq!(
            event_a,
            SessionEvent::HandshakeNegotiated {
                version: 1,
                shared_domains: vec!["core/exec".to_owned()],
            }
        );
        assert_eq!(event_a, event_b);

        session_a.close().await.expect("close a");
        session_b.close().await.expect("close b");
    }

    #[tokio::test]
    async fn a_manage_request_with_no_registered_handler_gets_an_explicit_unknown_verb_error() {
        let (a, b) = tcp_pair().await;
        let (session_a, _events_a) = Session::accept(a, [], HandlerRegistry::new())
            .await
            .expect("accept a");
        let (_session_b, mut _events_b) = Session::accept(b, [], HandlerRegistry::new())
            .await
            .expect("accept b");

        let outcome = session_a
            .send_manage_request(
                json_command("example.com/nothing:here"),
                scope(),
                None,
                None,
            )
            .await
            .expect("send_manage_request");
        match outcome {
            ManageOutcome::Error(error) => assert_eq!(error.code, "unknown-verb"),
            ManageOutcome::Ok(_) => panic!("expected an unknown-verb error"),
        }
    }

    #[tokio::test]
    async fn a_registered_handler_dispatches_and_the_caller_receives_its_outcome() {
        let (a, b) = tcp_pair().await;
        let registry =
            HandlerRegistry::new().register("example.com/echo:ping", Arc::new(EchoHandler));
        let (session_a, _events_a) = Session::accept(a, [], HandlerRegistry::new())
            .await
            .expect("accept a");
        let (_session_b, _events_b) = Session::accept(b, [], registry).await.expect("accept b");

        let outcome = session_a
            .send_manage_request(json_command("example.com/echo:ping"), scope(), None, None)
            .await
            .expect("send_manage_request");
        match outcome {
            ManageOutcome::Ok(ok) => {
                assert!(ok.extra.get(&"echoed-request-id".to_owned()).is_some());
            }
            ManageOutcome::Error(error) => panic!("expected ok, got {error:?}"),
        }
    }

    #[tokio::test]
    async fn a_registered_version_handler_answers_with_this_crate_s_own_compiled_version() {
        let (a, b) = tcp_pair().await;
        let registry = HandlerRegistry::new().register("core:version", Arc::new(VersionHandler));
        let (session_a, _events_a) = Session::accept(a, [], HandlerRegistry::new())
            .await
            .expect("accept a");
        let (_session_b, _events_b) = Session::accept(b, [], registry).await.expect("accept b");

        let outcome = session_a
            .send_manage_request(json_command("core:version"), scope(), None, None)
            .await
            .expect("send_manage_request");
        match outcome {
            ManageOutcome::Ok(ok) => {
                assert_eq!(
                    ok.extra.get(&"version".to_owned()),
                    Some(&CborValue::Text(env!("CARGO_PKG_VERSION").to_owned())),
                );
            }
            ManageOutcome::Error(error) => panic!("expected ok, got {error:?}"),
        }
    }

    /// A handler that never resolves -- `send_manage_request`'s own
    /// timeout is the only thing that can end the wait, proving the
    /// timeout is real and not merely returned instantly by coincidence.
    struct NeverRespondsHandler;

    #[async_trait::async_trait]
    impl ManageRequestHandler for NeverRespondsHandler {
        async fn handle(&self, _request: IncomingManageRequest) -> ManageOutcome {
            std::future::pending::<()>().await;
            unreachable!("pending() never resolves")
        }
    }

    #[tokio::test]
    async fn send_manage_request_times_out_when_no_response_arrives() {
        let (a, b) = tcp_pair().await;
        let registry = HandlerRegistry::new()
            .register("example.com/silence:ping", Arc::new(NeverRespondsHandler));
        let (session_a, _events_a) = Session::accept(a, [], HandlerRegistry::new())
            .await
            .expect("accept a");
        let (_session_b, _events_b) = Session::accept(b, [], registry).await.expect("accept b");

        let outcome = session_a
            .send_manage_request(
                json_command("example.com/silence:ping"),
                scope(),
                None,
                Some(Duration::from_millis(50)),
            )
            .await
            .expect("send_manage_request");
        match outcome {
            ManageOutcome::Error(error) => assert_eq!(error.code, "timeout"),
            ManageOutcome::Ok(_) => panic!("expected a timeout error"),
        }
    }

    #[tokio::test]
    async fn closing_a_session_rejects_a_pending_request_and_emits_disconnected() {
        let (a, b) = tcp_pair().await;
        let registry = HandlerRegistry::new()
            .register("example.com/silence:ping", Arc::new(NeverRespondsHandler));
        let (session_a, mut events_a) = Session::accept(a, [], HandlerRegistry::new())
            .await
            .expect("accept a");
        let (session_b, _events_b) = Session::accept(b, [], registry).await.expect("accept b");

        let pending = tokio::spawn({
            let session_a = std::sync::Arc::new(session_a);
            let session_a_for_request = std::sync::Arc::clone(&session_a);
            async move {
                let outcome = session_a_for_request
                    .send_manage_request(
                        json_command("example.com/silence:ping"),
                        scope(),
                        None,
                        None,
                    )
                    .await;
                (outcome, session_a)
            }
        });

        // Give the request time to actually be in flight before closing.
        tokio::time::sleep(Duration::from_millis(50)).await;
        session_b.close().await.expect("close b");

        let (result, session_a) = pending.await.expect("join");
        assert!(
            result.is_err(),
            "expected the disconnect to reject the pending request"
        );
        session_a.close().await.expect("close a");

        let mut saw_disconnected = false;
        while let Ok(event) = events_a.try_recv() {
            if matches!(event, SessionEvent::Disconnected { .. }) {
                saw_disconnected = true;
            }
        }
        assert!(
            saw_disconnected,
            "expected a Disconnected event on session a"
        );
    }

    #[tokio::test]
    async fn send_data_frame_delivers_the_frame_directly() {
        let (a, mut b) = tcp_pair().await;
        let (session_a, _events_a) = Session::accept(a, [], HandlerRegistry::new())
            .await
            .expect("accept a");

        // b is not wrapped as a Session here -- reading its raw frame stream directly proves send_data_frame puts the frame on the wire unmodified, with no manage-request/response envelope.
        let mut raw = b.receive().expect("receive");
        // Consume b's own inbound handshake frame (sent by session_a's accept) before asserting on the data frame.
        let _ = next_frame(&mut raw).await;

        let peer = DeviceId::from_bytes([7u8; 32]);
        session_a
            .send_data_frame(DataFrame::Have(DataHaveFrame { peer, head_seq: 42 }))
            .await
            .expect("send_data_frame");

        match next_frame(&mut raw).await {
            Some(Frame::DataHave(frame)) => {
                assert_eq!(frame.peer, peer);
                assert_eq!(frame.head_seq, 42);
            }
            other => panic!("expected data-have, got {other:?}"),
        }

        session_a.close().await.expect("close a");
    }
}

#[cfg(test)]
#[path = "session_relay_tests.rs"]
mod relay_tests;

#[cfg(test)]
#[path = "session_gossip_tests.rs"]
mod gossip_tests;
