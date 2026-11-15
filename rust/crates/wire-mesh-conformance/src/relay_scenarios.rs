//! The `handshake_scenarios` section of `secure-channel.v1.json`, checked against `wire_mesh_core::domain::relay_channels`: each scenario's parties are built from its identities, their handshakes begin from the fixed ephemeral keys the file names (so every hello is the same bytes the file holds), and the steps run one at a time to quiescence on a manual clock. After each step what changed is compared with what the file expects: the hellos sent (by the handshake each belongs to), the seals that completed with the counter of every frame, the seals that failed, the frame an open produced and the faults reported. Every field of the section is read, and a field this module does not read fails the run.
//!
//! A seal that waits for a channel is a future left unfinished between steps; quiescence is reached by polling every unfinished future until none changes, with no scheduler, so the order of events is the order of the polls.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use serde_json::Value;
use wire_mesh_core::adapters::NodeIdentity;
use wire_mesh_core::domain::relay_channels::{
    HandshakeSource, HelloSender, RelayChannels, RelayError, RelayOptions, SealPurpose,
};
use wire_mesh_core::domain::secure_channel::{begin_handshake_with, PendingHandshake};
use wire_mesh_core::ports::{Clock, CoreError, Identity};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::secure_channel::{SecureDataFrame, SecureHelloFrame};
use wire_mesh_wire::{decode_frame, Frame};

use super::obj::{Check, Obj};

/// The layout of the section this binary reads.
const LAYOUT_VERSION: i64 = 1;

/// How many rounds of polling every unfinished seal a step is given to settle in; each round that changes nothing ends it.
const SETTLE_ROUNDS: usize = 200;

const SCRIPTED_FAILURE: &str = "scripted failure";

#[derive(Debug, Default, PartialEq, Eq)]
struct Delta {
    hellos: Vec<String>,
    sealed: Vec<(String, Vec<String>)>,
    failed: Vec<(String, String)>,
    opened: Option<(String, String)>,
    faults: Vec<(String, u64)>,
}

impl Delta {
    fn sorted(mut self) -> Self {
        self.sealed.sort();
        self.failed.sort();
        self
    }
}

struct HandshakeSpec {
    name: String,
    party: String,
    to: String,
    secret: [u8; 32],
    public: Vec<u8>,
    nonce: [u8; 16],
    hello_vector: String,
}

struct ExtraSpec {
    name: String,
    from: String,
    hello_vector: String,
}

struct IdentitySpec {
    name: String,
    secret: Vec<u8>,
    public_key: Vec<u8>,
    device_id: [u8; 32],
}

enum Op {
    Seal {
        seal: String,
        party: String,
        to: String,
        purpose: SealPurpose,
        frame: String,
    },
    Hello {
        handshake: String,
        claimed: String,
    },
    ExtraHello {
        hello: String,
        to: String,
        claimed: String,
    },
    Data {
        seal: String,
        index: usize,
        to: String,
    },
    Advance(u64),
    Forget {
        party: String,
        peer: String,
    },
    Reset(String),
    Fail {
        party: String,
        what: String,
        enabled: bool,
    },
}

struct Step {
    op: Op,
    expect: Delta,
}

struct Scenario {
    name: String,
    handshakes: Vec<HandshakeSpec>,
    extra: Vec<ExtraSpec>,
    steps: Vec<Step>,
}

struct Section {
    identities: Vec<IdentitySpec>,
    frames: HashMap<String, Frame>,
    scenarios: Vec<Scenario>,
}

fn parse_expect(mut obj: Obj) -> Result<Delta, String> {
    let hellos = obj.strings("hellos")?;
    let mut sealed = Vec::new();
    for mut item in obj.objects("sealed")? {
        sealed.push((item.string("seal")?, item.strings("counters")?));
        item.finish()?;
    }
    let mut failed = Vec::new();
    for mut item in obj.objects("failed")? {
        failed.push((item.string("seal")?, item.string("kind")?));
        item.finish()?;
    }
    let opened = match obj.optional_object("opened")? {
        Some(mut item) => {
            let pair = (item.string("from")?, item.string("frame")?);
            item.finish()?;
            Some(pair)
        }
        None => None,
    };
    let mut faults = Vec::new();
    for mut item in obj.objects("faults")? {
        faults.push((item.string("peer")?, item.unsigned("suppressed")?));
        item.finish()?;
    }
    obj.finish()?;
    Ok(Delta {
        hellos,
        sealed,
        failed,
        opened,
        faults,
    })
}

fn parse_step(value: &Value, path: &str) -> Result<Step, String> {
    let mut obj = Obj::new(value, path)?;
    let op = obj.string("op")?;
    let parsed = match op.as_str() {
        "seal" => Op::Seal {
            seal: obj.string("seal")?,
            party: obj.string("party")?,
            to: obj.string("to")?,
            purpose: match obj.string("purpose")?.as_str() {
                "request" => SealPurpose::Request,
                "reply" => SealPurpose::Reply,
                other => return Err(format!("{path}: unknown purpose {other}")),
            },
            frame: obj.string("frame")?,
        },
        "hello" => Op::Hello {
            handshake: obj.string("handshake")?,
            claimed: obj.string("claimed")?,
        },
        "extra_hello" => Op::ExtraHello {
            hello: obj.string("hello")?,
            to: obj.string("to")?,
            claimed: obj.string("claimed")?,
        },
        "data" => Op::Data {
            seal: obj.string("seal")?,
            index: usize::try_from(obj.unsigned("index")?).map_err(|e| e.to_string())?,
            to: obj.string("to")?,
        },
        "advance" => Op::Advance(obj.unsigned("ms")?),
        "forget" => Op::Forget {
            party: obj.string("party")?,
            peer: obj.string("peer")?,
        },
        "reset" => Op::Reset(obj.string("party")?),
        "fail" => Op::Fail {
            party: obj.string("party")?,
            what: obj.string("what")?,
            enabled: obj.boolean("enabled")?,
        },
        other => return Err(format!("{path}: unknown op {other}")),
    };
    let expect = parse_expect(obj.object("expect")?)?;
    obj.finish()?;
    Ok(Step { op: parsed, expect })
}

fn parse(value: &Value) -> Result<Section, String> {
    let mut root = Obj::new(value, "handshake_scenarios")?;
    let version = root.integer("layout_version")?;
    if version != LAYOUT_VERSION {
        return Err(format!(
            "handshake_scenarios.layout_version is {version}, this binary reads {LAYOUT_VERSION}"
        ));
    }
    let mut identities = Vec::new();
    for mut item in root.objects("identities")? {
        let spec = IdentitySpec {
            name: item.string("name")?,
            secret: item.hex("secret_hex")?,
            public_key: item.hex("public_key_hex")?,
            device_id: item.fixed("device_id_hex")?,
        };
        item.integer("alg")?;
        item.finish()?;
        identities.push(spec);
    }
    let mut frames = HashMap::new();
    if let Value::Object(map) = root.take("frames")? {
        for (name, wire) in map {
            let text = wire
                .as_str()
                .ok_or_else(|| format!("frame {name} is not hex text"))?;
            let bytes = super::decode_hex(text).map_err(|e| format!("frame {name}: {e}"))?;
            let frame = decode_frame(&bytes).map_err(|e| format!("frame {name}: {e}"))?;
            frames.insert(name, frame);
        }
    }
    let mut scenarios = Vec::new();
    for mut item in root.objects("scenarios")? {
        let name = item.string("name")?;
        let mut handshakes = Vec::new();
        for mut handshake in item.objects("handshakes")? {
            let spec = HandshakeSpec {
                name: handshake.string("name")?,
                party: handshake.string("party")?,
                to: handshake.string("to")?,
                secret: handshake.fixed("ephemeral_secret_hex")?,
                public: handshake.hex("ephemeral_public_hex")?,
                nonce: handshake.fixed("nonce_hex")?,
                hello_vector: handshake.string("hello_vector")?,
            };
            handshake.finish()?;
            handshakes.push(spec);
        }
        let mut extra = Vec::new();
        for mut hello in item.objects("extra_hellos")? {
            let spec = ExtraSpec {
                name: hello.string("name")?,
                from: hello.string("from")?,
                hello_vector: hello.string("hello_vector")?,
            };
            hello.string("to")?;
            hello.finish()?;
            extra.push(spec);
        }
        let mut steps = Vec::new();
        let raw = item.take("steps")?;
        let Value::Array(list) = raw else {
            return Err(format!("{name}.steps is not an array"));
        };
        for (index, step) in list.iter().enumerate() {
            steps.push(parse_step(step, &format!("{name}.steps[{index}]"))?);
        }
        item.finish()?;
        scenarios.push(Scenario {
            name,
            handshakes,
            extra,
            steps,
        });
    }
    let mut counts = root.object("counts")?;
    let counted = counts.unsigned("scenarios")?;
    counts.finish()?;
    if usize::try_from(counted).ok() != Some(scenarios.len()) {
        return Err(format!(
            "handshake_scenarios.counts.scenarios says {counted} and the list holds {}",
            scenarios.len()
        ));
    }
    root.finish()?;
    Ok(Section {
        identities,
        frames,
        scenarios,
    })
}

struct ManualClock(AtomicU64);

impl Clock for ManualClock {
    fn now_unix_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct SentHello {
    name: String,
    from: String,
    to: String,
    hello: SecureHelloFrame,
}

/// What every side of one scenario shares: what a step changed, the hellos sent, and which handshake each ephemeral key belongs to.
struct Shared {
    delta: Mutex<Delta>,
    sent: Mutex<Vec<SentHello>>,
    by_key: Mutex<HashMap<Vec<u8>, String>>,
    /// Device-ids of the parties, by name.
    devices: HashMap<String, DeviceId>,
}

impl Shared {
    fn party_of(&self, device: &DeviceId) -> Result<String, String> {
        self.devices
            .iter()
            .find(|(name, held)| *held == device && name.as_str() != "c")
            .map(|(name, _)| name.clone())
            .ok_or_else(|| "no party has this device".to_owned())
    }
}

struct Sender {
    party: String,
    fail: Arc<AtomicBool>,
    shared: Arc<Shared>,
}

#[async_trait::async_trait]
impl HelloSender for Sender {
    async fn send_hello(&self, peer: &DeviceId, hello: &SecureHelloFrame) -> Result<(), CoreError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(CoreError::Transport(SCRIPTED_FAILURE.to_owned()));
        }
        let by_key = self.shared.by_key.lock().map_err(|e| lock_error(&e))?;
        let name = by_key
            .get(&hello.ephemeral_key)
            .cloned()
            .ok_or_else(|| CoreError::Transport("a hello no handshake of the file made".into()))?;
        drop(by_key);
        let to = self.shared.party_of(peer).map_err(CoreError::Transport)?;
        self.shared
            .sent
            .lock()
            .map_err(|e| lock_error(&e))?
            .push(SentHello {
                name: name.clone(),
                from: self.party.clone(),
                to,
                hello: hello.clone(),
            });
        self.shared
            .delta
            .lock()
            .map_err(|e| lock_error(&e))?
            .hellos
            .push(name);
        Ok(())
    }
}

fn lock_error<T>(error: &std::sync::PoisonError<T>) -> CoreError {
    CoreError::Transport(error.to_string())
}

/// One handshake of a scenario, with the hello the file holds for it.
struct Scripted {
    name: String,
    secret: [u8; 32],
    public: Vec<u8>,
    nonce: [u8; 16],
    hello: Frame,
}

struct Handshakes {
    party: String,
    fail_sign: Arc<AtomicBool>,
    specs: Vec<Scripted>,
    ordinals: Mutex<HashMap<String, usize>>,
    shared: Arc<Shared>,
}

#[async_trait::async_trait]
impl HandshakeSource for Handshakes {
    async fn begin(
        &self,
        identity: &dyn Identity,
        peer: DeviceId,
    ) -> Result<PendingHandshake, CoreError> {
        if self.fail_sign.load(Ordering::SeqCst) {
            return Err(CoreError::Crypto(SCRIPTED_FAILURE.to_owned()));
        }
        let to = self.shared.party_of(&peer).map_err(CoreError::Crypto)?;
        let key = format!("{}>{to}", self.party);
        let ordinal = {
            let mut ordinals = self.ordinals.lock().map_err(|e| lock_error(&e))?;
            let next = ordinals.entry(key.clone()).or_insert(0);
            let taken = *next;
            *next += 1;
            taken
        };
        let wanted = format!("{key}#{ordinal}");
        let spec = self
            .specs
            .iter()
            .find(|spec| spec.name == wanted)
            .ok_or_else(|| CoreError::Crypto(format!("the scenario has no handshake {wanted}")))?;
        self.shared
            .by_key
            .lock()
            .map_err(|e| lock_error(&e))?
            .insert(spec.public.clone(), spec.name.clone());
        let pending = begin_handshake_with(identity, peer, &spec.secret, spec.nonce).await?;
        if Frame::SecureHello(pending.hello().clone()) != spec.hello {
            return Err(CoreError::Crypto(format!(
                "the hello of {wanted} is not the one the file holds"
            )));
        }
        Ok(pending)
    }
}

struct Side {
    channels: Arc<RelayChannels>,
    fail_sign: Arc<AtomicBool>,
    fail_send: Arc<AtomicBool>,
}

type SealFuture = Pin<Box<dyn Future<Output = Result<Vec<SecureDataFrame>, RelayError>>>>;

struct Waiting {
    seal: String,
    party: String,
    future: SealFuture,
}

struct Run<'a> {
    scenario: &'a Scenario,
    section: &'a Section,
    wires: &'a HashMap<String, Vec<u8>>,
    clock: Arc<ManualClock>,
    shared: Arc<Shared>,
    sides: HashMap<String, Side>,
    waiting: Vec<Waiting>,
    sealed: HashMap<String, (String, Vec<SecureDataFrame>)>,
}

impl<'a> Run<'a> {
    fn hello_vector(&self, name: &str) -> Result<SecureHelloFrame, String> {
        let wire = self
            .wires
            .get(name)
            .ok_or_else(|| format!("no vector {name}"))?;
        match decode_frame(wire).map_err(|e| format!("{name}: {e}"))? {
            Frame::SecureHello(hello) => Ok(hello),
            _ => Err(format!("{name} is not a secure-hello")),
        }
    }

    fn device(&self, name: &str) -> Result<DeviceId, String> {
        self.shared
            .devices
            .get(name)
            .copied()
            .ok_or_else(|| format!("no identity {name}"))
    }

    fn side(&self, name: &str) -> Result<&Side, String> {
        self.sides
            .get(name)
            .ok_or_else(|| format!("no side {name}"))
    }

    fn claimed(&self, sender: &str, claimed: &str) -> Result<Option<DeviceId>, String> {
        match claimed {
            "sender" => self.device(sender).map(Some),
            "none" => Ok(None),
            other => self.device(other).map(Some),
        }
    }

    fn frame(&self, name: &str) -> Result<Frame, String> {
        self.section
            .frames
            .get(name)
            .cloned()
            .ok_or_else(|| format!("no frame {name}"))
    }

    fn frame_name(&self, frame: &Frame) -> Result<String, String> {
        self.section
            .frames
            .iter()
            .find(|(_, held)| *held == frame)
            .map(|(name, _)| name.clone())
            .ok_or_else(|| "an opened frame is none of the file's frames".to_owned())
    }

    /// Polls every unfinished seal until a round changes nothing.
    fn settle(&mut self) -> Result<(), String> {
        let mut context = Context::from_waker(Waker::noop());
        for _ in 0..SETTLE_ROUNDS {
            let mut progressed = false;
            let mut still = Vec::new();
            for mut waiting in std::mem::take(&mut self.waiting) {
                match waiting.future.as_mut().poll(&mut context) {
                    Poll::Pending => still.push(waiting),
                    Poll::Ready(result) => {
                        progressed = true;
                        self.finish(waiting.seal, waiting.party, result)?;
                    }
                }
            }
            self.waiting = still;
            if !progressed {
                break;
            }
        }
        Ok(())
    }

    fn finish(
        &mut self,
        seal: String,
        party: String,
        result: Result<Vec<SecureDataFrame>, RelayError>,
    ) -> Result<(), String> {
        let mut delta = self.shared.delta.lock().map_err(|e| e.to_string())?;
        match result {
            Ok(frames) => {
                delta.sealed.push((
                    seal.clone(),
                    frames.iter().map(|data| data.counter.to_string()).collect(),
                ));
                drop(delta);
                self.sealed.insert(seal, (party, frames));
            }
            Err(error) => {
                let kind = match error {
                    RelayError::Handshake(_) => "handshake_failed",
                    _ => "abandoned",
                };
                delta.failed.push((seal, kind.to_owned()));
            }
        }
        Ok(())
    }

    async fn apply(&mut self, op: &Op) -> Result<(), String> {
        match op {
            Op::Seal {
                seal,
                party,
                to,
                purpose,
                frame,
            } => {
                let channels = Arc::clone(&self.side(party)?.channels);
                let to = self.device(to)?;
                let frame = self.frame(frame)?;
                let purpose = *purpose;
                self.waiting.push(Waiting {
                    seal: seal.clone(),
                    party: party.clone(),
                    future: Box::pin(async move { channels.seal(to, &frame, purpose).await }),
                });
            }
            Op::Hello { handshake, claimed } => {
                let (to, from, hello) = {
                    let sent = self.shared.sent.lock().map_err(|e| e.to_string())?;
                    let found = sent
                        .iter()
                        .find(|entry| entry.name == *handshake)
                        .ok_or_else(|| format!("{handshake} was never sent"))?;
                    (found.to.clone(), found.from.clone(), found.hello.clone())
                };
                let claimed = self.claimed(&from, claimed)?;
                self.side(&to)?.channels.apply_hello(&hello, claimed).await;
            }
            Op::ExtraHello { hello, to, claimed } => {
                let extra = self
                    .scenario
                    .extra
                    .iter()
                    .find(|entry| entry.name == *hello)
                    .ok_or_else(|| format!("no extra hello {hello}"))?;
                let frame = self.hello_vector(&extra.hello_vector)?;
                let claimed = self.claimed(&extra.from, claimed)?;
                self.side(to)?.channels.apply_hello(&frame, claimed).await;
            }
            Op::Data { seal, index, to } => {
                let (from, data) = {
                    let (from, frames) = self
                        .sealed
                        .get(seal)
                        .ok_or_else(|| format!("{seal} sealed nothing"))?;
                    let data = frames
                        .get(*index)
                        .ok_or_else(|| format!("{seal} sealed no frame {index}"))?;
                    (from.clone(), data.clone())
                };
                let opened = self
                    .side(to)?
                    .channels
                    .open(&data, Some(self.device(&from)?));
                let result = match opened {
                    Some(opened) => Some((
                        self.shared.party_of(&opened.from)?,
                        self.frame_name(&opened.frame)?,
                    )),
                    None => None,
                };
                self.shared.delta.lock().map_err(|e| e.to_string())?.opened = result;
            }
            Op::Advance(ms) => {
                self.clock.0.fetch_add(*ms, Ordering::SeqCst);
            }
            Op::Forget { party, peer } => {
                self.side(party)?.channels.forget(&self.device(peer)?);
            }
            Op::Reset(party) => self.side(party)?.channels.reset("the session was reset"),
            Op::Fail {
                party,
                what,
                enabled,
            } => {
                let side = self.side(party)?;
                match what.as_str() {
                    "send" => side.fail_send.store(*enabled, Ordering::SeqCst),
                    "sign" => side.fail_sign.store(*enabled, Ordering::SeqCst),
                    other => return Err(format!("unknown failure {other}")),
                }
            }
        }
        Ok(())
    }
}

fn build_side(
    name: &str,
    identity: &IdentitySpec,
    scenario: &Scenario,
    frames: &[(String, Frame)],
    clock: &Arc<ManualClock>,
    shared: &Arc<Shared>,
) -> Result<Side, String> {
    let node = NodeIdentity::from_ed25519_secret(&identity.secret).map_err(|e| e.to_string())?;
    if node.device_id().0 != identity.device_id
        || node.identity_key().public_key != identity.public_key
    {
        return Err(format!(
            "identity {} is not its seed's own key",
            identity.name
        ));
    }
    let fail_sign = Arc::new(AtomicBool::new(false));
    let fail_send = Arc::new(AtomicBool::new(false));
    let specs = scenario
        .handshakes
        .iter()
        .filter(|spec| spec.party == name)
        .map(|spec| {
            let frame = frames
                .iter()
                .find(|(vector, _)| *vector == spec.hello_vector)
                .map(|(_, frame)| frame.clone())
                .ok_or_else(|| format!("no vector {}", spec.hello_vector))?;
            if !spec
                .name
                .starts_with(&format!("{}>{}#", spec.party, spec.to))
            {
                return Err(format!("{} does not name its own parties", spec.name));
            }
            Ok(Scripted {
                name: spec.name.clone(),
                secret: spec.secret,
                public: spec.public.clone(),
                nonce: spec.nonce,
                hello: frame,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let sink = Arc::clone(shared);
    let peers = Arc::clone(shared);
    let options = RelayOptions {
        on_fault: Some(Arc::new(move |report| {
            let peer = report
                .fault
                .peer
                .as_ref()
                .and_then(|device| peers.party_of(device).ok())
                .unwrap_or_default();
            if let Ok(mut delta) = sink.delta.lock() {
                delta.faults.push((peer, report.suppressed));
            }
        })),
        handshakes: Some(Arc::new(Handshakes {
            party: name.to_owned(),
            fail_sign: Arc::clone(&fail_sign),
            specs,
            ordinals: Mutex::new(HashMap::new()),
            shared: Arc::clone(shared),
        })),
        ..RelayOptions::default()
    };
    let channels = Arc::new(RelayChannels::new(
        Arc::new(node),
        Arc::new(Sender {
            party: name.to_owned(),
            fail: Arc::clone(&fail_send),
            shared: Arc::clone(shared),
        }),
        clock.clone(),
        options,
    ));
    Ok(Side {
        channels,
        fail_sign,
        fail_send,
    })
}

async fn run_scenario(
    scenario: &Scenario,
    section: &Section,
    wires: &HashMap<String, Vec<u8>>,
) -> Check {
    let devices: HashMap<String, DeviceId> = section
        .identities
        .iter()
        .map(|identity| (identity.name.clone(), DeviceId(identity.device_id)))
        .collect();
    let shared = Arc::new(Shared {
        delta: Mutex::new(Delta::default()),
        sent: Mutex::new(Vec::new()),
        by_key: Mutex::new(HashMap::new()),
        devices,
    });
    let clock = Arc::new(ManualClock(AtomicU64::new(0)));
    let frames: Vec<(String, Frame)> = wires
        .iter()
        .filter_map(|(name, wire)| decode_frame(wire).ok().map(|frame| (name.clone(), frame)))
        .collect();
    let mut sides = HashMap::new();
    for name in ["a", "b"] {
        let identity = section
            .identities
            .iter()
            .find(|identity| identity.name == name)
            .ok_or_else(|| format!("no identity {name}"))?;
        sides.insert(
            name.to_owned(),
            build_side(name, identity, scenario, &frames, &clock, &shared)?,
        );
    }
    let mut run = Run {
        scenario,
        section,
        wires,
        clock,
        shared,
        sides,
        waiting: Vec::new(),
        sealed: HashMap::new(),
    };
    for (index, step) in scenario.steps.iter().enumerate() {
        *run.shared.delta.lock().map_err(|e| e.to_string())? = Delta::default();
        run.apply(&step.op).await?;
        run.settle()?;
        let got =
            std::mem::take(&mut *run.shared.delta.lock().map_err(|e| e.to_string())?).sorted();
        let want = Delta {
            hellos: step.expect.hellos.clone(),
            sealed: step.expect.sealed.clone(),
            failed: step.expect.failed.clone(),
            opened: step.expect.opened.clone(),
            faults: step.expect.faults.clone(),
        }
        .sorted();
        if got != want {
            return Err(format!(
                "{} step {index}: expected {want:?}, got {got:?}",
                scenario.name
            ));
        }
    }
    Ok(())
}

/// Checks the section: one outcome per scenario, and the accounting of the section itself.
pub async fn check_section(
    value: &Value,
    wires: &HashMap<String, Vec<u8>>,
) -> Vec<(String, Check)> {
    let section = match parse(value) {
        Ok(section) => section,
        Err(e) => panic!("secure-channel.v1.json handshake_scenarios is not valid: {e}"),
    };
    let mut results = Vec::new();
    for scenario in &section.scenarios {
        results.push((
            format!("handshake_scenarios:{}", scenario.name),
            run_scenario(scenario, &section, wires).await,
        ));
    }
    results
}
