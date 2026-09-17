//! `threshold-share-claims`/`threshold-share-envelope` -- a round-2
//! signature share, wrapped in its own additional `cose-sign1` signed under
//! the releasing participant's own PERSONAL device key, never the group's.
//! This is what makes misbehaviour publicly provable rather than merely
//! locally identifiable to the coordinator: anyone holding this envelope,
//! not just the coordinator that requested the share, can attribute a
//! specific released share to a specific, identifiable device.
//!
//! Self-certifying, the same pattern `token-claims`/`revocation-claims`/
//! `handle-claims` already use: `issuer-key` travels inside the signed
//! payload, and a verifier checks `sha256(issuer-key.public-key) ==
//! issuer` before trusting anything else -- no prior contact with the
//! issuer is needed to verify the envelope, only the envelope itself.

use minicbor::{Decode, Decoder, Encode, Encoder};
use wire_mesh_core::domain::cose::sig_structure;
use wire_mesh_core::ports::identity::Identity;
use wire_mesh_core::ports::CoreError;
use wire_mesh_wire::error::DecodeError;
use wire_mesh_wire::identity::{DeviceId, IdentityKey};
use wire_mesh_wire::strict;
use wire_mesh_wire::tokens::{CoseSign1, CoseTokenHeaders};

/// `threshold-share-claims = { "session-id": session-id, group: device-id,
/// share: bstr, issuer: device-id, "issuer-key": identity-key }`.
/// CDE key order (encoded-length first, then bytewise): `group` (5),
/// `share` (5), `issuer` (6), `issuer-key` (10), `session-id` (10).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdShareClaims {
    pub session_id: u64,
    /// The group this share belongs to (the group's own device-id).
    pub group: DeviceId,
    /// The raw FROST `round2::SignatureShare` bytes -- opaque at this
    /// layer, matching how `parent`/`conditions` elsewhere in this spec
    /// nest an opaque signed structure rather than redefining its shape.
    pub share: Vec<u8>,
    /// The releasing participant's own PERSONAL device-id, never the group's.
    pub issuer: DeviceId,
    pub issuer_key: IdentityKey,
}

impl Encode<()> for ThresholdShareClaims {
    fn encode<W: minicbor::encode::Write>(
        &self,
        e: &mut Encoder<W>,
        ctx: &mut (),
    ) -> Result<(), minicbor::encode::Error<W::Error>> {
        e.map(5)?;
        e.str("group")?;
        self.group.encode(e, ctx)?;
        e.str("share")?.bytes(&self.share)?;
        e.str("issuer")?;
        self.issuer.encode(e, ctx)?;
        e.str("issuer-key")?;
        self.issuer_key.encode(e, ctx)?;
        e.str("session-id")?.u64(self.session_id)?;
        e.ok()
    }
}

impl Decode<'_, ()> for ThresholdShareClaims {
    fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
        claims_from(d).map_err(minicbor::decode::Error::custom)
    }
}

fn claims_from(d: &mut Decoder<'_>) -> Result<ThresholdShareClaims, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut session_id: Option<u64> = None;
    let mut group: Option<DeviceId> = None;
    let mut share: Option<Vec<u8>> = None;
    let mut issuer: Option<DeviceId> = None;
    let mut issuer_key: Option<IdentityKey> = None;

    while let Some(key) = map.next_key(d)? {
        match key {
            "group" => strict::set_once(
                &mut group,
                d.decode::<DeviceId>()
                    .map_err(|e| DecodeError::Malformed(e.to_string()))?,
            )?,
            "share" => strict::set_once(&mut share, strict::bytes_value(d)?)?,
            "issuer" => strict::set_once(
                &mut issuer,
                d.decode::<DeviceId>()
                    .map_err(|e| DecodeError::Malformed(e.to_string()))?,
            )?,
            "issuer-key" => strict::set_once(
                &mut issuer_key,
                d.decode::<IdentityKey>()
                    .map_err(|e| DecodeError::Malformed(e.to_string()))?,
            )?,
            "session-id" => strict::set_once(&mut session_id, strict::uint_value(d)?)?,
            other => return Err(DecodeError::UnknownKey(other.to_owned())),
        }
    }

    Ok(ThresholdShareClaims {
        session_id: session_id.ok_or(DecodeError::MissingField("session-id"))?,
        group: group.ok_or(DecodeError::MissingField("group"))?,
        share: share.ok_or(DecodeError::MissingField("share"))?,
        issuer: issuer.ok_or(DecodeError::MissingField("issuer"))?,
        issuer_key: issuer_key.ok_or(DecodeError::MissingField("issuer-key"))?,
    })
}

/// An error building or verifying a share envelope.
#[derive(Debug)]
pub enum ShareEnvelopeError {
    Core(CoreError),
    Decode(DecodeError),
    Encode(String),
    /// The envelope's own self-certification failed: `sha256(issuer-key.public-key) != issuer`.
    IssuerMismatch,
    /// The signature did not verify against the embedded `issuer-key`.
    BadSignature,
    /// The envelope's `issuer` does not match the identity the caller expected it from.
    UnexpectedIssuer,
}

impl core::fmt::Display for ShareEnvelopeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ShareEnvelopeError::Core(e) => write!(f, "{e}"),
            ShareEnvelopeError::Decode(e) => write!(f, "{e}"),
            ShareEnvelopeError::Encode(e) => write!(f, "encode error: {e}"),
            ShareEnvelopeError::IssuerMismatch => {
                write!(f, "share envelope self-certification failed: sha256(issuer-key.public-key) != issuer")
            }
            ShareEnvelopeError::BadSignature => {
                write!(f, "share envelope signature did not verify")
            }
            ShareEnvelopeError::UnexpectedIssuer => write!(
                f,
                "share envelope issuer does not match the expected participant"
            ),
        }
    }
}

impl std::error::Error for ShareEnvelopeError {}

impl From<CoreError> for ShareEnvelopeError {
    fn from(e: CoreError) -> Self {
        ShareEnvelopeError::Core(e)
    }
}

impl From<DecodeError> for ShareEnvelopeError {
    fn from(e: DecodeError) -> Self {
        ShareEnvelopeError::Decode(e)
    }
}

fn encode_claims(claims: &ThresholdShareClaims) -> Result<Vec<u8>, ShareEnvelopeError> {
    let mut e = Encoder::new(Vec::new());
    claims
        .encode(&mut e, &mut ())
        .map_err(|err| ShareEnvelopeError::Encode(err.to_string()))?;
    Ok(e.into_writer())
}

/// Mints a `threshold-share-envelope`: signs `claims` under `personal_identity`'s
/// own key (never the group's) via the same RFC 9052 Sig_structure every
/// other self-certifying structure in this codebase uses.
pub async fn mint_share_envelope(
    personal_identity: &dyn Identity,
    session_id: u64,
    group: DeviceId,
    share: Vec<u8>,
) -> Result<CoseSign1, ShareEnvelopeError> {
    let claims = ThresholdShareClaims {
        session_id,
        group,
        share,
        issuer: *personal_identity.device_id(),
        issuer_key: personal_identity.identity_key().clone(),
    };
    let payload = encode_claims(&claims)?;

    let protected = {
        let headers = CoseTokenHeaders {
            alg: Some(personal_identity.identity_key().alg),
            kid: Some(personal_identity.device_id().as_bytes().to_vec()),
            extra: Default::default(),
        };
        let mut e = Encoder::new(Vec::new());
        headers
            .encode(&mut e, &mut ())
            .map_err(|err| ShareEnvelopeError::Encode(err.to_string()))?;
        e.into_writer()
    };

    let signature = personal_identity
        .sign(&sig_structure(&protected, &payload))
        .await?;

    Ok(CoseSign1 {
        protected,
        unprotected: CoseTokenHeaders::new(),
        payload: Some(payload),
        signature,
    })
}

/// Verifies a `threshold-share-envelope` and returns its claims: checks
/// self-certification (`sha256(issuer-key.public-key) == issuer`), then the
/// signature against the embedded `issuer-key` -- the same two-step
/// obligation every other self-certifying structure in this spec carries.
/// A caller that additionally requires the envelope to have come from one
/// SPECIFIC expected participant (rather than merely a validly self-
/// certifying one) checks the returned claims' `issuer` itself; this
/// function's own job is only the envelope's internal consistency.
pub async fn verify_share_envelope(
    identity: &dyn Identity,
    envelope: &CoseSign1,
) -> Result<ThresholdShareClaims, ShareEnvelopeError> {
    let payload = envelope
        .payload
        .as_ref()
        .ok_or(DecodeError::MissingField("payload"))?;
    let mut d = Decoder::new(payload);
    let claims: ThresholdShareClaims = d
        .decode()
        .map_err(|e| ShareEnvelopeError::Decode(DecodeError::Malformed(e.to_string())))?;

    let derived_issuer = identity.derive_device_id(&claims.issuer_key.public_key);
    if derived_issuer != claims.issuer {
        return Err(ShareEnvelopeError::IssuerMismatch);
    }

    let to_be_signed = sig_structure(&envelope.protected, payload);
    let ok = identity
        .verify(&claims.issuer_key, &to_be_signed, &envelope.signature)
        .await?;
    if !ok {
        return Err(ShareEnvelopeError::BadSignature);
    }

    Ok(claims)
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire_mesh_core::adapters::node_identity::NodeIdentity;

    #[tokio::test]
    async fn mint_then_verify_round_trips_and_the_claims_match() {
        let personal = NodeIdentity::generate_ed25519();
        let group = DeviceId::from_bytes([9; 32]);
        let share_bytes = vec![1, 2, 3, 4];

        let envelope = mint_share_envelope(&personal, 42, group, share_bytes.clone())
            .await
            .expect("mint");

        let claims = verify_share_envelope(&personal, &envelope)
            .await
            .expect("verify");
        assert_eq!(claims.session_id, 42);
        assert_eq!(claims.group, group);
        assert_eq!(claims.share, share_bytes);
        assert_eq!(claims.issuer, *personal.device_id());
    }

    #[tokio::test]
    async fn a_tampered_share_fails_verification() {
        let personal = NodeIdentity::generate_ed25519();
        let group = DeviceId::from_bytes([9; 32]);

        let mut envelope = mint_share_envelope(&personal, 1, group, vec![1, 2, 3])
            .await
            .expect("mint");

        // Tamper with the payload bytes directly (simulating a
        // man-in-the-middle rewriting the released share) without
        // re-signing -- the signature must no longer verify.
        if let Some(payload) = &mut envelope.payload {
            let last = payload.len() - 1;
            payload[last] ^= 0xff;
        }

        let err = verify_share_envelope(&personal, &envelope)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ShareEnvelopeError::BadSignature)
                || matches!(err, ShareEnvelopeError::Decode(_))
        );
    }

    #[tokio::test]
    async fn an_envelope_signed_by_a_different_identity_is_still_self_certifying_and_verifies() {
        // Verification only needs the embedded issuer-key, not the local
        // verifier's own identity -- the same "verify is a property of the
        // given key, not the local node's own" rule every other self-
        // certifying structure in this codebase follows.
        let signer = NodeIdentity::generate_ed25519();
        let verifier = NodeIdentity::generate_ed25519();
        let group = DeviceId::from_bytes([1; 32]);

        let envelope = mint_share_envelope(&signer, 7, group, vec![5, 6, 7])
            .await
            .expect("mint");

        let claims = verify_share_envelope(&verifier, &envelope)
            .await
            .expect("verify");
        assert_eq!(claims.issuer, *signer.device_id());
    }
}
