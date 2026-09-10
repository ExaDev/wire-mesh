//! The node-identity adapter: local key material for Ed25519 (COSE alg
//! -8) and ES256 P-256 (COSE alg -7), signing and verification against
//! arbitrary issuer keys, and the raw-public-key device-id derivation.
//!
//! `public_key` bytes follow each algorithm's own canonical encoding:
//! 32 raw bytes for Ed25519, 65-byte uncompressed SEC1 (`0x04 || X || Y`)
//! for ES256 — the same encodings COSE keys use.

use ed25519_dalek::{Signature as Ed25519Signature, Signer, SigningKey, Verifier, VerifyingKey};
use p256::ecdsa::signature::{DigestSigner, DigestVerifier};
use p256::ecdsa::{
    Signature as P256Signature, SigningKey as P256SigningKey, VerifyingKey as P256VerifyingKey,
};
use p256::PublicKey;
use rand::rngs::OsRng;
use sha2::{Digest, Sha256};
use wire_mesh_wire::identity::{DeviceId, IdentityKey};
use wire_mesh_wire::tokens::CoseSign1;

use crate::domain::cose::sig_structure;
use crate::ports::{CoreError, Identity};

enum SigningMaterial {
    Ed25519(SigningKey),
    Es256(P256SigningKey),
}

pub struct NodeIdentity {
    device_id: DeviceId,
    identity_key: IdentityKey,
    signing: SigningMaterial,
}

impl NodeIdentity {
    /// Generate a fresh Ed25519 identity (COSE alg -8, EdDSA).
    pub fn generate_ed25519() -> Self {
        let signing = SigningKey::generate(&mut OsRng);
        let public_key = signing.verifying_key().as_bytes().to_vec();
        NodeIdentity::from_signing(
            SigningMaterial::Ed25519(signing),
            public_key,
            IdentityKey::ALG_ED25519,
        )
    }

    /// Generate a fresh ES256 identity (COSE alg -7, P-256 + SHA-256).
    pub fn generate_es256() -> Self {
        let signing = P256SigningKey::from(&p256::SecretKey::random(&mut OsRng));
        let public_key = signing
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        NodeIdentity::from_signing(
            SigningMaterial::Es256(signing),
            public_key,
            IdentityKey::ALG_ES256,
        )
    }

    fn from_signing(signing: SigningMaterial, public_key: Vec<u8>, alg: i64) -> Self {
        let device_id = derive_device_id_from_public_key(&public_key);
        NodeIdentity {
            device_id,
            identity_key: IdentityKey { alg, public_key },
            signing,
        }
    }

    /// Mint a COSE_Sign1 over `payload` (already-encoded claims bytes) with
    /// this node's key: canonical protected `{alg}` header, empty
    /// unprotected header, and a signature over the RFC 9052
    /// Sig_structure. The same construction every verifier checks.
    pub async fn mint_cose_sign1(&self, payload: &[u8]) -> Result<CoseSign1, CoreError> {
        let protected = {
            let headers = wire_mesh_wire::tokens::CoseTokenHeaders {
                alg: Some(self.identity_key.alg),
                kid: Some(self.device_id.as_bytes().to_vec()),
                extra: wire_mesh_wire::value::CanonicalMap::new(),
            };
            wire_mesh_wire::to_vec(&headers)
        };
        let signature = self.sign(&sig_structure(&protected, payload)).await?;
        Ok(CoseSign1 {
            protected,
            unprotected: wire_mesh_wire::tokens::CoseTokenHeaders::new(),
            payload: Some(payload.to_vec()),
            signature,
        })
    }
}

fn derive_device_id_from_public_key(public_key: &[u8]) -> DeviceId {
    let digest = Sha256::digest(public_key);
    DeviceId(digest.into())
}

#[async_trait::async_trait]
impl Identity for NodeIdentity {
    fn device_id(&self) -> &DeviceId {
        &self.device_id
    }

    fn identity_key(&self) -> &IdentityKey {
        &self.identity_key
    }

    async fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
        match &self.signing {
            SigningMaterial::Ed25519(key) => Ok(key.sign(message).to_bytes().to_vec()),
            SigningMaterial::Es256(key) => {
                let signature: P256Signature = key
                    .try_sign_digest(Sha256::new_with_prefix(message))
                    .map_err(|e| CoreError::Crypto(format!("ES256 signing failed: {e}")))?;
                Ok(signature.to_bytes().to_vec())
            }
        }
    }

    async fn verify(
        &self,
        key: &IdentityKey,
        message: &[u8],
        signature: &[u8],
    ) -> Result<bool, CoreError> {
        match key.alg {
            IdentityKey::ALG_ED25519 => {
                if key.public_key.len() != 32 {
                    return Err(CoreError::Crypto(format!(
                        "Ed25519 public key must be 32 bytes, got {}",
                        key.public_key.len()
                    )));
                }
                let mut public_key = [0u8; 32];
                public_key.copy_from_slice(&key.public_key);
                let verifying: VerifyingKey = VerifyingKey::from_bytes(&public_key)
                    .map_err(|e| CoreError::Crypto(format!("invalid Ed25519 public key: {e}")))?;
                let sig: Ed25519Signature = Ed25519Signature::from_slice(signature)
                    .map_err(|e| CoreError::Crypto(format!("Ed25519 signature: {e}")))?;
                Ok(verifying.verify(message, &sig).is_ok())
            }
            IdentityKey::ALG_ES256 => {
                let public_key = PublicKey::from_sec1_bytes(&key.public_key)
                    .map_err(|e| CoreError::Crypto(format!("invalid ES256 public key: {e}")))?;
                let verifying = P256VerifyingKey::from(&public_key);
                let sig = P256Signature::from_slice(signature)
                    .map_err(|e| CoreError::Crypto(format!("ES256 signature: {e}")))?;
                Ok(verifying
                    .verify_digest(Sha256::new_with_prefix(message), &sig)
                    .is_ok())
            }
            other => Err(CoreError::Crypto(format!(
                "unsupported COSE algorithm {other}"
            ))),
        }
    }

    fn derive_device_id(&self, public_key: &[u8]) -> DeviceId {
        derive_device_id_from_public_key(public_key)
    }
}
