//! Checks the `mint` section of `mint.v1.json` against `wire_mesh_core::domain::mint`: every minting case is run and compared byte for byte or by refusal reason, every minted token is verified, every revocation entry is minted byte for byte, and every `can_grant` and `can_grant_via` query gives the stated verdict. A field of the section this module does not read fails the run.

use std::collections::HashMap;

use serde_json::Value;
use wire_mesh_core::adapters::NodeIdentity;
use wire_mesh_core::domain::mint::{
    can_grant, can_grant_via, mint_capability_token, mint_revocation_entry, GrantCandidate,
    MintCapabilityToken, MintError, MintRefusal, NarrowingCandidate,
};
use wire_mesh_core::domain::revocation::RevocationView;
use wire_mesh_core::domain::tokens::{verify_capability_token, TokenVerdict};
use wire_mesh_core::ports::{Clock, Identity};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb, CoseSign1};

use super::obj::{Check, Obj};
use super::report_first_divergence;

/// The layout of the `mint` section this binary reads.
const LAYOUT_VERSION: i64 = 1;

struct FixedClock(u64);

impl Clock for FixedClock {
    fn now_unix_ms(&self) -> u64 {
        self.0
    }
}

enum Expected {
    Minted { vector: String, verifies: bool },
    Refused(String),
}

struct MintCase {
    name: String,
    issuer: String,
    now_ms: u64,
    token_id: Vec<u8>,
    bearer: String,
    capability: String,
    scope: CapabilityScope,
    expires: u64,
    not_before: Option<u64>,
    delegations_remaining: Option<u64>,
    conditions: Option<Vec<u8>>,
    parent: Option<Vec<u8>>,
    authorised_by: Option<Vec<u8>>,
    grants_capability: Option<String>,
    requests_capability: Option<String>,
    /// Set for a case only an implementation with a Rust-sized integer can run; this binary runs every case, and reads the flag so that a field nothing reads cannot hide.
    rust_only: bool,
    expected: Expected,
}

struct RevocationCase {
    name: String,
    issuer: String,
    token_id: Vec<u8>,
    revoked_at: u64,
    vector: String,
}

struct Query {
    name: String,
    held: Vec<u8>,
    device: String,
    candidate: NarrowingCandidate,
    bearer: Option<String>,
    now_ms: u64,
    expected: bool,
}

/// An identity of the file: its name, Ed25519 secret, public key and device-id.
struct IdentityRecord {
    name: String,
    secret: Vec<u8>,
    public_key: Vec<u8>,
    device_id: [u8; 32],
}

struct Section {
    now_ms: u64,
    identities: Vec<IdentityRecord>,
    mints: Vec<MintCase>,
    revocations: Vec<RevocationCase>,
    can_grant: Vec<Query>,
    can_grant_via: Vec<Query>,
    /// The number of cases of each list the header says the file holds.
    counts: Counts,
}

struct Counts {
    token_mints: u64,
    revocation_mints: u64,
    can_grant: u64,
    can_grant_via: u64,
}

fn scope_of(mut obj: Obj) -> Result<CapabilityScope, String> {
    let kind = obj.string("kind")?;
    let path = if obj.map.contains_key("path") {
        Some(obj.string("path")?)
    } else {
        None
    };
    obj.finish()?;
    Ok(CapabilityScope { kind, path })
}

fn candidate_of(mut obj: Obj) -> Result<NarrowingCandidate, String> {
    let candidate = NarrowingCandidate {
        capability: CapabilityVerb(obj.string("capability")?),
        scope: scope_of(obj.object("scope")?)?,
        expires: obj.unsigned("expires")?,
        delegations_remaining: obj.optional_unsigned("delegations_remaining")?,
    };
    obj.finish()?;
    Ok(candidate)
}

fn query_of(mut obj: Obj, with_bearer: bool) -> Result<Query, String> {
    let query = Query {
        name: obj.string("name")?,
        held: obj.hex("held_wire_hex")?,
        device: obj.string("device")?,
        candidate: candidate_of(obj.object("candidate")?)?,
        bearer: if with_bearer {
            Some(obj.string("candidate_bearer")?)
        } else {
            None
        },
        now_ms: obj.unsigned("now_ms")?,
        expected: match obj.take("expected")? {
            Value::Bool(value) => value,
            _ => return Err(format!("{}.expected is not a boolean", obj.path)),
        },
    };
    obj.finish()?;
    Ok(query)
}

fn mint_case_of(mut obj: Obj) -> Result<MintCase, String> {
    let name = obj.string("name")?;
    let case = MintCase {
        name,
        issuer: obj.string("issuer")?,
        now_ms: obj.unsigned("now_ms")?,
        token_id: obj.hex("token_id_hex")?,
        bearer: obj.string("bearer")?,
        capability: obj.string("capability")?,
        scope: scope_of(obj.object("scope")?)?,
        expires: obj.unsigned("expires")?,
        not_before: obj.optional_unsigned("not_before")?,
        delegations_remaining: obj.optional_unsigned("delegations_remaining")?,
        conditions: obj.optional_hex("conditions_hex")?,
        parent: obj.optional_hex("parent_wire_hex")?,
        authorised_by: obj.optional_hex("authorised_by_wire_hex")?,
        grants_capability: obj.optional_string("grants_capability")?,
        requests_capability: obj.optional_string("requests_capability")?,
        rust_only: obj.boolean("rust_only")?,
        expected: {
            let mut expected = obj.object("expected")?;
            let result = expected.string("result")?;
            let parsed = match result.as_str() {
                "minted" => Expected::Minted {
                    vector: expected.string("vector")?,
                    verifies: expected.boolean("verifies")?,
                },
                "refused" => Expected::Refused(expected.string("reason")?),
                other => return Err(format!("unknown result {other}")),
            };
            expected.finish()?;
            parsed
        },
    };
    obj.finish()?;
    Ok(case)
}

impl Section {
    /// Fails when a list holds a different number of cases than the header says, so a case that vanished from the file fails the run.
    fn check_counts(&self) -> Result<(), String> {
        for (name, held, recorded) in [
            ("token_mints", self.mints.len(), self.counts.token_mints),
            (
                "revocation_mints",
                self.revocations.len(),
                self.counts.revocation_mints,
            ),
            ("can_grant", self.can_grant.len(), self.counts.can_grant),
            (
                "can_grant_via",
                self.can_grant_via.len(),
                self.counts.can_grant_via,
            ),
        ] {
            if held as u64 != recorded {
                return Err(format!(
                    "mint.counts.{name} says {recorded} and the list holds {held}"
                ));
            }
        }
        Ok(())
    }

    /// A case is Rust-only exactly when it expects the refusal only an implementation with a Rust-sized integer gives, so the flag cannot drift from what the case does.
    fn check_rust_only_cases(&self) -> Result<(), String> {
        for case in &self.mints {
            let expects_value_refusal = matches!(&case.expected, Expected::Refused(reason)
                if reason == MintRefusal::ValueNotRepresentable.as_str());
            if case.rust_only != expects_value_refusal {
                return Err(format!(
                    "case {} is {}rust_only but {}expects value_not_representable",
                    case.name,
                    if case.rust_only { "" } else { "not " },
                    if expects_value_refusal {
                        ""
                    } else {
                        "does not "
                    },
                ));
            }
        }
        Ok(())
    }

    /// Every refusal reason some case expects, so a reason with no case fails the run.
    fn check_every_refusal_has_a_case(&self) -> Result<(), String> {
        for refusal in MintRefusal::ALL {
            let covered = self.mints.iter().any(|case| {
                matches!(&case.expected, Expected::Refused(reason) if reason == refusal.as_str())
            });
            if !covered {
                return Err(format!("no case expects the refusal {}", refusal.as_str()));
            }
        }
        Ok(())
    }

    fn parse(value: &Value) -> Result<Section, String> {
        let mut root = Obj::new(value, "mint")?;
        if root.integer("layout_version")? != LAYOUT_VERSION {
            return Err(format!("mint.layout_version is not {LAYOUT_VERSION}"));
        }
        let now_ms = root.unsigned("now_ms")?;
        let mut identities = Vec::new();
        let mut table = root.object("identities")?;
        let names: Vec<String> = table.map.keys().cloned().collect();
        for name in names {
            let mut entry = table.object(&name)?;
            if entry.integer("alg")? != -8 {
                return Err(format!("identity {name} is not Ed25519"));
            }
            if !entry.boolean("synthetic")? {
                return Err(format!("identity {name} is not marked synthetic"));
            }
            let secret = entry.hex("secret_hex")?;
            let public = entry.hex("public_key_hex")?;
            let device = entry.fixed::<32>("device_id_hex")?;
            entry.finish()?;
            identities.push(IdentityRecord {
                name,
                secret,
                public_key: public,
                device_id: device,
            });
        }
        table.finish()?;
        let section = Section {
            now_ms,
            identities,
            mints: root
                .objects("token_mints")?
                .into_iter()
                .map(mint_case_of)
                .collect::<Result<_, _>>()?,
            revocations: root
                .objects("revocation_mints")?
                .into_iter()
                .map(|mut obj| {
                    let case = RevocationCase {
                        name: obj.string("name")?,
                        issuer: obj.string("issuer")?,
                        token_id: obj.hex("token_id_hex")?,
                        revoked_at: obj.unsigned("revoked_at")?,
                        vector: obj.string("vector")?,
                    };
                    obj.finish()?;
                    Ok(case)
                })
                .collect::<Result<_, String>>()?,
            can_grant: root
                .objects("can_grant")?
                .into_iter()
                .map(|obj| query_of(obj, false))
                .collect::<Result<_, _>>()?,
            can_grant_via: root
                .objects("can_grant_via")?
                .into_iter()
                .map(|obj| query_of(obj, true))
                .collect::<Result<_, _>>()?,
            counts: {
                let mut counts = root.object("counts")?;
                let parsed = Counts {
                    token_mints: counts.unsigned("token_mints")?,
                    revocation_mints: counts.unsigned("revocation_mints")?,
                    can_grant: counts.unsigned("can_grant")?,
                    can_grant_via: counts.unsigned("can_grant_via")?,
                };
                counts.finish()?;
                parsed
            },
        };
        root.finish()?;
        section.check_counts()?;
        section.check_every_refusal_has_a_case()?;
        section.check_rust_only_cases()?;
        Ok(section)
    }
}

struct Ctx<'a> {
    section: &'a Section,
    identities: HashMap<String, NodeIdentity>,
    wires: &'a HashMap<String, Vec<u8>>,
}

impl Ctx<'_> {
    fn identity(&self, name: &str) -> Result<&NodeIdentity, String> {
        self.identities
            .get(name)
            .ok_or_else(|| format!("no identity named {name}"))
    }

    fn device(&self, name: &str) -> Result<DeviceId, String> {
        Ok(*self.identity(name)?.device_id())
    }

    fn wire(&self, vector: &str) -> Result<&[u8], String> {
        self.wires
            .get(vector)
            .map(Vec::as_slice)
            .ok_or_else(|| format!("no vector named {vector}"))
    }
}

fn token_from(wire: &[u8]) -> Result<CoseSign1, String> {
    CoseSign1::decode_bytes(wire).map_err(|e| format!("a held token does not decode: {e}"))
}

async fn check_mint(ctx: &Ctx<'_>, case: &MintCase) -> Check {
    let issuer = ctx.identity(&case.issuer)?;
    let parent = case.parent.as_deref().map(token_from).transpose()?;
    let authorised_by = case.authorised_by.as_deref().map(token_from).transpose()?;
    let clock = FixedClock(case.now_ms);
    let result = mint_capability_token(MintCapabilityToken {
        identity: issuer,
        clock: &clock,
        token_id: case.token_id.clone(),
        bearer: ctx.device(&case.bearer)?,
        capability: CapabilityVerb(case.capability.clone()),
        scope: case.scope.clone(),
        expires: case.expires,
        not_before: case.not_before,
        delegations_remaining: case.delegations_remaining,
        parent: parent.as_ref(),
        conditions: case.conditions.clone(),
        authorised_by: authorised_by.as_ref(),
        grants_capability: case.grants_capability.clone().map(CapabilityVerb),
        requests_capability: case.requests_capability.clone().map(CapabilityVerb),
    })
    .await;
    match (&case.expected, result) {
        (Expected::Refused(reason), Err(MintError::Refused(refusal))) => {
            if refusal.as_str() == reason {
                Ok(())
            } else {
                Err(format!("expected refusal {reason}, got {refusal}"))
            }
        }
        (Expected::Refused(reason), Ok(_)) => {
            Err(format!("expected refusal {reason}, but a token was minted"))
        }
        (_, Err(error)) => Err(format!("expected a token, got {error}")),
        (Expected::Minted { vector, verifies }, Ok(token)) => {
            report_first_divergence(ctx.wire(vector)?, &token.encode_to_vec())?;
            let verdict = verify_capability_token(
                issuer,
                &FixedClock(ctx.section.now_ms),
                &RevocationView::new(),
                &token,
                None,
            )
            .await;
            match (verdict, verifies) {
                (TokenVerdict::Valid { .. }, true) | (TokenVerdict::Invalid(_), false) => Ok(()),
                (TokenVerdict::Invalid(why), true) => {
                    Err(format!("the minted token does not verify: {why}"))
                }
                (TokenVerdict::Valid { .. }, false) => {
                    Err("the minted token verifies, but the vector says it does not".to_owned())
                }
            }
        }
    }
}

async fn check_revocation(ctx: &Ctx<'_>, case: &RevocationCase) -> Check {
    let issuer = ctx.identity(&case.issuer)?;
    let entry = mint_revocation_entry(issuer, case.token_id.clone(), case.revoked_at)
        .await
        .map_err(|e| format!("mint_revocation_entry: {e}"))?;
    report_first_divergence(ctx.wire(&case.vector)?, &entry.0.encode_to_vec())?;
    RevocationView::new()
        .verify_and_insert(&entry, issuer)
        .await
        .map_err(|e| format!("the minted entry is not admitted: {e}"))
}

fn check_query(ctx: &Ctx<'_>, query: &Query) -> Check {
    let held = token_from(&query.held)?;
    let device = ctx.device(&query.device)?;
    let verdict = match &query.bearer {
        None => can_grant(&held, &device, &query.candidate, query.now_ms),
        Some(bearer) => can_grant_via(
            &held,
            &device,
            &GrantCandidate {
                candidate: query.candidate.clone(),
                bearer: ctx.device(bearer)?,
            },
            query.now_ms,
        ),
    };
    if verdict == query.expected {
        Ok(())
    } else {
        Err(format!("expected {}, got {verdict}", query.expected))
    }
}

/// Runs every check of the section and names each, so the binary reports them like any other vector.
pub async fn check_section(
    value: &Value,
    wires: &HashMap<String, Vec<u8>>,
) -> Vec<(String, Check)> {
    let section = match Section::parse(value) {
        Ok(section) => section,
        Err(e) => panic!("mint.v1.json is not a valid vector file: {e}"),
    };
    let mut results = Vec::new();
    let mut identities = HashMap::new();
    for IdentityRecord {
        name,
        secret,
        public_key,
        device_id,
    } in &section.identities
    {
        let check = NodeIdentity::from_ed25519_secret(secret)
            .map_err(|e| format!("identity {name}: {e}"))
            .and_then(|node| {
                report_first_divergence(public_key, &node.identity_key().public_key)
                    .and_then(|()| report_first_divergence(device_id, node.device_id().as_bytes()))
                    .map(|()| node)
            });
        match check {
            Ok(node) => {
                identities.insert(name.clone(), node);
                results.push((format!("mint:identity:{name}"), Ok(())));
            }
            Err(e) => results.push((format!("mint:identity:{name}"), Err(e))),
        }
    }
    let ctx = Ctx {
        section: &section,
        identities,
        wires,
    };
    for case in &section.mints {
        results.push((
            format!("mint:token:{}", case.name),
            check_mint(&ctx, case).await,
        ));
    }
    for case in &section.revocations {
        results.push((
            format!("mint:revocation:{}", case.name),
            check_revocation(&ctx, case).await,
        ));
    }
    for query in &section.can_grant {
        results.push((
            format!("mint:can_grant:{}", query.name),
            check_query(&ctx, query),
        ));
    }
    for query in &section.can_grant_via {
        results.push((
            format!("mint:can_grant_via:{}", query.name),
            check_query(&ctx, query),
        ));
    }
    results
}

#[cfg(test)]
mod tests {
    /// serde_json without its `float_roundtrip` feature can read a decimal literal one unit in the last place away from the nearest double, which is what `JSON.parse` and `str::parse` give. A reader of vector files must agree with the TypeScript at numeric boundaries, so this compares a spread of 17-digit literals with the standard parse: it fails when the feature is off.
    #[test]
    fn serde_json_reads_floats_to_the_nearest_double() {
        let mut state: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for _ in 0..20_000 {
            let digits = next() % 100_000_000_000_000_000;
            let exponent = i64::try_from(next() % 40).expect("small") - 20;
            let literal = format!("{digits}e{exponent}");
            let expected: f64 = literal.parse().expect("a decimal literal");
            let read: f64 = serde_json::from_str(&literal).expect("valid JSON number");
            assert_eq!(read.to_bits(), expected.to_bits(), "{literal}");
        }
    }
}
