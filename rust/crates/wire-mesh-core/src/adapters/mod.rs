//! Edge implementations, one per port. Adapters are composition choices: swapping the in-memory storage for a Durable-Object or filesystem adapter, or the TCP transport for TLS/WebRTC, changes nothing in the domain layer.

#[cfg(feature = "fs")]
pub mod fs_storage;
pub mod memory_storage;
pub mod monotonic_clock;
pub mod node_identity;
pub mod system_clock;
#[cfg(feature = "net")]
pub mod tcp_transport;

#[cfg(feature = "fs")]
pub use fs_storage::FsStorage;
pub use memory_storage::MemoryStorage;
pub use monotonic_clock::MonotonicClock;
pub use node_identity::NodeIdentity;
pub use system_clock::SystemClock;
#[cfg(feature = "net")]
pub use tcp_transport::TcpTransport;
