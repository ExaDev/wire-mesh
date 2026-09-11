//! `conformance-check` — the Rust gate over the frozen conformance
//! vectors, mirroring `conformance/verify.test.ts` and the TS core's
//! conformance test in one binary.
//!
//! Two independent loops per vector:
//!
//! 1. **Typed decode/encode** — `wire_hex` is decoded through the strict
//!    typed codec (`Frame::decode_bytes` for frames and handshakes,
//!    `CoseSign1::decode_bytes` for the bare COSE vectors), validated,
//!    re-encoded through the CDE encoder, and compared byte-for-byte
//!    against `wire_hex`, with the first divergent byte reported on
//!    mismatch. For the COSE vectors the opaque `protected`/`payload`
//!    byte strings are additionally parsed on demand through the domain
//!    accessors (protected headers, token claims, handle claims) and
//!    re-encoded, pinning that the accessors round-trip the nested CBOR
//!    identically too.
//! 2. **Message-to-wire** — the vector's `message` JSON is walked into
//!    the [`CborValue`] DOM (sole-key `{"hex": ...}` objects becoming byte
//!    strings, non-integral JSON numbers rejected rather than truncated)
//!    and encoded, pinning the JSON-to-wire convention itself, not just
//!    the frozen bytes.
//!
//! Vector files are resolved from `CARGO_MANIFEST_DIR` so the working
//! directory never matters. Any failure prints the vector's name and how
//! it differs, and exits non-zero.

use std::fmt::Write as _;
use std::path::PathBuf;

use wire_mesh_wire::tokens::CoseSign1;
use wire_mesh_wire::value::{CanonicalMap, CborValue};
use wire_mesh_wire::{decode_frame, encode_frame, minicbor};

fn main() {
    let vector_dir: PathBuf = [env!("CARGO_MANIFEST_DIR"), "..", "..", "..", "conformance"]
        .into_iter()
        .collect();
    let files = ["frames.v1.json", "handshake.v1.json", "tokens.v1.json"];
    let mut total = 0usize;
    let mut passed = 0usize;
    let mut failures: Vec<String> = Vec::new();

    for file in files {
        let path = vector_dir.join(file);
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()));
        let vectors = validate_vector_file(&parsed, file);
        for vector in vectors {
            total += 1;
            let name = vector.name.clone();
            let outcome = check_vector(file, vector);
            match outcome {
                Ok(()) => {
                    passed += 1;
                    println!("PASS  {file}:{name}");
                }
                Err(failure) => {
                    let message = format!("{file}:{name}: {failure}");
                    println!("FAIL  {message}");
                    failures.push(message);
                }
            }
        }
    }

    println!();
    println!("{passed}/{total} vectors passed");
    if !failures.is_empty() {
        eprintln!("{} failing vector(s):", failures.len());
        for failure in &failures {
            eprintln!("  {failure}");
        }
        std::process::exit(1);
    }
}

struct Vector {
    name: String,
    message: serde_json::Value,
    wire_hex: String,
}

fn validate_vector_file(parsed: &serde_json::Value, file: &str) -> Vec<Vector> {
    let fail = |what: &str| -> ! { panic!("{file} is not a valid vector file: {what}") };
    let protocol_version = parsed
        .get("protocol_version")
        .unwrap_or_else(|| fail("missing protocol_version"))
        .as_u64()
        .unwrap_or_else(|| fail("protocol_version is not a uint"));
    if protocol_version != 1 {
        fail("unsupported protocol_version (expected 1)");
    }
    if parsed.get("description").map(serde_json::Value::is_string) != Some(true) {
        fail("missing description");
    }
    let raw_vectors = parsed
        .get("vectors")
        .unwrap_or_else(|| fail("missing vectors"))
        .as_array()
        .unwrap_or_else(|| fail("vectors is not an array"));
    raw_vectors
        .iter()
        .map(|v| Vector {
            name: v
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_else(|| fail("vector missing name"))
                .to_owned(),
            message: v
                .get("message")
                .cloned()
                .unwrap_or_else(|| fail("vector missing message")),
            wire_hex: v
                .get("wire_hex")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_else(|| fail("vector missing wire_hex"))
                .to_owned(),
        })
        .collect()
}

fn check_vector(file: &str, vector: Vector) -> Result<(), String> {
    let expected = decode_hex(&vector.wire_hex)?;
    // Primary loop: typed decode -> validate -> re-encode -> byte-exact.
    match file {
        "frames.v1.json" | "handshake.v1.json" => {
            let frame = decode_frame(&expected).map_err(|e| format!("typed decode failed: {e}"))?;
            frame
                .validate()
                .map_err(|e| format!("frame validation failed: {e}"))?;
            let actual = encode_frame(&frame);
            report_first_divergence(&expected, &actual)?;
        }
        "tokens.v1.json" => {
            let cose = CoseSign1::decode_bytes(&expected)
                .map_err(|e| format!("COSE decode failed: {e}"))?;
            let actual = cose.encode_to_vec();
            report_first_divergence(&expected, &actual)?;
            // The nested opaque members must survive the on-demand
            // accessors identically: protected headers, and whichever
            // claims shape the vector freezes.
            let headers = cose
                .decode_protected()
                .map_err(|e| format!("nested protected headers failed to parse: {e}"))?;
            report_first_divergence(
                &cose.protected,
                &minicbor::to_vec(&headers).map_err(|e| e.to_string())?,
            )?;
            let payload = cose.payload.as_deref().ok_or("token payload is nil")?;
            let reencoded_claims: Vec<u8> = if vector.name.starts_with("capability_token") {
                let claims = cose
                    .decode_claims()
                    .map_err(|e| format!("nested token-claims failed to parse: {e}"))?;
                claims.encode_to_vec()
            } else if vector.name.starts_with("room_notice") {
                let claims = cose
                    .decode_room_notice_claims()
                    .map_err(|e| format!("nested room-notice-claims failed to parse: {e}"))?;
                claims.encode_to_vec()
            } else {
                let claims = cose
                    .decode_handle_claims()
                    .map_err(|e| format!("nested handle-claims failed to parse: {e}"))?;
                claims.encode_to_vec()
            };
            report_first_divergence(payload, &reencoded_claims)?;
        }
        other => panic!("unknown vector file {other}"),
    }
    // Secondary loop: message JSON -> CborValue DOM -> CDE -> wire_hex.
    let dom = json_to_cbor(&vector.message)?;
    let encoded = minicbor::to_vec(&dom).map_err(|e| format!("DOM encode failed: {e}"))?;
    report_first_divergence(&expected, &encoded)
}

/// The first-divergence hex diff: names the offset and shows both sides
/// around it, so a one-byte key-order bug is immediately legible.
fn report_first_divergence(expected: &[u8], actual: &[u8]) -> Result<(), String> {
    if expected == actual {
        return Ok(());
    }
    let offset = expected
        .iter()
        .zip(actual.iter())
        .position(|(a, b)| a != b)
        .unwrap_or(expected.len().min(actual.len()));
    let context = 8;
    let lo = offset.saturating_sub(context);
    let hi = (offset + context).min(expected.len().max(actual.len()));
    let window = |bytes: &[u8]| -> String {
        let mut out = String::new();
        for (i, byte) in bytes.get(lo..hi).unwrap_or(&[]).iter().enumerate() {
            if lo + i == offset {
                write!(out, "[{byte:02x}]").expect("write to String");
            } else {
                write!(out, "{byte:02x}").expect("write to String");
            }
        }
        out
    };
    let length_note = if expected.len() != actual.len() {
        format!(
            " (lengths differ: expected {}, actual {})",
            expected.len(),
            actual.len()
        )
    } else {
        String::new()
    };
    Err(format!(
        "re-encode diverges from wire_hex at byte {offset}{length_note}\n  expected: {}\n  actual:   {}",
        window(expected),
        window(actual)
    ))
}

/// Walk a vector `message` into the CBOR DOM: the sole-key `{"hex": ...}`
/// marker convention for byte strings, objects into CDE-ordered maps, and
/// only integral JSON numbers (the Zod `.int()` equivalent — fractional or
/// out-of-range numbers are rejected, never truncated).
fn json_to_cbor(value: &serde_json::Value) -> Result<CborValue, String> {
    match value {
        serde_json::Value::Null => Ok(CborValue::Null),
        serde_json::Value::Bool(b) => Ok(CborValue::Bool(*b)),
        serde_json::Value::Number(n) => {
            if let Some(u) = n.as_u64() {
                Ok(CborValue::UInt(u))
            } else if let Some(i) = n.as_i64() {
                Ok(CborValue::Int(i))
            } else {
                Err(format!(
                    "number {n} is not an integral value representable as CBOR int/uint; refusing to truncate"
                ))
            }
        }
        serde_json::Value::String(s) => Ok(CborValue::Text(s.clone())),
        serde_json::Value::Array(items) => {
            let mut out = Vec::new();
            for item in items {
                out.push(json_to_cbor(item)?);
            }
            Ok(CborValue::Array(out))
        }
        serde_json::Value::Object(map) => {
            if map.len() == 1 && map.contains_key("hex") {
                let hex = map
                    .get("hex")
                    .and_then(serde_json::Value::as_str)
                    .ok_or("hex marker value is not a string")?;
                return Ok(CborValue::Bytes(decode_hex(hex)?));
            }
            let mut out: CanonicalMap<CborValue, CborValue> = CanonicalMap::new();
            for (key, item) in map {
                let value = json_to_cbor(item)?;
                out.insert(CborValue::Text(key.clone()), value)
                    .map_err(|e| format!("duplicate key {key:?} in message: {e}"))?;
            }
            Ok(CborValue::Map(out))
        }
    }
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err(format!("hex string has odd length {}", hex.len()));
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let high = (pair[0] as char)
            .to_digit(16)
            .ok_or_else(|| format!("invalid hex byte '{}'", String::from_utf8_lossy(pair)))?;
        let low = (pair[1] as char)
            .to_digit(16)
            .ok_or_else(|| format!("invalid hex byte '{}'", String::from_utf8_lossy(pair)))?;
        out.push(((high << 4) | low) as u8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        assert_eq!(decode_hex("0a0B").expect("hex"), vec![0x0a, 0x0b]);
        assert!(decode_hex("0").is_err());
        assert!(decode_hex("zz").is_err());
    }

    #[test]
    fn json_numbers_must_be_integral() {
        assert_eq!(
            json_to_cbor(&serde_json::from_str::<serde_json::Value>("65536").expect("json")),
            Ok(CborValue::UInt(65536))
        );
        assert_eq!(
            json_to_cbor(&serde_json::from_str::<serde_json::Value>("-7").expect("json")),
            Ok(CborValue::Int(-7))
        );
        assert!(
            json_to_cbor(&serde_json::from_str::<serde_json::Value>("1.5").expect("json")).is_err()
        );
    }
}
