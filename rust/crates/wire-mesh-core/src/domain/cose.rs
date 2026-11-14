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

use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::tokens::{CoseSign1, CoseTokenHeaders};
use wire_mesh_wire::value::{CborValue, HeaderLabel};

use crate::ports::{CoreError, Identity};

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

/// The protected header of every wire-mesh COSE_Sign1 an identity signs: `alg` and `kid` (the signer's device-id), canonically encoded under the text keys "1" and "4", exactly as the TypeScript core writes them and as the frozen vectors carry them. `spec/tokens.cddl` names the integer labels 1 and 4 for these; every verifier reads either form, and signing uses the text form so that both implementations mint the same bytes.
fn protected_header(alg: i64, device_id: &DeviceId) -> Vec<u8> {
    let mut extra = wire_mesh_wire::value::CanonicalMap::new();
    for (label, value) in [
        ("1", CborValue::Int(alg)),
        ("4", CborValue::Bytes(device_id.as_bytes().to_vec())),
    ] {
        if extra
            .insert(HeaderLabel::Text(label.to_owned()), value)
            .is_err()
        {
            unreachable!("the two labels are distinct");
        }
    }
    wire_mesh_wire::to_vec(&CoseTokenHeaders {
        alg: None,
        kid: None,
        extra,
    })
}

/// Signs `payload` (already-encoded claims bytes) as a COSE_Sign1 under `identity`: the canonical protected header, an empty unprotected header and a signature over the RFC 9052 `Sig_structure`, the same construction every verifier checks.
///
/// # Errors
///
/// The error `identity.sign` returns.
pub async fn sign_cose_sign1(
    identity: &dyn Identity,
    payload: &[u8],
) -> Result<CoseSign1, CoreError> {
    let protected = protected_header(identity.identity_key().alg, identity.device_id());
    let signature = identity.sign(&sig_structure(&protected, payload)).await?;
    Ok(CoseSign1 {
        protected,
        unprotected: CoseTokenHeaders::new(),
        payload: Some(payload.to_vec()),
        signature,
    })
}
