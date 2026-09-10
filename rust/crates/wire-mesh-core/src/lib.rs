//! `wire-mesh-core`: the Rust implementation's domain layer, ports, and adapters, the direct mirror of the TypeScript core minus its generated wire layer (which lives in `wire-mesh-wire`). Layout mirrors the TS core's ports/domain/adapters split: `ports` holds the contracts domain logic depends on (Transport, KeyValueStorage, Identity, Clock; the async ports use `#[async_trait]` because native async-fn-in-trait is not dyn-safe, keeping adapters interchangeable as trait objects at a small per-call allocation cost), `domain` holds handshake negotiation, capability-token verification, and revocation (depending only on ports and wire types), and `adapters` holds edge implementations, one per port.

#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]

pub mod adapters;
pub mod domain;
pub mod ports;
