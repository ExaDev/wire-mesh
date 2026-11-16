//! A relay peer for the interoperability test against the TypeScript hub (`ts/packages/core/test/relay-interop.integration.test.ts`): connects to a hub over TCP, announces itself, and either asks a target for something through a relay pairing or serves requests that arrive through one. It prints one line per event on standard output and ends when standard input closes.
//!
//! ```text
//! relay_peer <hub host:port> request <target device hex> <repeat> <timeout ms>
//! relay_peer <hub host:port> serve
//! relay_peer <hub host:port> gossip
//! ```
//!
//! Lines: `DEVICE <hex>` (this node's device-id, first), `RESULT <outcome>` (one per request: `ok`, `timeout` or `error <code>`), `HANDLED <verb>` (a request reached a handler) and `DATA <from hex>` (a core/data frame arrived through a relay).

use std::sync::Arc;
use std::time::Duration;

use wire_mesh_core::adapters::{MonotonicClock, NodeIdentity, TcpTransport};

use wire_mesh_core::domain::peer_advert::sign_peer_advert;
use wire_mesh_core::domain::relay_channels::{RelayChannels, RelayOptions};
use wire_mesh_core::domain::relay_client::{HubLink, RelayClient};
use wire_mesh_core::domain::session::{
    GossipConfig, HandlerRegistry, IncomingManageRequest, ManageRequestHandler, Session,
    SessionEvent, SessionOptions, HANDSHAKE_TIMEOUT,
};
use wire_mesh_core::ports::{Clock, Identity, Transport};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::{ManageCommand, ManageOk, ManageOutcome, ManageParams};
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb};
use wire_mesh_wire::transport::PeerAdvert;
use wire_mesh_wire::value::{CanonicalMap, CborValue};

/// The wall clock, which a gossip advert's snapshot time is read from.
struct SystemClock;

impl Clock for SystemClock {
    fn now_unix_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| {
                u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
            })
    }
}

struct Reporting;

#[async_trait::async_trait]
impl ManageRequestHandler for Reporting {
    async fn handle(&self, request: IncomingManageRequest) -> ManageOutcome {
        println!("HANDLED {}", request.command.verb.0);
        ManageOutcome::Ok(ManageOk {
            extra: CanonicalMap::new(),
        })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_device(text: &str) -> Result<DeviceId, String> {
    let bytes: Vec<u8> = (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(text.get(at..at + 2).unwrap_or(""), 16))
        .collect::<Result<_, _>>()
        .map_err(|error| error.to_string())?;
    let array: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "a device-id is 64 hex digits".to_owned())?;
    Ok(DeviceId(array))
}

async fn advert(identity: &NodeIdentity) -> Result<PeerAdvert, String> {
    let mut advert = PeerAdvert {
        device: *identity.device_id(),
        addresses: Vec::new(),
        // The time now, as a hub orders adverts by it: a fixed time would leave a later run of the same identity unable to replace its earlier advert.
        snapshot_seconds: i64::try_from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_secs(),
        )
        .map_err(|error| error.to_string())?,
        identity_key: identity.identity_key().clone(),
        signature: Vec::new(),
        extra: CanonicalMap::new(),
    };
    sign_peer_advert(identity, &mut advert)
        .await
        .map_err(|error| error.to_string())?;
    Ok(advert)
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [hub, mode, rest @ ..] = args.as_slice() else {
        return Err("usage: relay_peer <hub host:port> request|serve ...".to_owned());
    };
    let identity = Arc::new(NodeIdentity::generate_ed25519());
    println!("DEVICE {}", hex(&identity.device_id().0));
    let connection = TcpTransport::new()
        .connect(hub)
        .await
        .map_err(|error| error.to_string())?;
    let registry = HandlerRegistry::new().register("relay:echo", Arc::new(Reporting));
    let signer = Arc::clone(&identity);
    // The session announces itself in gossip mode, so the hub learns this node from the session's own advert; the other modes announce by hand.
    let gossiping = mode == "gossip";
    let mut options = SessionOptions::new().relayed(move |link: Arc<dyn HubLink>| {
        let channels = Arc::new(RelayChannels::new(
            signer,
            RelayClient::hello_sender(Arc::clone(&link)),
            Arc::new(MonotonicClock::new()),
            RelayOptions::default(),
        ));
        Arc::new(RelayClient::new(link, channels))
    });
    if gossiping {
        options = options.gossiping(GossipConfig {
            identity: Arc::clone(&identity) as Arc<dyn Identity>,
            clock: Arc::new(SystemClock),
            addresses: Vec::new(),
            accepted: false,
            handshake_timeout: HANDSHAKE_TIMEOUT,
        });
    }
    let (session, mut events) = Session::accept_with(
        connection,
        ["core/management".to_owned()],
        registry,
        options,
    )
    .await
    .map_err(|error| error.to_string())?;
    if !gossiping {
        session
            .announce(advert(&identity).await?)
            .await
            .map_err(|error| error.to_string())?;
    }
    println!("ANNOUNCED");
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                SessionEvent::RelayedData { from, .. } => println!("DATA {}", hex(&from.0)),
                SessionEvent::DirectoryChanged { device } => {
                    println!("DIRECTORY {}", hex(&device.0));
                }
                _ => {}
            }
        }
    });
    match (mode.as_str(), rest) {
        ("request", [target, repeat, timeout_ms]) => {
            let target = parse_device(target)?;
            let repeat: usize = repeat
                .parse()
                .map_err(|_| "repeat is a number".to_owned())?;
            let timeout = Duration::from_millis(
                timeout_ms
                    .parse()
                    .map_err(|_| "timeout is a number".to_owned())?,
            );
            for _ in 0..repeat {
                let mut params = CanonicalMap::new();
                params
                    .insert("verb".to_owned(), CborValue::Text("relay:echo".to_owned()))
                    .map_err(|error| error.to_string())?;
                let outcome = session
                    .send_manage_request_via(
                        target,
                        ManageCommand {
                            verb: CapabilityVerb("relay:echo".to_owned()),
                            params: ManageParams::Json(params),
                        },
                        CapabilityScope {
                            kind: "folder".to_owned(),
                            path: None,
                        },
                        None,
                        Some(timeout),
                    )
                    .await;
                match outcome {
                    Ok(ManageOutcome::Ok(_)) => println!("RESULT ok"),
                    Ok(ManageOutcome::Error(error)) => {
                        if error.code == "timeout" {
                            println!("RESULT timeout");
                        } else {
                            println!("RESULT error {}", error.code);
                        }
                    }
                    Err(error) => println!("RESULT failed {error}"),
                }
            }
        }
        ("serve" | "gossip", []) => {}
        _ => return Err("unknown mode or arguments".to_owned()),
    }
    // Ends when standard input closes, so the test decides how long this node stays on the hub.
    let mut line = String::new();
    while std::io::stdin()
        .read_line(&mut line)
        .map_err(|error| error.to_string())?
        > 0
    {
        line.clear();
    }
    let _ = session.close().await;
    Ok(())
}
