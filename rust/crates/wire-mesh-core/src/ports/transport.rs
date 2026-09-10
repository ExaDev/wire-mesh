//! The transport port: connect, listen, and per-connection frame
//! send/receive. Signatures carry serialisable frame values only — no
//! socket, TLS, or WebSocket primitives — so a plain TCP adapter, a TLS
//! adapter, a Durable-Object WebSocket adapter, and a WebRTC DataChannel
//! adapter are all interchangeable composition choices.

use core::pin::Pin;

use futures_core::Stream;
use wire_mesh_wire::Frame;

use crate::ports::CoreError;

/// A live connection to one peer.
///
/// The inbound frame stream is taken once, up front, and owned by the
/// consumer — a connection delivers its frames to exactly one consumer, in
/// arrival order until close. Making the stream owned (rather than
/// borrowing the connection) keeps the connection full-duplex: frames can
/// be sent while the receive stream is being driven, without borrow
/// contention between the two halves.
#[async_trait::async_trait]
pub trait Connection: Send + Sync {
    /// Send one frame. Resolves when the frame is handed to the transport.
    async fn send(&self, frame: Frame) -> Result<(), CoreError>;

    /// Take the inbound frame stream. One-shot: the stream ends (yields
    /// `None`) when the peer closes or the connection is closed locally;
    /// a second call errors rather than silently handing over an empty
    /// stream.
    fn receive(&mut self) -> Result<Pin<Box<dyn Stream<Item = Frame> + Send>>, CoreError>;

    /// Close the connection. Subsequent sends fail; the receive stream
    /// ends.
    async fn close(&mut self) -> Result<(), CoreError>;
}

/// Callback invoked with each accepted inbound connection.
pub type OnConnection = std::sync::Arc<dyn Fn(Box<dyn Connection>) + Send + Sync>;

/// Keeps a listener alive; dropping it stops listening.
pub trait ListenGuard: Send {
    /// The address actually bound, for stream transports that can report
    /// it (useful when listening on port 0). Adapters whose address is not
    /// a socket address return `None`.
    fn local_addr(&self) -> Option<std::net::SocketAddr> {
        None
    }
}

/// The transport port.
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    /// Connect to a peer at `address` (adapter-defined address syntax).
    async fn connect(&self, address: &str) -> Result<Box<dyn Connection>, CoreError>;

    /// Listen for inbound connections at `address`, invoking `on_connection`
    /// with each one. The returned guard keeps the listener alive; dropping
    /// it stops listening. An address of port 0 binds an OS-assigned port,
    /// queryable on the adapter's guard type.
    async fn listen(
        &self,
        address: &str,
        on_connection: OnConnection,
    ) -> Result<Box<dyn ListenGuard>, CoreError>;
}
