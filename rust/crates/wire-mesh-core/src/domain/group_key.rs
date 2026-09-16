//! The symmetric half of room.rekey's ECIES key-wrapping construction
//! (wire-mesh#141) -- the Rust port of `ts/packages/core/src/domain/group-key.ts`.
//! HKDF-SHA256 turns a raw ECDH shared secret (Identity::derive_shared_secret's
//! own output) into a per-(room, key-epoch) AES-256-GCM wrapping key, and
//! AES-256-GCM itself wraps the room content-encryption key and encrypts
//! notice content under it. The HKDF `info` encoding and the
//! IV-prepended-ciphertext framing are byte-identical to the TS
//! construction, so a wrapped key produced by either implementation
//! unwraps under the other.
//!
//! A fresh random IV is generated for every AES-256-GCM operation and
//! prepended to the output -- never a fixed or derived IV -- since a
//! wrapping key derived once per (room, key-epoch) may legitimately wrap
//! more than once, and reusing an AES-GCM IV under the same key is
//! catastrophic.

use aes_gcm::aead::generic_array::typenum::U12;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::Aes256Gcm;
use hkdf::Hkdf;
use sha2::Sha256;

/// The literal content-type suffix marking a room-notice's content as
/// AES-256-GCM-encrypted under a room.rekey epoch's content key (room.cddl
/// obligation 7) -- the same suffix convention MIME structured syntaxes like
/// `application/jose+json` already use.
pub const ENCRYPTED_CONTENT_TYPE_SUFFIX: &str = "+aes256gcm";

/// The AES-256 key byte length -- both the generated content keys and the
/// HKDF-derived wrapping keys.
const AES_KEY_BYTE_LENGTH: usize = 32;
/// The 96-bit IV size AES-GCM is specified and optimised for.
const GCM_NONCE_BYTE_LENGTH: usize = 12;
/// The room-path length prefix width in hkdf_info's own encoding.
const UINT32_BYTE_LENGTH: usize = 4;
/// The key-epoch field width in hkdf_info's own encoding.
const UINT64_BYTE_LENGTH: usize = 8;
/// Domain-separation prefix for HKDF's info: a NUL-terminated versioned
/// string, byte-identical to the TS construction's own.
const HKDF_INFO_PREFIX: &[u8] = b"wire-mesh/room-rekey/v1\0";

/// Generates a fresh, random 256-bit room content-encryption key.
pub fn generate_content_key() -> Vec<u8> {
    use rand::RngCore;
    let mut key = vec![0u8; AES_KEY_BYTE_LENGTH];
    rand::thread_rng().fill_bytes(&mut key);
    key
}

/// Whether a content-type names encrypted content (and therefore that the
/// notice carrying it MUST also name its key-epoch -- room.cddl obligation 7).
pub fn is_encrypted_content_type(content_type: &str) -> bool {
    content_type.ends_with(ENCRYPTED_CONTENT_TYPE_SUFFIX)
}

/// The notice's own TRUE content-type, with the encryption suffix appended --
/// never a separate generic sentinel, so the true type stays visible without
/// decrypting anything. Idempotent: an already-suffixed type is returned
/// unchanged.
pub fn encrypted_content_type(plaintext_content_type: &str) -> String {
    if is_encrypted_content_type(plaintext_content_type) {
        plaintext_content_type.to_owned()
    } else {
        format!("{plaintext_content_type}{ENCRYPTED_CONTENT_TYPE_SUFFIX}")
    }
}

/// Strips the encryption suffix back off, recovering the plaintext
/// content-type the sender originally had. A content-type carrying no suffix
/// is returned unchanged.
pub fn plaintext_content_type(encrypted_content_type: &str) -> String {
    if is_encrypted_content_type(encrypted_content_type) {
        encrypted_content_type
            .strip_suffix(ENCRYPTED_CONTENT_TYPE_SUFFIX)
            .unwrap_or(encrypted_content_type)
            .to_owned()
    } else {
        encrypted_content_type.to_owned()
    }
}

/// Binds HKDF's own `info` parameter to exactly the (room, key-epoch) pair a
/// wrapping key is for -- byte-identical to the TS construction: the
/// NUL-terminated versioned prefix, a big-endian u32 length-prefix over the
/// room path, then a big-endian u64 key-epoch. Length-prefixing keeps the
/// encoding unambiguous regardless of what characters a room path contains.
fn hkdf_info(room: &str, key_epoch: u64) -> Vec<u8> {
    let room_bytes = room.as_bytes();
    let mut info = Vec::with_capacity(
        HKDF_INFO_PREFIX.len() + UINT32_BYTE_LENGTH + room_bytes.len() + UINT64_BYTE_LENGTH,
    );
    info.extend_from_slice(HKDF_INFO_PREFIX);
    info.extend_from_slice(&(room_bytes.len() as u32).to_be_bytes());
    info.extend_from_slice(room_bytes);
    info.extend_from_slice(&key_epoch.to_be_bytes());
    info
}

/// Wraps and unwraps AES-GCM output as IV-prepended ciphertext, the framing
/// the TS construction uses -- the two halves share one helper because the
/// framing must be identical in both directions and both modules.
fn aes_gcm_seal(key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, aes_gcm::Error> {
    use rand::RngCore;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| aes_gcm::Error)?;
    let mut iv = vec![0u8; GCM_NONCE_BYTE_LENGTH];
    rand::thread_rng().fill_bytes(&mut iv);
    // From<&[u8]> rather than the deprecated from_slice named method -- the
    // underlying conversion impl is identical and not itself deprecated.
    let nonce: &aes_gcm::Nonce<U12> = iv.as_slice().into();
    let ciphertext = cipher.encrypt(nonce, Payload::from(plaintext))?;
    let mut out = Vec::with_capacity(iv.len() + ciphertext.len());
    out.extend_from_slice(&iv);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn aes_gcm_open(key: &[u8], iv_and_ciphertext: &[u8]) -> Result<Vec<u8>, aes_gcm::Error> {
    if iv_and_ciphertext.len() < GCM_NONCE_BYTE_LENGTH {
        // Match the TS side's loud rejection rather than silently mapping a
        // too-short input to aes-gcm's own error.
        return Err(aes_gcm::Error);
    }
    let (iv, ciphertext) = iv_and_ciphertext.split_at(GCM_NONCE_BYTE_LENGTH);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| aes_gcm::Error)?;
    let nonce: &aes_gcm::Nonce<U12> = iv.into();
    cipher.decrypt(nonce, Payload::from(ciphertext))
}

/// The per-(room, key-epoch) wrapping key derived from a raw ECDH shared
/// secret via HKDF-SHA256 -- hold this opaque; every operation on it goes
/// through this module's own functions.
pub type WrappingKey = [u8; AES_KEY_BYTE_LENGTH];

/// Derives an AES-256-GCM wrapping key from a raw ECDH shared secret
/// (Identity::derive_shared_secret's own output) via HKDF-SHA256, with
/// `info` binding the result to exactly one (room, key-epoch) pair. No
/// explicit salt, matching the TS construction: static-static ECDH already
/// produces a high-entropy shared secret, so an empty salt is the standard
/// RFC 5869 choice rather than a corner cut.
pub fn derive_wrapping_key(shared_secret: &[u8], room: &str, key_epoch: u64) -> WrappingKey {
    let hk = Hkdf::<Sha256>::new(None, shared_secret);
    let mut wrapping_key = [0u8; AES_KEY_BYTE_LENGTH];
    // expect is the honest choice over silently substituting a key on an
    // impossible branch: HKDF-SHA256's own output-length limit is 255*32
    // bytes, so a 32-byte Ok is structurally guaranteed here -- there is no
    // wrong-key fallback that would be safe to invent instead.
    #[allow(clippy::expect_used)]
    hk.expand(&hkdf_info(room, key_epoch), &mut wrapping_key)
        .expect("AES-256 key length is a valid HKDF-SHA256 output length");
    wrapping_key
}

/// Wraps a room content-encryption key for delivery in room.rekey's own
/// `wrapped-key` field.
pub fn wrap_content_key(
    wrapping_key: &WrappingKey,
    content_key: &[u8],
) -> Result<Vec<u8>, aes_gcm::Error> {
    aes_gcm_seal(wrapping_key, content_key)
}

/// Unwraps a room.rekey `wrapped-key` entry back into the room
/// content-encryption key it carries. Rejects (never returns a garbage key)
/// if the wrapping key or ciphertext don't match -- AES-256-GCM's own
/// authentication tag catches both.
pub fn unwrap_content_key(
    wrapping_key: &WrappingKey,
    wrapped: &[u8],
) -> Result<Vec<u8>, aes_gcm::Error> {
    aes_gcm_open(wrapping_key, wrapped)
}

/// Encrypts a room-notice's own `content` under the room's current
/// content-encryption key -- encrypt-then-sign, layered underneath
/// room-notice's existing cose-sign1 envelope, never a replacement for it.
pub fn encrypt_notice_content(
    content_key: &[u8],
    plaintext: &[u8],
) -> Result<Vec<u8>, aes_gcm::Error> {
    aes_gcm_seal(content_key, plaintext)
}

/// Decrypts a room-notice's own `content`, given the content-encryption key
/// for the epoch its key-epoch field names. Rejects on a wrong key or
/// tampered ciphertext, same as [`unwrap_content_key`].
pub fn decrypt_notice_content(
    content_key: &[u8],
    ciphertext: &[u8],
) -> Result<Vec<u8>, aes_gcm::Error> {
    aes_gcm_open(content_key, ciphertext)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM_PATH: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/general";

    #[test]
    fn generates_a_fresh_32_byte_key_each_call() {
        let a = generate_content_key();
        let b = generate_content_key();
        assert_eq!(a.len(), AES_KEY_BYTE_LENGTH);
        assert_ne!(a, b);
    }

    #[test]
    fn content_type_suffix_helpers_round_trip() {
        assert_eq!(encrypted_content_type("text/plain"), "text/plain+aes256gcm");
        assert_eq!(
            encrypted_content_type("text/plain+aes256gcm"),
            "text/plain+aes256gcm",
        );
        assert_eq!(plaintext_content_type("text/plain+aes256gcm"), "text/plain");
        assert_eq!(plaintext_content_type("text/plain"), "text/plain");
        assert!(is_encrypted_content_type("text/plain+aes256gcm"));
        assert!(!is_encrypted_content_type("text/plain"));
    }

    #[test]
    fn wrap_round_trips_through_a_derived_wrapping_key() {
        let shared_secret = generate_content_key(); // any 32 random bytes stand in for ECDH output
        let wrapping_key = derive_wrapping_key(&shared_secret, ROOM_PATH, 1);
        let content_key = generate_content_key();

        let wrapped = wrap_content_key(&wrapping_key, &content_key).expect("wrap");
        let unwrapped = unwrap_content_key(&wrapping_key, &wrapped).expect("unwrap");

        assert_eq!(unwrapped, content_key);
    }

    #[test]
    fn wrapping_twice_produces_different_bytes_the_iv_is_fresh() {
        let shared_secret = generate_content_key();
        let wrapping_key = derive_wrapping_key(&shared_secret, ROOM_PATH, 1);
        let content_key = generate_content_key();

        let first = wrap_content_key(&wrapping_key, &content_key).expect("wrap");
        let second = wrap_content_key(&wrapping_key, &content_key).expect("wrap");

        assert_ne!(first, second);
    }

    #[test]
    fn a_wrapping_key_for_a_different_epoch_cannot_unwrap() {
        let shared_secret = generate_content_key();
        let epoch1 = derive_wrapping_key(&shared_secret, ROOM_PATH, 1);
        let epoch2 = derive_wrapping_key(&shared_secret, ROOM_PATH, 2);
        let content_key = generate_content_key();
        let wrapped = wrap_content_key(&epoch1, &content_key).expect("wrap");

        assert!(unwrap_content_key(&epoch2, &wrapped).is_err());
    }

    #[test]
    fn a_wrapping_key_for_a_different_room_cannot_unwrap() {
        let shared_secret = generate_content_key();
        let room_a = derive_wrapping_key(&shared_secret, ROOM_PATH, 1);
        let room_b = derive_wrapping_key(
            &shared_secret,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/general",
            1,
        );
        let content_key = generate_content_key();
        let wrapped = wrap_content_key(&room_a, &content_key).expect("wrap");

        assert!(unwrap_content_key(&room_b, &wrapped).is_err());
    }

    #[test]
    fn both_parties_deriving_from_the_same_secret_reach_the_same_wrapping_key() {
        let shared_secret = generate_content_key();
        let sender = derive_wrapping_key(&shared_secret, ROOM_PATH, 3);
        let recipient = derive_wrapping_key(&shared_secret, ROOM_PATH, 3);
        let content_key = generate_content_key();

        let wrapped = wrap_content_key(&sender, &content_key).expect("wrap");
        let unwrapped = unwrap_content_key(&recipient, &wrapped).expect("unwrap");

        assert_eq!(unwrapped, content_key);
    }

    #[test]
    fn notice_content_round_trips_and_rejects_tampering() {
        let content_key = generate_content_key();
        let plaintext = b"see you at the usual spot";

        let ciphertext = encrypt_notice_content(&content_key, plaintext).expect("encrypt");
        let decrypted = decrypt_notice_content(&content_key, &ciphertext).expect("decrypt");
        assert_eq!(decrypted, plaintext);

        let mut tampered = ciphertext.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        assert!(decrypt_notice_content(&content_key, &tampered).is_err());

        let wrong_key = generate_content_key();
        assert!(decrypt_notice_content(&wrong_key, &ciphertext).is_err());
    }

    #[test]
    fn hkdf_info_matches_the_ts_construction_byte_for_byte() {
        // The cross-language compatibility invariant: a wrapped key produced
        // by the TS implementation must unwrap here (and vice versa), which
        // starts with identical info bytes. Pinned against the TS helper's
        // own documented encoding: prefix, BE u32 length, room, BE u64 epoch.
        let info = hkdf_info("a/general", 2);
        let mut expected = Vec::new();
        expected.extend_from_slice(b"wire-mesh/room-rekey/v1\0");
        expected.extend_from_slice(&9u32.to_be_bytes());
        expected.extend_from_slice(b"a/general");
        expected.extend_from_slice(&2u64.to_be_bytes());
        assert_eq!(info, expected);
    }
}
