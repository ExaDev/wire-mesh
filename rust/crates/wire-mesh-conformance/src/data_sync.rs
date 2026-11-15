//! The `data_sync` section of `data-sync.v1.json`: every scenario is run step by step against the real data-sync functions over an in-memory store, comparing what each step returns and the whole store after it.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;
use wire_mesh_core::adapters::MemoryStorage;
use wire_mesh_core::domain::data_sync::{
    append_own_entry, handle_data_entries, handle_data_have, handle_data_request, head_seq_for,
    read_entries, AppendError, DataEntriesOutcome,
};
use wire_mesh_core::ports::KeyValueStorage;
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::{decode_frame, Frame};

use super::decode_hex;
use super::obj::{Check, Obj};

/// The layout of the `data_sync` section this binary reads.
const LAYOUT_VERSION: i64 = 1;

type Store = BTreeMap<String, Vec<u8>>;

enum Op {
    HeadSeqFor {
        peer: DeviceId,
        returns: u64,
    },
    Append {
        entry: Vec<u8>,
        returns: u64,
        have_frame: String,
    },
    Have {
        frame: String,
        returns: Option<String>,
    },
    Request {
        frame: String,
        limit: u64,
        returns: Option<String>,
    },
    Entries {
        frame: String,
        applied: bool,
    },
    Read {
        peer: DeviceId,
        after: u64,
        returns: Vec<Vec<u8>>,
    },
}

struct Step {
    op: Op,
    store: Store,
}

struct Scenario {
    name: String,
    own: DeviceId,
    store: Store,
    steps: Vec<Step>,
}

fn store_of(mut obj: Obj) -> Result<Store, String> {
    let keys: Vec<String> = obj.map.keys().cloned().collect();
    let mut store = Store::new();
    for key in keys {
        let value = obj.hex(&key)?;
        store.insert(key, value);
    }
    obj.finish()?;
    Ok(store)
}

fn step_of(mut obj: Obj) -> Result<Step, String> {
    let kind = obj.string("op")?;
    let op = match kind.as_str() {
        "head_seq_for" => Op::HeadSeqFor {
            peer: DeviceId(obj.fixed::<32>("peer_hex")?),
            returns: obj.unsigned("returns")?,
        },
        "append_own_entry" => Op::Append {
            entry: obj.hex("entry_hex")?,
            returns: obj.unsigned("returns")?,
            have_frame: obj.string("have_frame")?,
        },
        "handle_data_have" => Op::Have {
            frame: obj.string("frame")?,
            returns: obj.optional_string("returns")?,
        },
        "handle_data_request" => Op::Request {
            frame: obj.string("frame")?,
            limit: obj.unsigned("limit")?,
            returns: obj.optional_string("returns")?,
        },
        "handle_data_entries" => {
            let frame = obj.string("frame")?;
            let applied = match obj.string("returns")?.as_str() {
                "applied" => true,
                "gap" => false,
                other => return Err(format!("unknown outcome {other}")),
            };
            Op::Entries { frame, applied }
        }
        "read_entries" => Op::Read {
            peer: DeviceId(obj.fixed::<32>("peer_hex")?),
            after: obj.unsigned("after")?,
            returns: obj
                .strings("returns")?
                .iter()
                .map(|entry| decode_hex(entry))
                .collect::<Result<_, _>>()?,
        },
        other => return Err(format!("unknown step {other}")),
    };
    let store = store_of(obj.object("store")?)?;
    obj.finish()?;
    Ok(Step { op, store })
}

fn scenario_of(mut obj: Obj) -> Result<Scenario, String> {
    let scenario = Scenario {
        name: obj.string("name")?,
        own: DeviceId(obj.fixed::<32>("own_device_hex")?),
        store: store_of(obj.object("store")?)?,
        steps: obj
            .objects("steps")?
            .into_iter()
            .map(step_of)
            .collect::<Result<_, _>>()?,
    };
    obj.finish()?;
    Ok(scenario)
}

fn frame_from(wires: &HashMap<String, Vec<u8>>, name: &str) -> Result<Frame, String> {
    let wire = wires
        .get(name)
        .ok_or_else(|| format!("no vector named {name}"))?;
    decode_frame(wire).map_err(|e| format!("{name} does not decode: {e}"))
}

async fn snapshot(storage: &MemoryStorage) -> Result<Store, String> {
    let mut store = Store::new();
    for key in storage.keys("").await.map_err(|e| e.to_string())? {
        let value = storage
            .get(&key)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("key {key} listed but not held"))?;
        store.insert(key, value);
    }
    Ok(store)
}

async fn run_scenario(scenario: &Scenario, wires: &HashMap<String, Vec<u8>>) -> Check {
    let storage = MemoryStorage::new();
    for (key, value) in &scenario.store {
        storage
            .set(key, value.clone())
            .await
            .map_err(|e| e.to_string())?;
    }
    for (index, step) in scenario.steps.iter().enumerate() {
        let at = |what: String| format!("step {index}: {what}");
        match &step.op {
            Op::HeadSeqFor { peer, returns } => {
                let head = head_seq_for(&storage, peer)
                    .await
                    .map_err(|e| at(e.to_string()))?;
                if head != *returns {
                    return Err(at(format!("expected head {returns}, got {head}")));
                }
            }
            Op::Append {
                entry,
                returns,
                have_frame,
            } => {
                let (seq, announced) = append_own_entry(&storage, &scenario.own, entry.clone())
                    .await
                    .map_err(|e| at(e.to_string()))?;
                if seq != *returns {
                    return Err(at(format!("expected seq {returns}, got {seq}")));
                }
                match frame_from(wires, have_frame)? {
                    Frame::DataHave(expected) if expected == announced => {}
                    other => {
                        return Err(at(format!("expected {other:?}, got {announced:?}")));
                    }
                }
            }
            Op::Have { frame, returns } => {
                let Frame::DataHave(input) = frame_from(wires, frame)? else {
                    return Err(at(format!("{frame} is not a data-have frame")));
                };
                let got = handle_data_have(&storage, &input)
                    .await
                    .map_err(|e| at(e.to_string()))?;
                let expected = match returns {
                    None => None,
                    Some(name) => match frame_from(wires, name)? {
                        Frame::DataRequest(request) => Some(request),
                        _ => return Err(at(format!("{name} is not a data-request frame"))),
                    },
                };
                if got != expected {
                    return Err(at(format!("expected {expected:?}, got {got:?}")));
                }
            }
            Op::Request {
                frame,
                limit,
                returns,
            } => {
                let Frame::DataRequest(input) = frame_from(wires, frame)? else {
                    return Err(at(format!("{frame} is not a data-request frame")));
                };
                let got = handle_data_request(&storage, &input, *limit)
                    .await
                    .map_err(|e| at(e.to_string()))?;
                let expected = match returns {
                    None => None,
                    Some(name) => match frame_from(wires, name)? {
                        Frame::DataEntries(entries) => Some(entries),
                        _ => return Err(at(format!("{name} is not a data-entries frame"))),
                    },
                };
                if got != expected {
                    return Err(at(format!("expected {expected:?}, got {got:?}")));
                }
            }
            Op::Entries { frame, applied } => {
                let Frame::DataEntries(input) = frame_from(wires, frame)? else {
                    return Err(at(format!("{frame} is not a data-entries frame")));
                };
                let outcome = handle_data_entries(&storage, &input)
                    .await
                    .map_err(|e| at(e.to_string()))?;
                let expected = if *applied {
                    DataEntriesOutcome::Applied
                } else {
                    DataEntriesOutcome::Gap
                };
                if outcome != expected {
                    return Err(at(format!("expected {expected:?}, got {outcome:?}")));
                }
            }
            Op::Read {
                peer,
                after,
                returns,
            } => {
                let read = read_entries(&storage, peer, *after)
                    .await
                    .map_err(|e| at(e.to_string()))?;
                if read != *returns {
                    return Err(at(format!("expected {returns:?}, got {read:?}")));
                }
            }
        }
        let held = snapshot(&storage).await.map_err(&at)?;
        if held != step.store {
            return Err(at(format!(
                "expected the store {:?}, got {:?}",
                step.store, held
            )));
        }
    }
    Ok(())
}

/// Runs every scenario of the section and names each, so the binary reports them like any other vector.
pub async fn check_section(
    value: &Value,
    wires: &HashMap<String, Vec<u8>>,
) -> Vec<(String, Check)> {
    let section = match parse(value) {
        Ok(section) => section,
        Err(e) => panic!("data-sync.v1.json is not a valid vector file: {e}"),
    };
    let mut results = Vec::new();
    for scenario in &section.scenarios {
        results.push((
            format!("data_sync:scenario:{}", scenario.name),
            run_scenario(scenario, wires).await,
        ));
    }
    for case in &section.refused_appends {
        results.push((
            format!("data_sync:refused_append:{}", case.name),
            run_refused_append(case).await,
        ));
    }
    for case in &section.refused_heads {
        results.push((
            format!("data_sync:refused_head:{}", case.name),
            run_refused_head(case).await,
        ));
    }
    for case in &section.rust_only {
        results.push((
            format!("data_sync:rust_only:{}", case.name),
            run_rust_only(case).await,
        ));
    }
    results
}

struct RefusedAppend {
    name: String,
    own: DeviceId,
    store: Store,
    entry: Vec<u8>,
}

struct RefusedHead {
    name: String,
    own: DeviceId,
    store: Store,
}

struct RustOnlyCase {
    name: String,
    store: Store,
    op: String,
    peer: Option<DeviceId>,
    frame: Option<Vec<u8>>,
    limit: Option<u64>,
    returns: String,
}

struct Section {
    scenarios: Vec<Scenario>,
    refused_appends: Vec<RefusedAppend>,
    refused_heads: Vec<RefusedHead>,
    rust_only: Vec<RustOnlyCase>,
}

fn parse(value: &Value) -> Result<Section, String> {
    let mut root = Obj::new(value, "data_sync")?;
    if root.integer("layout_version")? != LAYOUT_VERSION {
        return Err(format!("data_sync.layout_version is not {LAYOUT_VERSION}"));
    }
    let scenarios: Vec<Scenario> = root
        .objects("scenarios")?
        .into_iter()
        .map(scenario_of)
        .collect::<Result<_, _>>()?;
    let mut refused_appends = Vec::new();
    for mut obj in root.objects("refused_appends")? {
        refused_appends.push(RefusedAppend {
            name: obj.string("name")?,
            own: DeviceId(obj.fixed::<32>("own_device_hex")?),
            store: store_of(obj.object("store")?)?,
            entry: obj.hex("entry_hex")?,
        });
        obj.finish()?;
    }
    let mut refused_heads = Vec::new();
    for mut obj in root.objects("refused_heads")? {
        refused_heads.push(RefusedHead {
            name: obj.string("name")?,
            own: DeviceId(obj.fixed::<32>("own_device_hex")?),
            store: store_of(obj.object("store")?)?,
        });
        obj.finish()?;
    }
    let mut rust_only = Vec::new();
    for mut obj in root.objects("rust_only_cases")? {
        rust_only.push(RustOnlyCase {
            name: obj.string("name")?,
            store: store_of(obj.object("store")?)?,
            op: obj.string("op")?,
            peer: obj
                .optional_hex("peer_hex")?
                .map(|bytes| {
                    <[u8; 32]>::try_from(bytes.as_slice())
                        .map(DeviceId)
                        .map_err(|_| "peer_hex is not 32 bytes".to_owned())
                })
                .transpose()?,
            frame: obj.optional_hex("frame_wire_hex")?,
            limit: obj.optional_unsigned("limit")?,
            returns: obj.string("returns")?,
        });
        obj.finish()?;
    }
    let mut counts = root.object("counts")?;
    let recorded = [
        ("scenarios", counts.unsigned("scenarios")?, scenarios.len()),
        (
            "refused_appends",
            counts.unsigned("refused_appends")?,
            refused_appends.len(),
        ),
        (
            "refused_heads",
            counts.unsigned("refused_heads")?,
            refused_heads.len(),
        ),
        (
            "rust_only_cases",
            counts.unsigned("rust_only_cases")?,
            rust_only.len(),
        ),
    ];
    counts.finish()?;
    root.finish()?;
    for (name, said, held) in recorded {
        if said != held as u64 {
            return Err(format!(
                "data_sync.counts.{name} says {said} and the list holds {held}"
            ));
        }
    }
    Ok(Section {
        scenarios,
        refused_appends,
        refused_heads,
        rust_only,
    })
}

async fn loaded(store: &Store) -> Result<MemoryStorage, String> {
    let storage = MemoryStorage::new();
    for (key, value) in store {
        storage
            .set(key, value.clone())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(storage)
}

async fn run_refused_append(case: &RefusedAppend) -> Check {
    let storage = loaded(&case.store).await?;
    match append_own_entry(&storage, &case.own, case.entry.clone()).await {
        Err(AppendError::LogFull) => {}
        other => return Err(format!("expected the log to be full, got {other:?}")),
    }
    let held = snapshot(&storage).await?;
    if held == case.store {
        Ok(())
    } else {
        Err(format!("the store changed: {held:?}"))
    }
}

async fn run_refused_head(case: &RefusedHead) -> Check {
    let storage = loaded(&case.store).await?;
    let peer = case.own;
    let storage_fault =
        |what: &str, result: Result<(), wire_mesh_core::ports::CoreError>| match result {
            Err(wire_mesh_core::ports::CoreError::Storage(_)) => Ok(()),
            other => Err(format!("{what}: expected a storage fault, got {other:?}")),
        };
    storage_fault(
        "head_seq_for",
        head_seq_for(&storage, &peer).await.map(|_| ()),
    )?;
    storage_fault(
        "handle_data_have",
        handle_data_have(
            &storage,
            &wire_mesh_wire::data::DataHaveFrame { peer, head_seq: 1 },
        )
        .await
        .map(|_| ()),
    )?;
    storage_fault(
        "handle_data_request",
        handle_data_request(
            &storage,
            &wire_mesh_wire::data::DataRequestFrame { peer, from_seq: 0 },
            1,
        )
        .await
        .map(|_| ()),
    )?;
    storage_fault(
        "handle_data_entries",
        handle_data_entries(
            &storage,
            &wire_mesh_wire::data::DataEntriesFrame {
                peer,
                from_seq: 0,
                entries: vec![vec![1]],
            },
        )
        .await
        .map(|_| ()),
    )?;
    storage_fault(
        "read_entries",
        read_entries(&storage, &peer, 0).await.map(|_| ()),
    )?;
    match append_own_entry(&storage, &peer, vec![1]).await {
        Err(AppendError::Storage(wire_mesh_core::ports::CoreError::Storage(_))) => {}
        other => {
            return Err(format!(
                "append_own_entry: expected a storage fault, got {other:?}"
            ))
        }
    }
    let held = snapshot(&storage).await?;
    if held == case.store {
        Ok(())
    } else {
        Err(format!("the store changed: {held:?}"))
    }
}

async fn run_rust_only(case: &RustOnlyCase) -> Check {
    let storage = loaded(&case.store).await?;
    let frame = case
        .frame
        .as_deref()
        .map(|wire| decode_frame(wire).map_err(|e| format!("the frame does not decode: {e}")))
        .transpose()?;
    let got = match (case.op.as_str(), frame) {
        ("handle_data_have", Some(Frame::DataHave(frame))) => handle_data_have(&storage, &frame)
            .await
            .map(|request| if request.is_none() { "none" } else { "request" }),
        ("handle_data_request", Some(Frame::DataRequest(frame))) => {
            handle_data_request(&storage, &frame, case.limit.unwrap_or(0))
                .await
                .map(|entries| if entries.is_none() { "none" } else { "entries" })
        }
        ("handle_data_entries", Some(Frame::DataEntries(frame))) => {
            handle_data_entries(&storage, &frame)
                .await
                .map(|outcome| match outcome {
                    DataEntriesOutcome::Rejected => "rejected",
                    DataEntriesOutcome::Gap => "gap",
                    DataEntriesOutcome::Applied => "applied",
                })
        }
        ("head_seq_for", None) => {
            let peer = case.peer.as_ref().ok_or("head_seq_for names no peer")?;
            head_seq_for(&storage, peer).await.map(|_| "a head")
        }
        (op, _) => return Err(format!("unknown op {op} or frame of the wrong kind")),
    };
    let outcome = match got {
        Ok(name) => name,
        Err(wire_mesh_core::ports::CoreError::Storage(_)) => "storage_fault",
        Err(other) => return Err(format!("an unexpected error: {other}")),
    };
    if outcome != case.returns {
        return Err(format!("expected {}, got {outcome}", case.returns));
    }
    let held = snapshot(&storage).await?;
    if held == case.store {
        Ok(())
    } else {
        Err(format!("the store changed: {held:?}"))
    }
}
