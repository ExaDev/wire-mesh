//! `conformance-check` — the Rust gate over the frozen conformance
//! vectors, mirroring `conformance/verify.unit.test.ts` and the TS core's
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
//! `secure-channel.v1.json` additionally carries a `secure_channel` section of recomputed cryptography and verdicts, which [`secure_channel`] checks field by field against the real handshake, key schedule, sealing and opening.
//!
//! Every `conformance/*.v1.json` is accounted for: it is either checked by
//! this binary ([`CONSUMED`]) or listed with its tracking issue in
//! [`NOT_YET_CONSUMED`], and a file in neither, or a listed file that no
//! longer exists, fails the run. A consumed file may carry only the
//! top-level keys this binary reads, so a new section cannot be ignored
//! silently.
//!
//! Vector files are resolved from `CARGO_MANIFEST_DIR` so the working
//! directory never matters. Any failure prints the vector's name and how
//! it differs, and exits non-zero.

use std::fmt::Write as _;
use std::path::PathBuf;

use std::collections::HashMap;

use wire_mesh_core::adapters::NodeIdentity;
use wire_mesh_core::domain::{verify_peer_advert, PeerAdvertVerdict};
use wire_mesh_wire::tokens::{CoseSign1, TokenClaims};
use wire_mesh_wire::transport::{peer_advert_signing_input, PeerAdvert};
use wire_mesh_wire::value::{CanonicalMap, CborValue};
use wire_mesh_wire::{decode_frame, encode_frame, minicbor, DecodeError};

mod mint;
mod obj;
mod secure_channel;

/// The vector files this binary checks, each with the top-level keys it reads.
const CONSUMED: [&str; 7] = [
    "frames.v1.json",
    "handshake.v1.json",
    "tokens.v1.json",
    "adverts.v1.json",
    "invalid-frames.v1.json",
    SECURE_CHANNEL_FILE,
    MINT_FILE,
];

/// The vector file whose `secure_channel` section [`secure_channel`] checks.
const SECURE_CHANNEL_FILE: &str = "secure-channel.v1.json";

/// The vector file whose `mint` section [`mint`] checks.
const MINT_FILE: &str = "mint.v1.json";

/// The top-level keys every consumed file may carry: the ones `validate_vector_file` reads.
const CONSUMED_KEYS: [&str; 3] = ["protocol_version", "description", "vectors"];

/// The top-level section a file carries besides the shared keys, with the file that carries it.
const SECTIONS: [(&str, &str); 2] = [(SECURE_CHANNEL_FILE, "secure_channel"), (MINT_FILE, "mint")];

/// Vector files this binary does not check yet, each with the issue that tracks checking it. The run reports them as not consumed and fails if a file is missing from here and from [`CONSUMED`].
const NOT_YET_CONSUMED: [(&str, &str); 0] = [];

/// Every `*.v1.json` in `dir`, by file name.
fn vector_files_in(dir: &std::path::Path) -> Vec<String> {
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()))
        .map(|entry| {
            entry
                .unwrap_or_else(|e| panic!("cannot read an entry of {}: {e}", dir.display()))
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .filter(|name| name.ends_with(".v1.json"))
        .collect();
    found.sort();
    found
}

/// What is wrong with how the files in the directory are accounted for: a file nobody checks or lists, and a listed file that is not there. Empty when every file is consumed or registered.
fn accounting_problems(
    present: &[String],
    consumed: &[&str],
    not_yet: &[(&str, &str)],
) -> Vec<String> {
    let mut problems = Vec::new();
    for file in present {
        let is_consumed = consumed.contains(&file.as_str());
        let registered = not_yet.iter().any(|(name, _)| name == file);
        if !is_consumed && !registered {
            problems.push(format!(
                "{file} is neither consumed by this binary nor listed in NOT_YET_CONSUMED"
            ));
        }
        if is_consumed && registered {
            problems.push(format!(
                "{file} is both consumed and listed as not yet consumed"
            ));
        }
    }
    for name in consumed.iter().chain(not_yet.iter().map(|(name, _)| name)) {
        if !present.iter().any(|file| file == name) {
            problems.push(format!("{name} is listed but there is no such file"));
        }
    }
    problems
}

/// The directory the vector files are read from, resolved from `CARGO_MANIFEST_DIR` so the working directory never matters.
fn vector_dir() -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "..", "..", "..", "conformance"]
        .into_iter()
        .collect()
}

/// What is wrong with the accounting of the real `conformance/` directory against [`CONSUMED`] and [`NOT_YET_CONSUMED`].
fn directory_problems() -> Vec<String> {
    accounting_problems(
        &vector_files_in(&vector_dir()),
        &CONSUMED,
        &NOT_YET_CONSUMED,
    )
}

/// The first top-level key of a vector file that this binary does not read.
fn unread_top_level_key<'a>(parsed: &'a serde_json::Value, file: &str) -> Option<&'a str> {
    parsed.as_object()?.keys().map(String::as_str).find(|key| {
        !CONSUMED_KEYS.contains(key)
            && !SECTIONS
                .iter()
                .any(|(section_file, section)| *section_file == file && section == key)
    })
}

#[tokio::main]
async fn main() {
    let vector_dir = vector_dir();
    let files = CONSUMED;
    let problems = directory_problems();
    if !problems.is_empty() {
        for problem in &problems {
            eprintln!("{problem}");
        }
        std::process::exit(1);
    }
    for (file, issue) in NOT_YET_CONSUMED {
        println!("NOT CONSUMED  {file} (tracked in {issue})");
    }
    // Any identity will do as a verifier: a peer-advert is self-certifying, so it is checked against the key it carries and this one's own key is never involved.
    let verifier = NodeIdentity::generate_ed25519();
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
        let wires: HashMap<String, Vec<u8>> = vectors
            .iter()
            .map(|v| {
                decode_hex(&v.wire_hex)
                    .map(|bytes| (v.name.clone(), bytes))
                    .unwrap_or_else(|e| panic!("{file}:{}: {e}", v.name))
            })
            .collect();
        for vector in vectors {
            total += 1;
            let name = vector.name.clone();
            let outcome = check_vector(file, vector, &verifier).await;
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
        if let Some((_, section_key)) = SECTIONS
            .iter()
            .find(|(section_file, _)| *section_file == file)
        {
            let section = parsed
                .get(*section_key)
                .unwrap_or_else(|| panic!("{file} has no {section_key} section"));
            let outcomes = if file == MINT_FILE {
                mint::check_section(section, &wires).await
            } else {
                secure_channel::check_section(section, &wires).await
            };
            for (name, outcome) in outcomes {
                total += 1;
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
    /// adverts.v1.json only: the exact bytes an advert's signature covers, and the verdict a conformant verifier must reach. Both are absent from every other vector file, which has nothing beyond its own wire bytes to pin.
    advert: Option<AdvertExpectations>,
    /// invalid-frames.v1.json only: what the bytes are, the CDDL rule whose pattern their value breaks, and the same bytes with a valid value. Every vector in that file must be refused, at decoding or at validation, and its control accepted.
    invalid: Option<InvalidExpectations>,
}

struct InvalidExpectations {
    /// `frame` or `token-claims`.
    kind: String,
    pattern: String,
    control_wire_hex: String,
}

struct AdvertExpectations {
    signing_input_hex: String,
    verifies: bool,
}

fn validate_vector_file(parsed: &serde_json::Value, file: &str) -> Vec<Vector> {
    let fail = |what: &str| -> ! { panic!("{file} is not a valid vector file: {what}") };
    if let Some(key) = unread_top_level_key(parsed, file) {
        fail(&format!("top-level key {key} is not read by this binary"));
    }
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
            advert: if file == "adverts.v1.json" {
                Some(AdvertExpectations {
                    signing_input_hex: v
                        .get("signing_input_hex")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_else(|| fail("advert vector missing signing_input_hex"))
                        .to_owned(),
                    verifies: v
                        .get("verifies")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or_else(|| fail("advert vector missing verifies")),
                })
            } else {
                None
            },
            invalid: if file == "invalid-frames.v1.json" {
                if v.get("refused").and_then(serde_json::Value::as_bool) != Some(true) {
                    fail("invalid-frame vector missing refused: true");
                }
                let text = |key: &str| -> String {
                    v.get(key)
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_else(|| fail(&format!("invalid-frame vector missing {key}")))
                        .to_owned()
                };
                Some(InvalidExpectations {
                    kind: text("kind"),
                    pattern: text("pattern"),
                    control_wire_hex: text("valid_control_wire_hex"),
                })
            } else {
                None
            },
        })
        .collect()
}

async fn check_vector(file: &str, vector: Vector, verifier: &NodeIdentity) -> Result<(), String> {
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
        SECURE_CHANNEL_FILE => match decode_frame(&expected) {
            Ok(frame) => {
                frame
                    .validate()
                    .map_err(|e| format!("frame validation failed: {e}"))?;
                report_first_divergence(&expected, &encode_frame(&frame))?;
            }
            // A hello whose ephemeral key is not 65 bytes is refused where the frame is decoded, which the spec allows (the establish verdicts require the refusal, whichever stage gives it). Only that refusal is let through, so any other decode failure still fails the vector; the message-to-wire loop below still pins its bytes.
            Err(DecodeError::InvalidLength {
                field: "ephemeral-key",
                ..
            }) if vector.name.starts_with("establish_") => {}
            Err(e) => return Err(format!("typed decode failed: {e}")),
        },
        MINT_FILE => {
            // Tokens and revocation entries alike are COSE_Sign1 structures: what a mint produced decodes and re-encodes to the same bytes.
            let cose = CoseSign1::decode_bytes(&expected)
                .map_err(|e| format!("COSE decode failed: {e}"))?;
            report_first_divergence(&expected, &cose.encode_to_vec())?;
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
        "adverts.v1.json" => {
            let advert: PeerAdvert =
                minicbor::decode(&expected).map_err(|e| format!("typed decode failed: {e}"))?;
            let actual = minicbor::to_vec(&advert).map_err(|e| e.to_string())?;
            report_first_divergence(&expected, &actual)?;
            let expectations = vector
                .advert
                .as_ref()
                .ok_or("advert vector carries no expectations")?;
            // The frozen signing input is the actual interoperability surface: an implementation that reconstructs it even one byte differently rejects every advert another implementation sends, while still passing all of its own tests.
            let signing_input = peer_advert_signing_input(&advert);
            let expected_signing_input = decode_hex(&expectations.signing_input_hex)?;
            report_first_divergence(&expected_signing_input, &signing_input)?;
            let verdict = verify_peer_advert(verifier, &advert).await;
            let verifies = verdict == PeerAdvertVerdict::Valid;
            if verifies != expectations.verifies {
                return Err(format!(
                    "verdict mismatch: expected verifies={}, got {verdict:?}",
                    expectations.verifies
                ));
            }
        }
        "invalid-frames.v1.json" => {
            let invalid = vector
                .invalid
                .as_ref()
                .ok_or_else(|| "invalid-frame vector without its expectations".to_owned())?;
            let control = decode_hex(&invalid.control_wire_hex)?;
            // Refused at decoding or at validation: either way nothing comes out of these bytes. The control, the same bytes with a valid value, must come out, so the refusal is the pattern's.
            let (refused, control_accepted) = match invalid.kind.as_str() {
                "frame" => (
                    decode_frame(&expected)
                        .ok()
                        .is_none_or(|frame| frame.validate().is_err()),
                    decode_frame(&control)
                        .ok()
                        .is_some_and(|frame| frame.validate().is_ok()),
                ),
                "token-claims" => (
                    TokenClaims::decode_bytes(&expected)
                        .ok()
                        .is_none_or(|claims| claims.validate_verbs().is_err()),
                    TokenClaims::decode_bytes(&control)
                        .ok()
                        .is_some_and(|claims| claims.validate_verbs().is_ok()),
                ),
                other => return Err(format!("unknown invalid-vector kind {other}")),
            };
            if !refused {
                return Err(format!("a value breaking {} was accepted", invalid.pattern));
            }
            if !control_accepted {
                return Err(format!(
                    "the valid control for {} was refused, so the refusal may not be the pattern's",
                    invalid.pattern
                ));
            }
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
        "bytes diverge from the expected bytes at byte {offset}{length_note}\n  expected: {}\n  actual:   {}",
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
    if !hex.len().is_multiple_of(2) {
        return Err(format!("hex string has odd length {}", hex.len()));
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    let bytes = hex.as_bytes();
    // The length is even (checked above), so there is no remainder.
    let (pairs, _) = bytes.as_chunks::<2>();
    for pair in pairs {
        let high = (pair[0] as char).to_digit(16).ok_or_else(|| {
            format!(
                "invalid hex byte '{}'",
                String::from_utf8_lossy(pair.as_slice())
            )
        })?;
        let low = (pair[1] as char).to_digit(16).ok_or_else(|| {
            format!(
                "invalid hex byte '{}'",
                String::from_utf8_lossy(pair.as_slice())
            )
        })?;
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

    fn names(files: &[&str]) -> Vec<String> {
        files.iter().map(|file| (*file).to_owned()).collect()
    }

    #[test]
    fn a_file_that_is_neither_consumed_nor_listed_is_reported() {
        let problems =
            accounting_problems(&names(&["a.v1.json", "b.v1.json"]), &["a.v1.json"], &[]);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("b.v1.json"));
    }

    #[test]
    fn a_listed_file_that_is_missing_is_reported() {
        let problems = accounting_problems(
            &names(&["a.v1.json"]),
            &["a.v1.json"],
            &[("gone.v1.json", "x/y#1")],
        );
        assert_eq!(problems.len(), 1);
        assert!(problems[0].starts_with("gone.v1.json"));
    }

    #[test]
    fn a_file_both_consumed_and_listed_is_reported() {
        let problems = accounting_problems(
            &names(&["a.v1.json"]),
            &["a.v1.json"],
            &[("a.v1.json", "x/y#1")],
        );
        assert_eq!(problems.len(), 1);
    }

    #[test]
    fn consumed_and_registered_files_are_accepted() {
        let problems = accounting_problems(
            &names(&["a.v1.json", "b.v1.json"]),
            &["a.v1.json"],
            &[("b.v1.json", "x/y#1")],
        );
        assert!(problems.is_empty());
    }

    #[test]
    fn the_real_directory_is_fully_accounted_for() {
        assert_eq!(directory_problems(), Vec::<String>::new());
    }

    #[test]
    fn a_top_level_key_the_binary_does_not_read_is_found() {
        let with_extra = serde_json::json!({
            "protocol_version": 1,
            "description": "d",
            "vectors": [],
            "extra_section": {},
        });
        assert_eq!(
            unread_top_level_key(&with_extra, "frames.v1.json"),
            Some("extra_section")
        );
        let plain = serde_json::json!({ "protocol_version": 1, "description": "d", "vectors": [] });
        assert_eq!(unread_top_level_key(&plain, "frames.v1.json"), None);
    }

    #[test]
    fn the_secure_channel_section_is_read_only_for_its_own_file() {
        let with_section = serde_json::json!({
            "protocol_version": 1,
            "description": "d",
            "vectors": [],
            "secure_channel": {},
        });
        assert_eq!(
            unread_top_level_key(&with_section, SECURE_CHANNEL_FILE),
            None
        );
        assert_eq!(
            unread_top_level_key(&with_section, "frames.v1.json"),
            Some("secure_channel")
        );
    }
}
