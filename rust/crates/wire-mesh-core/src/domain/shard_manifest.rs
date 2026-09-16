//! The shard manifest entry codec (wire-mesh#36) -- the Rust half of the
//! byte-identical pair with `ts/packages/core/src/domain/shard-manifest.ts`.
//! A manifest (`{total-shards, threshold, content-type, original-length,
//! shards: [{device, transfer-id}]}`) is published as an ordinary opaque
//! core/data entry, so a Rust reader must consume TS-written entry bytes
//! verbatim and vice versa. The map's keys are written in RFC 8949 4.2.1
//! CDE order (encoded-length first, then bytewise) -- `shards`,
//! `threshold`, `content-type`, `total-shards`, `original-length` for this
//! key set -- exactly matching what cbor2's cdeEncodeOptions produces on
//! the TS side; the pinned test asserts the byte stream against the TS
//! suite's own output.

use minicbor::{Decoder, Encoder};
use wire_mesh_wire::error::DecodeError;
use wire_mesh_wire::identity::DeviceId;

/// The content-type a core/data entry carrying a shard manifest declares.
pub const SHARD_MANIFEST_CONTENT_TYPE: &str = "application/x-wire-mesh-shard-manifest";

/// Where one shard lives: the device holding it, and the bulk transfer that delivered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardLocation {
    pub device: DeviceId,
    pub transfer_id: Vec<u8>,
}

/// The manifest itself: N shards, any `threshold` of which reconstruct
/// `original_length` bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShardManifest {
    pub total_shards: u64,
    pub threshold: u64,
    /// The reconstructed content's own content-type (already suffixed if encrypted).
    pub content_type: String,
    /// The byte length the K shards reconstruct to -- the fact the shards
    /// cannot carry themselves (zero-padding is indistinguishable from a
    /// trailing zero byte).
    pub original_length: u64,
    pub shards: Vec<ShardLocation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    /// The entry bytes are not a well-formed manifest map.
    Malformed(String),
    /// The manifest's own numbers disagree (shards list length vs
    /// total-shards, threshold beyond total-shards).
    Inconsistent(String),
}

impl core::fmt::Display for ManifestError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ManifestError::Malformed(what) => write!(f, "malformed shard manifest: {what}"),
            ManifestError::Inconsistent(what) => {
                write!(f, "inconsistent shard manifest: {what}")
            }
        }
    }
}

impl std::error::Error for ManifestError {}

impl From<DecodeError> for ManifestError {
    fn from(error: DecodeError) -> Self {
        ManifestError::Malformed(error.to_string())
    }
}

fn validate(manifest: &ShardManifest) -> Result<(), ManifestError> {
    if manifest.shards.len() as u64 != manifest.total_shards {
        return Err(ManifestError::Inconsistent(format!(
            "declares {} shards but lists {}",
            manifest.total_shards,
            manifest.shards.len()
        )));
    }
    if manifest.threshold < 1 || manifest.threshold > manifest.total_shards {
        return Err(ManifestError::Inconsistent(format!(
            "threshold {} must be between 1 and {}",
            manifest.threshold, manifest.total_shards
        )));
    }
    Ok(())
}

/// The manifest's map keys in RFC 8949 4.2.1 CDE order for this key set
/// (encoded-length first, then bytewise): "shards"(7) < "threshold"(9) <
/// "content-type"(12) < "total-shards"(12, bytewise after) <
/// "original-length"(15).
mod keys {
    pub const SHARDS: &str = "shards";
    pub const THRESHOLD: &str = "threshold";
    pub const CONTENT_TYPE: &str = "content-type";
    pub const TOTAL_SHARDS: &str = "total-shards";
    pub const ORIGINAL_LENGTH: &str = "original-length";
    pub const DEVICE: &str = "device";
    pub const TRANSFER_ID: &str = "transfer-id";
}

pub fn encode_shard_manifest(manifest: &ShardManifest) -> Result<Vec<u8>, ManifestError> {
    validate(manifest)?;
    let mut buf = Vec::new();
    {
        let mut encoder = Encoder::new(&mut buf);
        // Writes to a Vec are infallible, so every encoder call below
        // unwraps a structurally-guaranteed Ok -- the only failure mode is
        // a trait-object glitch that cannot occur for Vec<u8>.
        encoder
            .map(5)
            .and_then(|encoder| encoder.str(keys::SHARDS))
            .and_then(|encoder| encoder.array(manifest.shards.len() as u64))
            .map_err(|e| ManifestError::Malformed(e.to_string()))?;
        for shard in &manifest.shards {
            encoder
                .map(2)
                .and_then(|encoder| encoder.str(keys::DEVICE))
                .and_then(|encoder| encoder.bytes(&shard.device.0))
                .and_then(|encoder| encoder.str(keys::TRANSFER_ID))
                .and_then(|encoder| encoder.bytes(&shard.transfer_id))
                .map_err(|e| ManifestError::Malformed(e.to_string()))?;
        }
        encoder
            .str(keys::THRESHOLD)
            .and_then(|encoder| encoder.u64(manifest.threshold))
            .and_then(|encoder| encoder.str(keys::CONTENT_TYPE))
            .and_then(|encoder| encoder.str(&manifest.content_type))
            .and_then(|encoder| encoder.str(keys::TOTAL_SHARDS))
            .and_then(|encoder| encoder.u64(manifest.total_shards))
            .and_then(|encoder| encoder.str(keys::ORIGINAL_LENGTH))
            .and_then(|encoder| encoder.u64(manifest.original_length))
            .map_err(|e| ManifestError::Malformed(e.to_string()))?;
    }
    Ok(buf)
}

pub fn decode_shard_manifest(entry: &[u8]) -> Result<ShardManifest, ManifestError> {
    let mut decoder = Decoder::new(entry);
    let map_len = decoder
        .map()
        .map_err(|e| ManifestError::Malformed(e.to_string()))?
        .ok_or_else(|| ManifestError::Malformed("indefinite-length map".to_owned()))?;
    if map_len != 5 {
        return Err(ManifestError::Malformed(format!(
            "expected a 5-key manifest map, got {map_len}"
        )));
    }
    // Decoded in wire order (CDE), not field order.
    let mut shards: Option<Vec<ShardLocation>> = None;
    let mut threshold: Option<u64> = None;
    let mut content_type: Option<String> = None;
    let mut total_shards: Option<u64> = None;
    let mut original_length: Option<u64> = None;
    for _ in 0..map_len {
        let key = decoder
            .str()
            .map_err(|e| ManifestError::Malformed(e.to_string()))?;
        match key {
            keys::SHARDS => {
                let array_len = decoder
                    .array()
                    .map_err(|e| ManifestError::Malformed(e.to_string()))?
                    .ok_or_else(|| {
                        ManifestError::Malformed("indefinite-length shards".to_owned())
                    })?;
                let mut locations = Vec::with_capacity(array_len as usize);
                for _ in 0..array_len {
                    let location_map = decoder
                        .map()
                        .map_err(|e| ManifestError::Malformed(e.to_string()))?
                        .ok_or_else(|| {
                            ManifestError::Malformed("indefinite location map".to_owned())
                        })?;
                    if location_map != 2 {
                        return Err(ManifestError::Malformed(
                            "shard location must carry exactly device and transfer-id".to_owned(),
                        ));
                    }
                    let mut device: Option<DeviceId> = None;
                    let mut transfer_id: Option<Vec<u8>> = None;
                    for _ in 0..location_map {
                        let inner_key = decoder
                            .str()
                            .map_err(|e| ManifestError::Malformed(e.to_string()))?;
                        match inner_key {
                            keys::DEVICE => {
                                let bytes = decoder
                                    .bytes()
                                    .map_err(|e| ManifestError::Malformed(e.to_string()))?;
                                device = Some(device_from(bytes)?);
                            }
                            keys::TRANSFER_ID => {
                                transfer_id = Some(
                                    decoder
                                        .bytes()
                                        .map_err(|e| ManifestError::Malformed(e.to_string()))?
                                        .to_vec(),
                                );
                            }
                            other => {
                                return Err(ManifestError::Malformed(format!(
                                    "unknown shard-location key {other}"
                                )))
                            }
                        }
                    }
                    match (device, transfer_id) {
                        (Some(device), Some(transfer_id)) => locations.push(ShardLocation {
                            device,
                            transfer_id,
                        }),
                        _ => {
                            return Err(ManifestError::Malformed(
                                "shard location missing device or transfer-id".to_owned(),
                            ))
                        }
                    }
                }
                shards = Some(locations);
            }
            keys::THRESHOLD => {
                threshold = Some(
                    decoder
                        .u64()
                        .map_err(|e| ManifestError::Malformed(e.to_string()))?,
                );
            }
            keys::CONTENT_TYPE => {
                content_type = Some(
                    decoder
                        .str()
                        .map_err(|e| ManifestError::Malformed(e.to_string()))?
                        .to_owned(),
                );
            }
            keys::TOTAL_SHARDS => {
                total_shards = Some(
                    decoder
                        .u64()
                        .map_err(|e| ManifestError::Malformed(e.to_string()))?,
                );
            }
            keys::ORIGINAL_LENGTH => {
                original_length = Some(
                    decoder
                        .u64()
                        .map_err(|e| ManifestError::Malformed(e.to_string()))?,
                );
            }
            other => {
                return Err(ManifestError::Malformed(format!(
                    "unknown manifest key {other}"
                )))
            }
        }
    }
    let manifest = ShardManifest {
        total_shards: total_shards
            .ok_or_else(|| ManifestError::Malformed("missing total-shards".to_owned()))?,
        threshold: threshold
            .ok_or_else(|| ManifestError::Malformed("missing threshold".to_owned()))?,
        content_type: content_type
            .ok_or_else(|| ManifestError::Malformed("missing content-type".to_owned()))?,
        original_length: original_length
            .ok_or_else(|| ManifestError::Malformed("missing original-length".to_owned()))?,
        shards: shards.ok_or_else(|| ManifestError::Malformed("missing shards".to_owned()))?,
    };
    validate(&manifest)?;
    Ok(manifest)
}

fn device_from(bytes: &[u8]) -> Result<DeviceId, ManifestError> {
    if bytes.len() != 32 {
        return Err(ManifestError::Malformed(format!(
            "device-id must be 32 bytes, got {}",
            bytes.len()
        )));
    }
    let mut id = [0u8; 32];
    id.copy_from_slice(bytes);
    Ok(DeviceId(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device_bytes(pattern: u8) -> DeviceId {
        let mut id = [0u8; 32];
        for (i, slot) in id.iter_mut().enumerate() {
            *slot = (i as u8).wrapping_mul(pattern);
        }
        DeviceId(id)
    }

    fn fixture() -> ShardManifest {
        ShardManifest {
            total_shards: 3,
            threshold: 2,
            content_type: "text/plain+aes256gcm".to_owned(),
            original_length: 42,
            shards: vec![
                ShardLocation {
                    device: device_bytes(1),
                    transfer_id: vec![1],
                },
                ShardLocation {
                    device: {
                        let mut id = [0u8; 32];
                        for (i, slot) in id.iter_mut().enumerate() {
                            *slot = 255 - i as u8;
                        }
                        DeviceId(id)
                    },
                    transfer_id: vec![2],
                },
                ShardLocation {
                    device: device_bytes(7),
                    transfer_id: vec![3],
                },
            ],
        }
    }

    #[test]
    fn round_trips_through_entry_bytes() {
        let manifest = fixture();
        let entry = encode_shard_manifest(&manifest).expect("encode");
        assert_eq!(decode_shard_manifest(&entry).expect("decode"), manifest);
    }

    /// The cross-language pin: these bytes are the TS suite's own
    /// encodeShardManifest output for the identical fixture, verbatim.
    #[test]
    fn produces_the_ts_suites_entry_bytes_exactly() {
        let entry = encode_shard_manifest(&fixture()).expect("encode");
        let pinned_hex = "a56673686172647383a2666465766963655820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f6b7472616e736665722d69644101a2666465766963655820fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e06b7472616e736665722d69644102a266646576696365582000070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d96b7472616e736665722d69644103697468726573686f6c64026c636f6e74656e742d7479706574746578742f706c61696e2b61657332353667636d6c746f74616c2d736861726473036f6f726967696e616c2d6c656e677468182a";
        let expected = hex_to_bytes(pinned_hex);
        assert_eq!(entry, expected);
    }

    /// The inverse pin: the TS-produced entry bytes decode cleanly here.
    #[test]
    fn decodes_the_ts_suites_entry_bytes() {
        let pinned_hex = "a56673686172647383a2666465766963655820000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f6b7472616e736665722d69644101a2666465766963655820fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedecebeae9e8e7e6e5e4e3e2e1e06b7472616e736665722d69644102a266646576696365582000070e151c232a31383f464d545b626970777e858c939aa1a8afb6bdc4cbd2d96b7472616e736665722d69644103697468726573686f6c64026c636f6e74656e742d7479706574746578742f706c61696e2b61657332353667636d6c746f74616c2d736861726473036f6f726967696e616c2d6c656e677468182a";
        let entry = hex_to_bytes(pinned_hex);
        assert_eq!(decode_shard_manifest(&entry).expect("decode"), fixture());
    }

    #[test]
    fn rejects_an_inconsistent_manifest() {
        let mut manifest = fixture();
        manifest.total_shards = 4;
        assert!(matches!(
            encode_shard_manifest(&manifest),
            Err(ManifestError::Inconsistent(_))
        ));
        let mut manifest = fixture();
        manifest.threshold = 4;
        assert!(matches!(
            encode_shard_manifest(&manifest),
            Err(ManifestError::Inconsistent(_))
        ));
    }

    #[test]
    fn rejects_malformed_entry_bytes() {
        assert!(decode_shard_manifest(&[0xff]).is_err());
        assert!(decode_shard_manifest(&[]).is_err());
    }

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex digit"))
            .collect()
    }
}
