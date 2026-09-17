//! exadev.io/threshold -- FROST(Ed25519, SHA-512) threshold signing (RFC 9591) among a person's own devices, wrapping the audited `frost-ed25519`/`frost-core` crates (ZcashFoundation, NCC-audited) rather than reimplementing curve or field arithmetic. See `spec/threshold.cddl` for the wire protocol this crate's domain logic implements, and the design doc referenced from wire-mesh#29 for the full security rationale.

pub mod dkg;
pub mod identifiers;
pub mod identity;
pub mod lagrange;
pub mod nonce_store;
pub mod reshare;
pub mod share_envelope;
pub mod signing;
pub mod subject;

pub use frost_ed25519 as frost;
