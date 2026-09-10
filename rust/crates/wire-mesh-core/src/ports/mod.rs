//! Ports: the contracts domain logic depends on, and nothing else. Domain modules never touch a socket, the system clock, or a storage backend directly; runtime-specific and vendor-specific concerns live in adapters at the edges, satisfying these traits. The bar for each port: could a second implementation, built on completely different vendor primitives, satisfy the exact same contract with zero changes to the contract or its callers?

pub mod clock;
pub mod identity;
pub mod storage;
pub mod transport;

pub use clock::Clock;
pub use identity::Identity;
pub use storage::KeyValueStorage;
pub use transport::{Connection, ListenGuard, OnConnection, Transport};

/// The error type every port and adapter reports through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    Transport(String),
    Storage(String),
    Crypto(String),
    /// A wire-level decode/encode failure surfaced through a port.
    Wire(String),
}

impl core::fmt::Display for CoreError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CoreError::Transport(m) => write!(f, "transport: {m}"),
            CoreError::Storage(m) => write!(f, "storage: {m}"),
            CoreError::Crypto(m) => write!(f, "crypto: {m}"),
            CoreError::Wire(m) => write!(f, "wire: {m}"),
        }
    }
}

impl std::error::Error for CoreError {}

impl From<wire_mesh_wire::DecodeError> for CoreError {
    fn from(e: wire_mesh_wire::DecodeError) -> Self {
        CoreError::Wire(e.to_string())
    }
}

impl From<wire_mesh_wire::EncodeError> for CoreError {
    fn from(e: wire_mesh_wire::EncodeError) -> Self {
        CoreError::Wire(e.to_string())
    }
}
