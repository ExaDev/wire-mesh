//! The node-identity adapter: local key material for Ed25519 (COSE alg
//! -8) and ES256 P-256 (COSE alg -7), signing and verification against
//! arbitrary issuer keys, and the raw-public-key device-id derivation.
//!
//! `public_key` bytes follow each algorithm's own canonical encoding:
//! 32 raw bytes for Ed25519, 65-byte uncompressed SEC1 (`0x04 || X || Y`)
//! for ES256 — the same encodings COSE keys use.

use ed25519_dalek::{Signature as Ed25519Signature, Signer, SigningKey};
use p256::ecdsa::signature::{DigestSigner, DigestVerifier};
use p256::ecdsa::{
    Signature as P256Signature, SigningKey as P256SigningKey, VerifyingKey as P256VerifyingKey,
};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use wire_mesh_wire::identity::{DeviceId, IdentityKey};
use wire_mesh_wire::tokens::CoseSign1;
use zeroize::{Zeroize, Zeroizing};

use crate::domain::identity_key::{ed25519_public_key, es256_public_key};
use crate::ports::{CoreError, Identity};

/// A fresh P-256 secret scalar from the operating system's randomness, by rejection sampling. The curve crate's own generator takes a `rand_core` 0.10 generator, and `rand` 0.8's `OsRng` is a 0.6 one.
fn random_p256_secret() -> p256::SecretKey {
    let mut bytes = [0u8; 32];
    loop {
        OsRng.fill_bytes(&mut bytes);
        let key = p256::SecretKey::from_slice(&bytes);
        bytes.zeroize();
        if let Ok(key) = key {
            return key;
        }
    }
}

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
        let signing = P256SigningKey::from(&random_p256_secret());
        let public_key = signing
            .verifying_key()
            .to_sec1_point(false)
            .as_bytes()
            .to_vec();
        NodeIdentity::from_signing(
            SigningMaterial::Es256(signing),
            public_key,
            IdentityKey::ALG_ES256,
        )
    }

    /// Restores the Ed25519 identity whose secret is `secret` (the bytes [`NodeIdentity::export_secret`] gave), so a node that restarts keeps its key and with it its device id. Exactly 32 bytes; any other length is an error.
    pub fn from_ed25519_secret(secret: &[u8]) -> Result<Self, CoreError> {
        let bytes: [u8; 32] = secret.try_into().map_err(|_| {
            CoreError::Crypto(format!(
                "an Ed25519 secret is 32 bytes, not {}",
                secret.len()
            ))
        })?;
        let bytes = Zeroizing::new(bytes);
        let signing = SigningKey::from_bytes(&bytes);
        let public_key = signing.verifying_key().as_bytes().to_vec();
        Ok(NodeIdentity::from_signing(
            SigningMaterial::Ed25519(signing),
            public_key,
            IdentityKey::ALG_ED25519,
        ))
    }

    /// Restores the ES256 (P-256) identity whose secret scalar is `secret` (the bytes [`NodeIdentity::export_secret`] gave). Exactly 32 bytes that are a valid P-256 scalar (nonzero and below the group order); anything else is an error.
    pub fn from_es256_secret(secret: &[u8]) -> Result<Self, CoreError> {
        // p256 accepts a short slice and pads it, so the length is checked here: a stored secret that lost bytes must not restore as another key.
        if secret.len() != 32 {
            return Err(CoreError::Crypto(format!(
                "a P-256 secret is 32 bytes, not {}",
                secret.len()
            )));
        }
        let key = p256::SecretKey::from_slice(secret)
            .map_err(|e| CoreError::Crypto(format!("not a valid P-256 secret: {e}")))?;
        let signing = P256SigningKey::from(&key);
        let public_key = signing
            .verifying_key()
            .to_sec1_point(false)
            .as_bytes()
            .to_vec();
        Ok(NodeIdentity::from_signing(
            SigningMaterial::Es256(signing),
            public_key,
            IdentityKey::ALG_ES256,
        ))
    }

    /// The 32-byte secret behind this identity, which [`NodeIdentity::from_ed25519_secret`] or [`NodeIdentity::from_es256_secret`] (by `identity_key().alg`) takes back. The buffer is zeroed when dropped. This type has no `Debug`, so the secret cannot reach a log through one; where the bytes are kept is the caller's to decide.
    pub fn export_secret(&self) -> Zeroizing<[u8; 32]> {
        match &self.signing {
            SigningMaterial::Ed25519(key) => Zeroizing::new(key.to_bytes()),
            SigningMaterial::Es256(key) => {
                let mut bytes = Zeroizing::new([0u8; 32]);
                bytes.copy_from_slice(&key.to_bytes()[..]);
                bytes
            }
        }
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
        crate::domain::cose::sign_cose_sign1(self, payload).await
    }
}

/// The `device-id = SHA-256(identity-key.public-key)` derivation rule,
/// exported standalone (not merely reachable through a `NodeIdentity`
/// instance) precisely because it is a pure property of a given key, not
/// of the local node holding one -- the same reason the TS adapter
/// (`node-identity.ts`) already exports its own `deriveDeviceId` this way.
/// A caller checking a token's self-certifying `issuer-key` against its
/// claimed `issuer` needs this for an ARBITRARY key, not just the local
/// identity's own.
pub fn derive_device_id_from_public_key(public_key: &[u8]) -> DeviceId {
    let digest = Sha256::digest(public_key);
    DeviceId(digest.into())
}

/// Verifies `signature` over `message` against an arbitrary `identity-key`
/// -- exported standalone for the identical reason
/// [`derive_device_id_from_public_key`] is: verification is a pure function
/// of the given key, never of the local node's own private material, so a
/// caller verifying a token's embedded issuer-key (or, once `core/threshold`
/// lands, a group's aggregate FROST signature -- an ordinary Ed25519
/// signature indistinguishable from this same ALG_ED25519 path) has no need
/// to construct a whole `NodeIdentity` just to call it.
pub fn verify_with_identity_key(
    key: &IdentityKey,
    message: &[u8],
    signature: &[u8],
) -> Result<bool, CoreError> {
    match key.alg {
        IdentityKey::ALG_ED25519 => {
            let verifying = ed25519_public_key(&key.public_key)?;
            let sig: Ed25519Signature = Ed25519Signature::from_slice(signature)
                .map_err(|e| CoreError::Crypto(format!("Ed25519 signature: {e}")))?;
            // Strict verification: a signature whose R is of small order, or whose S is not reduced, does not verify.
            Ok(verifying.verify_strict(message, &sig).is_ok())
        }
        IdentityKey::ALG_ES256 => {
            let public_key = es256_public_key(&key.public_key)
                .map_err(|e| CoreError::Crypto(format!("invalid ES256 public key: {e}")))?;
            let verifying = P256VerifyingKey::from(&public_key);
            let sig = P256Signature::from_slice(signature)
                .map_err(|e| CoreError::Crypto(format!("ES256 signature: {e}")))?;
            Ok(verifying
                .verify_digest(
                    |digest: &mut Sha256| {
                        digest.update(message);
                        Ok(())
                    },
                    &sig,
                )
                .is_ok())
        }
        other => Err(CoreError::Crypto(format!(
            "unsupported COSE algorithm {other}"
        ))),
    }
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
                    .try_sign_digest(|digest: &mut Sha256| {
                        digest.update(message);
                        Ok(())
                    })
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
        verify_with_identity_key(key, message, signature)
    }

    fn derive_device_id(&self, public_key: &[u8]) -> DeviceId {
        derive_device_id_from_public_key(public_key)
    }

    fn derive_shared_secret(&self, peer_key: &IdentityKey) -> Result<Vec<u8>, CoreError> {
        if self.identity_key.alg != IdentityKey::ALG_ES256 {
            return Err(CoreError::Crypto(
                "ECDH requires an ES256 (P-256) local identity-key".to_owned(),
            ));
        }
        if peer_key.alg != IdentityKey::ALG_ES256 {
            return Err(CoreError::Crypto(
                "ECDH requires an ES256 (P-256) peer identity-key".to_owned(),
            ));
        }
        // Unlike Web Crypto (which permanently binds a CryptoKey to the one
        // algorithm it was imported for, forcing the TS side's caller-supplied
        // dual-import dance), p256's SecretKey works for both ECDSA signing and
        // ECDH directly -- the same scalar, no second import needed.
        let SigningMaterial::Es256(signing) = &self.signing else {
            return Err(CoreError::Crypto(
                "ECDH requires an ES256 (P-256) local identity-key".to_owned(),
            ));
        };
        let peer_public = es256_public_key(&peer_key.public_key).map_err(|e| {
            CoreError::Crypto(format!("peer identity-key is not a valid P-256 point: {e}"))
        })?;
        let shared =
            p256::ecdh::diffie_hellman(signing.as_nonzero_scalar(), peer_public.as_affine());
        Ok(shared.raw_secret_bytes().to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn es256_identities_derive_the_same_ecdh_shared_secret_both_directions() {
        let a = NodeIdentity::generate_es256();
        let b = NodeIdentity::generate_es256();

        let from_a = a.derive_shared_secret(b.identity_key()).expect("ECDH");
        let from_b = b.derive_shared_secret(a.identity_key()).expect("ECDH");

        assert_eq!(from_a, from_b);
    }

    #[tokio::test]
    async fn a_different_peer_derives_a_different_shared_secret() {
        let a = NodeIdentity::generate_es256();
        let b = NodeIdentity::generate_es256();
        let c = NodeIdentity::generate_es256();

        let with_b = a.derive_shared_secret(b.identity_key()).expect("ECDH");
        let with_c = a.derive_shared_secret(c.identity_key()).expect("ECDH");

        assert_ne!(with_b, with_c);
    }

    #[tokio::test]
    async fn a_small_order_ed25519_key_is_refused_even_with_a_signature_that_verifies_under_it() {
        let verifier = NodeIdentity::generate_ed25519();
        // R = the identity element and S = 0 verifies under the identity element for any message.
        let mut signature = vec![0u8; 64];
        signature[0] = 1;
        let mut identity_element = vec![0u8; 32];
        identity_element[0] = 1;
        let key = IdentityKey {
            alg: IdentityKey::ALG_ED25519,
            public_key: identity_element,
        };
        assert!(verifier.verify(&key, b"message", &signature).await.is_err());
    }

    #[tokio::test]
    async fn an_ed25519_signature_with_a_small_order_r_does_not_verify() {
        let verifier = NodeIdentity::generate_ed25519();
        let signer = NodeIdentity::generate_ed25519();
        let mut signature = signer.sign(b"message").await.unwrap();
        assert!(verifier
            .verify(signer.identity_key(), b"message", &signature)
            .await
            .unwrap());
        // Replace R with the identity element: the equation no longer holds, and a strict verifier refuses it before checking.
        signature[..32].fill(0);
        signature[0] = 1;
        assert!(!verifier
            .verify(signer.identity_key(), b"message", &signature)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn an_es256_key_in_another_encoding_of_the_same_point_is_refused() {
        use p256::elliptic_curve::sec1::ToSec1Point;
        let a = NodeIdentity::generate_es256();
        let b = NodeIdentity::generate_es256();
        let signature = b.sign(b"message").await.unwrap();
        let uncompressed = b.identity_key().public_key.clone();
        let compressed = p256::PublicKey::from_sec1_bytes(&uncompressed)
            .unwrap()
            .to_sec1_point(true)
            .as_bytes()
            .to_vec();
        let mut compact = vec![0x05];
        compact.extend_from_slice(&uncompressed[1..33]);
        assert!(a
            .verify(b.identity_key(), b"message", &signature)
            .await
            .unwrap());
        for encoding in [compressed, compact] {
            let key = IdentityKey {
                alg: IdentityKey::ALG_ES256,
                public_key: encoding,
            };
            assert!(a.verify(&key, b"message", &signature).await.is_err());
            assert!(a.derive_shared_secret(&key).is_err());
        }
    }

    #[tokio::test]
    async fn deriving_against_a_non_es256_peer_key_fails_closed() {
        let a = NodeIdentity::generate_es256();
        let ed25519 = NodeIdentity::generate_ed25519();

        assert!(a.derive_shared_secret(ed25519.identity_key()).is_err());
    }

    #[tokio::test]
    async fn an_ed25519_identity_cannot_derive_at_all() {
        let ed25519 = NodeIdentity::generate_ed25519();
        let es256 = NodeIdentity::generate_es256();
        assert!(ed25519.derive_shared_secret(es256.identity_key()).is_err());
    }
    #[tokio::test]
    async fn an_ed25519_identity_restored_from_its_secret_is_the_same_identity() {
        let original = NodeIdentity::generate_ed25519();
        let restored =
            NodeIdentity::from_ed25519_secret(original.export_secret().as_slice()).unwrap();
        assert_eq!(restored.device_id(), original.device_id());
        assert_eq!(restored.identity_key(), original.identity_key());
        // What one signs the other verifies, and the reverse.
        let signature = original.sign(b"message").await.unwrap();
        assert!(restored
            .verify(original.identity_key(), b"message", &signature)
            .await
            .unwrap());
        let signature = restored.sign(b"message").await.unwrap();
        assert!(original
            .verify(restored.identity_key(), b"message", &signature)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn an_es256_identity_restored_from_its_secret_is_the_same_identity() {
        let original = NodeIdentity::generate_es256();
        let restored =
            NodeIdentity::from_es256_secret(original.export_secret().as_slice()).unwrap();
        assert_eq!(restored.device_id(), original.device_id());
        assert_eq!(restored.identity_key(), original.identity_key());
        let signature = original.sign(b"message").await.unwrap();
        assert!(restored
            .verify(original.identity_key(), b"message", &signature)
            .await
            .unwrap());
    }

    #[test]
    fn a_secret_of_the_wrong_length_is_an_error() {
        assert!(NodeIdentity::from_ed25519_secret(&[1u8; 31]).is_err());
        assert!(NodeIdentity::from_ed25519_secret(&[1u8; 33]).is_err());
        assert!(NodeIdentity::from_es256_secret(&[1u8; 31]).is_err());
    }

    #[test]
    fn a_p256_secret_that_is_not_a_valid_scalar_is_an_error() {
        // Zero is no scalar, and neither is a value at or above the group order.
        assert!(NodeIdentity::from_es256_secret(&[0u8; 32]).is_err());
        assert!(NodeIdentity::from_es256_secret(&[0xffu8; 32]).is_err());
    }

    #[test]
    fn two_secrets_make_two_identities() {
        let a = NodeIdentity::from_ed25519_secret(&[1u8; 32]).unwrap();
        let b = NodeIdentity::from_ed25519_secret(&[2u8; 32]).unwrap();
        assert_ne!(a.device_id(), b.device_id());
    }
}
