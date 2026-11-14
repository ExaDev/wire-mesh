//! What an identity-key's bytes must be before they are used as a key. The same rules hold for every verifier, on every platform and in every implementation, so a key is never usable under one and refused under another.
//!
//! An Ed25519 key is exactly 32 bytes, the canonical encoding of a point on the curve (its y coordinate is below the field prime, and it decodes) and not a point of small order (the eight torsion points, the identity element among them).

use ed25519_dalek::VerifyingKey;

use crate::ports::CoreError;

/// Length of an Ed25519 public key.
pub const ED25519_PUBLIC_KEY_SIZE: usize = 32;

/// Whether the y coordinate an encoding carries (its 255 low bits) is below the field prime 2^255 - 19, which every canonical encoding satisfies.
fn y_is_canonical(encoding: &[u8; ED25519_PUBLIC_KEY_SIZE]) -> bool {
    let mut y = *encoding;
    y[ED25519_PUBLIC_KEY_SIZE - 1] &= 0x7f;
    // The prime is 0x7fff...ffed little-endian: the encoding is at or above it only when the top byte is 0x7f, every byte between is 0xff and the lowest is at least 0xed.
    let all_high_bytes_set = y[1..ED25519_PUBLIC_KEY_SIZE - 1]
        .iter()
        .all(|byte| *byte == 0xff)
        && y[ED25519_PUBLIC_KEY_SIZE - 1] == 0x7f;
    !(all_high_bytes_set && y[0] >= 0xed)
}

/// Decodes an Ed25519 identity-key, refusing every key that is not exactly 32 bytes, not the canonical encoding of a curve point, or a small-order point.
///
/// # Errors
///
/// A [`CoreError::Crypto`] naming which rule the bytes break.
pub fn ed25519_public_key(bytes: &[u8]) -> Result<VerifyingKey, CoreError> {
    let encoding: [u8; ED25519_PUBLIC_KEY_SIZE] = bytes.try_into().map_err(|_| {
        CoreError::Crypto(format!(
            "an Ed25519 public key is {ED25519_PUBLIC_KEY_SIZE} bytes, not {}",
            bytes.len()
        ))
    })?;
    if !y_is_canonical(&encoding) {
        return Err(CoreError::Crypto(
            "an Ed25519 public key is not a canonical encoding".to_owned(),
        ));
    }
    let key = VerifyingKey::from_bytes(&encoding)
        .map_err(|_| CoreError::Crypto("an Ed25519 public key is not a curve point".to_owned()))?;
    if key.is_weak() {
        return Err(CoreError::Crypto(
            "an Ed25519 public key is a small-order point".to_owned(),
        ));
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SMALL_ORDER: [&str; 8] = [
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    ];

    fn unhex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex"))
            .collect()
    }

    #[test]
    fn every_small_order_point_is_refused() {
        for encoding in SMALL_ORDER {
            assert!(ed25519_public_key(&unhex(encoding)).is_err(), "{encoding}");
        }
    }

    #[test]
    fn a_non_canonical_encoding_is_refused_even_of_a_point_that_is_not_small_order() {
        // y = 3 is the y of a curve point of large order; y + p = 2^255 - 16 fits in 255 bits and decodes to the same point, so it is the encoding of the same key that is not canonical.
        let canonical = {
            let mut bytes = [0u8; 32];
            bytes[0] = 3;
            bytes
        };
        assert!(ed25519_public_key(&canonical).is_ok());
        let mut non_canonical = [0xffu8; 32];
        non_canonical[0] = 0xed + 3;
        non_canonical[31] = 0x7f;
        assert!(ed25519_public_key(&non_canonical).is_err());
        // The same with the sign bit of x set.
        non_canonical[31] = 0xff;
        assert!(ed25519_public_key(&non_canonical).is_err());
    }

    #[test]
    fn a_wrong_length_and_a_non_point_are_refused() {
        assert!(ed25519_public_key(&[3u8; 31]).is_err());
        assert!(ed25519_public_key(&[3u8; 33]).is_err());
        // y = 2 is not the y of any point.
        let mut not_a_point = [0u8; 32];
        not_a_point[0] = 2;
        assert!(ed25519_public_key(&not_a_point).is_err());
    }

    #[test]
    fn an_ordinary_key_is_accepted() {
        let identity = crate::adapters::NodeIdentity::generate_ed25519();
        use crate::ports::Identity;
        assert!(ed25519_public_key(&identity.identity_key().public_key).is_ok());
    }
}
