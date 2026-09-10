//! The COSE signing convention shared by capability tokens, handle
//! records, and revocation entries.
//!
//! RFC 9052 §4.4's `Sig_structure` for a single-signer signature is the
//! array `["Signature1", body_protected, external_aad, payload]`, where
//! `body_protected` is the protected-header map bytes (the content of the
//! COSE_Sign1's first bstr), `external_aad` is the empty bstr, and
//! `payload` is the signed content — for wire-mesh, the canonical CBOR
//! encoding of the claims map. Assembling it here, once, keeps every
//! signing and verification site from hand-rolling its own.

/// Assemble the RFC 9052 §4.4 `Sig_structure` bytes for a single-signer
/// signature over `payload`, with `protected` as the body-protected
/// header and an empty external AAD.
pub fn sig_structure(protected: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut e = wire_mesh_wire::minicbor::Encoder::new(Vec::new());
    // Vec writes are infallible and the values are plain strings/bytes.
    e.array(4)
        .and_then(|e| e.str("Signature1"))
        .and_then(|e| e.bytes(protected))
        .and_then(|e| e.bytes(&[]))
        .and_then(|e| e.bytes(payload))
        .and_then(|e| e.ok())
        .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
    e.into_writer()
}
