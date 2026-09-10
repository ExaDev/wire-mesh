//! The identity/crypto port. One trait covers the local node's own key
//! (signing), verification against arbitrary issuer keys, and the
//! device-id derivation — so domain logic never imports a crypto library
//! directly.

use wire_mesh_wire::identity::{DeviceId, IdentityKey};

use crate::ports::CoreError;

#[async_trait::async_trait]
pub trait Identity: Send + Sync {
    /// This node's device-id.
    fn device_id(&self) -> &DeviceId;

    /// This node's public identity key.
    fn identity_key(&self) -> &IdentityKey;

    /// Sign `message` (an assembled COSE Sig_structure) with the local
    /// private key.
    async fn sign(&self, message: &[u8]) -> Result<Vec<u8>, CoreError>;

    /// Verify `signature` over `message` against an arbitrary issuer key —
    /// not just the local one, so delegated-token chains verify without
    /// prior contact with any issuer.
    async fn verify(
        &self,
        key: &IdentityKey,
        message: &[u8],
        signature: &[u8],
    ) -> Result<bool, CoreError>;

    /// The device-id derivation rule: SHA-256 of the *raw public-key
    /// bytes*, never of certificate DER (which embeds a serial number and
    /// validity window that change on every reissue).
    fn derive_device_id(&self, public_key: &[u8]) -> DeviceId;
}
