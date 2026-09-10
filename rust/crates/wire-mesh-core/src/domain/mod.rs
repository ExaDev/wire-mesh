//! Domain logic: depends only on the port traits and the wire types, never on an adapter or a global/platform API, so runtime and storage stay swappable composition concerns at the edges.

pub mod cose;
pub mod handshake;
pub mod revocation;
pub mod tokens;

pub use handshake::{negotiate, NegotiationResult, SUPPORTED_PROTOCOL_VERSION};
pub use revocation::{RevocationError, RevocationView};
pub use tokens::{verify_capability_token, TokenRejection, TokenVerdict};
