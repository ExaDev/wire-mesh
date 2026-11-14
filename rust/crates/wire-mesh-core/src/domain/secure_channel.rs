//! The end-to-end channel two devices open between themselves inside a relay pairing (`spec/secure-channel.cddl`), the Rust port of `ts/packages/core/src/domain/secure-channel.ts`. A relay only forwards the bytes of a `relay-data` frame; here the two devices authenticate each other's identity keys over a fresh ECDH exchange, derive one AES-256-GCM key per direction and seal every frame they exchange, so the relay sees ciphertext and a receiver learns the sender from the handshake and from nothing a relay asserts.
//!
//! Pure crypto and framing, with no connection or session in it. The handshake is three steps: [`begin_handshake`] makes this side's hello, [`verify_hello`] checks a received one, and [`establish_channel`] derives the keys once both hellos exist. A [`SecureChannel`] then seals and opens frames. A transport decides when to run each step and carries the hellos and sealed frames as the payload of `relay-data`.
//!
//! The module has no dependency on an operating system, a socket or a runtime, and builds for `wasm32-unknown-unknown` with the rest of this crate.

use aes_gcm::aead::generic_array::typenum::U12;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use ed25519_dalek::VerifyingKey as Ed25519VerifyingKey;
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::elliptic_curve::Generate;
use p256::{NonZeroScalar, PublicKey};
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::Sha256;
use wire_mesh_wire::identity::{DeviceId, IdentityKey};
use wire_mesh_wire::secure_channel::{
    SecureDataFrame, SecureHelloFrame, EPHEMERAL_KEY_SIZE, NONCE_SIZE,
};
use wire_mesh_wire::{decode_frame, encode_frame, DecodeError, Frame, ValidationError};
use zeroize::{ZeroizeOnDrop, Zeroizing};

use crate::ports::{CoreError, Identity};

/// Domain separation for the bytes a hello's signature covers.
pub const HELLO_CONTEXT: &[u8] = b"wire-mesh/secure-hello/v1\0";
/// Domain separation for the HKDF `info` of the direction keys.
pub const CHANNEL_CONTEXT: &[u8] = b"wire-mesh/secure-channel/v1\0";
/// Domain separation for the associated data of a sealed frame.
pub const DATA_CONTEXT: &[u8] = b"wire-mesh/secure-data/v1\0";
/// HKDF label of the key that seals frames sent by the device with the lower device-id.
pub const LABEL_LOW_TO_HIGH: &[u8] = b"lo-to-hi";
/// HKDF label of the key that seals frames sent by the device with the higher device-id.
pub const LABEL_HIGH_TO_LOW: &[u8] = b"hi-to-lo";

const KEY_SIZE: usize = 32;
const COUNTER_SIZE: usize = 8;
const IV_SIZE: usize = 12;
/// SEC1 tag byte of an uncompressed point.
const UNCOMPRESSED_POINT_TAG: u8 = 0x04;

/// The bytes a hello's signature covers: `HELLO_CONTEXT || ephemeral_key || nonce || sender || recipient`. Every part but the context has a fixed length, so the concatenation is unambiguous. `sender` is the device-id derived from the hello's own identity-key and `recipient` is the hello's `to-device`.
pub fn hello_signing_input(
    ephemeral_key: &[u8; EPHEMERAL_KEY_SIZE],
    nonce: &[u8; NONCE_SIZE],
    sender: &DeviceId,
    recipient: &DeviceId,
) -> Vec<u8> {
    let mut input = Vec::with_capacity(HELLO_CONTEXT.len() + EPHEMERAL_KEY_SIZE + NONCE_SIZE + 64);
    input.extend_from_slice(HELLO_CONTEXT);
    input.extend_from_slice(ephemeral_key);
    input.extend_from_slice(nonce);
    input.extend_from_slice(sender.as_bytes());
    input.extend_from_slice(recipient.as_bytes());
    input
}

/// The HKDF `info` for one direction key: `CHANNEL_CONTEXT || low || high || label`, where `low` and `high` are the two device-ids in bytewise order and `label` is [`LABEL_LOW_TO_HIGH`] or [`LABEL_HIGH_TO_LOW`].
pub fn channel_hkdf_info(low: &DeviceId, high: &DeviceId, label: &[u8]) -> Vec<u8> {
    let mut info = Vec::with_capacity(CHANNEL_CONTEXT.len() + 64 + label.len());
    info.extend_from_slice(CHANNEL_CONTEXT);
    info.extend_from_slice(low.as_bytes());
    info.extend_from_slice(high.as_bytes());
    info.extend_from_slice(label);
    info
}

/// The HKDF salt: the nonce of the lower device-id's hello followed by the nonce of the higher one's.
pub fn channel_salt(
    nonce_low: &[u8; NONCE_SIZE],
    nonce_high: &[u8; NONCE_SIZE],
) -> [u8; 2 * NONCE_SIZE] {
    let mut salt = [0u8; 2 * NONCE_SIZE];
    salt[..NONCE_SIZE].copy_from_slice(nonce_low);
    salt[NONCE_SIZE..].copy_from_slice(nonce_high);
    salt
}

/// The 96-bit AES-GCM IV for a counter: four zero bytes, then the counter as a big-endian `u64`.
pub fn data_iv(counter: u64) -> [u8; IV_SIZE] {
    let mut iv = [0u8; IV_SIZE];
    iv[IV_SIZE - COUNTER_SIZE..].copy_from_slice(&counter.to_be_bytes());
    iv
}

/// The associated data of a sealed frame: `DATA_CONTEXT || sender || recipient || counter` with the counter as a big-endian `u64`.
pub fn data_associated_data(sender: &DeviceId, recipient: &DeviceId, counter: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(DATA_CONTEXT.len() + 64 + COUNTER_SIZE);
    aad.extend_from_slice(DATA_CONTEXT);
    aad.extend_from_slice(sender.as_bytes());
    aad.extend_from_slice(recipient.as_bytes());
    aad.extend_from_slice(&counter.to_be_bytes());
    aad
}

/// Whether obligation 5 of the spec lets a frame travel inside a `secure-data-frame`: only a manage-request, manage-response, data-have, data-request or data-entries frame may. A receiver drops every other frame it opens: [`SecureChannel::open`] still returns it, and the caller applies this check to what comes out. The spec states no rule for a sender, so [`SecureChannel::seal`] does not apply it.
pub fn is_sealable(frame: &Frame) -> bool {
    matches!(
        frame,
        Frame::ManageRequest(_)
            | Frame::ManageResponse(_)
            | Frame::DataHave(_)
            | Frame::DataRequest(_)
            | Frame::DataEntries(_)
    )
}

/// The device on the other end of a channel, as its own hello proved it to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecureChannelPeer {
    /// The device-id derived from `identity_key`, never one the peer claimed.
    pub device_id: DeviceId,
    pub identity_key: IdentityKey,
}

/// Why [`verify_hello`] refused a hello, in the order the checks run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelloRefusal {
    /// The hello is addressed to another device. Checked before anything about the identity key.
    WrongRecipient,
    /// The identity key's algorithm is neither EdDSA (-8) nor ES256 (-7).
    UnsupportedIdentityAlgorithm,
    /// The identity key is not a usable key for its algorithm: the wrong size, or not a curve point where that is checked on import. Checked before the signature.
    InvalidIdentityKey,
    /// The signature does not verify, or is not a signature of the algorithm's form.
    BadSignature,
}

impl core::fmt::Display for HelloRefusal {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            HelloRefusal::WrongRecipient => "the hello is addressed to another device",
            HelloRefusal::UnsupportedIdentityAlgorithm => {
                "the hello's identity key uses an unsupported algorithm"
            }
            HelloRefusal::InvalidIdentityKey => "the hello's identity key is not a usable key",
            HelloRefusal::BadSignature => "the hello's signature does not verify",
        })
    }
}

impl std::error::Error for HelloRefusal {}

/// Why [`establish_channel`] could not derive a channel from a verified hello.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EstablishError {
    /// The peer's ephemeral key is not a SEC1 uncompressed P-256 point of 65 bytes on the curve.
    UnusableEphemeralKey,
    /// The peer's nonce is not 16 bytes.
    InvalidNonce,
}

impl core::fmt::Display for EstablishError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            EstablishError::UnusableEphemeralKey => {
                "the peer's ephemeral key is not an uncompressed P-256 point on the curve"
            }
            EstablishError::InvalidNonce => "the peer's nonce is not 16 bytes",
        })
    }
}

impl std::error::Error for EstablishError {}

/// Why [`SecureChannel::seal`] produced no frame. A refusal does not change the channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealError {
    /// The next counter would not fit in a `u64`. The channel sends no more frames, since a counter must never wrap or repeat.
    CounterExhausted,
    /// The encoded frame is longer than AES-GCM can seal under one IV.
    FrameTooLong,
}

impl core::fmt::Display for SealError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SealError::CounterExhausted => f.write_str("the send counter is exhausted"),
            SealError::FrameTooLong => f.write_str("the frame is too long to seal"),
        }
    }
}

impl std::error::Error for SealError {}

/// Why an authenticated plaintext is not one frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaintextFault {
    /// The bytes are not exactly one canonically encoded frame.
    Decode(DecodeError),
    /// The bytes decode, but the frame breaks a rule decoding cannot express.
    Invalid(ValidationError),
}

/// Why [`SecureChannel::open`] returned no frame, in the order the checks run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// The counter is not above every counter already accepted, so the frame is a replay or arrives out of order. Checked before decrypting, so an altered frame at a counter already passed is this. The channel is unchanged.
    Replayed,
    /// The frame does not open under the receive key with its own counter as IV and associated data, which includes a ciphertext shorter than the 16-byte tag. The channel is unchanged.
    Unauthentic,
    /// The frame authenticated but its plaintext is not one frame. This is the only refusal that consumes the counter.
    Undecodable(PlaintextFault),
}

impl core::fmt::Display for OpenError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            OpenError::Replayed => f.write_str("the counter was already passed"),
            OpenError::Unauthentic => f.write_str("the frame does not authenticate"),
            OpenError::Undecodable(PlaintextFault::Decode(error)) => {
                write!(f, "the plaintext is not one frame: {error}")
            }
            OpenError::Undecodable(PlaintextFault::Invalid(error)) => {
                write!(f, "the plaintext is not a valid frame: {error}")
            }
        }
    }
}

impl std::error::Error for OpenError {}

/// One side's half of a handshake, between sending its hello and receiving the peer's. [`establish_channel`] consumes it, so an ephemeral key serves exactly one channel. The ephemeral secret is zeroised when this is dropped, and `Debug` prints neither it nor anything derived from it.
pub struct PendingHandshake {
    peer: DeviceId,
    hello: SecureHelloFrame,
    nonce: [u8; NONCE_SIZE],
    ephemeral: Zeroizing<NonZeroScalar>,
}

impl ZeroizeOnDrop for PendingHandshake {}

impl core::fmt::Debug for PendingHandshake {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("PendingHandshake")
            .field("peer", &self.peer)
            .field("hello", &self.hello)
            .finish_non_exhaustive()
    }
}

impl PendingHandshake {
    /// The device this handshake is addressed to.
    pub fn peer(&self) -> &DeviceId {
        &self.peer
    }

    /// The hello to send to [`peer`](PendingHandshake::peer).
    pub fn hello(&self) -> &SecureHelloFrame {
        &self.hello
    }
}

/// Starts a handshake with `peer`: draws a fresh ephemeral P-256 key and a fresh 16-byte nonce and signs a hello for `peer` with `identity`. Both are drawn from the operating system's generator and are never reused.
///
/// # Errors
///
/// The error `identity.sign` returns.
pub async fn begin_handshake(
    identity: &dyn Identity,
    peer: DeviceId,
) -> Result<PendingHandshake, CoreError> {
    let ephemeral = NonZeroScalar::generate();
    let mut nonce = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce);
    begin_with(identity, peer, Zeroizing::new(ephemeral), nonce).await
}

/// [`begin_handshake`] with the ephemeral secret scalar and the nonce chosen by the caller, so a handshake can be reproduced byte for byte. Reusing either breaks the channel's security; only conformance checks and tests call this, which is why it exists only with the `conformance` feature or under test.
///
/// # Errors
///
/// A [`CoreError::Crypto`] when `ephemeral_secret` is not a P-256 scalar (zero, or not below the group order), or the error `identity.sign` returns.
#[cfg(any(test, feature = "conformance"))]
pub async fn begin_handshake_with(
    identity: &dyn Identity,
    peer: DeviceId,
    ephemeral_secret: &[u8; KEY_SIZE],
    nonce: [u8; NONCE_SIZE],
) -> Result<PendingHandshake, CoreError> {
    let ephemeral = NonZeroScalar::try_from(&ephemeral_secret[..])
        .map_err(|_| CoreError::Crypto("the ephemeral secret is not a P-256 scalar".to_owned()))?;
    begin_with(identity, peer, Zeroizing::new(ephemeral), nonce).await
}

async fn begin_with(
    identity: &dyn Identity,
    peer: DeviceId,
    ephemeral: Zeroizing<NonZeroScalar>,
    nonce: [u8; NONCE_SIZE],
) -> Result<PendingHandshake, CoreError> {
    let public = PublicKey::from_secret_scalar(&ephemeral);
    let point = public.to_sec1_point(false);
    let ephemeral_key: [u8; EPHEMERAL_KEY_SIZE] = point
        .as_bytes()
        .try_into()
        .map_err(|_| CoreError::Crypto("an ephemeral key is not 65 bytes".to_owned()))?;
    let signature = identity
        .sign(&hello_signing_input(
            &ephemeral_key,
            &nonce,
            identity.device_id(),
            &peer,
        ))
        .await?;
    Ok(PendingHandshake {
        peer,
        nonce,
        ephemeral,
        hello: SecureHelloFrame {
            ephemeral_key: ephemeral_key.to_vec(),
            nonce: nonce.to_vec(),
            identity_key: identity.identity_key().clone(),
            to_device: peer,
            signature,
        },
    })
}

/// Whether `key` is a usable key for its algorithm, as far as importing it can tell: Ed25519 is 32 bytes that decompress to a curve point, ES256 is a SEC1 point on P-256.
fn check_identity_key(key: &IdentityKey) -> Result<(), HelloRefusal> {
    match key.alg {
        IdentityKey::ALG_ED25519 => {
            let bytes: &[u8; 32] = key
                .public_key
                .as_slice()
                .try_into()
                .map_err(|_| HelloRefusal::InvalidIdentityKey)?;
            Ed25519VerifyingKey::from_bytes(bytes)
                .map(|_| ())
                .map_err(|_| HelloRefusal::InvalidIdentityKey)
        }
        IdentityKey::ALG_ES256 => PublicKey::from_sec1_bytes(&key.public_key)
            .map(|_| ())
            .map_err(|_| HelloRefusal::InvalidIdentityKey),
        _ => Err(HelloRefusal::UnsupportedIdentityAlgorithm),
    }
}

/// Checks a received hello and returns the device it proves. In order: the hello is addressed to `identity`'s device, its identity key's algorithm is supported, the key is usable, and its signature verifies over [`hello_signing_input`] with the sender derived from the key. The sender is never claimed, so no check can refuse a hello for naming the wrong sender.
///
/// A signature that is malformed for its algorithm (a DER-encoded ES256 signature, a short Ed25519 one) is a [`HelloRefusal::BadSignature`], as is any error the identity port gives for it, since by then the key has been checked and the signature is the only input left. An ES256 signature is raw `r || s` and is accepted with `s` in either half of the group order.
///
/// # Errors
///
/// The [`HelloRefusal`] for the first check that fails.
pub async fn verify_hello(
    identity: &dyn Identity,
    hello: &SecureHelloFrame,
) -> Result<SecureChannelPeer, HelloRefusal> {
    let key = &hello.identity_key;
    if hello.to_device != *identity.device_id() {
        return Err(HelloRefusal::WrongRecipient);
    }
    check_identity_key(key)?;
    let sender = identity.derive_device_id(&key.public_key);
    let ephemeral_key: &[u8; EPHEMERAL_KEY_SIZE] = hello
        .ephemeral_key
        .as_slice()
        .try_into()
        .map_err(|_| HelloRefusal::BadSignature)?;
    let nonce: &[u8; NONCE_SIZE] = hello
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| HelloRefusal::BadSignature)?;
    let input = hello_signing_input(ephemeral_key, nonce, &sender, identity.device_id());
    match identity.verify(key, &input, &hello.signature).await {
        Ok(true) => Ok(SecureChannelPeer {
            device_id: sender,
            identity_key: key.clone(),
        }),
        Ok(false) | Err(_) => Err(HelloRefusal::BadSignature),
    }
}

/// The two direction keys of a channel. Each is zeroised when dropped.
pub struct DirectionKeys {
    /// The key that seals frames sent by the device with the lower device-id.
    pub low_to_high: Zeroizing<[u8; KEY_SIZE]>,
    /// The key that seals frames sent by the device with the higher device-id.
    pub high_to_low: Zeroizing<[u8; KEY_SIZE]>,
}

impl core::fmt::Debug for DirectionKeys {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("DirectionKeys").finish_non_exhaustive()
    }
}

/// The key schedule: HKDF-SHA256 with `shared_secret` as input keying material, [`channel_salt`] as salt and [`channel_hkdf_info`] as info, to 32 bytes per direction. `low` and `high` are the two device-ids in bytewise order and `nonce_low` and `nonce_high` the nonces of the hellos those devices sent.
pub fn derive_direction_keys(
    shared_secret: &[u8; KEY_SIZE],
    low: &DeviceId,
    high: &DeviceId,
    nonce_low: &[u8; NONCE_SIZE],
    nonce_high: &[u8; NONCE_SIZE],
) -> DirectionKeys {
    let salt = channel_salt(nonce_low, nonce_high);
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), shared_secret);
    let derive = |label: &[u8]| {
        let mut key = Zeroizing::new([0u8; KEY_SIZE]);
        // The output length is one HMAC block of SHA-256, far below HKDF's limit, so expansion cannot fail.
        if hkdf
            .expand(&channel_hkdf_info(low, high, label), key.as_mut_slice())
            .is_err()
        {
            unreachable!("32 bytes is within the HKDF-SHA256 output limit");
        }
        key
    };
    DirectionKeys {
        low_to_high: derive(LABEL_LOW_TO_HIGH),
        high_to_low: derive(LABEL_HIGH_TO_LOW),
    }
}

/// ECDH between `secret` and a peer's SEC1 uncompressed ephemeral key, as the 32-byte x-coordinate of the product point. Any other encoding of the key (compressed, hybrid, the identity, a wrong length) is refused even where the curve crate would parse it, because the spec requires exactly 65 bytes.
fn ecdh_shared_secret(
    secret: &NonZeroScalar,
    remote_ephemeral_key: &[u8],
) -> Result<Zeroizing<[u8; KEY_SIZE]>, EstablishError> {
    if remote_ephemeral_key.len() != EPHEMERAL_KEY_SIZE
        || remote_ephemeral_key.first() != Some(&UNCOMPRESSED_POINT_TAG)
    {
        return Err(EstablishError::UnusableEphemeralKey);
    }
    let public = PublicKey::from_sec1_bytes(remote_ephemeral_key)
        .map_err(|_| EstablishError::UnusableEphemeralKey)?;
    let shared = p256::ecdh::diffie_hellman(secret, public.as_affine());
    let mut out = Zeroizing::new([0u8; KEY_SIZE]);
    out.copy_from_slice(shared.raw_secret_bytes().as_slice());
    Ok(out)
}

impl PendingHandshake {
    /// This side's ECDH result with a peer's ephemeral key, so conformance checks can compare the shared secret before any key is derived from it.
    ///
    /// # Errors
    ///
    /// [`EstablishError::UnusableEphemeralKey`] when the key is not an uncompressed P-256 point.
    #[cfg(any(test, feature = "conformance"))]
    pub fn shared_secret_with(
        &self,
        remote_ephemeral_key: &[u8],
    ) -> Result<Zeroizing<[u8; KEY_SIZE]>, EstablishError> {
        ecdh_shared_secret(&self.ephemeral, remote_ephemeral_key)
    }
}

/// Completes a handshake once the peer's hello has verified: derives the two direction keys from the ECDH result of the ephemeral keys and returns the channel. `local` is this device's id, `pending` this side's own half (begun here, or in answer to `remote`), `remote` the peer's hello and `peer` the device [`verify_hello`] authenticated for it.
///
/// # Errors
///
/// [`EstablishError::UnusableEphemeralKey`] when the peer's ephemeral key is not an uncompressed P-256 point on the curve, which only a hostile or broken peer sends, and [`EstablishError::InvalidNonce`] when its nonce is not 16 bytes.
pub fn establish_channel(
    local: &DeviceId,
    pending: PendingHandshake,
    remote: &SecureHelloFrame,
    peer: SecureChannelPeer,
) -> Result<SecureChannel, EstablishError> {
    let shared = ecdh_shared_secret(&pending.ephemeral, &remote.ephemeral_key)?;
    let remote_nonce: [u8; NONCE_SIZE] = remote
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| EstablishError::InvalidNonce)?;
    let local_is_low = *local < peer.device_id;
    let (low, high) = if local_is_low {
        (local, &peer.device_id)
    } else {
        (&peer.device_id, local)
    };
    let (nonce_low, nonce_high) = if local_is_low {
        (&pending.nonce, &remote_nonce)
    } else {
        (&remote_nonce, &pending.nonce)
    };
    let DirectionKeys {
        low_to_high,
        high_to_low,
    } = derive_direction_keys(&shared, low, high, nonce_low, nonce_high);
    let (send_key, receive_key) = if local_is_low {
        (low_to_high, high_to_low)
    } else {
        (high_to_low, low_to_high)
    };
    Ok(SecureChannel {
        peer,
        local: *local,
        send_key,
        receive_key,
        next_send: Some(0),
        highest_received: None,
    })
}

/// One end of an established channel. The direction keys are zeroised when it is dropped, and `Debug` prints neither them nor anything derived from them.
///
/// [`seal`](SecureChannel::seal) and [`open`](SecureChannel::open) take `&mut self`, so the borrow checker gives the counter ordering a caller sharing a channel across tasks must otherwise build: it holds the channel behind a lock and seals or opens one frame at a time.
pub struct SecureChannel {
    peer: SecureChannelPeer,
    local: DeviceId,
    send_key: Zeroizing<[u8; KEY_SIZE]>,
    receive_key: Zeroizing<[u8; KEY_SIZE]>,
    /// The counter the next seal uses, or `None` once `u64::MAX` has been used.
    next_send: Option<u64>,
    /// The highest counter accepted so far, or `None` before the first frame.
    highest_received: Option<u64>,
}

impl ZeroizeOnDrop for SecureChannel {}

impl core::fmt::Debug for SecureChannel {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("SecureChannel")
            .field("peer", &self.peer)
            .field("local", &self.local)
            .finish_non_exhaustive()
    }
}

impl SecureChannel {
    /// The device on the other end, as its hello proved it.
    pub fn peer(&self) -> &SecureChannelPeer {
        &self.peer
    }

    /// Seals one frame for the peer under the next send counter. The plaintext is the canonical encoding of `frame`, sealed with AES-256-GCM under the send key, [`data_iv`] and [`data_associated_data`]. The sender imposes no restriction on the kind of frame because the spec imposes none; only the receiver drops a kind obligation 5 does not allow (see [`is_sealable`]).
    ///
    /// # Errors
    ///
    /// [`SealError::CounterExhausted`] once counter `u64::MAX` has been used (and on every call after it: the counter never wraps), and [`SealError::FrameTooLong`]. A refusal leaves the counter where it was.
    pub fn seal(&mut self, frame: &Frame) -> Result<SecureDataFrame, SealError> {
        let counter = self.next_send.ok_or(SealError::CounterExhausted)?;
        let plaintext = encode_frame(frame);
        let ciphertext = cipher(&self.send_key)
            .encrypt(
                iv_nonce(&data_iv(counter)),
                Payload {
                    msg: &plaintext,
                    aad: &data_associated_data(&self.local, &self.peer.device_id, counter),
                },
            )
            .map_err(|_| SealError::FrameTooLong)?;
        self.next_send = counter.checked_add(1);
        Ok(SecureDataFrame {
            counter,
            ciphertext,
        })
    }

    /// Opens a frame from the peer. The checks run in this order: the counter must be above every counter already accepted, the ciphertext must authenticate under the receive key with the frame's own counter as IV and associated data, and the plaintext must be exactly one valid frame. A frame that authenticates counts as received whether or not its plaintext decodes. The caller still applies obligation 5 to what comes out, with [`is_sealable`].
    ///
    /// # Errors
    ///
    /// [`OpenError::Replayed`] and [`OpenError::Unauthentic`] leave the channel unchanged, so a forged frame cannot lock out genuine ones. [`OpenError::Undecodable`] consumes the counter.
    pub fn open(&mut self, data: &SecureDataFrame) -> Result<Frame, OpenError> {
        if self
            .highest_received
            .is_some_and(|highest| data.counter <= highest)
        {
            return Err(OpenError::Replayed);
        }
        let plaintext = cipher(&self.receive_key)
            .decrypt(
                iv_nonce(&data_iv(data.counter)),
                Payload {
                    msg: &data.ciphertext,
                    aad: &data_associated_data(&self.peer.device_id, &self.local, data.counter),
                },
            )
            .map_err(|_| OpenError::Unauthentic)?;
        // Advanced only after the frame authenticated.
        self.highest_received = Some(data.counter);
        let frame = decode_frame(&plaintext)
            .map_err(|error| OpenError::Undecodable(PlaintextFault::Decode(error)))?;
        frame
            .validate()
            .map_err(|error| OpenError::Undecodable(PlaintextFault::Invalid(error)))?;
        Ok(frame)
    }
}

/// An AES-256-GCM instance for one operation, built from the zeroising key so no long-lived cipher state holds a copy of it.
fn cipher(key: &[u8; KEY_SIZE]) -> Aes256Gcm {
    Aes256Gcm::new(key.into())
}

fn iv_nonce(iv: &[u8; IV_SIZE]) -> &aes_gcm::Nonce<U12> {
    iv.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::NodeIdentity;
    use wire_mesh_wire::data::DataHaveFrame;
    use wire_mesh_wire::transport::PingFrame;
    use zeroize::Zeroize;

    fn have(head_seq: u64) -> Frame {
        Frame::DataHave(DataHaveFrame {
            peer: DeviceId([7; 32]),
            head_seq,
        })
    }

    /// Runs the real handshake between two identities and returns both ends.
    async fn connect(a: &NodeIdentity, b: &NodeIdentity) -> (SecureChannel, SecureChannel) {
        let pending_a = begin_handshake(a, *b.device_id()).await.expect("begin a");
        let pending_b = begin_handshake(b, *a.device_id()).await.expect("begin b");
        let hello_a = pending_a.hello().clone();
        let hello_b = pending_b.hello().clone();
        let peer_b = verify_hello(a, &hello_b).await.expect("verify b");
        let peer_a = verify_hello(b, &hello_a).await.expect("verify a");
        (
            establish_channel(a.device_id(), pending_a, &hello_b, peer_b).expect("establish a"),
            establish_channel(b.device_id(), pending_b, &hello_a, peer_a).expect("establish b"),
        )
    }

    #[tokio::test]
    async fn frames_sent_each_way_open_at_the_other_end_for_both_identity_algorithms() {
        for (a, b) in [
            (
                NodeIdentity::generate_ed25519(),
                NodeIdentity::generate_ed25519(),
            ),
            (
                NodeIdentity::generate_es256(),
                NodeIdentity::generate_ed25519(),
            ),
            (
                NodeIdentity::generate_es256(),
                NodeIdentity::generate_es256(),
            ),
        ] {
            let (mut a_end, mut b_end) = connect(&a, &b).await;
            assert_eq!(a_end.peer().device_id, *b.device_id());
            assert_eq!(b_end.peer().device_id, *a.device_id());
            for head_seq in 0..3 {
                let sealed = a_end.seal(&have(head_seq)).expect("seal");
                assert_eq!(sealed.counter, head_seq);
                assert_eq!(b_end.open(&sealed), Ok(have(head_seq)));
                let sealed = b_end.seal(&have(head_seq + 10)).expect("seal");
                assert_eq!(a_end.open(&sealed), Ok(have(head_seq + 10)));
            }
        }
    }

    #[tokio::test]
    async fn a_frame_sealed_by_one_end_does_not_open_at_the_same_end_when_reflected() {
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let (mut a_end, _b_end) = connect(&a, &b).await;
        let sealed = a_end.seal(&have(1)).expect("seal");
        assert_eq!(a_end.open(&sealed), Err(OpenError::Unauthentic));
    }

    #[tokio::test]
    async fn two_handshakes_between_the_same_devices_derive_different_keys() {
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let (mut first_a, mut first_b) = connect(&a, &b).await;
        let (mut second_a, mut second_b) = connect(&a, &b).await;
        let frame = have(5);
        let on_first = first_a.seal(&frame).expect("seal");
        let on_second = second_a.seal(&frame).expect("seal");
        assert_eq!(on_first.counter, on_second.counter);
        assert_ne!(on_first.ciphertext, on_second.ciphertext);
        assert_eq!(second_b.open(&on_first), Err(OpenError::Unauthentic));
        assert_eq!(first_b.open(&on_second), Err(OpenError::Unauthentic));
        assert_eq!(first_b.open(&on_first), Ok(frame.clone()));
        assert_eq!(second_b.open(&on_second), Ok(frame));
    }

    #[tokio::test]
    async fn sealing_refuses_once_the_counter_is_exhausted_and_never_wraps() {
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let (mut a_end, mut b_end) = connect(&a, &b).await;
        a_end.next_send = Some(u64::MAX - 1);
        let second_last = a_end.seal(&have(1)).expect("second last");
        let last = a_end.seal(&have(2)).expect("last");
        assert_eq!(second_last.counter, u64::MAX - 1);
        assert_eq!(last.counter, u64::MAX);
        for _ in 0..3 {
            assert_eq!(a_end.seal(&have(3)), Err(SealError::CounterExhausted));
        }
        assert_eq!(b_end.open(&second_last), Ok(have(1)));
        assert_eq!(b_end.open(&last), Ok(have(2)));
    }

    #[tokio::test]
    async fn a_frame_obligation_5_does_not_allow_is_sealed_and_opened_and_reported_as_droppable() {
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let (mut a_end, mut b_end) = connect(&a, &b).await;
        let ping = Frame::Ping(PingFrame);
        let sealed = a_end
            .seal(&ping)
            .expect("a sender imposes no kind restriction");
        let opened = b_end.open(&sealed).expect("the receiver opens it");
        assert_eq!(opened, ping);
        assert!(!is_sealable(&opened));
        assert!(is_sealable(&have(1)));
    }

    #[tokio::test]
    async fn a_replayed_frame_and_a_forged_high_counter_leave_genuine_frames_openable() {
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let (mut a_end, mut b_end) = connect(&a, &b).await;
        let first = a_end.seal(&have(1)).expect("seal");
        let second = a_end.seal(&have(2)).expect("seal");
        let forged = SecureDataFrame {
            counter: 1000,
            ciphertext: second.ciphertext.clone(),
        };
        assert_eq!(b_end.open(&forged), Err(OpenError::Unauthentic));
        assert_eq!(b_end.open(&first), Ok(have(1)));
        assert_eq!(b_end.open(&first), Err(OpenError::Replayed));
        assert_eq!(b_end.open(&second), Ok(have(2)));
    }

    #[tokio::test]
    async fn an_authenticated_plaintext_that_is_not_a_frame_consumes_its_counter() {
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let (mut a_end, mut b_end) = connect(&a, &b).await;
        let junk = SecureDataFrame {
            counter: 0,
            ciphertext: cipher(&a_end.send_key)
                .encrypt(
                    iv_nonce(&data_iv(0)),
                    Payload {
                        msg: &[0xff],
                        aad: &data_associated_data(a.device_id(), b.device_id(), 0),
                    },
                )
                .expect("encrypt"),
        };
        assert!(matches!(
            b_end.open(&junk),
            Err(OpenError::Undecodable(PlaintextFault::Decode(_)))
        ));
        assert_eq!(b_end.open(&junk), Err(OpenError::Replayed));
        a_end.next_send = Some(1);
        let next = a_end.seal(&have(9)).expect("seal");
        assert_eq!(b_end.open(&next), Ok(have(9)));
    }

    #[tokio::test]
    async fn an_unusable_ephemeral_key_is_refused_when_the_channel_is_established() {
        let (a, b) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_ed25519(),
        );
        let remote = begin_handshake(&b, *a.device_id()).await.expect("begin");
        let peer = SecureChannelPeer {
            device_id: *b.device_id(),
            identity_key: b.identity_key().clone(),
        };
        let mut hello = remote.hello().clone();
        let mut compressed = vec![0x02];
        compressed.extend_from_slice(&hello.ephemeral_key[1..33]);
        for key in [vec![0x04; 65], compressed, vec![0u8; 65], Vec::new()] {
            hello.ephemeral_key = key;
            let consumed = begin_handshake(&a, *b.device_id()).await.expect("begin");
            assert_eq!(
                establish_channel(a.device_id(), consumed, &hello, peer.clone()).unwrap_err(),
                EstablishError::UnusableEphemeralKey
            );
        }
    }

    #[tokio::test]
    async fn a_hello_for_another_device_or_with_a_tampered_field_is_refused() {
        let (a, b, c) = (
            NodeIdentity::generate_ed25519(),
            NodeIdentity::generate_es256(),
            NodeIdentity::generate_ed25519(),
        );
        let hello = begin_handshake(&a, *b.device_id()).await.expect("begin");
        assert!(verify_hello(&b, hello.hello()).await.is_ok());
        assert_eq!(
            verify_hello(&c, hello.hello()).await.unwrap_err(),
            HelloRefusal::WrongRecipient
        );
        let mut swapped = hello.hello().clone();
        swapped.nonce[0] ^= 1;
        assert_eq!(
            verify_hello(&b, &swapped).await.unwrap_err(),
            HelloRefusal::BadSignature
        );
        let mut unsupported = hello.hello().clone();
        unsupported.identity_key.alg = -35;
        assert_eq!(
            verify_hello(&b, &unsupported).await.unwrap_err(),
            HelloRefusal::UnsupportedIdentityAlgorithm
        );
    }

    #[tokio::test]
    async fn secrets_are_zeroised_on_drop_and_absent_from_debug_output() {
        fn assert_zeroize_on_drop<T: ZeroizeOnDrop>() {}
        assert_zeroize_on_drop::<PendingHandshake>();
        assert_zeroize_on_drop::<SecureChannel>();
        // The key fields themselves are `Zeroizing`, which wipes on drop and on an explicit call; this observes the explicit call on a derived key.
        let mut keys = derive_direction_keys(
            &[3; 32],
            &DeviceId([1; 32]),
            &DeviceId([2; 32]),
            &[4; 16],
            &[5; 16],
        );
        assert_ne!(*keys.low_to_high, [0u8; 32]);
        keys.low_to_high.zeroize();
        assert_eq!(*keys.low_to_high, [0u8; 32]);

        let a = NodeIdentity::generate_ed25519();
        let pending = begin_handshake_with(&a, DeviceId([9; 32]), &[0x11; 32], [0x22; 16])
            .await
            .expect("begin");
        let rendered = format!("{pending:?}");
        assert!(!rendered.contains("1111"), "{rendered}");
        assert_eq!(format!("{keys:?}"), "DirectionKeys { .. }");
    }
}
