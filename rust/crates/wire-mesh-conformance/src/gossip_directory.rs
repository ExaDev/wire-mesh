//! The `gossip_directory` section of `gossip-directory.v1.json`: the extension rules against the real validator, each scenario against the real directory, and each self-advert against the real builder, whose signature is verified.

use std::collections::HashMap;

use serde_json::Value;
use wire_mesh_core::adapters::NodeIdentity;
use wire_mesh_core::domain::gossip_directory::{AdvertOutcome, GossipDirectory};
use wire_mesh_core::domain::gossip_extensions::validate_gossip_extensions;
use wire_mesh_core::domain::peer_advert::{verify_peer_advert, PeerAdvertVerdict};
use wire_mesh_core::domain::room_path::bytes_to_hex;
use wire_mesh_core::domain::self_advert::{
    build_self_advert, compute_topology_peers, TopologyInputs,
};
use wire_mesh_core::ports::Identity;
use wire_mesh_wire::value::CborValue;
use wire_mesh_wire::{decode_frame, Frame};

use super::obj::{Check, Obj};

/// The layout of the `gossip_directory` section this binary reads.
const LAYOUT_VERSION: i64 = 1;

/// The identity the scenarios run as, which verifies every advert it is given.
const VERIFIER: &str = "me";

fn outcome_name(outcome: &AdvertOutcome) -> &'static str {
    match outcome {
        AdvertOutcome::Admitted(_) => "admitted",
        AdvertOutcome::Older(_) => "older",
        AdvertOutcome::Refused(_, why) => why.as_str(),
    }
}

fn identities(section: &mut Obj) -> Result<HashMap<String, NodeIdentity>, String> {
    let mut held = HashMap::new();
    for mut who in section.objects("identities")? {
        let name = who.string("name")?;
        let secret = who.hex("secret_hex")?;
        let public_key = who.hex("public_key_hex")?;
        let device = who.hex("device_id_hex")?;
        who.finish()?;
        let identity = NodeIdentity::from_ed25519_secret(&secret).map_err(|e| e.to_string())?;
        if identity.identity_key().public_key != public_key {
            return Err(format!(
                "identity {name}: the secret gives another public key"
            ));
        }
        if identity.device_id().as_bytes().as_slice() != device.as_slice() {
            return Err(format!(
                "identity {name}: the secret gives another device id"
            ));
        }
        held.insert(name, identity);
    }
    Ok(held)
}

fn check_extension(mut case: Obj) -> Check {
    let keys = case.strings("keys")?;
    let refused = case.optional_object("refused")?;
    let expected = match refused {
        None => None,
        Some(mut refused) => {
            let key = refused.string("key")?;
            let reason = refused.string("reason")?;
            refused.finish()?;
            Some((key, reason))
        }
    };
    case.string("name")?;
    case.finish()?;
    let got = validate_gossip_extensions(keys.iter().map(String::as_str))
        .err()
        .map(|refused| (refused.key, refused.refusal.as_str().to_owned()));
    if got == expected {
        Ok(())
    } else {
        Err(format!("refused {got:?}, the file records {expected:?}"))
    }
}

async fn check_scenario(
    mut scenario: Obj,
    verifier: &NodeIdentity,
    wires: &HashMap<String, Vec<u8>>,
) -> Check {
    scenario.string("name")?;
    scenario.boolean("rust_only")?;
    let mut directory = GossipDirectory::new();
    for (index, mut step) in scenario.objects("steps")?.into_iter().enumerate() {
        let vector = step.string("vector")?;
        let outcomes = step.strings("outcomes")?;
        let mut held = Vec::new();
        for mut entry in step.objects("directory")? {
            held.push((entry.string("device")?, entry.integer("snapshot_seconds")?));
            entry.finish()?;
        }
        step.finish()?;
        let wire = wires
            .get(&vector)
            .ok_or_else(|| format!("step {index}: no vector {vector}"))?;
        let Frame::Gossip(frame) = decode_frame(wire).map_err(|e| e.to_string())? else {
            return Err(format!("step {index}: {vector} is not a gossip frame"));
        };
        let got: Vec<&str> = {
            let applied = directory.apply(verifier, &frame).await;
            applied.iter().map(outcome_name).collect()
        };
        if got != outcomes.iter().map(String::as_str).collect::<Vec<_>>() {
            return Err(format!(
                "step {index}: outcomes {got:?}, the file records {outcomes:?}"
            ));
        }
        let have: Vec<(String, i64)> = directory
            .entries()
            .iter()
            .map(|entry| {
                (
                    bytes_to_hex(entry.device.as_bytes()),
                    entry.advert.snapshot_seconds,
                )
            })
            .collect();
        if have != held {
            return Err(format!(
                "step {index}: directory {have:?}, the file records {held:?}"
            ));
        }
    }
    scenario.finish()
}

async fn check_self_advert(mut case: Obj, who: &HashMap<String, NodeIdentity>) -> Check {
    case.string("name")?;
    let name = case.string("identity")?;
    let identity = who
        .get(&name)
        .ok_or_else(|| format!("no identity {name}"))?;
    let mut extensions = Vec::new();
    let mut given = case.object("extensions")?;
    let keys: Vec<String> = given.map.keys().cloned().collect();
    for key in keys {
        let value = given.string(&key)?;
        extensions.push((key, CborValue::Text(value)));
    }
    given.finish()?;
    let now = case.unsigned("now_seconds")?;
    let mut expected = case.object("expected")?;
    let device = expected.hex("device_hex")?;
    let addresses = expected.strings("addresses")?;
    let snapshot = expected.integer("snapshot_seconds")?;
    let key_names = expected.strings("extension_keys")?;
    let mut topology = expected.object("topology")?;
    let direct = topology.take("direct")?;
    let relayed = topology.take("relayed")?;
    topology.finish()?;
    expected.finish()?;
    case.finish()?;
    if direct != Value::Array(Vec::new()) || relayed != Value::Array(Vec::new()) {
        return Err("a self-advert with no connection has an empty topology".to_owned());
    }
    let advert = build_self_advert(
        identity,
        &[],
        now,
        &extensions,
        &compute_topology_peers(&TopologyInputs::default()),
    )
    .await
    .map_err(|e| e.to_string())?;
    if advert.device.as_bytes().as_slice() != device.as_slice() {
        return Err("the advert names another device".to_owned());
    }
    if !addresses.is_empty() || !advert.addresses.is_empty() {
        return Err(format!("addresses {:?}", advert.addresses));
    }
    if advert.snapshot_seconds != snapshot {
        return Err(format!(
            "snapshot {} not {snapshot}",
            advert.snapshot_seconds
        ));
    }
    let mut got: Vec<String> = advert.extra.iter().map(|(key, _)| key.clone()).collect();
    got.sort();
    if got != key_names {
        return Err(format!(
            "extension keys {got:?}, the file records {key_names:?}"
        ));
    }
    match verify_peer_advert(identity, &advert).await {
        PeerAdvertVerdict::Valid => Ok(()),
        PeerAdvertVerdict::Invalid(why) => Err(format!("the advert does not verify: {why:?}")),
    }
}

pub async fn check_section(
    value: &Value,
    wires: &HashMap<String, Vec<u8>>,
) -> Vec<(String, Check)> {
    let mut section = Obj::new(value, "gossip_directory").expect("an object");
    let layout = section.integer("layout_version").expect("layout_version");
    assert!(
        layout == LAYOUT_VERSION,
        "gossip-directory.v1.json: layout_version {layout}"
    );
    let who = identities(&mut section).expect("identities");
    let verifier = who.get(VERIFIER).expect("the verifier identity");
    let extension_cases = section
        .objects("extension_validation")
        .expect("extension_validation");
    let scenarios = section
        .objects("directory_scenarios")
        .expect("directory_scenarios");
    let self_adverts = section.objects("self_adverts").expect("self_adverts");
    let mut counts = section.object("counts").expect("counts");
    for (name, held) in [
        ("extension_validation", extension_cases.len()),
        ("directory_scenarios", scenarios.len()),
        ("self_adverts", self_adverts.len()),
    ] {
        let said = counts.unsigned(name).expect("a count");
        assert!(
            said == held as u64,
            "gossip-directory.v1.json: counts.{name} says {said} and the list holds {held}"
        );
    }
    counts.finish().expect("counts are all read");
    section.finish().expect("sections are all read");

    let mut results = Vec::new();
    for mut case in extension_cases {
        let name = case.string("name").expect("a name");
        // `name` is read twice by `check_extension`; put it back for its own read.
        case.map
            .insert("name".to_owned(), Value::String(name.clone()));
        results.push((
            format!("gossip_directory:extension:{name}"),
            check_extension(case),
        ));
    }
    for scenario in scenarios {
        let name = scenario
            .map
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_owned();
        results.push((
            format!("gossip_directory:scenario:{name}"),
            check_scenario(scenario, verifier, wires).await,
        ));
    }
    for case in self_adverts {
        let name = case
            .map
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_owned();
        results.push((
            format!("gossip_directory:self_advert:{name}"),
            check_self_advert(case, &who).await,
        ));
    }
    results
}
