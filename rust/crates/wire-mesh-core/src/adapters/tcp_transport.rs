//! The Tokio TCP transport adapter. Frames travel with a 4-byte
//! big-endian length prefix, matching the TypeScript adapter's framing
//! shape; TLS is a separate future adapter behind the same port.
//!
//! The receive-side frame cap is this adapter's own policy, not part of
//! the wire contract (`handshake.cddl` explicitly leaves any domain-count
//! or size cap to implementations).

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll};

use futures_core::Stream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::AbortHandle;
use wire_mesh_wire::{decode_frame, encode_frame, Frame};

use crate::ports::{Connection, CoreError, ListenGuard, OnConnection, Transport};

/// How many consecutive `accept()` failures a listener tolerates before
/// stopping, and how long it pauses between them (bounded backoff instead
/// of a hot spin on persistent errors such as EMFILE).
const ACCEPT_ERROR_LIMIT: u32 = 32;
const ACCEPT_ERROR_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);
/// This adapter's receive-side frame-size cap: 16 MiB. The wire contract
/// sets no bound; a deployment wanting a different cap swaps adapters or
/// layers its own policy.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Default)]
pub struct TcpTransport;

impl TcpTransport {
    pub fn new() -> Self {
        Self
    }
}

fn parse_address(address: &str) -> Result<SocketAddr, CoreError> {
    let trimmed = address.trim_start_matches("tcp://");
    SocketAddr::from_str(trimmed)
        .or_else(|_| {
            use std::net::ToSocketAddrs;
            trimmed
                .to_socket_addrs()
                .ok()
                .and_then(|mut addrs| addrs.next())
                .ok_or(())
        })
        .map_err(|_| CoreError::Transport(format!("invalid TCP address {address:?}")))
}

#[async_trait::async_trait]
impl Transport for TcpTransport {
    async fn connect(&self, address: &str) -> Result<Box<dyn Connection>, CoreError> {
        let addr = parse_address(address)?;
        let stream = TcpStream::connect(addr)
            .await
            .map_err(|e| CoreError::Transport(format!("connect to {addr} failed: {e}")))?;
        Ok(Box::new(TcpConnection::new(stream)))
    }

    async fn listen(
        &self,
        address: &str,
        on_connection: OnConnection,
    ) -> Result<Box<dyn ListenGuard>, CoreError> {
        let addr = parse_address(address)?;
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| CoreError::Transport(format!("bind {addr} failed: {e}")))?;
        let local = listener
            .local_addr()
            .map_err(|e| CoreError::Transport(format!("local_addr failed: {e}")))?;
        let task = tokio::spawn(async move {
            let mut consecutive_errors = 0u32;
            loop {
                let (stream, _peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    // A persistent accept failure (e.g. EMFILE under fd
                    // exhaustion) would otherwise hot-spin, so back off
                    // briefly and give up after a sustained run of them —
                    // fail-closed rather than burning a core forever.
                    Err(e) => {
                        consecutive_errors += 1;
                        if consecutive_errors >= ACCEPT_ERROR_LIMIT {
                            eprintln!("tcp accept failed {consecutive_errors} times in a row ({e}); listener stopping");
                            return;
                        }
                        tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                        continue;
                    }
                };
                consecutive_errors = 0;
                on_connection(Box::new(TcpConnection::new(stream)));
            }
        });
        Ok(Box::new(TcpListenGuard {
            local,
            abort: task.abort_handle(),
        }))
    }
}

/// A live TCP connection: a reader task feeding an inbound frame channel,
/// and a writer task draining an outbound encoded-frame channel. Frames
/// arrive in order because both channels are FIFO.
struct TcpConnection {
    inbound: Option<mpsc::Receiver<Frame>>,
    outbound: Option<mpsc::Sender<Vec<u8>>>,
    closed: Arc<AtomicBool>,
    reader_abort: AbortHandle,
}

impl TcpConnection {
    fn new(stream: TcpStream) -> Self {
        let (read_half, write_half) = stream.into_split();
        let (inbound_tx, inbound_rx) = mpsc::channel::<Frame>(64);
        let (outbound_tx, mut outbound_rx) = mpsc::channel::<Vec<u8>>(64);
        let closed = Arc::new(AtomicBool::new(false));

        let _writer = tokio::spawn(async move {
            let mut writer = write_half;
            while let Some(frame_bytes) = outbound_rx.recv().await {
                let prefix = (frame_bytes.len() as u32).to_be_bytes();
                if writer.write_all(&prefix).await.is_err()
                    || writer.write_all(&frame_bytes).await.is_err()
                {
                    break;
                }
            }
            // Dropping the last outbound sender means close(): finish the
            // TCP write half so the peer sees EOF rather than a hang.
            let _ = writer.shutdown().await;
        });

        let reader_closed = Arc::clone(&closed);
        let reader = tokio::spawn(async move {
            let mut reader = read_half;
            loop {
                let mut prefix = [0u8; 4];
                if reader.read_exact(&mut prefix).await.is_err() {
                    break;
                }
                let len = u32::from_be_bytes(prefix) as usize;
                if len > MAX_FRAME_BYTES {
                    break;
                }
                let mut buf = vec![0u8; len];
                if reader.read_exact(&mut buf).await.is_err() {
                    break;
                }
                let frame = match decode_frame(&buf) {
                    Ok(frame) => frame,
                    // A peer sending an undecodable body has violated the
                    // connection's framing: end the stream fail-closed,
                    // with the reason surfaced on stderr rather than
                    // vanishing silently (the receive iteration simply
                    // ends, same as a peer disconnect).
                    Err(e) => {
                        eprintln!("tcp connection dropped after undecodable frame body: {e}");
                        break;
                    }
                };
                if inbound_tx.send(frame).await.is_err() {
                    break;
                }
                if reader_closed.load(Ordering::Relaxed) {
                    break;
                }
            }
            // inbound_tx drops here: the receive stream ends.
        });

        TcpConnection {
            inbound: Some(inbound_rx),
            outbound: Some(outbound_tx),
            closed,
            reader_abort: reader.abort_handle(),
        }
    }
}

#[async_trait::async_trait]
impl Connection for TcpConnection {
    async fn send(&self, frame: Frame) -> Result<(), CoreError> {
        if self.closed.load(Ordering::Relaxed) {
            return Err(CoreError::Transport("connection is closed".to_owned()));
        }
        let outbound = self
            .outbound
            .as_ref()
            .ok_or_else(|| CoreError::Transport("connection is closed".to_owned()))?;
        let bytes = encode_frame(&frame);
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(CoreError::Transport(format!(
                "encoded frame is {} bytes, above the {}-byte send cap",
                bytes.len(),
                MAX_FRAME_BYTES
            )));
        }
        outbound
            .send(bytes)
            .await
            .map_err(|_| CoreError::Transport("connection writer is gone".to_owned()))
    }

    fn receive(&mut self) -> Result<Pin<Box<dyn Stream<Item = Frame> + Send>>, CoreError> {
        match self.inbound.take() {
            Some(rx) => Ok(Box::pin(OwnedRecvStream { rx })),
            None => Err(CoreError::Transport(
                "the inbound frame stream was already taken by an earlier receive()".to_owned(),
            )),
        }
    }

    async fn close(&mut self) -> Result<(), CoreError> {
        if self.closed.swap(true, Ordering::Relaxed) {
            return Ok(());
        }
        // Dropping the outbound sender ends the writer loop and shuts the
        // write half down; aborting the reader tears the read side down
        // deterministically instead of waiting for the peer's EOF.
        self.outbound = None;
        self.reader_abort.abort();
        Ok(())
    }
}

/// An owned stream over the connection's inbound channel: polls the mpsc
/// receiver directly, yielding frames in arrival order until the channel
/// closes (peer close, local close, or reader teardown).
struct OwnedRecvStream {
    rx: mpsc::Receiver<Frame>,
}

impl Stream for OwnedRecvStream {
    type Item = Frame;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Frame>> {
        let this = self.get_mut();
        // mpsc recv() is cancel-safe, so recreating the future each poll is correct; the stream ends with None when the channel closes.
        let mut fut = std::pin::pin!(this.rx.recv());
        fut.as_mut().poll(cx)
    }
}

pub struct TcpListenGuard {
    local: SocketAddr,
    abort: AbortHandle,
}

impl TcpListenGuard {
    /// The address actually bound (useful when listening on port 0).
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }
}

impl ListenGuard for TcpListenGuard {
    fn address(&self) -> String {
        self.local.to_string()
    }
}

impl Drop for TcpListenGuard {
    fn drop(&mut self) {
        self.abort.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::negotiate;
    use tokio_stream::StreamExt;
    use wire_mesh_wire::handshake::{DomainId, HandshakeFrame, ProtocolVersion};

    #[tokio::test]
    async fn frames_round_trip_in_order_over_tcp() {
        let transport = TcpTransport::new();
        let (accepted_tx, mut accepted_rx) = mpsc::unbounded_channel::<Box<dyn Connection>>();
        let guard = transport
            .listen(
                "127.0.0.1:0",
                std::sync::Arc::new(move |conn| {
                    let _ = accepted_tx.send(conn);
                }),
            )
            .await
            .expect("listen");
        let bound = guard
            .address()
            .parse::<SocketAddr>()
            .expect("tcp reports a parseable host:port address");
        let port = bound.port();

        let mut client = transport
            .connect(&format!("127.0.0.1:{port}"))
            .await
            .expect("connect");
        let mut server = accepted_rx.recv().await.expect("accepted connection");

        // The protocol's own opening move: handshake both ways, negotiate the intersection.
        let client_handshake = HandshakeFrame {
            version: ProtocolVersion(1),
            domains: vec![
                DomainId("core/management".to_owned()),
                DomainId("core/exec".to_owned()),
            ],
            params: None,
        };
        let server_handshake = HandshakeFrame {
            version: ProtocolVersion(1),
            domains: vec![
                DomainId("core/exec".to_owned()),
                DomainId("core/data".to_owned()),
            ],
            params: None,
        };
        client
            .send(Frame::Handshake(client_handshake.clone()))
            .await
            .expect("send handshake");
        server
            .send(Frame::Handshake(server_handshake.clone()))
            .await
            .expect("send handshake");

        let mut client_frames = client.receive().expect("take client stream");
        let mut server_frames = server.receive().expect("take server stream");
        let from_server = match client_frames.next().await.expect("frame") {
            Frame::Handshake(h) => h,
            other => panic!("expected handshake, got {:?}", other.kind()),
        };
        let from_client = match server_frames.next().await.expect("frame") {
            Frame::Handshake(h) => h,
            other => panic!("expected handshake, got {:?}", other.kind()),
        };
        let client_side = negotiate(&client_handshake, &from_server).expect("negotiate");
        let server_side = negotiate(&from_client, &server_handshake).expect("negotiate");
        assert_eq!(client_side.version, 1);
        assert_eq!(client_side.shared_domains, vec!["core/exec".to_owned()]);
        assert_eq!(
            client_side, server_side,
            "both sides reach the same negotiated set"
        );

        // Arrival order is preserved across several frames.
        for seq in 0..3u64 {
            client
                .send(Frame::SyncPunch(
                    wire_mesh_wire::transport::SyncPunchFrame {
                        nonce: seq,
                        deadline_unix_ms: 0,
                    },
                ))
                .await
                .expect("send");
        }
        for expected in 0..3u64 {
            match server_frames.next().await.expect("frame") {
                Frame::SyncPunch(p) => assert_eq!(p.nonce, expected),
                other => panic!("expected sync-punch, got {:?}", other.kind()),
            }
        }

        // Close ends the receive stream.
        client.close().await.expect("close");
        assert!(
            client_frames.next().await.is_none(),
            "receive stream ends after close"
        );
    }
}
