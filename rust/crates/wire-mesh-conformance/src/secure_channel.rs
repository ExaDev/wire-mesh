//! Checks the `secure_channel` section of `secure-channel.v1.json` against `wire_mesh_core::domain::secure_channel`.
//!
//! Every field of the section is read, and a field this module does not read fails the run: each object is parsed through [`Obj`], which refuses to finish while keys remain. What is recomputed from the fixed inputs and compared:
//!
//! - each identity's public key and device-id from its secret;
//! - each hello's ephemeral public key, signing input, signature (regenerated for Ed25519, verified for ES256, whose signatures are randomised) and the hello's wire bytes;
//! - each handshake's shared secret, salt, both HKDF infos and both direction keys;
//! - each transcript frame's IV, associated data and ciphertext, by sealing it on the real channel, and the opened frame at the other end;
//! - every hello verdict, establish verdict and open sequence step by step, with the expected class.

use std::collections::HashMap;

use serde_json::{Map, Value};
use wire_mesh_core::adapters::NodeIdentity;
use wire_mesh_core::domain::secure_channel::{
    begin_handshake_with, channel_hkdf_info, channel_salt, data_associated_data, data_iv,
    derive_direction_keys, establish_channel, hello_signing_input, is_sealable, verify_hello,
    EstablishError, HelloRefusal, OpenError, PendingHandshake, SecureChannel, LABEL_HIGH_TO_LOW,
    LABEL_LOW_TO_HIGH,
};
use wire_mesh_core::ports::Identity;
use wire_mesh_wire::identity::{DeviceId, IdentityKey};
use wire_mesh_wire::secure_channel::{SecureHelloFrame, EPHEMERAL_KEY_SIZE, NONCE_SIZE};
use wire_mesh_wire::{decode_frame, encode_frame, Frame};

use super::{decode_hex, report_first_divergence};

type Check = Result<(), String>;

/// A JSON object read field by field. [`Obj::finish`] fails while any field is left, so a field nothing reads cannot go unnoticed.
struct Obj {
    path: String,
    map: Map<String, Value>,
}

impl Obj {
    fn new(value: &Value, path: impl Into<String>) -> Result<Self, String> {
        let path = path.into();
        let map = value
            .as_object()
            .ok_or_else(|| format!("{path} is not an object"))?
            .clone();
        Ok(Obj { path, map })
    }

    fn take(&mut self, key: &str) -> Result<Value, String> {
        self.map
            .remove(key)
            .ok_or_else(|| format!("{} has no field {key}", self.path))
    }

    fn string(&mut self, key: &str) -> Result<String, String> {
        match self.take(key)? {
            Value::String(text) => Ok(text),
            _ => Err(format!("{}.{key} is not a string", self.path)),
        }
    }

    fn boolean(&mut self, key: &str) -> Result<bool, String> {
        self.take(key)?
            .as_bool()
            .ok_or_else(|| format!("{}.{key} is not a boolean", self.path))
    }

    fn integer(&mut self, key: &str) -> Result<i64, String> {
        self.take(key)?
            .as_i64()
            .ok_or_else(|| format!("{}.{key} is not an integer", self.path))
    }

    fn hex(&mut self, key: &str) -> Result<Vec<u8>, String> {
        let text = self.string(key)?;
        decode_hex(&text).map_err(|e| format!("{}.{key}: {e}", self.path))
    }

    /// A hex field that is `null` when it does not apply.
    fn optional_hex(&mut self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match self.take(key)? {
            Value::Null => Ok(None),
            Value::String(text) => decode_hex(&text)
                .map(Some)
                .map_err(|e| format!("{}.{key}: {e}", self.path)),
            _ => Err(format!("{}.{key} is neither null nor a string", self.path)),
        }
    }

    fn fixed<const N: usize>(&mut self, key: &str) -> Result<[u8; N], String> {
        let bytes = self.hex(key)?;
        <[u8; N]>::try_from(bytes.as_slice())
            .map_err(|_| format!("{}.{key} is {} bytes, not {N}", self.path, bytes.len()))
    }

    fn object(&mut self, key: &str) -> Result<Obj, String> {
        let value = self.take(key)?;
        Obj::new(&value, format!("{}.{key}", self.path))
    }

    fn objects(&mut self, key: &str) -> Result<Vec<Obj>, String> {
        match self.take(key)? {
            Value::Array(items) => items
                .iter()
                .enumerate()
                .map(|(i, item)| Obj::new(item, format!("{}.{key}[{i}]", self.path)))
                .collect(),
            _ => Err(format!("{}.{key} is not an array", self.path)),
        }
    }

    fn strings(&mut self, key: &str) -> Result<Vec<String>, String> {
        match self.take(key)? {
            Value::Array(items) => items
                .into_iter()
                .map(|item| match item {
                    Value::String(text) => Ok(text),
                    _ => Err(format!("{}.{key} holds a non-string", self.path)),
                })
                .collect(),
            _ => Err(format!("{}.{key} is not an array", self.path)),
        }
    }

    /// Fails when the object has a field nothing read.
    fn finish(self) -> Check {
        if self.map.is_empty() {
            Ok(())
        } else {
            let unread: Vec<&str> = self.map.keys().map(String::as_str).collect();
            Err(format!(
                "{} has field(s) this binary does not read: {}",
                self.path,
                unread.join(", ")
            ))
        }
    }
}

struct IdentitySpec {
    alg: i64,
    secret: Vec<u8>,
    public_key: Vec<u8>,
    device_id: [u8; 32],
}

struct SideSpec {
    identity: String,
    peer: String,
    ephemeral_secret: [u8; 32],
    ephemeral_public: Vec<u8>,
    nonce: [u8; NONCE_SIZE],
    signing_input: Vec<u8>,
    signature: Vec<u8>,
    signature_verify_only: bool,
    hello_vector: String,
}

struct KeySchedule {
    low: String,
    high: String,
    shared_secret: [u8; 32],
    salt: Vec<u8>,
    info_low_to_high: Vec<u8>,
    info_high_to_low: Vec<u8>,
    key_low_to_high: [u8; 32],
    key_high_to_low: [u8; 32],
}

struct TranscriptFrame {
    from: String,
    counter: String,
    inner_frame: String,
    inner_wire: Vec<u8>,
    iv: Vec<u8>,
    aad: Vec<u8>,
    ciphertext: Vec<u8>,
    sealed_vector: String,
}

struct Handshake {
    name: String,
    sides: Vec<SideSpec>,
    key_schedule: KeySchedule,
    transcript: Vec<TranscriptFrame>,
}

struct HelloVerdict {
    name: String,
    handshake: String,
    receiver: String,
    hello_vector: String,
    expected: String,
    also_acceptable: Vec<String>,
    peer_device_id: Option<Vec<u8>>,
    signing_input: Option<Vec<u8>>,
    signature: Option<Vec<u8>>,
}

struct EstablishVerdict {
    name: String,
    handshake: String,
    side: String,
    hello_vector: String,
    hello_verdict: String,
    expected: String,
    refused_at: String,
    stage_advisory: bool,
}

enum Expected {
    Opened(Vec<u8>),
    Refused(String),
}

struct Step {
    counter: String,
    wire: Vec<u8>,
    expected: Expected,
    full_width_only: bool,
}

struct OpenSequence {
    name: String,
    handshake: String,
    sender: String,
    receiver: String,
    steps: Vec<Step>,
    receiver_drops_after_open: bool,
}

/// The whole `secure_channel` section, parsed with every field read.
pub struct Section {
    identities: Vec<(String, IdentitySpec)>,
    handshakes: Vec<Handshake>,
    hello_verdicts: Vec<HelloVerdict>,
    establish_verdicts: Vec<EstablishVerdict>,
    open_sequences: Vec<OpenSequence>,
}

fn parse_identity(mut obj: Obj) -> Result<IdentitySpec, String> {
    let spec = IdentitySpec {
        alg: obj.integer("alg")?,
        secret: obj.hex("secret_hex")?,
        public_key: obj.hex("public_key_hex")?,
        device_id: obj.fixed("device_id_hex")?,
    };
    if !obj.boolean("synthetic")? {
        return Err(format!("{} is not marked synthetic", obj.path));
    }
    obj.finish()?;
    Ok(spec)
}

fn parse_side(mut obj: Obj) -> Result<SideSpec, String> {
    let side = SideSpec {
        identity: obj.string("identity")?,
        peer: obj.string("peer")?,
        ephemeral_secret: obj.fixed("ephemeral_secret_hex")?,
        ephemeral_public: obj.hex("ephemeral_public_hex")?,
        nonce: obj.fixed("nonce_hex")?,
        signing_input: obj.hex("signing_input_hex")?,
        signature: obj.hex("signature_hex")?,
        signature_verify_only: obj.boolean("signature_verify_only")?,
        hello_vector: obj.string("hello_vector")?,
    };
    obj.finish()?;
    Ok(side)
}

fn parse_key_schedule(mut obj: Obj) -> Result<KeySchedule, String> {
    let schedule = KeySchedule {
        low: obj.string("low")?,
        high: obj.string("high")?,
        shared_secret: obj.fixed("shared_secret_hex")?,
        salt: obj.hex("salt_hex")?,
        info_low_to_high: obj.hex("info_low_to_high_hex")?,
        info_high_to_low: obj.hex("info_high_to_low_hex")?,
        key_low_to_high: obj.fixed("key_low_to_high_hex")?,
        key_high_to_low: obj.fixed("key_high_to_low_hex")?,
    };
    obj.finish()?;
    Ok(schedule)
}

fn parse_transcript_frame(mut obj: Obj) -> Result<TranscriptFrame, String> {
    let frame = TranscriptFrame {
        from: obj.string("from")?,
        counter: obj.string("counter")?,
        inner_frame: obj.string("inner_frame")?,
        inner_wire: obj.hex("inner_wire_hex")?,
        iv: obj.hex("iv_hex")?,
        aad: obj.hex("aad_hex")?,
        ciphertext: obj.hex("ciphertext_hex")?,
        sealed_vector: obj.string("sealed_vector")?,
    };
    obj.finish()?;
    Ok(frame)
}

fn parse_handshake(mut obj: Obj) -> Result<Handshake, String> {
    let name = obj.string("name")?;
    let sides = obj
        .objects("sides")?
        .into_iter()
        .map(parse_side)
        .collect::<Result<Vec<_>, _>>()?;
    let key_schedule = parse_key_schedule(obj.object("key_schedule")?)?;
    let transcript = obj
        .objects("transcript")?
        .into_iter()
        .map(parse_transcript_frame)
        .collect::<Result<Vec<_>, _>>()?;
    obj.finish()?;
    Ok(Handshake {
        name,
        sides,
        key_schedule,
        transcript,
    })
}

fn parse_hello_verdict(mut obj: Obj) -> Result<HelloVerdict, String> {
    let verdict = HelloVerdict {
        name: obj.string("name")?,
        handshake: obj.string("handshake")?,
        receiver: obj.string("receiver")?,
        hello_vector: obj.string("hello_vector")?,
        expected: obj.string("expected")?,
        also_acceptable: obj.strings("also_acceptable")?,
        peer_device_id: obj.optional_hex("peer_device_id_hex")?,
        signing_input: obj.optional_hex("signing_input_hex")?,
        signature: obj.optional_hex("signature_hex")?,
    };
    obj.finish()?;
    Ok(verdict)
}

fn parse_establish_verdict(mut obj: Obj) -> Result<EstablishVerdict, String> {
    let verdict = EstablishVerdict {
        name: obj.string("name")?,
        handshake: obj.string("handshake")?,
        side: obj.string("side")?,
        hello_vector: obj.string("hello_vector")?,
        hello_verdict: obj.string("hello_verdict")?,
        expected: obj.string("expected")?,
        refused_at: obj.string("refused_at")?,
        stage_advisory: obj.boolean("stage_advisory")?,
    };
    obj.finish()?;
    Ok(verdict)
}

fn parse_step(mut obj: Obj) -> Result<Step, String> {
    let counter = obj.string("counter")?;
    let wire = obj.hex("secure_data_wire_hex")?;
    let mut expected = obj.object("expected")?;
    let result = expected.string("result")?;
    let expected = if result == "opened" {
        let frame = expected.hex("frame_wire_hex")?;
        expected.finish()?;
        Expected::Opened(frame)
    } else {
        expected.finish()?;
        Expected::Refused(result)
    };
    let step = Step {
        counter,
        wire,
        expected,
        full_width_only: obj.boolean("full_width_only")?,
    };
    obj.finish()?;
    Ok(step)
}

fn parse_open_sequence(mut obj: Obj) -> Result<OpenSequence, String> {
    let sequence = OpenSequence {
        name: obj.string("name")?,
        handshake: obj.string("handshake")?,
        sender: obj.string("sender")?,
        receiver: obj.string("receiver")?,
        steps: obj
            .objects("steps")?
            .into_iter()
            .map(parse_step)
            .collect::<Result<Vec<_>, _>>()?,
        receiver_drops_after_open: obj.boolean("receiver_drops_after_open")?,
    };
    obj.finish()?;
    Ok(sequence)
}

impl Section {
    /// Parses the section, failing on a field it does not read.
    pub fn parse(value: &Value) -> Result<Section, String> {
        let mut root = Obj::new(value, "secure_channel")?;
        if root.integer("layout_version")? != 1 {
            return Err("secure_channel.layout_version is not 1".to_owned());
        }
        let mut identities = Vec::new();
        let mut table = root.object("identities")?;
        let names: Vec<String> = table.map.keys().cloned().collect();
        for name in names {
            let entry = table.object(&name)?;
            identities.push((name, parse_identity(entry)?));
        }
        table.finish()?;
        let section = Section {
            identities,
            handshakes: root
                .objects("handshakes")?
                .into_iter()
                .map(parse_handshake)
                .collect::<Result<_, _>>()?,
            hello_verdicts: root
                .objects("hello_verdicts")?
                .into_iter()
                .map(parse_hello_verdict)
                .collect::<Result<_, _>>()?,
            establish_verdicts: root
                .objects("establish_verdicts")?
                .into_iter()
                .map(parse_establish_verdict)
                .collect::<Result<_, _>>()?,
            open_sequences: root
                .objects("open_sequences")?
                .into_iter()
                .map(parse_open_sequence)
                .collect::<Result<_, _>>()?,
        };
        root.finish()?;
        Ok(section)
    }
}

/// An identity restored from its fixed secret, with the device-id it must have.
struct Ident {
    node: NodeIdentity,
}

struct Ctx<'a> {
    section: &'a Section,
    identities: HashMap<String, Ident>,
    /// The top-level `vectors`, by name, as wire bytes.
    wires: &'a HashMap<String, Vec<u8>>,
}

impl Ctx<'_> {
    fn ident(&self, name: &str) -> Result<&NodeIdentity, String> {
        self.identities
            .get(name)
            .map(|ident| &ident.node)
            .ok_or_else(|| format!("no identity named {name}"))
    }

    fn device(&self, name: &str) -> Result<DeviceId, String> {
        Ok(*self.ident(name)?.device_id())
    }

    fn handshake(&self, name: &str) -> Result<&Handshake, String> {
        self.section
            .handshakes
            .iter()
            .find(|h| h.name == name)
            .ok_or_else(|| format!("no handshake named {name}"))
    }

    fn wire(&self, vector: &str) -> Result<&[u8], String> {
        self.wires
            .get(vector)
            .map(Vec::as_slice)
            .ok_or_else(|| format!("no vector named {vector}"))
    }

    fn hello(&self, vector: &str) -> Result<SecureHelloFrame, String> {
        match decode_frame(self.wire(vector)?) {
            Ok(Frame::SecureHello(hello)) => Ok(hello),
            Ok(other) => Err(format!("{vector} is a {} frame, not a hello", other.kind())),
            Err(e) => Err(format!("{vector} does not decode: {e}")),
        }
    }

    /// This side's half of the handshake, begun from its fixed ephemeral secret and nonce.
    async fn pending(&self, side: &SideSpec) -> Result<PendingHandshake, String> {
        begin_handshake_with(
            self.ident(&side.identity)?,
            self.device(&side.peer)?,
            &side.ephemeral_secret,
            side.nonce,
        )
        .await
        .map_err(|e| format!("begin_handshake_with: {e}"))
    }

    /// The channel `side` ends up with after verifying the other side's hello `remote_vector`, as a transport would build it.
    async fn channel(
        &self,
        side: &SideSpec,
        remote: &SecureHelloFrame,
    ) -> Result<SecureChannel, String> {
        let node = self.ident(&side.identity)?;
        let peer = verify_hello(node, remote)
            .await
            .map_err(|e| format!("the peer's hello was refused: {e}"))?;
        establish_channel(node.device_id(), self.pending(side).await?, remote, peer)
            .map_err(|e| format!("establish_channel: {e}"))
    }
}

fn same(label: &str, expected: &[u8], actual: &[u8]) -> Check {
    report_first_divergence(expected, actual).map_err(|e| format!("{label}: {e}"))
}

fn same_text(label: &str, expected: &str, actual: &str) -> Check {
    if expected == actual {
        Ok(())
    } else {
        Err(format!("{label}: expected {expected}, got {actual}"))
    }
}

fn hello_class(
    verdict: &Result<wire_mesh_core::domain::secure_channel::SecureChannelPeer, HelloRefusal>,
) -> &'static str {
    match verdict {
        Ok(_) => "ok",
        Err(HelloRefusal::WrongRecipient) => "wrong_recipient",
        Err(HelloRefusal::UnsupportedIdentityAlgorithm) => "unsupported_identity_alg",
        Err(HelloRefusal::InvalidIdentityKey) => "invalid_identity_key",
        Err(HelloRefusal::BadSignature) => "bad_signature",
    }
}

fn establish_class(result: &Result<SecureChannel, EstablishError>) -> &'static str {
    match result {
        Ok(_) => "established",
        Err(EstablishError::UnusableEphemeralKey) => "unusable_ephemeral_key",
        Err(EstablishError::InvalidNonce) => "invalid_nonce",
    }
}

fn open_class(result: &Result<Frame, OpenError>) -> &'static str {
    match result {
        Ok(_) => "opened",
        Err(OpenError::Replayed) => "replayed",
        Err(OpenError::Unauthentic) => "unauthentic",
        Err(OpenError::Undecodable(_)) => "undecodable",
    }
}

fn check_identity(name: &str, spec: &IdentitySpec) -> Check {
    let node = match spec.alg {
        IdentityKey::ALG_ED25519 => NodeIdentity::from_ed25519_secret(&spec.secret),
        IdentityKey::ALG_ES256 => NodeIdentity::from_es256_secret(&spec.secret),
        other => return Err(format!("identity {name} has algorithm {other}")),
    }
    .map_err(|e| format!("identity {name}: {e}"))?;
    same(
        &format!("identity {name} public key"),
        &spec.public_key,
        &node.identity_key().public_key,
    )?;
    same(
        &format!("identity {name} device-id"),
        &spec.device_id,
        node.device_id().as_bytes(),
    )
}

async fn check_side(ctx: &Ctx<'_>, handshake: &str, side: &SideSpec) -> Check {
    let label = format!("{handshake} {} to {}", side.identity, side.peer);
    let node = ctx.ident(&side.identity)?;
    let sender = ctx.device(&side.identity)?;
    let recipient = ctx.device(&side.peer)?;
    let pending = ctx.pending(side).await?;
    let hello = pending.hello();
    same(
        &format!("{label} ephemeral public key"),
        &side.ephemeral_public,
        &hello.ephemeral_key,
    )?;
    same(&format!("{label} nonce"), &side.nonce, &hello.nonce)?;
    let ephemeral_key: [u8; EPHEMERAL_KEY_SIZE] = hello
        .ephemeral_key
        .as_slice()
        .try_into()
        .map_err(|_| format!("{label}: the ephemeral key is not {EPHEMERAL_KEY_SIZE} bytes"))?;
    same(
        &format!("{label} signing input"),
        &side.signing_input,
        &hello_signing_input(&ephemeral_key, &side.nonce, &sender, &recipient),
    )?;
    let committed = ctx.hello(&side.hello_vector)?;
    same(
        &format!("{label} committed hello signature"),
        &side.signature,
        &committed.signature,
    )?;
    let mut regenerated = hello.clone();
    if side.signature_verify_only {
        // ES256 signatures are randomised, so this one is verified and never reproduced; everything else in the hello is still compared.
        let valid = node
            .verify(
                node.identity_key(),
                &side.signing_input,
                &committed.signature,
            )
            .await
            .map_err(|e| format!("{label}: verifying the committed signature: {e}"))?;
        if !valid {
            return Err(format!("{label}: the committed signature does not verify"));
        }
        regenerated.signature = committed.signature.clone();
    } else {
        same(
            &format!("{label} regenerated signature"),
            &side.signature,
            &hello.signature,
        )?;
    }
    same(
        &format!("{label} hello wire"),
        ctx.wire(&side.hello_vector)?,
        &encode_frame(&Frame::SecureHello(regenerated)),
    )
}

async fn check_handshake(ctx: &Ctx<'_>, handshake: &Handshake) -> Check {
    let [first, second] = handshake.sides.as_slice() else {
        return Err(format!("{} does not have two sides", handshake.name));
    };
    for side in [first, second] {
        check_side(ctx, &handshake.name, side).await?;
    }

    let schedule = &handshake.key_schedule;
    let first_is_low = ctx.device(&first.identity)? < ctx.device(&second.identity)?;
    let (low, high) = if first_is_low {
        (first, second)
    } else {
        (second, first)
    };
    same_text(
        &format!("{} low device", handshake.name),
        &schedule.low,
        &low.identity,
    )?;
    same_text(
        &format!("{} high device", handshake.name),
        &schedule.high,
        &high.identity,
    )?;
    let shared_first = ctx
        .pending(first)
        .await?
        .shared_secret_with(&second.ephemeral_public)
        .map_err(|e| format!("{} shared secret: {e}", handshake.name))?;
    let shared_second = ctx
        .pending(second)
        .await?
        .shared_secret_with(&first.ephemeral_public)
        .map_err(|e| format!("{} shared secret: {e}", handshake.name))?;
    same(
        &format!("{} shared secret", handshake.name),
        &schedule.shared_secret,
        shared_first.as_slice(),
    )?;
    same(
        &format!("{} shared secret from the other end", handshake.name),
        &schedule.shared_secret,
        shared_second.as_slice(),
    )?;
    let (low_device, high_device) = (ctx.device(&low.identity)?, ctx.device(&high.identity)?);
    same(
        &format!("{} salt", handshake.name),
        &schedule.salt,
        &channel_salt(&low.nonce, &high.nonce),
    )?;
    same(
        &format!("{} info lo-to-hi", handshake.name),
        &schedule.info_low_to_high,
        &channel_hkdf_info(&low_device, &high_device, LABEL_LOW_TO_HIGH),
    )?;
    same(
        &format!("{} info hi-to-lo", handshake.name),
        &schedule.info_high_to_low,
        &channel_hkdf_info(&low_device, &high_device, LABEL_HIGH_TO_LOW),
    )?;
    let keys = derive_direction_keys(
        &shared_first,
        &low_device,
        &high_device,
        &low.nonce,
        &high.nonce,
    );
    same(
        &format!("{} key lo-to-hi", handshake.name),
        &schedule.key_low_to_high,
        keys.low_to_high.as_slice(),
    )?;
    same(
        &format!("{} key hi-to-lo", handshake.name),
        &schedule.key_high_to_low,
        keys.high_to_low.as_slice(),
    )?;

    let mut channels: HashMap<&str, SecureChannel> = HashMap::new();
    channels.insert(
        first.identity.as_str(),
        ctx.channel(first, &ctx.hello(&second.hello_vector)?)
            .await?,
    );
    channels.insert(
        second.identity.as_str(),
        ctx.channel(second, &ctx.hello(&first.hello_vector)?)
            .await?,
    );
    for step in &handshake.transcript {
        let receiver_name = if step.from == first.identity {
            &second.identity
        } else {
            &first.identity
        };
        let label = format!("{} {} from {}", handshake.name, step.inner_frame, step.from);
        let inner = decode_frame(&step.inner_wire).map_err(|e| format!("{label}: {e}"))?;
        let counter: u64 = step
            .counter
            .parse()
            .map_err(|_| format!("{label}: counter {} is not a u64", step.counter))?;
        let sender = ctx.device(&step.from)?;
        let receiver = ctx.device(receiver_name)?;
        same(&format!("{label} IV"), &step.iv, &data_iv(counter))?;
        same(
            &format!("{label} associated data"),
            &step.aad,
            &data_associated_data(&sender, &receiver, counter),
        )?;
        let sealed = channels
            .get_mut(step.from.as_str())
            .ok_or_else(|| format!("{label}: no channel"))?
            .seal(&inner)
            .map_err(|e| format!("{label}: seal: {e}"))?;
        same_text(
            &format!("{label} counter"),
            &step.counter,
            &sealed.counter.to_string(),
        )?;
        same(
            &format!("{label} ciphertext"),
            &step.ciphertext,
            &sealed.ciphertext,
        )?;
        same(
            &format!("{label} sealed frame wire"),
            ctx.wire(&step.sealed_vector)?,
            &encode_frame(&Frame::SecureData(sealed.clone())),
        )?;
        let opened = channels
            .get_mut(receiver_name.as_str())
            .ok_or_else(|| format!("{label}: no channel"))?
            .open(&sealed)
            .map_err(|e| format!("{label}: open: {e}"))?;
        same(
            &format!("{label} opened frame"),
            &step.inner_wire,
            &encode_frame(&opened),
        )?;
    }
    Ok(())
}

async fn check_hello_verdict(ctx: &Ctx<'_>, verdict: &HelloVerdict) -> Check {
    ctx.handshake(&verdict.handshake)?;
    let node = ctx.ident(&verdict.receiver)?;
    let hello = ctx.hello(&verdict.hello_vector)?;
    if let Some(expected_input) = &verdict.signing_input {
        let sender = node.derive_device_id(&hello.identity_key.public_key);
        let ephemeral_key: [u8; EPHEMERAL_KEY_SIZE] = hello
            .ephemeral_key
            .as_slice()
            .try_into()
            .map_err(|_| "the hello's ephemeral key is not 65 bytes".to_owned())?;
        let nonce: [u8; NONCE_SIZE] = hello
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| "the hello's nonce is not 16 bytes".to_owned())?;
        same(
            "signing input",
            expected_input,
            &hello_signing_input(&ephemeral_key, &nonce, &sender, &hello.to_device),
        )?;
    }
    if let Some(expected_signature) = &verdict.signature {
        same("signature", expected_signature, &hello.signature)?;
    }
    let result = verify_hello(node, &hello).await;
    let class = hello_class(&result);
    if class != verdict.expected && !verdict.also_acceptable.iter().any(|a| a == class) {
        return Err(format!(
            "expected {} (also acceptable: {:?}), got {class}",
            verdict.expected, verdict.also_acceptable
        ));
    }
    match (&result, &verdict.peer_device_id) {
        (Ok(peer), Some(expected)) => {
            same("peer device-id", expected, peer.device_id.as_bytes())?;
            if peer.identity_key != hello.identity_key {
                return Err("the peer's identity key is not the hello's".to_owned());
            }
            Ok(())
        }
        (Ok(_), None) => Err("an accepted hello has no expected peer device-id".to_owned()),
        (Err(_), Some(_)) => Err("a refused hello has an expected peer device-id".to_owned()),
        (Err(_), None) => Ok(()),
    }
}

async fn check_establish_verdict(ctx: &Ctx<'_>, verdict: &EstablishVerdict) -> Check {
    let handshake = ctx.handshake(&verdict.handshake)?;
    let side = handshake
        .sides
        .iter()
        .find(|s| s.identity == verdict.side)
        .ok_or_else(|| format!("{} has no side {}", handshake.name, verdict.side))?;
    let node = ctx.ident(&side.identity)?;
    match verdict.refused_at.as_str() {
        "establishment" | "decoding_or_establishment" => {}
        other => return Err(format!("unknown refused_at {other}")),
    }
    let hello = match decode_frame(ctx.wire(&verdict.hello_vector)?) {
        Ok(Frame::SecureHello(hello)) => hello,
        Ok(other) => return Err(format!("the vector is a {} frame", other.kind())),
        // Refused where the frame is decoded, which the spec allows for a key that is not 65 bytes.
        Err(_) if verdict.stage_advisory && verdict.expected == "refused" => return Ok(()),
        Err(e) => return Err(format!("the hello does not decode: {e}")),
    };
    let result = verify_hello(node, &hello).await;
    same_text(
        "hello verdict",
        &verdict.hello_verdict,
        hello_class(&result),
    )?;
    let peer = result.map_err(|e| format!("the hello was refused: {e}"))?;
    let established = establish_channel(node.device_id(), ctx.pending(side).await?, &hello, peer);
    let class = establish_class(&established);
    if verdict.expected == "refused" {
        if established.is_ok() {
            return Err("expected the channel to be refused, got established".to_owned());
        }
    } else {
        same_text("establishment", &verdict.expected, class)?;
    }
    Ok(())
}

async fn check_open_sequence(ctx: &Ctx<'_>, sequence: &OpenSequence) -> Check {
    let handshake = ctx.handshake(&sequence.handshake)?;
    let side_of = |name: &str| {
        handshake
            .sides
            .iter()
            .find(|s| s.identity == name)
            .ok_or_else(|| format!("{} has no side {name}", handshake.name))
    };
    let receiver = side_of(&sequence.receiver)?;
    let sender = side_of(&sequence.sender)?;
    let mut channel = ctx
        .channel(receiver, &ctx.hello(&sender.hello_vector)?)
        .await?;
    for (index, step) in sequence.steps.iter().enumerate() {
        let label = format!(
            "step {index} (counter {}{})",
            step.counter,
            if step.full_width_only {
                ", full width only"
            } else {
                ""
            }
        );
        let data = match decode_frame(&step.wire) {
            Ok(Frame::SecureData(data)) => data,
            Ok(other) => {
                return Err(format!(
                    "{label}: a {} frame, not secure-data",
                    other.kind()
                ))
            }
            Err(e) => return Err(format!("{label}: does not decode: {e}")),
        };
        same_text(&label, &step.counter, &data.counter.to_string())?;
        let result = channel.open(&data);
        let class = open_class(&result);
        match (&step.expected, &result) {
            (Expected::Opened(wire), Ok(frame)) => {
                same(&format!("{label} opened frame"), wire, &encode_frame(frame))?;
                if is_sealable(frame) == sequence.receiver_drops_after_open {
                    return Err(format!(
                        "{label}: a {} frame is {}sealable under obligation 5 but the vector says the receiver {}",
                        frame.kind(),
                        if is_sealable(frame) { "" } else { "not " },
                        if sequence.receiver_drops_after_open { "drops it" } else { "keeps it" },
                    ));
                }
            }
            (Expected::Refused(expected), _) => same_text(&label, expected, class)?,
            (Expected::Opened(_), Err(e)) => {
                return Err(format!(
                    "{label}: expected the frame to open, got {class} ({e})"
                ))
            }
        }
    }
    Ok(())
}

/// Runs every check of the section and names each, so the binary reports them like any other vector.
pub async fn check_section(
    value: &Value,
    wires: &HashMap<String, Vec<u8>>,
) -> Vec<(String, Check)> {
    let section = match Section::parse(value) {
        Ok(section) => section,
        Err(e) => panic!("secure-channel.v1.json is not a valid vector file: {e}"),
    };
    let mut identities = HashMap::new();
    let mut results = Vec::new();
    for (name, spec) in &section.identities {
        let result = check_identity(name, spec);
        if result.is_ok() {
            let node = match spec.alg {
                IdentityKey::ALG_ED25519 => NodeIdentity::from_ed25519_secret(&spec.secret),
                _ => NodeIdentity::from_es256_secret(&spec.secret),
            };
            if let Ok(node) = node {
                identities.insert(name.clone(), Ident { node });
            }
        }
        results.push((format!("secure_channel:identity:{name}"), result));
    }
    let ctx = Ctx {
        section: &section,
        identities,
        wires,
    };
    for handshake in &section.handshakes {
        results.push((
            format!("secure_channel:handshake:{}", handshake.name),
            check_handshake(&ctx, handshake).await,
        ));
    }
    for verdict in &section.hello_verdicts {
        results.push((
            format!("secure_channel:hello_verdict:{}", verdict.name),
            check_hello_verdict(&ctx, verdict).await,
        ));
    }
    for verdict in &section.establish_verdicts {
        results.push((
            format!("secure_channel:establish_verdict:{}", verdict.name),
            check_establish_verdict(&ctx, verdict).await,
        ));
    }
    for sequence in &section.open_sequences {
        results.push((
            format!("secure_channel:open_sequence:{}", sequence.name),
            check_open_sequence(&ctx, sequence).await,
        ));
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_field_nothing_reads_is_found() {
        let value = serde_json::json!({ "read": "x", "extra": 1 });
        let mut obj = Obj::new(&value, "o").expect("object");
        assert_eq!(obj.string("read").expect("string"), "x");
        let error = obj.finish().expect_err("an unread field");
        assert!(error.contains("extra"), "{error}");
    }

    #[test]
    fn an_object_with_every_field_read_finishes() {
        let value = serde_json::json!({ "read": "x" });
        let mut obj = Obj::new(&value, "o").expect("object");
        obj.string("read").expect("string");
        assert_eq!(obj.finish(), Ok(()));
    }

    #[test]
    fn an_unread_field_in_a_nested_step_fails_parsing() {
        let step = serde_json::json!({
            "counter": "0",
            "secure_data_wire_hex": "00",
            "expected": { "result": "replayed", "frame_wire_hex": "00" },
            "full_width_only": false,
        });
        let error = parse_step(Obj::new(&step, "step").expect("object"))
            .err()
            .expect("a refusal with a frame is not a step");
        assert!(error.contains("frame_wire_hex"), "{error}");
    }
}
