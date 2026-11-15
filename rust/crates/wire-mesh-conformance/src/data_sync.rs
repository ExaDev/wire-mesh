//! The `data_sync` section of `data-sync.v1.json`: every scenario is run step by step against the real data-sync functions over an in-memory store, comparing what each step returns and the whole store after it.

use std::collections::{BTreeMap, HashMap};

use serde_json::Value;
use wire_mesh_core::adapters::MemoryStorage;
use wire_mesh_core::domain::data_sync::{
    append_own_entry, handle_data_entries, handle_data_have, handle_data_request, head_seq_for,
    read_entries, DataEntriesOutcome,
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
    let scenarios = match parse(value) {
        Ok(scenarios) => scenarios,
        Err(e) => panic!("data-sync.v1.json is not a valid vector file: {e}"),
    };
    let mut results = Vec::new();
    for scenario in &scenarios {
        results.push((
            format!("data_sync:scenario:{}", scenario.name),
            run_scenario(scenario, wires).await,
        ));
    }
    results
}

fn parse(value: &Value) -> Result<Vec<Scenario>, String> {
    let mut root = Obj::new(value, "data_sync")?;
    if root.integer("layout_version")? != LAYOUT_VERSION {
        return Err(format!("data_sync.layout_version is not {LAYOUT_VERSION}"));
    }
    let scenarios: Vec<Scenario> = root
        .objects("scenarios")?
        .into_iter()
        .map(scenario_of)
        .collect::<Result<_, _>>()?;
    let mut counts = root.object("counts")?;
    let said = counts.unsigned("scenarios")?;
    counts.finish()?;
    root.finish()?;
    if said != scenarios.len() as u64 {
        return Err(format!(
            "data_sync.counts.scenarios says {said} and the list holds {}",
            scenarios.len()
        ));
    }
    Ok(scenarios)
}
