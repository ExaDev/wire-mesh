//! The `room_params` section of `room-params.v1.json`: every typed frame is decoded as the shape the file names and each field compared, every frame that breaks a rule of a shape is refused, and the room-path and hex helpers are run against their cases.

use std::collections::HashMap;

use serde_json::{json, Value};
use wire_mesh_core::domain::room_path::{
    bytes_from_hex, bytes_to_hex, dm_room_path, owner_named_room_path, parse_room_path,
    slug_room_name, ParsedRoomPath, RoomPathError,
};
use wire_mesh_wire::management::{ManageOutcome, ManageParams};
use wire_mesh_wire::room_params::{CapabilityGrantOk, RoomJoinOk, RoomMember, RoomMembersOk};
use wire_mesh_wire::{decode_frame, minicbor, Extra, Frame};

use super::obj::{Check, Obj};

/// The layout of the `room_params` section this binary reads.
const LAYOUT_VERSION: i64 = 1;

const SHAPES: [&str; 8] = [
    "room.send",
    "room.read",
    "room.leave",
    "room.invite",
    "capability.request",
    "room-join-ok",
    "room-members-ok",
    "capability-grant-ok",
];

struct Typed {
    vector: String,
    shape: String,
    fields: Value,
}

struct Refused {
    name: String,
    shape: String,
    control: String,
    /// The TypeScript schema accepts the frame, so only this binary checks that it is refused.
    rust_only: bool,
    frame: Vec<u8>,
}

struct Section {
    typed: Vec<Typed>,
    refused: Vec<Refused>,
    path: Value,
}

fn extra_keys(extra: &Extra) -> Vec<String> {
    let mut keys: Vec<String> = extra.iter().map(|(key, _)| key.clone()).collect();
    keys.sort();
    keys
}

fn member(member: &RoomMember) -> Value {
    json!({
        "device_hex": bytes_to_hex(&member.device.0),
        "extra_keys": extra_keys(&member.extra),
    })
}

/// A typed value as the file records its fields, with the keys of its open tail under `extra_keys`.
fn project_params(params: &ManageParams) -> Option<(&'static str, Value)> {
    match params {
        ManageParams::RoomSend(p) => Some((
            "room.send",
            json!({
                "message_id_hex": bytes_to_hex(&p.message_id),
                "sent_at": p.sent_at,
                "text": p.text,
                "content_type": p.content_type,
                "refs": p.refs.as_ref().map(|refs| refs.iter().map(|r| json!({
                    "id_hex": bytes_to_hex(&r.id),
                    "relation": r.relation,
                })).collect::<Vec<_>>()),
                "extra_keys": extra_keys(&p.extra),
            }),
        )),
        ManageParams::RoomRead(p) => Some((
            "room.read",
            json!({
                "messages_hex": p.messages.iter().map(|m| bytes_to_hex(m)).collect::<Vec<_>>(),
                "at": p.at,
                "extra_keys": extra_keys(&p.extra),
            }),
        )),
        ManageParams::RoomLeave(p) => {
            Some(("room.leave", json!({ "extra_keys": extra_keys(&p.extra) })))
        }
        ManageParams::RoomInvite(p) => Some((
            "room.invite",
            json!({
                "invitee_hex": bytes_to_hex(&p.invitee.0),
                "token_wire_hex": bytes_to_hex(&p.token.encode_to_vec()),
                "extra_keys": extra_keys(&p.extra),
            }),
        )),
        ManageParams::CapabilityRequest(p) => Some((
            "capability.request",
            json!({
                "capability": p.capability,
                "valid_until": p.valid_until,
                "extra_keys": extra_keys(&p.extra),
            }),
        )),
        _ => None,
    }
}

/// The typed outcome of `shape` read from a decoded `manage-ok`, projected as the file records it.
fn project_outcome(
    shape: &str,
    ok: &wire_mesh_wire::management::ManageOk,
) -> Result<Value, String> {
    match shape {
        "room-join-ok" => {
            let typed = RoomJoinOk::from_ok(ok).map_err(|e| e.to_string())?;
            Ok(json!({
                "granted_token_wire_hex": bytes_to_hex(&typed.granted_token.encode_to_vec()),
                "members": typed.members.iter().map(member).collect::<Vec<_>>(),
                "extra_keys": extra_keys(&typed.extra),
            }))
        }
        "room-members-ok" => {
            let typed = RoomMembersOk::from_ok(ok).map_err(|e| e.to_string())?;
            Ok(json!({
                "members": typed.members.iter().map(member).collect::<Vec<_>>(),
                "extra_keys": extra_keys(&typed.extra),
            }))
        }
        "capability-grant-ok" => {
            let typed = CapabilityGrantOk::from_ok(ok).map_err(|e| e.to_string())?;
            Ok(json!({
                "granted_token_wire_hex": bytes_to_hex(&typed.granted_token.encode_to_vec()),
                "extra_keys": extra_keys(&typed.extra),
            }))
        }
        other => Err(format!("{other} is not an outcome shape")),
    }
}

/// What a frame decodes to, as the file records it: the shape and its fields.
fn project_frame(wire: &[u8]) -> Result<(String, Value), String> {
    match decode_frame(wire).map_err(|e| format!("does not decode: {e}"))? {
        Frame::ManageRequest(request) => project_params(&request.command.params)
            .map(|(shape, fields)| (shape.to_owned(), fields))
            .ok_or_else(|| "the params are not a typed room or capability shape".to_owned()),
        Frame::ManageResponse(response) => match &response.outcome {
            ManageOutcome::Ok(ok) => {
                for shape in ["room-join-ok", "room-members-ok", "capability-grant-ok"] {
                    if let Ok(fields) = project_outcome(shape, ok) {
                        return Ok((shape.to_owned(), fields));
                    }
                }
                Err("the outcome is not a typed room or capability shape".to_owned())
            }
            ManageOutcome::Error(_) => Err("the outcome is an error".to_owned()),
        },
        _ => Err("not a manage frame".to_owned()),
    }
}

fn check_typed(typed: &Typed, wires: &HashMap<String, Vec<u8>>) -> Check {
    let wire = wires
        .get(&typed.vector)
        .ok_or_else(|| format!("no vector named {}", typed.vector))?;
    let (shape, fields) = project_frame(wire)?;
    if shape != typed.shape {
        return Err(format!("expected the shape {}, got {shape}", typed.shape));
    }
    let expected = normalise(&typed.fields);
    let got = normalise(&fields);
    if got != expected {
        return Err(format!("expected the fields {expected}, got {got}"));
    }
    // The typed value re-encodes to the bytes it was read from.
    reencode(&typed.shape, wire)
}

/// Sorts every `extra_keys` list so the comparison does not depend on the order the file lists them in.
fn normalise(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    if key == "extra_keys" {
                        let mut keys: Vec<Value> = item.as_array().cloned().unwrap_or_default();
                        keys.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
                        (key.clone(), Value::Array(keys))
                    } else {
                        (key.clone(), normalise(item))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(normalise).collect()),
        other => other.clone(),
    }
}

fn reencode(shape: &str, wire: &[u8]) -> Check {
    let frame = decode_frame(wire).map_err(|e| e.to_string())?;
    let encoded = wire_mesh_wire::encode_frame(&frame);
    super::report_first_divergence(wire, &encoded)?;
    // The typed value alone re-encodes to its own bytes: the type owns its encoding, not only the frame around it.
    match frame {
        Frame::ManageRequest(request) => {
            let params = &request.command.params;
            let own = minicbor::to_vec(params).map_err(|e| e.to_string())?;
            let back: ManageParams = minicbor::decode(&own).map_err(|e| e.to_string())?;
            if back != *params {
                return Err(format!("{shape} does not survive its own encoding"));
            }
            Ok(())
        }
        Frame::ManageResponse(response) => match &response.outcome {
            ManageOutcome::Ok(ok) => {
                let again = match shape {
                    "room-join-ok" => RoomJoinOk::from_ok(ok).map(|t| t.into_ok()),
                    "room-members-ok" => RoomMembersOk::from_ok(ok).map(|t| t.into_ok()),
                    _ => CapabilityGrantOk::from_ok(ok).map(|t| t.into_ok()),
                }
                .map_err(|e| e.to_string())?;
                if again != *ok {
                    return Err(format!("{shape} does not survive its own encoding"));
                }
                Ok(())
            }
            ManageOutcome::Error(_) => Err("an error outcome".to_owned()),
        },
        _ => Err("not a manage frame".to_owned()),
    }
}

fn check_refused(refused: &Refused, section: &Section, wires: &HashMap<String, Vec<u8>>) -> Check {
    let control = section
        .typed
        .iter()
        .find(|typed| typed.vector == refused.control)
        .ok_or_else(|| format!("the control {} is not a typed vector", refused.control))?;
    if control.shape != refused.shape {
        return Err(format!(
            "the control {} is a different shape",
            control.vector
        ));
    }
    check_typed(control, wires)?;
    let outcome_shape = refused.shape.ends_with("-ok");
    let verdict = match decode_frame(&refused.frame) {
        Err(_) if !outcome_shape => Ok(()),
        Err(e) => Err(format!("an outcome frame did not decode at all: {e}")),
        Ok(Frame::ManageRequest(request)) if !outcome_shape => {
            match project_params(&request.command.params) {
                Some(_) => Err("the frame was read as a typed shape".to_owned()),
                None => {
                    Err("the frame decoded, but not as a typed shape or as a refusal".to_owned())
                }
            }
        }
        Ok(Frame::ManageResponse(response)) if outcome_shape => match &response.outcome {
            ManageOutcome::Ok(ok) => match project_outcome(&refused.shape, ok) {
                Err(_) => Ok(()),
                Ok(_) => Err("the outcome was read as the typed shape".to_owned()),
            },
            ManageOutcome::Error(_) => Err("an error outcome".to_owned()),
        },
        Ok(_) => Err("the frame is of the wrong kind".to_owned()),
    };
    verdict.map_err(|reason| {
        if refused.rust_only {
            format!("{reason} (the TypeScript schema accepts this frame, and this binary must still refuse it)")
        } else {
            reason
        }
    })
}

fn error_name(error: RoomPathError) -> &'static str {
    error.as_str()
}

fn path_expectation(mut obj: Obj) -> Result<Result<String, String>, String> {
    let result = if obj.map.contains_key("path") {
        Ok(obj.string("path")?)
    } else {
        Err(obj.string("error")?)
    };
    obj.finish()?;
    Ok(result)
}

fn parse_section(value: &Value) -> Result<(Section, Counts), String> {
    let mut root = Obj::new(value, "room_params")?;
    if root.integer("layout_version")? != LAYOUT_VERSION {
        return Err(format!(
            "room_params.layout_version is not {LAYOUT_VERSION}"
        ));
    }
    let mut typed = Vec::new();
    for mut obj in root.objects("typed")? {
        let vector = obj.string("vector")?;
        let shape = obj.string("shape")?;
        let fields = obj.take("fields")?;
        obj.finish()?;
        typed.push(Typed {
            vector,
            shape,
            fields,
        });
    }
    let mut refused = Vec::new();
    for mut obj in root.objects("refused")? {
        let item = Refused {
            name: obj.string("name")?,
            shape: obj.string("shape")?,
            control: obj.string("control")?,
            rust_only: obj.boolean("rust_only")?,
            frame: obj.hex("frame_wire_hex")?,
        };
        obj.finish()?;
        refused.push(item);
    }
    let path = root.take("room_path")?;
    let mut counts = root.object("counts")?;
    let counted = Counts {
        typed: counts.unsigned("typed")?,
        refused: counts.unsigned("refused")?,
        bytes: counts.unsigned("bytes")?,
        bytes_refused: counts.unsigned("bytes_refused")?,
        owner_named: counts.unsigned("owner_named")?,
        dm: counts.unsigned("dm")?,
        parse: counts.unsigned("parse")?,
        slug: counts.unsigned("slug")?,
    };
    counts.finish()?;
    root.finish()?;
    let section = Section {
        typed,
        refused,
        path,
    };
    for shape in SHAPES {
        if !section.typed.iter().any(|entry| entry.shape == shape) {
            return Err(format!("no typed vector of the shape {shape}"));
        }
    }
    Ok((section, counted))
}

struct Counts {
    typed: u64,
    refused: u64,
    bytes: u64,
    bytes_refused: u64,
    owner_named: u64,
    dm: u64,
    parse: u64,
    slug: u64,
}

/// Runs every case of the room-path section.
fn path_results(path: &Value, counts: &Counts) -> Result<Vec<(String, Check)>, String> {
    let mut root = Obj::new(path, "room_params.room_path")?;
    let mut results: Vec<(String, Check)> = Vec::new();
    let mut seen_errors: Vec<String> = Vec::new();

    let bytes = root.objects("bytes")?;
    let bytes_len = bytes.len() as u64;
    for mut obj in bytes {
        let name = obj.string("name")?;
        let hex = obj.string("bytes_hex")?;
        obj.finish()?;
        let check = match bytes_from_hex(&hex) {
            Some(decoded) if bytes_to_hex(&decoded) == hex => Ok(()),
            Some(_) => Err("the bytes did not encode back to the text".to_owned()),
            None => Err("a valid hex text was refused".to_owned()),
        };
        results.push((format!("room_params:hex:{name}"), check));
    }
    let refused = root.objects("bytes_refused")?;
    let refused_len = refused.len() as u64;
    for mut obj in refused {
        let name = obj.string("name")?;
        let text = obj.string("text")?;
        obj.finish()?;
        let check = match bytes_from_hex(&text) {
            None => Ok(()),
            Some(_) => Err("a malformed hex text was accepted".to_owned()),
        };
        results.push((format!("room_params:hex_refused:{name}"), check));
    }

    let owner_named = root.objects("owner_named")?;
    let owner_len = owner_named.len() as u64;
    for mut obj in owner_named {
        let name = obj.string("name")?;
        let owner = obj.string("owner")?;
        let local = obj.string("local_name")?;
        let expected = path_expectation(obj.object("expected")?)?;
        obj.finish()?;
        let got = owner_named_room_path(&owner, &local).map(|p| p.as_str().to_owned());
        if let Err(error) = &got {
            seen_errors.push(error_name(*error).to_owned());
        }
        results.push((
            format!("room_params:owner_named:{name}"),
            compare_path(&expected, &got),
        ));
    }
    let dm = root.objects("dm")?;
    let dm_len = dm.len() as u64;
    for mut obj in dm {
        let name = obj.string("name")?;
        let a = obj.string("a")?;
        let b = obj.string("b")?;
        let expected = path_expectation(obj.object("expected")?)?;
        obj.finish()?;
        let got = dm_room_path(&a, &b).map(|p| p.as_str().to_owned());
        if let Err(error) = &got {
            seen_errors.push(error_name(*error).to_owned());
        }
        results.push((
            format!("room_params:dm:{name}"),
            compare_path(&expected, &got),
        ));
    }
    let parse = root.objects("parse")?;
    let parse_len = parse.len() as u64;
    for mut obj in parse {
        let name = obj.string("name")?;
        let path_text = obj.string("path")?;
        let mut expected = obj.object("expected")?;
        let check = if expected.map.contains_key("error") {
            let reason = expected.string("error")?;
            seen_errors.push(reason.clone());
            match parse_room_path(&path_text) {
                None if reason == RoomPathError::NotARoomPath.as_str() => Ok(()),
                None => Err(format!("refused, but the file names {reason}")),
                Some(parsed) => Err(format!("expected a refusal, got {parsed:?}")),
            }
        } else {
            let kind = expected.string("kind")?;
            let want = if kind == "owner_named" {
                ParsedRoomPath::OwnerNamed {
                    owner: expected.string("owner")?,
                    local_name: expected.string("local_name")?,
                }
            } else {
                ParsedRoomPath::Dm {
                    participants: (expected.string("first")?, expected.string("second")?),
                }
            };
            match parse_room_path(&path_text) {
                Some(parsed) if parsed == want => Ok(()),
                other => Err(format!("expected {want:?}, got {other:?}")),
            }
        };
        expected.finish()?;
        obj.finish()?;
        results.push((format!("room_params:parse:{name}"), check));
    }
    let slug = root.objects("slug")?;
    let slug_len = slug.len() as u64;
    for mut obj in slug {
        let name = obj.string("name")?;
        let input = obj.string("input")?;
        let expected = obj.object("expected")?;
        let want = path_expectation_slug(expected)?;
        obj.finish()?;
        let got = slug_room_name(&input);
        if let Err(error) = &got {
            seen_errors.push(error_name(*error).to_owned());
        }
        let check = match (&want, &got) {
            (Ok(slug), Ok(held)) if slug == held => Ok(()),
            (Err(reason), Err(error)) if reason == error.as_str() => Ok(()),
            _ => Err(format!("expected {want:?}, got {got:?}")),
        };
        results.push((format!("room_params:slug:{name}"), check));
    }
    root.finish()?;

    for (name, said, held) in [
        ("bytes", counts.bytes, bytes_len),
        ("bytes_refused", counts.bytes_refused, refused_len),
        ("owner_named", counts.owner_named, owner_len),
        ("dm", counts.dm, dm_len),
        ("parse", counts.parse, parse_len),
        ("slug", counts.slug, slug_len),
    ] {
        if said != held {
            return Err(format!(
                "room_params.counts.{name} says {said} and the list holds {held}"
            ));
        }
    }
    for error in RoomPathError::ALL {
        if !seen_errors.iter().any(|seen| seen == error.as_str()) {
            return Err(format!("no case expects the error {}", error.as_str()));
        }
    }
    Ok(results)
}

fn path_expectation_slug(mut obj: Obj) -> Result<Result<String, String>, String> {
    let result = if obj.map.contains_key("slug") {
        Ok(obj.string("slug")?)
    } else {
        Err(obj.string("error")?)
    };
    obj.finish()?;
    Ok(result)
}

fn compare_path(expected: &Result<String, String>, got: &Result<String, RoomPathError>) -> Check {
    match (expected, got) {
        (Ok(path), Ok(held)) if path == held => Ok(()),
        (Err(reason), Err(error)) if reason == error.as_str() => Ok(()),
        _ => Err(format!("expected {expected:?}, got {got:?}")),
    }
}

/// Runs every check of the section and names each, so the binary reports them like any other vector.
pub fn check_section(value: &Value, wires: &HashMap<String, Vec<u8>>) -> Vec<(String, Check)> {
    let parsed = parse_section(value);
    let (section, counts) = match parsed {
        Ok(parsed) => parsed,
        Err(e) => panic!("room-params.v1.json is not a valid vector file: {e}"),
    };
    for (name, said, held) in [
        ("typed", counts.typed, section.typed.len() as u64),
        ("refused", counts.refused, section.refused.len() as u64),
    ] {
        assert!(
            said == held,
            "room-params.v1.json: counts.{name} says {said} and the list holds {held}"
        );
    }
    let mut results = Vec::new();
    for typed in &section.typed {
        results.push((
            format!("room_params:typed:{}", typed.vector),
            check_typed(typed, wires),
        ));
    }
    for refused in &section.refused {
        results.push((
            format!("room_params:refused:{}", refused.name),
            check_refused(refused, &section, wires),
        ));
    }
    match path_results(&section.path, &counts) {
        Ok(more) => results.extend(more),
        Err(e) => panic!("room-params.v1.json is not a valid vector file: {e}"),
    }
    results
}
