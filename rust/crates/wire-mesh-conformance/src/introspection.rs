//! The `introspection` section of `introspection.v1.json`: every typed frame is read as the shape the file names and each field compared, every frame that breaks a rule of a shape is refused, and the path-trace and topology functions are run against a scripted peer and clock and against the adverts of the file.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use wire_mesh_core::domain::path_trace::{
    build_path_trace_command, build_path_trace_response, path_trace_scope, trace_path,
    ManageRequestSender, PathTraceError, TracePath,
};
use wire_mesh_core::domain::topology::{
    assemble_topology_graph, read_topology_peers, send_topology_get, DirectoryEntry, TopologyEdge,
    TopologyGetError,
};
use wire_mesh_core::ports::{Clock, CoreError};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::introspection::{
    PathTrace, PathTraceOk, TopologyGet, TopologyGetOk, TopologyPeers,
};
use wire_mesh_wire::management::{ManageCommand, ManageOutcome, ManageParams};
use wire_mesh_wire::tokens::{CapabilityScope, CoseSign1};
use wire_mesh_wire::transport::PeerAdvert;
use wire_mesh_wire::{decode_frame, Frame};

use super::obj::{Check, Obj};

/// The layout of the `introspection` section this binary reads.
const LAYOUT_VERSION: i64 = 1;

const SHAPES: [&str; 4] = [
    "path.trace",
    "topology.get",
    "path-trace-ok",
    "topology-get-ok",
];

type Wires = HashMap<String, Vec<u8>>;

fn wire<'a>(wires: &'a Wires, name: &str) -> Result<&'a [u8], String> {
    wires
        .get(name)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("no vector named {name}"))
}

fn outcome_of(wires: &Wires, name: &str) -> Result<ManageOutcome, String> {
    match decode_frame(wire(wires, name)?).map_err(|e| format!("{name} does not decode: {e}"))? {
        Frame::ManageResponse(response) => Ok(response.outcome),
        _ => Err(format!("{name} is not a manage-response")),
    }
}

fn advert_of(wires: &Wires, name: &str) -> Result<PeerAdvert, String> {
    match decode_frame(wire(wires, name)?).map_err(|e| format!("{name} does not decode: {e}"))? {
        Frame::Gossip(gossip) => gossip
            .peers
            .into_iter()
            .next()
            .ok_or_else(|| format!("{name} holds no advert")),
        _ => Err(format!("{name} is not a gossip frame")),
    }
}

fn peers_json(peers: &TopologyPeers) -> Value {
    json!({
        "direct_hex": peers.direct.iter().map(|d| hex(&d.0)).collect::<Vec<_>>(),
        "relayed": peers.relayed.iter().map(|r| json!({
            "device_hex": hex(&r.device.0),
            "via_hex": r.via.as_ref().map(|v| hex(&v.0)),
        })).collect::<Vec<_>>(),
    })
}

fn hex(bytes: &[u8]) -> String {
    wire_mesh_core::domain::room_path::bytes_to_hex(bytes)
}

fn extra_keys(extra: &wire_mesh_wire::Extra) -> Vec<String> {
    let mut keys: Vec<String> = extra.iter().map(|(key, _)| key.clone()).collect();
    keys.sort();
    keys
}

/// A typed frame as the file records it: the shape and the fields, with the keys of the open tail under `extra_keys`.
fn project(shape: &str, wire_bytes: &[u8]) -> Result<Value, String> {
    let frame = decode_frame(wire_bytes).map_err(|e| format!("does not decode: {e}"))?;
    match (shape, frame) {
        ("path.trace", Frame::ManageRequest(request)) => match request.command.params {
            ManageParams::PathTrace(PathTrace) => Ok(json!({})),
            _ => Err("read as another shape".to_owned()),
        },
        ("topology.get", Frame::ManageRequest(request)) => match request.command.params {
            ManageParams::TopologyGet(TopologyGet) => Ok(json!({})),
            _ => Err("read as another shape".to_owned()),
        },
        ("path-trace-ok", Frame::ManageResponse(response)) => match &response.outcome {
            ManageOutcome::Ok(ok) => {
                let typed = PathTraceOk::from_ok(ok).map_err(|e| e.to_string())?;
                Ok(json!({
                    "relayed": typed.relayed,
                    "hub_address": typed.hub_address,
                    "extra_keys": extra_keys(&typed.extra),
                }))
            }
            ManageOutcome::Error(_) => Err("an error outcome".to_owned()),
        },
        ("topology-get-ok", Frame::ManageResponse(response)) => match &response.outcome {
            ManageOutcome::Ok(ok) => {
                let typed = TopologyGetOk::from_ok(ok).map_err(|e| e.to_string())?;
                Ok(json!({
                    "peers": peers_json(&typed.peers),
                    "extra_keys": extra_keys(&typed.extra),
                }))
            }
            ManageOutcome::Error(_) => Err("an error outcome".to_owned()),
        },
        (other, _) => Err(format!("{other} is not read from this kind of frame")),
    }
}

fn sorted_keys(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| {
                    if key == "extra_keys" {
                        let mut keys: Vec<Value> = item.as_array().cloned().unwrap_or_default();
                        keys.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
                        (key.clone(), Value::Array(keys))
                    } else {
                        (key.clone(), sorted_keys(item))
                    }
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(sorted_keys).collect()),
        other => other.clone(),
    }
}

/// What the file records for a typed vector, with the open tail's keys sorted.
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

enum Reply {
    Vector(String),
    Closed,
}

fn reply_of(mut obj: Obj) -> Result<Reply, String> {
    let reply = if obj.map.contains_key("closed") {
        if !obj.boolean("closed")? {
            return Err("closed is not true".to_owned());
        }
        Reply::Closed
    } else {
        Reply::Vector(obj.string("vector")?)
    };
    obj.finish()?;
    Ok(reply)
}

struct Counts {
    typed: u64,
    refused: u64,
    path_trace_responses: u64,
    trace_cases: u64,
    topology_reads: u64,
    topology_graphs: u64,
    topology_get_cases: u64,
}

/// A manage-request sender that answers with a scripted outcome or reports its connection closed.
struct Scripted(Result<ManageOutcome, String>);

#[async_trait::async_trait]
impl ManageRequestSender for Scripted {
    async fn send_manage_request(
        &self,
        _command: ManageCommand,
        _scope: CapabilityScope,
        _token: Option<CoseSign1>,
        _timeout: Option<Duration>,
    ) -> Result<ManageOutcome, CoreError> {
        self.0.clone().map_err(CoreError::Transport)
    }
}

struct Ticks(Mutex<Vec<u64>>);

impl Clock for Ticks {
    fn now_unix_ms(&self) -> u64 {
        let mut ticks = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if ticks.is_empty() {
            0
        } else {
            ticks.remove(0)
        }
    }
}

fn scripted(reply: &Reply, wires: &Wires) -> Result<Scripted, String> {
    Ok(Scripted(match reply {
        Reply::Closed => Err("connection closed".to_owned()),
        Reply::Vector(name) => Ok(outcome_of(wires, name)?),
    }))
}

fn edge_json(edge: &TopologyEdge) -> Value {
    match edge {
        TopologyEdge::Direct { from, to } => json!({
            "kind": "direct", "from_hex": hex(&from.0), "to_hex": hex(&to.0), "via_hex": Value::Null,
        }),
        TopologyEdge::Relay { from, to, via } => json!({
            "kind": "relay", "from_hex": hex(&from.0), "to_hex": hex(&to.0),
            "via_hex": via.as_ref().map(|v| hex(&v.0)),
        }),
    }
}

fn compare(what: &str, got: &Value, expected: &Value) -> Check {
    if got == expected {
        Ok(())
    } else {
        Err(format!("{what}: expected {expected}, got {got}"))
    }
}

async fn check_trace(entry: &mut Obj, wires: &Wires) -> Check {
    let relayed = entry.boolean("relayed")?;
    let local_hub_address = entry.optional_string("local_hub_address")?;
    let clock = Ticks(Mutex::new(entry.unsigneds("clock_ms")?));
    let reply = reply_of(entry.object("reply")?)?;
    let expected = entry.take("expected")?;
    let sender = scripted(&reply, wires)?;
    let result = trace_path(TracePath {
        sender: &sender,
        clock: &clock,
        scope: None,
        token: None,
        timeout: None,
        relayed,
        local_hub_address,
    })
    .await;
    let got = match result {
        Ok(result) => json!({
            "rtt_ms": result.rtt_ms,
            "local": { "relayed": result.local.relayed, "hub_address": result.local.hub_address },
            "remote": result.remote.map(|r| json!({"relayed": r.relayed, "hub_address": r.hub_address})),
            "outcome": match result.outcome { ManageOutcome::Ok(_) => "ok", ManageOutcome::Error(_) => "error" },
        }),
        Err(PathTraceError::Malformed(_)) => json!({ "error": "malformed" }),
        Err(PathTraceError::Send(_)) => json!({ "error": "send" }),
    };
    compare("the trace", &got, &expected)
}

async fn check_get(entry: &mut Obj, wires: &Wires) -> Check {
    let reply = reply_of(entry.object("reply")?)?;
    let expected = entry.take("expected")?;
    let sender = scripted(&reply, wires)?;
    let got = match send_topology_get(&sender, None).await {
        Ok(peers) => json!({ "peers": peers_json(&peers) }),
        Err(TopologyGetError::Refused { code }) => json!({ "error": "refused", "code": code }),
        Err(TopologyGetError::Malformed) => json!({ "error": "malformed" }),
        Err(TopologyGetError::Send(_)) => json!({ "error": "send" }),
    };
    compare("topology.get", &got, &expected)
}

/// Runs every check of the section and names each, so the binary reports them like any other vector.
pub async fn check_section(value: &Value, wires: &Wires) -> Vec<(String, Check)> {
    match run(value, wires).await {
        Ok(results) => results,
        Err(e) => panic!("introspection.v1.json is not a valid vector file: {e}"),
    }
}

async fn run(value: &Value, wires: &Wires) -> Result<Vec<(String, Check)>, String> {
    let mut root = Obj::new(value, "introspection")?;
    if root.integer("layout_version")? != LAYOUT_VERSION {
        return Err(format!(
            "introspection.layout_version is not {LAYOUT_VERSION}"
        ));
    }
    let mut results: Vec<(String, Check)> = Vec::new();

    let mut typed = Vec::new();
    for mut obj in root.objects("typed")? {
        let item = Typed {
            vector: obj.string("vector")?,
            shape: obj.string("shape")?,
            fields: sorted_keys(&obj.take("fields")?),
        };
        obj.finish()?;
        typed.push(item);
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
    for shape in SHAPES {
        if !typed.iter().any(|entry| entry.shape == shape) {
            return Err(format!("no typed vector of the shape {shape}"));
        }
    }
    for entry in &typed {
        let got = wire(wires, &entry.vector).and_then(|bytes| project(&entry.shape, bytes));
        let check = got.and_then(|got| compare("the fields", &sorted_keys(&got), &entry.fields));
        results.push((format!("introspection:typed:{}", entry.vector), check));
    }
    for entry in &refused {
        let control = typed
            .iter()
            .find(|candidate| candidate.vector == entry.control)
            .filter(|candidate| candidate.shape == entry.shape)
            .ok_or_else(|| format!("{} has no control of its shape", entry.name))?;
        let control_read =
            wire(wires, &control.vector).and_then(|bytes| project(&entry.shape, bytes));
        let check = match (control_read, project(&entry.shape, &entry.frame)) {
            (Err(e), _) => Err(format!("the control is refused: {e}")),
            (Ok(_), Err(_)) => Ok(()),
            (Ok(_), Ok(_)) if entry.rust_only => Err(
                "a frame with a key the rule does not name was read as the shape (the TypeScript schema accepts it, and this binary must still refuse it)"
                    .to_owned(),
            ),
            (Ok(_), Ok(_)) => Err("a frame breaking a rule was read as the shape".to_owned()),
        };
        results.push((format!("introspection:refused:{}", entry.name), check));
    }

    let responses = root.objects("path_trace_responses")?;
    let responses_len = responses.len() as u64;
    for mut obj in responses {
        let name = obj.string("name")?;
        let relayed = obj.boolean("relayed")?;
        let hub = obj.optional_string("hub_address")?;
        let vector = obj.string("vector")?;
        obj.finish()?;
        let check = outcome_of(wires, &vector).and_then(|expected| {
            let got = build_path_trace_response(relayed, hub.as_deref());
            if got == expected {
                Ok(())
            } else {
                Err(format!("expected {expected:?}, got {got:?}"))
            }
        });
        results.push((format!("introspection:path_trace_response:{name}"), check));
    }
    // The command and scope the trace sends are fixed.
    let command = build_path_trace_command();
    results.push((
        "introspection:path_trace_command".to_owned(),
        if command.verb.0 == "path:trace" && path_trace_scope().kind == "node" {
            Ok(())
        } else {
            Err("the command or scope is not the registered one".to_owned())
        },
    ));

    let traces = root.objects("trace_cases")?;
    let traces_len = traces.len() as u64;
    for mut obj in traces {
        let name = obj.string("name")?;
        let check = check_trace(&mut obj, wires).await;
        obj.finish()?;
        results.push((format!("introspection:trace:{name}"), check));
    }

    let reads = root.objects("topology_reads")?;
    let reads_len = reads.len() as u64;
    for mut obj in reads {
        let name = obj.string("name")?;
        let vector = obj.string("vector")?;
        let expected = obj.take("expected")?;
        obj.finish()?;
        let check = advert_of(wires, &vector).and_then(|advert| {
            let got = read_topology_peers(&advert).map_or(Value::Null, |peers| peers_json(&peers));
            compare("the topology", &got, &expected)
        });
        results.push((format!("introspection:topology_read:{name}"), check));
    }

    let graphs = root.objects("topology_graphs")?;
    let graphs_len = graphs.len() as u64;
    for mut obj in graphs {
        let name = obj.string("name")?;
        let mut directory = Vec::new();
        for mut member in obj.objects("directory")? {
            let device = DeviceId(member.fixed::<32>("device_hex")?);
            let vector = member.string("vector")?;
            member.finish()?;
            directory.push((device, vector));
        }
        let expected = obj.take("expected")?;
        obj.finish()?;
        let entries: Result<Vec<DirectoryEntry>, String> = directory
            .iter()
            .map(|(device, vector)| {
                Ok(DirectoryEntry {
                    device: *device,
                    advert: advert_of(wires, vector)?,
                })
            })
            .collect();
        let check = entries.and_then(|entries| {
            let graph = assemble_topology_graph(&entries);
            let got = json!({
                "nodes_hex": graph.nodes.iter().map(|n| hex(&n.0)).collect::<Vec<_>>(),
                "edges": graph.edges.iter().map(edge_json).collect::<Vec<_>>(),
            });
            compare("the graph", &got, &expected)
        });
        results.push((format!("introspection:topology_graph:{name}"), check));
    }

    let gets = root.objects("topology_get_cases")?;
    let gets_len = gets.len() as u64;
    for mut obj in gets {
        let name = obj.string("name")?;
        let check = check_get(&mut obj, wires).await;
        obj.finish()?;
        results.push((format!("introspection:topology_get:{name}"), check));
    }

    let mut counts = root.object("counts")?;
    let counted = Counts {
        typed: counts.unsigned("typed")?,
        refused: counts.unsigned("refused")?,
        path_trace_responses: counts.unsigned("path_trace_responses")?,
        trace_cases: counts.unsigned("trace_cases")?,
        topology_reads: counts.unsigned("topology_reads")?,
        topology_graphs: counts.unsigned("topology_graphs")?,
        topology_get_cases: counts.unsigned("topology_get_cases")?,
    };
    counts.finish()?;
    root.finish()?;
    for (name, said, held) in [
        ("typed", counted.typed, typed.len() as u64),
        ("refused", counted.refused, refused.len() as u64),
        (
            "path_trace_responses",
            counted.path_trace_responses,
            responses_len,
        ),
        ("trace_cases", counted.trace_cases, traces_len),
        ("topology_reads", counted.topology_reads, reads_len),
        ("topology_graphs", counted.topology_graphs, graphs_len),
        ("topology_get_cases", counted.topology_get_cases, gets_len),
    ] {
        if said != held {
            return Err(format!(
                "introspection.counts.{name} says {said} and the list holds {held}"
            ));
        }
    }
    Ok(results)
}
