//! Verification for `peer-advert` (`spec/transport.cddl`), the one gossiped
//! structure that legitimately travels beyond the connection it was sent on:
//! a hub re-broadcasts what it receives, and a gateway forwards the adverts
//! of the local peers it fronts. Binding an advert to its arriving connection
//! therefore cannot authenticate it (wire-mesh#225) -- the signature is what
//! ties an advert to the device it names, and the `identity-key` travelling
//! inside the signed content is what makes it self-certifying, so a receiver
//! with no prior contact with that device and no directory to consult can
//! still check one.
//!
//! The mirror of `ts/packages/core/src/domain/peer-advert.ts`. The signing
//! input itself lives in `wire_mesh_wire::transport`, next to the encoder
//! whose canonical bytes it depends on, so the two languages agree on what is
//! signed rather than each deriving it separately.

use wire_mesh_wire::transport::{peer_advert_signing_input, PeerAdvert};

use crate::ports::Identity;

/// Why a gossiped advert was refused. A verdict rather than an error because
/// one bad entry in a gossip frame says nothing about the others: a caller
/// drops the entry it names and carries on with the rest of the frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerAdvertRejection {
    /// `sha256(identity-key.public-key)` is not the `device` the advert
    /// claims, so the advert describes a device whose key it does not hold.
    WrongDevice,
    /// The signature does not verify under the advert's own embedded key, or
    /// that key could not be used at all. `alg` and `public-key` are both
    /// attacker-chosen (`identity-key` constrains them to an int and a bstr,
    /// nothing more), so a key an implementation cannot import is refused
    /// exactly as a wrong signature is rather than surfacing as an error.
    BadSignature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerAdvertVerdict {
    Valid,
    Invalid(PeerAdvertRejection),
}

/// Both validity checks `spec/transport.cddl` states for a gossiped advert,
/// in the order a verifier must apply them: the embedded identity-key
/// self-certifies against the advert's own `device`, and the signature
/// verifies under that same key over [`peer_advert_signing_input`]'s bytes.
pub async fn verify_peer_advert(identity: &dyn Identity, advert: &PeerAdvert) -> PeerAdvertVerdict {
    if identity.derive_device_id(&advert.identity_key.public_key) != advert.device {
        return PeerAdvertVerdict::Invalid(PeerAdvertRejection::WrongDevice);
    }
    let message = peer_advert_signing_input(advert);
    match identity
        .verify(&advert.identity_key, &message, &advert.signature)
        .await
    {
        Ok(true) => PeerAdvertVerdict::Valid,
        Ok(false) | Err(_) => PeerAdvertVerdict::Invalid(PeerAdvertRejection::BadSignature),
    }
}

/// Signs an advert's content in place, filling in the `signature` entry the
/// signing input itself excludes. The caller has already set `device` and
/// `identity_key`, since a node only ever signs an advert naming itself.
pub async fn sign_peer_advert(
    identity: &dyn Identity,
    advert: &mut PeerAdvert,
) -> Result<(), crate::ports::CoreError> {
    advert.signature = identity.sign(&peer_advert_signing_input(advert)).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::node_identity::NodeIdentity;
    use wire_mesh_wire::identity::{DeviceId, IdentityKey};
    use wire_mesh_wire::value::{CanonicalMap, CborValue};

    /// A signature length no algorithm here produces, so the bytes cannot
    /// accidentally verify against anything.
    const FILLER_SIGNATURE: [u8; 64] = [0xaa; 64];

    fn unsigned_advert(identity: &NodeIdentity) -> PeerAdvert {
        let mut extra = CanonicalMap::new();
        extra
            .insert(
                "presence/status".to_owned(),
                CborValue::Text("idle".to_owned()),
            )
            .expect("insert");
        PeerAdvert {
            device: *identity.device_id(),
            addresses: vec!["203.0.113.5:4433".to_owned()],
            snapshot_seconds: 1861833600,
            identity_key: identity.identity_key().clone(),
            signature: FILLER_SIGNATURE.to_vec(),
            extra,
        }
    }

    async fn signed_advert(identity: &NodeIdentity) -> PeerAdvert {
        let mut advert = unsigned_advert(identity);
        sign_peer_advert(identity, &mut advert)
            .await
            .expect("sign advert");
        advert
    }

    #[tokio::test]
    async fn accepts_an_advert_signed_by_the_device_it_names() {
        let identity = NodeIdentity::generate_ed25519();
        let advert = signed_advert(&identity).await;
        assert_eq!(
            verify_peer_advert(&identity, &advert).await,
            PeerAdvertVerdict::Valid
        );
    }

    #[tokio::test]
    async fn accepts_an_advert_checked_by_an_unrelated_node() {
        // An advert is self-certifying, so a node with no prior contact with the advertised device checks it with its own identity port and nothing else.
        let advertiser = NodeIdentity::generate_ed25519();
        let verifier = NodeIdentity::generate_ed25519();
        let advert = signed_advert(&advertiser).await;
        assert_eq!(
            verify_peer_advert(&verifier, &advert).await,
            PeerAdvertVerdict::Valid
        );
    }

    #[tokio::test]
    async fn rejects_an_altered_typed_field() {
        let identity = NodeIdentity::generate_ed25519();
        let mut advert = signed_advert(&identity).await;
        advert.addresses = vec!["198.51.100.2:4433".to_owned()];
        assert_eq!(
            verify_peer_advert(&identity, &advert).await,
            PeerAdvertVerdict::Invalid(PeerAdvertRejection::BadSignature)
        );
    }

    #[tokio::test]
    async fn rejects_an_altered_extension_key() {
        let identity = NodeIdentity::generate_ed25519();
        let mut advert = signed_advert(&identity).await;
        advert.extra = {
            let mut extra = CanonicalMap::new();
            extra
                .insert(
                    "presence/status".to_owned(),
                    CborValue::Text("active".to_owned()),
                )
                .expect("insert");
            extra
        };
        assert_eq!(
            verify_peer_advert(&identity, &advert).await,
            PeerAdvertVerdict::Invalid(PeerAdvertRejection::BadSignature)
        );
    }

    #[tokio::test]
    async fn rejects_a_key_that_does_not_hash_to_the_named_device() {
        let identity = NodeIdentity::generate_ed25519();
        let mut advert = signed_advert(&identity).await;
        advert.device = DeviceId([0x11; 32]);
        assert_eq!(
            verify_peer_advert(&identity, &advert).await,
            PeerAdvertVerdict::Invalid(PeerAdvertRejection::WrongDevice)
        );
    }

    #[tokio::test]
    async fn rejects_an_advert_naming_a_device_it_holds_no_key_for() {
        // Self-certification passes here, since the key really does hash to the named device, so only the signature check refuses it: the advertiser cannot produce one without the victim's private key.
        let advertiser = NodeIdentity::generate_ed25519();
        let victim = NodeIdentity::generate_ed25519();
        let mut advert = signed_advert(&advertiser).await;
        advert.device = *victim.device_id();
        advert.identity_key = victim.identity_key().clone();
        assert_eq!(
            verify_peer_advert(&advertiser, &advert).await,
            PeerAdvertVerdict::Invalid(PeerAdvertRejection::BadSignature)
        );
    }

    #[tokio::test]
    async fn rejects_a_corrupted_signature() {
        let identity = NodeIdentity::generate_ed25519();
        let mut advert = signed_advert(&identity).await;
        advert.signature[0] ^= 0xff;
        assert_eq!(
            verify_peer_advert(&identity, &advert).await,
            PeerAdvertVerdict::Invalid(PeerAdvertRejection::BadSignature)
        );
    }

    #[tokio::test]
    async fn rejects_an_unusable_identity_key_without_erroring() {
        let identity = NodeIdentity::generate_ed25519();
        let mut advert = signed_advert(&identity).await;
        // An alg no implementation here supports, kept self-certifying so the refusal has to come from the key being unusable rather than from a device-id mismatch.
        let unsupported_alg = 9999;
        advert.identity_key = IdentityKey {
            alg: unsupported_alg,
            public_key: advert.identity_key.public_key.clone(),
        };
        assert_eq!(
            verify_peer_advert(&identity, &advert).await,
            PeerAdvertVerdict::Invalid(PeerAdvertRejection::BadSignature)
        );
    }
}
