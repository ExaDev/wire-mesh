//! Edge implementations, one per port. Adapters are composition choices: swapping the in-memory storage for a Durable-Object or filesystem adapter, or the TCP transport for TLS/WebRTC, changes nothing in the domain layer.

pub mod memory_storage;
pub mod node_identity;
pub mod system_clock;
pub mod tcp_transport;

pub use memory_storage::MemoryStorage;
pub use node_identity::NodeIdentity;
pub use system_clock::SystemClock;
pub use tcp_transport::TcpTransport;
