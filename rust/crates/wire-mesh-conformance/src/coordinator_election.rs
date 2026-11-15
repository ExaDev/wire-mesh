//! The `coordinator_election` section of `coordinator-election.v1.json`: every scenario is run step by step against the real [`CoordinatorElection`], and the pure rules (which terms a later claim can supersede, the order of device-ids) against their functions.

use std::collections::HashMap;

use serde_json::Value;
use wire_mesh_core::domain::{
    is_supersedable_term, ClaimRefusal, CoordinatorClaim, CoordinatorElection, EvaluationOutcome,
};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::transport::CoordinatorFrame;
use wire_mesh_wire::{decode_frame, Frame};

use super::obj::{Check, Obj};

/// The layout of the `coordinator_election` section this binary reads.
const LAYOUT_VERSION: i64 = 1;

/// The claim an expected state or outcome names.
fn claim_of(obj: Option<Obj>) -> Result<Option<CoordinatorClaim>, String> {
    let Some(mut obj) = obj else {
        return Ok(None);
    };
    let claim = CoordinatorClaim {
        term: obj.unsigned("term")?,
        coordinator: DeviceId(obj.fixed::<32>("coordinator_hex")?),
        capacity_hint: obj.optional_unsigned("capacity_hint")?,
    };
    obj.finish()?;
    Ok(Some(claim))
}

enum Op {
    Evaluate {
        frame: String,
        outcome: String,
        incumbent: Option<CoordinatorClaim>,
    },
    Claim {
        capacity_hint: Option<u64>,
        frame: Option<String>,
        refused: bool,
    },
    Announce {
        frame: Option<String>,
    },
}

struct Step {
    op: Op,
    current: Option<CoordinatorClaim>,
    is_self: bool,
}

struct Scenario {
    name: String,
    own: DeviceId,
    steps: Vec<Step>,
}

fn step_of(mut obj: Obj) -> Result<Step, String> {
    let kind = obj.string("op")?;
    let op = match kind.as_str() {
        "evaluate" => {
            let frame = obj.string("frame")?;
            let mut expected = obj.object("expected")?;
            let outcome = expected.string("outcome")?;
            let incumbent = claim_of(expected.optional_object("incumbent")?)?;
            expected.finish()?;
            Op::Evaluate {
                frame,
                outcome,
                incumbent,
            }
        }
        "claim" => {
            let capacity_hint = obj.optional_unsigned("capacity_hint")?;
            let mut expected = obj.object("expected")?;
            let frame = expected.optional_string("frame")?;
            let refused = expected.boolean("refused")?;
            expected.finish()?;
            Op::Claim {
                capacity_hint,
                frame,
                refused,
            }
        }
        "announce_current" => {
            let mut expected = obj.object("expected")?;
            let frame = expected.optional_string("frame")?;
            expected.finish()?;
            Op::Announce { frame }
        }
        other => return Err(format!("unknown step {other}")),
    };
    let mut state = obj.object("state")?;
    let current = claim_of(state.optional_object("current")?)?;
    let is_self = state.boolean("is_self")?;
    state.finish()?;
    obj.finish()?;
    Ok(Step {
        op,
        current,
        is_self,
    })
}

fn scenario_of(mut obj: Obj) -> Result<Scenario, String> {
    let scenario = Scenario {
        name: obj.string("name")?,
        own: DeviceId(obj.fixed::<32>("own_device_hex")?),
        steps: obj
            .objects("steps")?
            .into_iter()
            .map(step_of)
            .collect::<Result<_, _>>()?,
    };
    obj.finish()?;
    Ok(scenario)
}

fn frame_from(wires: &HashMap<String, Vec<u8>>, name: &str) -> Result<CoordinatorFrame, String> {
    let wire = wires
        .get(name)
        .ok_or_else(|| format!("no vector named {name}"))?;
    match decode_frame(wire).map_err(|e| format!("{name} does not decode: {e}"))? {
        Frame::Coordinator(frame) => Ok(frame),
        _ => Err(format!("{name} is not a coordinator frame")),
    }
}

fn run_scenario(scenario: &Scenario, wires: &HashMap<String, Vec<u8>>) -> Check {
    let mut election = CoordinatorElection::new(scenario.own);
    for (index, step) in scenario.steps.iter().enumerate() {
        let at = |what: String| format!("step {index}: {what}");
        match &step.op {
            Op::Evaluate {
                frame,
                outcome,
                incumbent,
            } => {
                let verdict = election.evaluate(&frame_from(wires, frame)?);
                let (name, held) = match verdict {
                    EvaluationOutcome::Accepted { incumbent } => ("accepted", Some(incumbent)),
                    EvaluationOutcome::Retained { incumbent } => ("retained", Some(incumbent)),
                    EvaluationOutcome::Rejected => ("rejected", None),
                };
                if name != outcome {
                    return Err(at(format!("expected {outcome}, got {name}")));
                }
                if held != *incumbent {
                    return Err(at(format!(
                        "expected the incumbent {incumbent:?}, got {held:?}"
                    )));
                }
            }
            Op::Claim {
                capacity_hint,
                frame,
                refused,
            } => match (election.claim(*capacity_hint), refused) {
                (Ok(made), false) => {
                    let expected = frame_from(
                        wires,
                        frame
                            .as_deref()
                            .ok_or_else(|| at("a claim with no frame".to_owned()))?,
                    )?;
                    if made != expected {
                        return Err(at(format!("expected the frame {expected:?}, got {made:?}")));
                    }
                }
                (Err(_), true) => {}
                (Ok(made), true) => {
                    return Err(at(format!("expected a refusal, got the frame {made:?}")))
                }
                (Err(error), false) => return Err(at(format!("expected a frame, got {error}"))),
            },
            Op::Announce { frame } => {
                let expected = frame
                    .as_deref()
                    .map(|name| frame_from(wires, name))
                    .transpose()?;
                let announced = election.announce_current();
                if announced != expected {
                    return Err(at(format!("expected {expected:?}, got {announced:?}")));
                }
            }
        }
        if election.current() != step.current.as_ref() {
            return Err(at(format!(
                "expected the state {:?}, got {:?}",
                step.current,
                election.current()
            )));
        }
        if election.is_self() != step.is_self {
            return Err(at(format!("expected is_self {}", step.is_self)));
        }
    }
    Ok(())
}

/// Runs every check of the section and names each, so the binary reports them like any other vector.
pub fn check_section(value: &Value, wires: &HashMap<String, Vec<u8>>) -> Vec<(String, Check)> {
    match parse_and_check(value, wires) {
        Ok(results) => results,
        Err(e) => panic!("coordinator-election.v1.json is not a valid vector file: {e}"),
    }
}

fn parse_and_check(
    value: &Value,
    wires: &HashMap<String, Vec<u8>>,
) -> Result<Vec<(String, Check)>, String> {
    let mut root = Obj::new(value, "coordinator_election")?;
    if root.integer("layout_version")? != LAYOUT_VERSION {
        return Err(format!(
            "coordinator_election.layout_version is not {LAYOUT_VERSION}"
        ));
    }
    let scenarios: Vec<Scenario> = root
        .objects("scenarios")?
        .into_iter()
        .map(scenario_of)
        .collect::<Result<_, _>>()?;
    let mut refused = Vec::new();
    for mut obj in root.objects("refused_claims")? {
        refused.push((
            obj.string("name")?,
            DeviceId(obj.fixed::<32>("own_device_hex")?),
            obj.unsigned("capacity_hint")?,
        ));
        obj.finish()?;
    }
    let mut rust_only_frames = Vec::new();
    for mut obj in root.objects("rust_only_frames")? {
        rust_only_frames.push((
            obj.string("name")?,
            DeviceId(obj.fixed::<32>("own_device_hex")?),
            obj.hex("frame_wire_hex")?,
            obj.string("expected")?,
        ));
        obj.finish()?;
    }
    let mut terms = Vec::new();
    for mut obj in root.objects("supersedable_terms")? {
        terms.push((obj.unsigned("term")?, obj.boolean("expected")?));
        obj.finish()?;
    }
    let mut orders = Vec::new();
    for mut obj in root.objects("device_orders")? {
        orders.push((
            obj.string("name")?,
            DeviceId(obj.fixed::<32>("a_hex")?),
            DeviceId(obj.fixed::<32>("b_hex")?),
            obj.integer("expected")?,
        ));
        obj.finish()?;
    }
    let mut counts = root.object("counts")?;
    let recorded = [
        ("scenarios", counts.unsigned("scenarios")?, scenarios.len()),
        (
            "refused_claims",
            counts.unsigned("refused_claims")?,
            refused.len(),
        ),
        (
            "rust_only_frames",
            counts.unsigned("rust_only_frames")?,
            rust_only_frames.len(),
        ),
        (
            "supersedable_terms",
            counts.unsigned("supersedable_terms")?,
            terms.len(),
        ),
        (
            "device_orders",
            counts.unsigned("device_orders")?,
            orders.len(),
        ),
    ];
    counts.finish()?;
    root.finish()?;
    for (name, said, held) in recorded {
        if said != held as u64 {
            return Err(format!(
                "coordinator_election.counts.{name} says {said} and the list holds {held}"
            ));
        }
    }

    let mut results = Vec::new();
    for scenario in &scenarios {
        results.push((
            format!("coordinator_election:scenario:{}", scenario.name),
            run_scenario(scenario, wires),
        ));
    }
    for (name, own, hint) in refused {
        let mut election = CoordinatorElection::new(own);
        let check = match election.claim(Some(hint)) {
            Err(ClaimRefusal::CapacityHintNotRepresentable) if election.current().is_none() => {
                Ok(())
            }
            other => Err(format!(
                "expected a refusal and no claim made, got {other:?}"
            )),
        };
        results.push((format!("coordinator_election:refused_claim:{name}"), check));
    }
    for (name, own, frame_wire, expected) in rust_only_frames {
        let mut election = CoordinatorElection::new(own);
        let check = match (decode_frame(&frame_wire), expected.as_str()) {
            (Ok(Frame::Coordinator(frame)), "rejected") => {
                if election.evaluate(&frame) == EvaluationOutcome::Rejected
                    && election.current().is_none()
                {
                    Ok(())
                } else {
                    Err("the frame was not dropped unevaluated".to_owned())
                }
            }
            (Ok(_), _) => Err("not a coordinator frame, or an unknown expectation".to_owned()),
            (Err(e), _) => Err(format!("the frame does not decode: {e}")),
        };
        results.push((
            format!("coordinator_election:rust_only_frame:{name}"),
            check,
        ));
    }
    for (term, expected) in terms {
        let got = is_supersedable_term(term);
        results.push((
            format!("coordinator_election:supersedable:{term}"),
            if got == expected {
                Ok(())
            } else {
                Err(format!("expected {expected}, got {got}"))
            },
        ));
    }
    for (name, a, b, expected) in orders {
        let got = match a.cmp(&b) {
            std::cmp::Ordering::Less => -1,
            std::cmp::Ordering::Equal => 0,
            std::cmp::Ordering::Greater => 1,
        };
        results.push((
            format!("coordinator_election:device_order:{name}"),
            if got == expected {
                Ok(())
            } else {
                Err(format!("expected {expected}, got {got}"))
            },
        ));
    }
    Ok(results)
}
