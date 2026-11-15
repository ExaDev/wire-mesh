//! The `file_storage` section of `file-storage.v1.json`: the key layout against the pure layout functions, and every scenario against the real [`FsStorage`] over a copy of its starting directory, comparing what each operation returns and the whole directory after it, read back with plain file operations.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;
use wire_mesh_core::adapters::FsStorage;
use wire_mesh_core::domain::fs_layout::{
    check_key, key_to_relative_path, relative_path_to_key, KeyRefusal,
};
use wire_mesh_core::ports::{CoreError, KeyValueStorage};

use super::decode_hex;
use super::obj::{Check, Obj};

/// The layout of the `file_storage` section this binary reads.
const LAYOUT_VERSION: i64 = 1;

/// A directory as the file records it: each file under it, `/`-joined, with its content.
type Directory = BTreeMap<String, Vec<u8>>;

enum Expected {
    Path(String),
    Refusal(String),
}

struct KeyCase {
    name: String,
    key: String,
    expected: Expected,
}

/// What a `get` returns: a value, absence, or a failure of one of the two kinds.
#[derive(Debug, PartialEq, Eq)]
enum Got {
    Value(Vec<u8>),
    Absent,
    Refused,
    Error,
}

enum Op {
    Get {
        key: String,
        returns: Got,
    },
    Set {
        key: String,
        value: Vec<u8>,
        returns: Outcome,
    },
    Delete {
        key: String,
        returns: Outcome,
    },
    Keys {
        prefix: String,
        returns: Vec<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Ok,
    Refused,
    Error,
}

struct Step {
    op: Op,
    directory: Directory,
}

struct Scenario {
    name: String,
    start: Directory,
    steps: Vec<Step>,
}

fn directory_of(mut obj: Obj) -> Result<Directory, String> {
    let keys: Vec<String> = obj.map.keys().cloned().collect();
    let mut directory = Directory::new();
    for key in keys {
        let content = obj.hex(&key)?;
        directory.insert(key, content);
    }
    obj.finish()?;
    Ok(directory)
}

fn outcome_of(name: &str) -> Result<Outcome, String> {
    match name {
        "ok" => Ok(Outcome::Ok),
        "refused" => Ok(Outcome::Refused),
        "error" => Ok(Outcome::Error),
        other => Err(format!("unknown outcome {other}")),
    }
}

fn step_of(mut obj: Obj) -> Result<Step, String> {
    let kind = obj.string("op")?;
    let op = match kind.as_str() {
        "get" => {
            let key = obj.string("key")?;
            let returns = match obj.take("returns")? {
                Value::Null => Got::Absent,
                Value::String(text) => match text.as_str() {
                    "refused" => Got::Refused,
                    "error" => Got::Error,
                    hex => Got::Value(decode_hex(hex)?),
                },
                _ => return Err("get returns neither null nor a string".to_owned()),
            };
            Op::Get { key, returns }
        }
        "set" => Op::Set {
            key: obj.string("key")?,
            value: obj.hex("value_hex")?,
            returns: outcome_of(&obj.string("returns")?)?,
        },
        "delete" => Op::Delete {
            key: obj.string("key")?,
            returns: outcome_of(&obj.string("returns")?)?,
        },
        "keys" => Op::Keys {
            prefix: obj.string("prefix")?,
            returns: obj.strings("returns")?,
        },
        other => return Err(format!("unknown step {other}")),
    };
    let directory = directory_of(obj.object("directory")?)?;
    obj.finish()?;
    Ok(Step { op, directory })
}

fn scenario_of(mut obj: Obj) -> Result<Scenario, String> {
    let scenario = Scenario {
        name: obj.string("name")?,
        start: directory_of(obj.object("start")?)?,
        steps: obj
            .objects("steps")?
            .into_iter()
            .map(step_of)
            .collect::<Result<_, _>>()?,
    };
    obj.finish()?;
    Ok(scenario)
}

fn key_case_of(mut obj: Obj) -> Result<KeyCase, String> {
    let name = obj.string("name")?;
    let key = obj.string("key")?;
    let mut expected = obj.object("expected")?;
    let parsed = if expected.map.contains_key("path") {
        Expected::Path(expected.string("path")?)
    } else {
        Expected::Refusal(expected.string("refusal")?)
    };
    expected.finish()?;
    obj.finish()?;
    Ok(KeyCase {
        name,
        key,
        expected: parsed,
    })
}

fn check_key_case(case: &KeyCase) -> Check {
    match (&case.expected, check_key(&case.key)) {
        (Expected::Path(path), Ok(())) => {
            let got = key_to_relative_path(&case.key).map_err(|e| e.to_string())?;
            let joined = got
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if joined != *path {
                return Err(format!("expected the path {path}, got {joined}"));
            }
            let back = relative_path_to_key(&got).map_err(|e| e.to_string())?;
            if back != case.key {
                return Err(format!("the path came back as the key {back:?}"));
            }
            Ok(())
        }
        (Expected::Refusal(reason), Err(refusal)) => {
            if refusal.as_str() != reason {
                return Err(format!("expected {reason}, got {}", refusal.as_str()));
            }
            match key_to_relative_path(&case.key) {
                Err(again) if again == refusal => Ok(()),
                other => Err(format!("the path of a refused key was {other:?}")),
            }
        }
        (Expected::Path(path), Err(refusal)) => Err(format!(
            "expected the path {path}, got the refusal {}",
            refusal.as_str()
        )),
        (Expected::Refusal(reason), Ok(())) => Err(format!(
            "expected the refusal {reason}, but the key was accepted"
        )),
    }
}

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A fresh directory path that does not exist yet, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        Scratch(std::env::temp_dir().join(format!(
            "wire-mesh-conformance-file-storage-{}-{n}",
            std::process::id()
        )))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Writes `files` under `root` with plain file operations: the directory another implementation would have written. A directory with no files is not created.
fn materialise(root: &Path, files: &Directory) -> Result<(), String> {
    for (path, content) in files {
        let target: PathBuf = root.join(path.split('/').collect::<PathBuf>());
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every file under `dir` with its content, read with plain file operations: what another implementation would read. A missing directory holds nothing.
fn snapshot(dir: &Path) -> Result<Directory, String> {
    fn walk(root: &Path, relative: &Path, into: &mut Directory) -> Result<(), String> {
        let here = root.join(relative);
        let entries = match std::fs::read_dir(&here) {
            Ok(entries) => entries,
            Err(e)
                if e.kind() == std::io::ErrorKind::NotFound && relative.as_os_str().is_empty() =>
            {
                return Ok(());
            }
            Err(e) => return Err(e.to_string()),
        };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let child = relative.join(entry.file_name());
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() {
                walk(root, &child, into)?;
            } else if kind.is_file() {
                let key = child
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                into.insert(
                    key,
                    std::fs::read(root.join(&child)).map_err(|e| e.to_string())?,
                );
            }
        }
        Ok(())
    }
    let mut into = Directory::new();
    walk(dir, Path::new(""), &mut into)?;
    Ok(into)
}

/// What an operation did, as the file names it: a failure is a refusal when the layout refuses the key, and an operating system error otherwise.
fn outcome_of_result(key: &str, result: &Result<(), CoreError>) -> Outcome {
    match result {
        Ok(()) => Outcome::Ok,
        Err(_) if check_key(key).is_err() => Outcome::Refused,
        Err(_) => Outcome::Error,
    }
}

async fn run_scenario(scenario: &Scenario) -> Check {
    let scratch = Scratch::new();
    let root = scratch.0.join("store");
    materialise(&root, &scenario.start)?;
    let storage = FsStorage::new(&root);
    for (index, step) in scenario.steps.iter().enumerate() {
        let at = |what: String| format!("step {index}: {what}");
        match &step.op {
            Op::Get { key, returns } => {
                let got = match storage.get(key).await {
                    Ok(Some(value)) => Got::Value(value),
                    Ok(None) => Got::Absent,
                    Err(_) if check_key(key).is_err() => Got::Refused,
                    Err(_) => Got::Error,
                };
                if got != *returns {
                    return Err(at(format!(
                        "get {key:?}: expected {returns:?}, got {got:?}"
                    )));
                }
            }
            Op::Set {
                key,
                value,
                returns,
            } => {
                let got = outcome_of_result(key, &storage.set(key, value.clone()).await);
                if got != *returns {
                    return Err(at(format!(
                        "set {key:?}: expected {returns:?}, got {got:?}"
                    )));
                }
            }
            Op::Delete { key, returns } => {
                let got = outcome_of_result(key, &storage.delete(key).await);
                if got != *returns {
                    return Err(at(format!(
                        "delete {key:?}: expected {returns:?}, got {got:?}"
                    )));
                }
            }
            Op::Keys { prefix, returns } => {
                let got = storage.keys(prefix).await.map_err(|e| at(e.to_string()))?;
                if got != *returns {
                    return Err(at(format!(
                        "keys {prefix:?}: expected {returns:?}, got {got:?}"
                    )));
                }
            }
        }
        let held = snapshot(&root).map_err(&at)?;
        if held != step.directory {
            return Err(at(format!(
                "expected the directory {:?}, got {:?}",
                step.directory, held
            )));
        }
    }
    Ok(())
}

struct Section {
    key_layout: Vec<KeyCase>,
    scenarios: Vec<Scenario>,
}

fn parse(value: &Value) -> Result<Section, String> {
    let mut root = Obj::new(value, "file_storage")?;
    if root.integer("layout_version")? != LAYOUT_VERSION {
        return Err(format!(
            "file_storage.layout_version is not {LAYOUT_VERSION}"
        ));
    }
    let key_layout: Vec<KeyCase> = root
        .objects("key_layout")?
        .into_iter()
        .map(key_case_of)
        .collect::<Result<_, _>>()?;
    let scenarios: Vec<Scenario> = root
        .objects("scenarios")?
        .into_iter()
        .map(scenario_of)
        .collect::<Result<_, _>>()?;
    let mut counts = root.object("counts")?;
    let said = [
        (
            "key_layout",
            counts.unsigned("key_layout")?,
            key_layout.len(),
        ),
        ("scenarios", counts.unsigned("scenarios")?, scenarios.len()),
    ];
    counts.finish()?;
    root.finish()?;
    for (name, recorded, held) in said {
        if recorded != held as u64 {
            return Err(format!(
                "file_storage.counts.{name} says {recorded} and the list holds {held}"
            ));
        }
    }
    for refusal in KeyRefusal::ALL {
        let covered = key_layout.iter().any(
            |case| matches!(&case.expected, Expected::Refusal(reason) if reason == refusal.as_str()),
        );
        if !covered {
            return Err(format!("no case expects the refusal {}", refusal.as_str()));
        }
    }
    Ok(Section {
        key_layout,
        scenarios,
    })
}

/// Runs every check of the section and names each, so the binary reports them like any other vector.
pub async fn check_section(value: &Value) -> Vec<(String, Check)> {
    let section = match parse(value) {
        Ok(section) => section,
        Err(e) => panic!("file-storage.v1.json is not a valid vector file: {e}"),
    };
    let mut results = Vec::new();
    for case in &section.key_layout {
        results.push((
            format!("file_storage:key_layout:{}", case.name),
            check_key_case(case),
        ));
    }
    for scenario in &section.scenarios {
        results.push((
            format!("file_storage:scenario:{}", scenario.name),
            run_scenario(scenario).await,
        ));
    }
    results
}
