//! Real, wire-driven DKG/reshare session orchestration (wire-mesh#177): the
//! Rust equivalent of `ts/packages/core/src/adapters/threshold-dkg.ts`'s
//! `runFreshThresholdDkg`/`computeReshareContribution`/
//! `sendReshareContribution`/`joinThresholdReshare`, driving this crate's
//! own [`crate::dkg`]/[`crate::reshare`] round functions over real
//! `manage-request` traffic. Matches the TS side's own choreography (round 1
//! broadcast, round 2 pairwise exchange, round 3 local computation,
//! echo-broadcast confirm; resharing's own asymmetry, where only survivors
//! deal and every member of the new participant set independently derives
//! and confirms) -- deliberately NOT its async-iterable shape.
//!
//! `mesh-session.ts`'s `MeshSession` is one object that can address any
//! peer and yields one shared incoming stream tagged with `fromDevice`;
//! `wire_mesh_core::domain::session::Session` (wire-mesh#173) is instead
//! scoped to exactly one already-established connection, with its
//! `HandlerRegistry` fixed at `Session::accept` time. A device running a
//! DKG/reshare ceremony among N peers therefore holds N separate `Session`s
//! (one per peer connection), each needing its own dispatch wired up before
//! the ceremony starts -- there is no single shared incoming-request stream
//! to filter, the way `startDkgConsumeLoop` filters one.
//!
//! This module deliberately never references `wire_mesh_core::domain::session`
//! at all -- that module only exists when `wire-mesh-core`'s "net" feature
//! is on, and this crate's own `[dependencies]` keep it off (see this
//! crate's own `Cargo.toml` comment on why: `wire-mesh-threshold-wasm`'s
//! wasm32-unknown-unknown build needs it off to succeed at all). Exactly
//! `network.rs`'s own established pattern for signing: [`handle_keygen_round1`]/
//! [`handle_keygen_round2`]/[`handle_keygen_confirm`] are plain functions a
//! real `ManageRequestHandler` impl (built where `Session` is actually in
//! scope -- a `[dev-dependencies]` test, or a real consuming binary) matches
//! `request.command.params`'s decoded variant onto, exactly the wiring
//! `tests/session_runtime_network.rs`'s own `ThresholdParticipant` already
//! does for `handle_threshold_commit`/`handle_threshold_sign`. Constructing
//! one of these per peer connection (baking in which peer it answers for)
//! is how this module knows "who sent this" without a `fromDevice`-style
//! field on the request itself -- answering a request that arrived on the
//! connection to `peer` is definitionally a message *from* `peer`.
//!
//! Outbound sends reuse [`crate::network::ManageRequestSender`] unchanged --
//! it already addresses an explicit `target: DeviceId` per call, exactly
//! the shape a caller backing it with N per-peer `Session`s needs, and
//! nothing about it assumes the signing protocol specifically.
//!
//! Every send in this module is awaited sequentially rather than
//! concurrently (`Promise.all`'s own choice, TS-side): each per-peer
//! connection is fully independent (no shared iterator, no cross-peer
//! blocking), so sequential awaits are exactly as correct as concurrent
//! ones, only slower for a large N -- not a correctness property, and the
//! ceremony sizes this crate targets (a person's own devices) never
//! approach a scale where that matters.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::task::{Context, Poll, Waker};

use frost_ed25519::keys::dkg::{round1, round2};
use frost_ed25519::keys::{
    KeyPackage, PublicKeyPackage, SecretShare, VerifiableSecretSharingCommitment,
};
use frost_ed25519::Identifier;
use wire_mesh_core::ports::CoreError;
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::{
    ManageCommand, ManageError, ManageOk, ManageOutcome, ManageParams,
};
use wire_mesh_wire::threshold::{
    ThresholdKeygenConfirm, ThresholdKeygenRound1, ThresholdKeygenRound2,
};
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb, CoseSign1};
use wire_mesh_wire::value::CanonicalMap;

use crate::dkg::{self, DkgError};
use crate::identifiers::{identifier_for_device, IdentifierError};
use crate::network::{keygen_capability_verb, ManageRequestSender};
use crate::reshare::{self, ReshareError};

/// An error in the DKG/reshare network orchestration flow. Wraps this
/// crate's own pure-crypto errors ([`DkgError`], [`ReshareError`],
/// [`IdentifierError`]), a raw `frost_ed25519` error surfaced directly by a
/// wire (de)serialization call this module performs itself, a transport
/// failure from the caller-supplied [`ManageRequestSender`], and the
/// failure modes specific to this orchestration layer: a peer's response
/// carrying an explicit `manage-error`, a collector aborted by a DIFFERENT
/// peer's earlier detected mismatch, and the mandatory echo-broadcast
/// confirm round detecting a mismatch itself (transcript digest, group key,
/// or -- for a reshare -- the derived group key not matching
/// `existing-group-key` at all, meaning a takeover attempt).
#[derive(Debug)]
pub enum DkgNetworkError {
    Dkg(DkgError),
    Reshare(ReshareError),
    Identifier(IdentifierError),
    Frost(frost_ed25519::Error),
    Transport(CoreError),
    /// A peer's `manage-response` for a round1/round2/confirm send was an
    /// explicit `manage-error`, not an ack -- unlike threshold SIGNING
    /// (which tolerates a non-cooperating participant, since only a quorum
    /// is required), a DKG/reshare ceremony has no partial-success path:
    /// every named participant MUST cooperate, so any error response aborts
    /// the whole ceremony immediately.
    UnexpectedOutcome {
        peer: DeviceId,
        code: String,
    },
    /// A fresh DKG's round1 payload from `peer` carried no
    /// `proof-of-knowledge` -- REQUIRED for a fresh DKG (absent this, a
    /// participant broadcasting last could adaptively bias the resulting
    /// group key).
    MissingProofOfKnowledge(DeviceId),
    /// A reshare's `compute_reshare_contribution` result had no outgoing
    /// share for `peer`, despite `peer` being a member of `new_participants`
    /// -- structurally impossible for a well-formed `frost_ed25519::keys::split`
    /// output, surfaced as a typed error rather than a panic since it would
    /// mean this crate's own reshare round1 is broken.
    MissingContribution(DeviceId),
    /// The echo-broadcast confirm round detected a transcript digest or
    /// group-key mismatch with `peer` -- the ceremony MUST abort, never be
    /// repaired in place.
    TranscriptMismatch {
        peer: DeviceId,
    },
    /// A reshare's own derived group key does not match `existing-group-key`
    /// -- a reshare that changes the group key is a takeover, never
    /// adopted.
    TakeoverRejected,
    /// A [`PerDeviceCollector`] this ceremony depends on was aborted by a
    /// DIFFERENT peer's earlier detected mismatch (see [`AbortReason`]).
    Aborted(String),
}

impl core::fmt::Display for DkgNetworkError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            DkgNetworkError::Dkg(e) => write!(f, "{e}"),
            DkgNetworkError::Reshare(e) => write!(f, "{e}"),
            DkgNetworkError::Identifier(e) => write!(f, "{e}"),
            DkgNetworkError::Frost(e) => write!(f, "FROST error: {e}"),
            DkgNetworkError::Transport(e) => write!(f, "transport error: {e}"),
            DkgNetworkError::UnexpectedOutcome { peer, code } => {
                write!(f, "peer {peer:?} returned manage-error {code:?}")
            }
            DkgNetworkError::MissingProofOfKnowledge(peer) => write!(
                f,
                "threshold.keygen-round1 from {peer:?} is missing proof-of-knowledge, REQUIRED for a fresh DKG"
            ),
            DkgNetworkError::MissingContribution(peer) => {
                write!(f, "no reshare contribution computed for new participant {peer:?}")
            }
            DkgNetworkError::TranscriptMismatch { peer } => write!(
                f,
                "keygen echo-broadcast transcript mismatch with {peer:?} -- aborting"
            ),
            DkgNetworkError::TakeoverRejected => write!(
                f,
                "reshare's own derived group key does not match existing-group-key -- refusing to adopt a takeover"
            ),
            DkgNetworkError::Aborted(reason) => write!(f, "ceremony aborted: {reason}"),
        }
    }
}

impl std::error::Error for DkgNetworkError {}

impl From<DkgError> for DkgNetworkError {
    fn from(e: DkgError) -> Self {
        DkgNetworkError::Dkg(e)
    }
}

impl From<ReshareError> for DkgNetworkError {
    fn from(e: ReshareError) -> Self {
        DkgNetworkError::Reshare(e)
    }
}

impl From<IdentifierError> for DkgNetworkError {
    fn from(e: IdentifierError) -> Self {
        DkgNetworkError::Identifier(e)
    }
}

impl From<frost_ed25519::Error> for DkgNetworkError {
    fn from(e: frost_ed25519::Error) -> Self {
        DkgNetworkError::Frost(e)
    }
}

impl From<AbortReason> for DkgNetworkError {
    fn from(e: AbortReason) -> Self {
        DkgNetworkError::Aborted(e.to_string())
    }
}

/// A ceremony-abort reason, broadcast to every waiter (current and future)
/// of a failed [`PerDeviceCollector`] -- mirrors `threshold-dkg.ts`'s own
/// `PerDeviceCollector.fail`. `Arc<str>` rather than `String` so `fail` can
/// clone it cheaply once per waiter without re-allocating the message.
#[derive(Debug, Clone)]
pub struct AbortReason(pub Arc<str>);

impl core::fmt::Display for AbortReason {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.0)
    }
}

struct PerDeviceState<T> {
    ready: HashMap<DeviceId, T>,
    wakers: HashMap<DeviceId, Waker>,
    failure: Option<AbortReason>,
}

/// One (round, session)'s worth of per-sender-device delivery: a value that
/// arrives before anyone is waiting for it is buffered; a waiter that
/// arrives before the value does is parked until [`Self::deliver`] wakes it.
/// Mirrors `threshold-dkg.ts`'s own `PerDeviceCollector`, implemented as a
/// hand-rolled [`Future`] (rather than a `tokio::sync::oneshot` per wait) so
/// this crate's `[dependencies]` never need an async runtime at all --
/// [`KeygenRoundCollectors`] stays usable from a plain `Session`-backed
/// native binary without pulling `tokio` into `wire-mesh-threshold-wasm`'s
/// wasm32-unknown-unknown build (see this crate's own `Cargo.toml` comment
/// on why `wire-mesh-core`'s "net" feature must stay off for that build to
/// succeed at all).
pub struct PerDeviceCollector<T> {
    state: StdMutex<PerDeviceState<T>>,
}

impl<T> Default for PerDeviceCollector<T> {
    fn default() -> Self {
        Self {
            state: StdMutex::new(PerDeviceState {
                ready: HashMap::new(),
                wakers: HashMap::new(),
                failure: None,
            }),
        }
    }
}

impl<T> PerDeviceCollector<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Delivers `value` as having arrived from `peer`. If a waiter is
    /// already parked for `peer`, wakes it; otherwise buffers `value` for
    /// the next [`Self::await_from`] call.
    pub fn deliver(&self, peer: DeviceId, value: T) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.ready.insert(peer, value);
        if let Some(waker) = state.wakers.remove(&peer) {
            waker.wake();
        }
    }

    /// Aborts every pending and future wait on this collector -- the
    /// ceremony failed for a reason no single `await_from` call caused
    /// (e.g. a peer's echo-broadcast confirm mismatched).
    pub fn fail(&self, error: AbortReason) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.failure = Some(error);
        for (_, waker) in state.wakers.drain() {
            waker.wake();
        }
    }

    /// Waits for a value delivered from `peer`, or the collector's own
    /// failure. Resolves immediately if a value or failure is already
    /// present; otherwise parks until [`Self::deliver`] or [`Self::fail`]
    /// wakes it.
    pub fn await_from(&self, peer: DeviceId) -> AwaitFrom<'_, T> {
        AwaitFrom {
            collector: self,
            peer,
        }
    }
}

/// The [`Future`] returned by [`PerDeviceCollector::await_from`]. Contains
/// no self-referential state (just a borrow and a `Copy` key), so it is
/// automatically `Unpin` and needs no `unsafe` pinning code of its own.
pub struct AwaitFrom<'a, T> {
    collector: &'a PerDeviceCollector<T>,
    peer: DeviceId,
}

impl<T> Future for AwaitFrom<'_, T> {
    type Output = Result<T, AbortReason>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let mut state = this
            .collector
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(value) = state.ready.remove(&this.peer) {
            return Poll::Ready(Ok(value));
        }
        if let Some(failure) = &state.failure {
            return Poll::Ready(Err(failure.clone()));
        }
        state.wakers.insert(this.peer, cx.waker().clone());
        Poll::Pending
    }
}

/// `threshold-keygen-round1`'s own payload, decoded off the wire but not
/// yet recombined into a `frost_ed25519` package -- kept as separate fields
/// (mirroring `threshold-dkg.ts`'s own `Round1Payload`) because a fresh DKG
/// combines them into a `dkg::round1::Package` while a reshare combines
/// only `commitment` into a `VerifiableSecretSharingCommitment`, never the
/// same combination.
#[derive(Debug, Clone)]
pub struct Round1Payload {
    pub commitment: Vec<Vec<u8>>,
    pub proof_of_knowledge: Option<Vec<u8>>,
    pub existing_group_key: Option<Vec<u8>>,
}

/// `threshold-keygen-confirm`'s own payload.
#[derive(Debug, Clone)]
pub struct ConfirmPayload {
    pub transcript_digest: Vec<u8>,
    pub group_key: Vec<u8>,
}

/// The three collectors one keygen/reshare ceremony needs, shared (via
/// `Arc`) across every per-peer dispatch handler the caller wires up for
/// that ceremony's `session_id` (see this module's own doc comment for why
/// the actual `ManageRequestHandler` impl lives with the caller, not here).
#[derive(Default)]
pub struct KeygenRoundCollectors {
    pub round1: PerDeviceCollector<Round1Payload>,
    pub round2: PerDeviceCollector<Vec<u8>>,
    pub confirm: PerDeviceCollector<ConfirmPayload>,
}

impl KeygenRoundCollectors {
    pub fn new() -> Self {
        Self::default()
    }

    /// Aborts every one of this ceremony's three collectors at once --
    /// mirrors `threshold-dkg.ts`'s own inline `collectors.round1.fail(...);
    /// collectors.round2.fail(...); collectors.confirm.fail(...);` on a
    /// transcript mismatch.
    pub fn fail(&self, error: AbortReason) {
        self.round1.fail(error.clone());
        self.round2.fail(error.clone());
        self.confirm.fail(error);
    }
}

fn manage_ok_empty() -> ManageOutcome {
    ManageOutcome::Ok(ManageOk {
        extra: CanonicalMap::new(),
    })
}

fn manage_error(code: &str) -> ManageOutcome {
    ManageOutcome::Error(ManageError {
        code: code.to_owned(),
        message: None,
    })
}

/// Handles an incoming `threshold-keygen-round1` for a ceremony already
/// bound to `session_id`, delivering it into `collectors` as having arrived
/// from `from_peer`. A real `ManageRequestHandler` (constructed per peer
/// connection, with that peer's own `DeviceId` baked in as `from_peer` --
/// see this module's own doc comment) calls this from its `handle` once it
/// has matched `request.command.params` to this variant. Checking
/// `params.session_id` against `session_id` and returning an explicit
/// `manage-error { code: "session-mismatch" }` on a mismatch (rather than
/// silently declining to respond, the way `startDkgConsumeLoop`'s own
/// `continue` does for TS's single SHARED incoming stream) is deliberate:
/// there is no shared stream here for another consumer to pick the message
/// up from instead, so silently not responding would just hang the
/// sender's own `send_manage_request` until its timeout, and this
/// codebase's own `HandlerRegistry` convention (an unknown verb gets a
/// loud, immediate `manage-error`, never a silently-dropped frame) already
/// establishes that an explicit error is the right answer here.
pub fn handle_keygen_round1(
    collectors: &KeygenRoundCollectors,
    session_id: u64,
    from_peer: DeviceId,
    params: ThresholdKeygenRound1,
) -> ManageOutcome {
    if params.session_id != session_id {
        return manage_error("session-mismatch");
    }
    collectors.round1.deliver(
        from_peer,
        Round1Payload {
            commitment: params.commitment,
            proof_of_knowledge: params.proof_of_knowledge,
            existing_group_key: params.existing_group_key,
        },
    );
    manage_ok_empty()
}

/// Handles an incoming `threshold-keygen-round2` -- see
/// [`handle_keygen_round1`]'s own doc comment for the calling convention.
pub fn handle_keygen_round2(
    collectors: &KeygenRoundCollectors,
    session_id: u64,
    from_peer: DeviceId,
    params: ThresholdKeygenRound2,
) -> ManageOutcome {
    if params.session_id != session_id {
        return manage_error("session-mismatch");
    }
    collectors.round2.deliver(from_peer, params.share);
    manage_ok_empty()
}

/// Handles an incoming `threshold-keygen-confirm` -- see
/// [`handle_keygen_round1`]'s own doc comment for the calling convention.
pub fn handle_keygen_confirm(
    collectors: &KeygenRoundCollectors,
    session_id: u64,
    from_peer: DeviceId,
    params: ThresholdKeygenConfirm,
) -> ManageOutcome {
    if params.session_id != session_id {
        return manage_error("session-mismatch");
    }
    collectors.confirm.deliver(
        from_peer,
        ConfirmPayload {
            transcript_digest: params.transcript_digest,
            group_key: params.group_key,
        },
    );
    manage_ok_empty()
}

/// Sends `command` to `peer` and turns an explicit `manage-error` response
/// into `Err` immediately -- unlike threshold signing's own tolerant
/// `continue`-on-error (a quorum can survive a non-cooperating participant),
/// a DKG/reshare ceremony needs every named participant, so any error
/// response aborts the whole ceremony right away.
async fn send_one<S: ManageRequestSender>(
    sender: &S,
    peer: DeviceId,
    command: ManageCommand,
    scope: CapabilityScope,
    token: Option<CoseSign1>,
) -> Result<(), DkgNetworkError> {
    let outcome = sender
        .send_manage_request(peer, command, scope, token)
        .await
        .map_err(DkgNetworkError::Transport)?;
    match outcome {
        ManageOutcome::Ok(_) => Ok(()),
        ManageOutcome::Error(error) => Err(DkgNetworkError::UnexpectedOutcome {
            peer,
            code: error.code,
        }),
    }
}

fn keygen_round1_command(
    session_id: u64,
    threshold: u64,
    participants: &[DeviceId],
    commitment: Vec<Vec<u8>>,
    proof_of_knowledge: Option<Vec<u8>>,
    existing_group_key: Option<Vec<u8>>,
    is_reshare: bool,
) -> ManageCommand {
    ManageCommand {
        verb: CapabilityVerb(keygen_capability_verb(is_reshare).to_owned()),
        params: ManageParams::ThresholdKeygenRound1(ThresholdKeygenRound1 {
            session_id,
            threshold,
            participants: participants.to_vec(),
            commitment,
            proof_of_knowledge,
            existing_group_key,
        }),
    }
}

fn keygen_round2_command(session_id: u64, share: Vec<u8>, is_reshare: bool) -> ManageCommand {
    ManageCommand {
        verb: CapabilityVerb(keygen_capability_verb(is_reshare).to_owned()),
        params: ManageParams::ThresholdKeygenRound2(ThresholdKeygenRound2 { session_id, share }),
    }
}

fn keygen_confirm_command(
    session_id: u64,
    transcript_digest: Vec<u8>,
    group_key: Vec<u8>,
    is_reshare: bool,
) -> ManageCommand {
    ManageCommand {
        verb: CapabilityVerb(keygen_capability_verb(is_reshare).to_owned()),
        params: ManageParams::ThresholdKeygenConfirm(ThresholdKeygenConfirm {
            session_id,
            transcript_digest,
            group_key,
        }),
    }
}

/// Every option [`run_fresh_threshold_dkg`] needs, borrowed rather than
/// owned so the caller keeps its own `sender`/`collectors` alive across the
/// whole ceremony (and can reuse `sender` for a later reshare, since
/// nothing about a [`ManageRequestSender`] is ceremony-specific).
pub struct RunFreshThresholdDkg<'a, S: ManageRequestSender> {
    pub sender: &'a S,
    pub collectors: &'a KeygenRoundCollectors,
    pub own_device_id: DeviceId,
    /// Every OTHER participant in the ceremony -- this device's own id is
    /// never included, matching `dkg::round2`/`round3`'s own "MUST NOT
    /// include this participant's own package" contract.
    pub other_participants: Vec<DeviceId>,
    pub threshold: u16,
    pub session_id: u64,
    pub scope: CapabilityScope,
    pub token: Option<CoseSign1>,
}

/// Runs a fresh DKG ceremony's full choreography for ONE device: broadcast
/// round 1, exchange round 2 pairwise, compute round 3 locally, then
/// confirm. Every participant calls this with the identical `session_id`
/// and `other_participants`-plus-`own_device_id` set, each with its own
/// per-peer dispatch already wired up on their respective `Session`s (this
/// function only sends and awaits collector deliveries; it never itself
/// drives a `Session`'s dispatch loop). Rejects (without ever returning a
/// result) if any peer's confirm digest or group key mismatches this
/// device's own -- the ceremony MUST abort, never be repaired in place,
/// matching `dkg::confirm_matches`'s own verifier obligation.
pub async fn run_fresh_threshold_dkg<S: ManageRequestSender>(
    options: RunFreshThresholdDkg<'_, S>,
) -> Result<(KeyPackage, PublicKeyPackage), DkgNetworkError> {
    const IS_RESHARE: bool = false;
    let max_signers = (options.other_participants.len() + 1) as u16;
    let own_identifier = identifier_for_device(&options.own_device_id)?;
    let mut all_participants = Vec::with_capacity(options.other_participants.len() + 1);
    all_participants.push(options.own_device_id);
    all_participants.extend_from_slice(&options.other_participants);

    let (own_secret, own_package) = dkg::round1(own_identifier, max_signers, options.threshold)?;
    let (own_commitment, own_proof) = dkg::split_round1_package(&own_package)?;

    // Round 1: broadcast this device's own commitment + proof of knowledge.
    for &peer in &options.other_participants {
        let command = keygen_round1_command(
            options.session_id,
            u64::from(options.threshold),
            &all_participants,
            own_commitment.clone(),
            Some(own_proof.clone()),
            None,
            IS_RESHARE,
        );
        send_one(
            options.sender,
            peer,
            command,
            options.scope.clone(),
            options.token.clone(),
        )
        .await?;
    }

    // Collect every other participant's round1 package.
    let mut round1_packages: BTreeMap<Identifier, round1::Package> = BTreeMap::new();
    let mut identifier_lookup: HashMap<Identifier, DeviceId> = HashMap::new();
    for &peer in &options.other_participants {
        let payload = options.collectors.round1.await_from(peer).await?;
        let proof = payload
            .proof_of_knowledge
            .ok_or(DkgNetworkError::MissingProofOfKnowledge(peer))?;
        let package = dkg::combine_round1_package(&payload.commitment, &proof)?;
        let identifier = identifier_for_device(&peer)?;
        identifier_lookup.insert(identifier, peer);
        round1_packages.insert(identifier, package);
    }

    let (own_secret2, outgoing) = dkg::round2(own_secret, &round1_packages)?;

    // Round 2: send each recipient's own pairwise sub-share.
    for (identifier, package) in &outgoing {
        let peer = *identifier_lookup
            .get(identifier)
            .expect("outgoing round2 packages are keyed by round1's own participant set");
        let share_bytes = package.serialize()?;
        let command = keygen_round2_command(options.session_id, share_bytes, IS_RESHARE);
        send_one(
            options.sender,
            peer,
            command,
            options.scope.clone(),
            options.token.clone(),
        )
        .await?;
    }

    // Collect every other participant's round2 share.
    let mut round2_packages: BTreeMap<Identifier, round2::Package> = BTreeMap::new();
    for &peer in &options.other_participants {
        let identifier = identifier_for_device(&peer)?;
        let bytes = options.collectors.round2.await_from(peer).await?;
        let package = round2::Package::deserialize(&bytes)?;
        round2_packages.insert(identifier, package);
    }

    let (key_package, public_key_package) =
        dkg::round3(&own_secret2, &round1_packages, &round2_packages)?;

    // The transcript digest covers the FULL N-package set, including this device's own.
    let mut all_round1_packages = round1_packages;
    all_round1_packages.insert(own_identifier, own_package);
    let own_digest =
        dkg::transcript_digest(&all_round1_packages, public_key_package.verifying_key())?;
    let group_key_bytes = public_key_package.verifying_key().serialize()?;

    // Confirm: echo-broadcast this device's own digest + group key.
    for &peer in &options.other_participants {
        let command = keygen_confirm_command(
            options.session_id,
            own_digest.to_vec(),
            group_key_bytes.clone(),
            IS_RESHARE,
        );
        send_one(
            options.sender,
            peer,
            command,
            options.scope.clone(),
            options.token.clone(),
        )
        .await?;
    }

    // Collect every other participant's confirm and verify it matches.
    for &peer in &options.other_participants {
        let confirm = options.collectors.confirm.await_from(peer).await?;
        let matches = dkg::confirm_matches(
            &own_digest,
            public_key_package.verifying_key(),
            &confirm.transcript_digest,
            &confirm.group_key,
        );
        if matches.is_err() {
            options.collectors.fail(AbortReason(
                format!("DKG echo-broadcast transcript mismatch with {peer:?} -- aborting").into(),
            ));
            return Err(DkgNetworkError::TranscriptMismatch { peer });
        }
    }

    Ok((key_package, public_key_package))
}

// --- Reshare -------------------------------------------------------------
//
// Resharing has no single symmetric choreography the way fresh DKG does:
// only the T SURVIVORS dealt from an existing share broadcast round 1 and
// send round 2; every member of the NEW participant set (survivors staying
// on and brand-new joiners alike) must independently collect all T
// survivors' round1 broadcasts, derive the combined public key package, and
// combine whatever round2 shares it received. A device that is both a
// survivor AND a member of the new set runs BOTH
// `compute_reshare_contribution`+`send_reshare_contribution` and
// `join_threshold_reshare` concurrently; a survivor that is leaving runs
// only `contribute_threshold_reshare` (and is done); a brand-new device
// with no prior share runs only `join_threshold_reshare`.

/// A surviving participant's dealer contribution to a reshare ceremony --
/// the Rust equivalent of `threshold-dkg.ts`'s own `ReshareContribution`.
pub struct ReshareContribution {
    pub commitment: VerifiableSecretSharingCommitment,
    /// Every recipient's own pairwise sub-share, keyed by recipient
    /// identifier.
    pub outgoing: BTreeMap<Identifier, SecretShare>,
    /// This survivor's own round-2 share to itself, present iff this device
    /// is also a member of `new_participants` -- extracted from `outgoing`
    /// so a caller staying in the committee never has to special-case its
    /// own entry.
    pub share_to_self: Option<SecretShare>,
}

/// The synchronous half of a surviving participant's dealer role -- no
/// network I/O, deliberately split out from [`send_reshare_contribution`]
/// so a device that is ALSO staying in `new_participants` can start
/// [`join_threshold_reshare`] (which begins listening immediately) with
/// this result's own `commitment`/`share_to_self` BEFORE the broadcast
/// sends below have gone anywhere: two devices that are both survivors and
/// both new participants would otherwise deadlock, each waiting for the
/// other's `join_threshold_reshare` to start listening before either's own
/// send is acknowledged, while neither starts listening until its own
/// sends finish.
pub fn compute_reshare_contribution(
    own_device_id: DeviceId,
    own_old_key_package: &KeyPackage,
    survivors: &[DeviceId],
    new_participants: &[DeviceId],
    new_threshold: u16,
) -> Result<ReshareContribution, DkgNetworkError> {
    let own_identifier = identifier_for_device(&own_device_id)?;
    let survivor_ids: Vec<Identifier> = survivors
        .iter()
        .map(identifier_for_device)
        .collect::<Result<_, _>>()?;
    let new_ids: Vec<Identifier> = new_participants
        .iter()
        .map(identifier_for_device)
        .collect::<Result<_, _>>()?;
    let (commitment, outgoing) = reshare::round1_reshare(
        own_identifier,
        own_old_key_package.signing_share(),
        &survivor_ids,
        &new_ids,
        new_threshold,
    )?;
    let share_to_self = outgoing.get(&own_identifier).cloned();
    Ok(ReshareContribution {
        commitment,
        outgoing,
        share_to_self,
    })
}

/// Every option [`send_reshare_contribution`] needs.
pub struct SendReshareContribution<'a, S: ManageRequestSender> {
    pub sender: &'a S,
    pub own_device_id: DeviceId,
    /// The full new participant set this reshare is moving to (may overlap
    /// with survivors, may add or drop devices). MUST be identical across
    /// every survivor's own call for this session-id.
    pub new_participants: Vec<DeviceId>,
    pub new_threshold: u16,
    /// The group's own existing Ed25519 verifying key, echoed on
    /// `threshold-keygen-round1` as `existing-group-key` so recipients know
    /// this is a reshare (not a fresh DKG) of a specific, already-known
    /// group.
    pub existing_group_key: Vec<u8>,
    pub session_id: u64,
    pub scope: CapabilityScope,
    pub token: Option<CoseSign1>,
}

/// The network half of a surviving participant's dealer role: broadcasts
/// round 1 (the commitment) to every recipient other than itself, then
/// sends each recipient's own round-2 share pairwise, from an
/// already-computed [`compute_reshare_contribution`] result. Resolves once
/// every send has been acknowledged.
pub async fn send_reshare_contribution<S: ManageRequestSender>(
    options: SendReshareContribution<'_, S>,
    contribution: &ReshareContribution,
) -> Result<(), DkgNetworkError> {
    const IS_RESHARE: bool = true;
    let commitment_parts = reshare::split_commitment(&contribution.commitment)?;
    let recipients: Vec<DeviceId> = options
        .new_participants
        .iter()
        .copied()
        .filter(|&peer| peer != options.own_device_id)
        .collect();

    for &peer in &recipients {
        let command = keygen_round1_command(
            options.session_id,
            u64::from(options.new_threshold),
            &options.new_participants,
            commitment_parts.clone(),
            None,
            Some(options.existing_group_key.clone()),
            IS_RESHARE,
        );
        send_one(
            options.sender,
            peer,
            command,
            options.scope.clone(),
            options.token.clone(),
        )
        .await?;
    }

    for &peer in &recipients {
        let identifier = identifier_for_device(&peer)?;
        let share = contribution
            .outgoing
            .get(&identifier)
            .ok_or(DkgNetworkError::MissingContribution(peer))?;
        let share_bytes = share.serialize()?;
        let command = keygen_round2_command(options.session_id, share_bytes, IS_RESHARE);
        send_one(
            options.sender,
            peer,
            command,
            options.scope.clone(),
            options.token.clone(),
        )
        .await?;
    }
    Ok(())
}

/// Runs a surviving participant's OWN dealer role end to end:
/// [`compute_reshare_contribution`] then [`send_reshare_contribution`].
/// Only correct for a survivor that is LEAVING the committee (not a member
/// of `new_participants`) -- it has no further round to take part in, so
/// there is no concurrent listener this call's own sends could deadlock
/// against. A survivor that is ALSO staying in `new_participants` MUST call
/// [`compute_reshare_contribution`] and [`send_reshare_contribution`]
/// separately, starting its own [`join_threshold_reshare`] (with the
/// computed contribution) concurrently with `send_reshare_contribution` --
/// see that function's own doc comment for why.
pub async fn contribute_threshold_reshare<S: ManageRequestSender>(
    own_old_key_package: &KeyPackage,
    survivors: &[DeviceId],
    options: SendReshareContribution<'_, S>,
) -> Result<ReshareContribution, DkgNetworkError> {
    let contribution = compute_reshare_contribution(
        options.own_device_id,
        own_old_key_package,
        survivors,
        &options.new_participants,
        options.new_threshold,
    )?;
    send_reshare_contribution(options, &contribution).await?;
    Ok(contribution)
}

/// This device's own survivor contribution, known locally rather than sent
/// to itself over the wire -- present when this device is itself one of
/// the T survivors (from a concurrent [`compute_reshare_contribution`] call
/// on this same device).
pub struct ReshareOwnContribution {
    pub commitment: VerifiableSecretSharingCommitment,
    pub share_to_self: SecretShare,
}

/// Every option [`join_threshold_reshare`] needs.
pub struct JoinThresholdReshare<'a, S: ManageRequestSender> {
    pub sender: &'a S,
    pub collectors: &'a KeygenRoundCollectors,
    pub own_device_id: DeviceId,
    /// Every survivor this device must collect a round1 broadcast and
    /// round2 share FROM over the wire -- the full survivor set, MINUS this
    /// device itself if it is also a survivor (see `own_contribution`).
    pub other_survivors: Vec<DeviceId>,
    /// Present when this device is itself one of the T survivors; absent
    /// for a brand-new device with no prior share, which only ever
    /// receives.
    pub own_contribution: Option<ReshareOwnContribution>,
    pub new_participants: Vec<DeviceId>,
    pub new_threshold: u16,
    pub existing_group_key: Vec<u8>,
    pub session_id: u64,
    pub scope: CapabilityScope,
    pub token: Option<CoseSign1>,
}

/// Runs a new-participant's own receiving role: collects every survivor's
/// round1 broadcast and this device's own round2 share, derives the
/// reshared group's public key package (verifying it still matches
/// `existing_group_key` -- a reshare that changes the group key is a
/// takeover, never adopted), then confirms via the same echo-broadcast
/// digest exchange fresh DKG uses, against every OTHER member of
/// `new_participants` (not just survivors -- every new-participant peer
/// independently derives and must agree on the identical digest and group
/// key). Rejects, without ever returning a key package, on any digest,
/// group-key, or existing-group-key mismatch.
pub async fn join_threshold_reshare<S: ManageRequestSender>(
    options: JoinThresholdReshare<'_, S>,
) -> Result<(KeyPackage, PublicKeyPackage), DkgNetworkError> {
    const IS_RESHARE: bool = true;
    let own_identifier = identifier_for_device(&options.own_device_id)?;

    let mut survivor_commitments: BTreeMap<Identifier, VerifiableSecretSharingCommitment> =
        BTreeMap::new();
    for &peer in &options.other_survivors {
        let payload = options.collectors.round1.await_from(peer).await?;
        let commitment = reshare::combine_commitment_parts(&payload.commitment)?;
        let identifier = identifier_for_device(&peer)?;
        survivor_commitments.insert(identifier, commitment);
    }
    if let Some(own) = &options.own_contribution {
        survivor_commitments.insert(own_identifier, own.commitment.clone());
    }

    let combined_commitments: Vec<VerifiableSecretSharingCommitment> =
        survivor_commitments.values().cloned().collect();
    let combined = reshare::combine_survivor_commitments(&combined_commitments)?;
    let new_ids: Vec<Identifier> = options
        .new_participants
        .iter()
        .map(identifier_for_device)
        .collect::<Result<_, _>>()?;
    let public_key_package = reshare::derive_public_key_package(&combined, &new_ids)?;
    let derived_group_key = public_key_package.verifying_key().serialize()?;
    if derived_group_key != options.existing_group_key {
        return Err(DkgNetworkError::TakeoverRejected);
    }

    let mut received_shares: Vec<SecretShare> = Vec::new();
    for &peer in &options.other_survivors {
        let bytes = options.collectors.round2.await_from(peer).await?;
        received_shares.push(SecretShare::deserialize(&bytes)?);
    }
    if let Some(own) = &options.own_contribution {
        received_shares.push(own.share_to_self.clone());
    }

    let key_package = reshare::combine_received_shares(
        own_identifier,
        &received_shares,
        &public_key_package,
        options.new_threshold,
    )?;

    let other_new_participants: Vec<DeviceId> = options
        .new_participants
        .iter()
        .copied()
        .filter(|&peer| peer != options.own_device_id)
        .collect();
    let own_digest =
        reshare::transcript_digest(&survivor_commitments, public_key_package.verifying_key())?;

    for &peer in &other_new_participants {
        let command = keygen_confirm_command(
            options.session_id,
            own_digest.to_vec(),
            derived_group_key.clone(),
            IS_RESHARE,
        );
        send_one(
            options.sender,
            peer,
            command,
            options.scope.clone(),
            options.token.clone(),
        )
        .await?;
    }

    for &peer in &other_new_participants {
        let confirm = options.collectors.confirm.await_from(peer).await?;
        let matches = dkg::confirm_matches(
            &own_digest,
            public_key_package.verifying_key(),
            &confirm.transcript_digest,
            &confirm.group_key,
        );
        if matches.is_err() {
            options.collectors.fail(AbortReason(
                format!("reshare echo-broadcast transcript mismatch with {peer:?} -- aborting")
                    .into(),
            ));
            return Err(DkgNetworkError::TranscriptMismatch { peer });
        }
    }

    Ok((key_package, public_key_package))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device_id(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    /// Routes every `send_manage_request` this device makes directly into
    /// the target peer's own [`KeygenRoundCollectors`] via
    /// `handle_keygen_round1`/`round2`/`confirm`, with `own_device_id` as
    /// the "from" identity -- the in-process stand-in for "one Session per
    /// peer connection" this module's own doc comment describes, proving
    /// the wiring (this module's plain handler functions dispatching
    /// correctly by `ManageParams` variant) without a real transport.
    struct LoopbackSender {
        own_device_id: DeviceId,
        session_id: u64,
        peers: HashMap<DeviceId, Arc<KeygenRoundCollectors>>,
    }

    #[async_trait::async_trait]
    impl ManageRequestSender for LoopbackSender {
        async fn send_manage_request(
            &self,
            target: DeviceId,
            command: ManageCommand,
            _scope: CapabilityScope,
            _token: Option<CoseSign1>,
        ) -> Result<ManageOutcome, CoreError> {
            let collectors = self
                .peers
                .get(&target)
                .expect("test fixture: unknown target device");
            let outcome = match command.params {
                ManageParams::ThresholdKeygenRound1(params) => {
                    handle_keygen_round1(collectors, self.session_id, self.own_device_id, params)
                }
                ManageParams::ThresholdKeygenRound2(params) => {
                    handle_keygen_round2(collectors, self.session_id, self.own_device_id, params)
                }
                ManageParams::ThresholdKeygenConfirm(params) => {
                    handle_keygen_confirm(collectors, self.session_id, self.own_device_id, params)
                }
                _ => manage_error("unsupported"),
            };
            Ok(outcome)
        }
    }

    fn loopback_senders(
        device_ids: &[DeviceId],
        session_id: u64,
    ) -> (Vec<LoopbackSender>, Vec<Arc<KeygenRoundCollectors>>) {
        let collectors: Vec<Arc<KeygenRoundCollectors>> = device_ids
            .iter()
            .map(|_| Arc::new(KeygenRoundCollectors::new()))
            .collect();
        let senders = device_ids
            .iter()
            .map(|&own_device_id| {
                let peers = device_ids
                    .iter()
                    .zip(collectors.iter())
                    .filter(|(&peer, _)| peer != own_device_id)
                    .map(|(&peer, c)| (peer, Arc::clone(c)))
                    .collect();
                LoopbackSender {
                    own_device_id,
                    session_id,
                    peers,
                }
            })
            .collect();
        (senders, collectors)
    }

    /// A full 3-participant, T=2 fresh DKG over this module's own network
    /// orchestration (not `dkg.rs`'s in-process round functions directly,
    /// the way `dkg.rs`'s own test proves the crypto) -- every participant
    /// ends up agreeing on the same group verifying key, driven entirely
    /// through `run_fresh_threshold_dkg`'s `send`/`await_from` choreography.
    #[tokio::test]
    async fn three_participants_run_fresh_threshold_dkg_to_the_same_group_key() {
        let device_ids = [device_id(1), device_id(2), device_id(3)];
        let session_id = 1;
        let (senders, collectors) = loopback_senders(&device_ids, session_id);
        let scope = crate::network::threshold_group_scope();

        let mut handles = Vec::new();
        for (index, sender) in senders.into_iter().enumerate() {
            let own_device_id = device_ids[index];
            let other_participants: Vec<DeviceId> = device_ids
                .iter()
                .copied()
                .filter(|&d| d != own_device_id)
                .collect();
            let collectors = Arc::clone(&collectors[index]);
            let scope = scope.clone();
            handles.push(tokio::spawn(async move {
                run_fresh_threshold_dkg(RunFreshThresholdDkg {
                    sender: &sender,
                    collectors: &collectors,
                    own_device_id,
                    other_participants,
                    threshold: 2,
                    session_id,
                    scope,
                    token: None,
                })
                .await
            }));
        }

        let mut group_keys = Vec::new();
        for handle in handles {
            let (_key_package, public_key_package) =
                handle.await.expect("task join").expect("fresh dkg");
            group_keys.push(
                public_key_package
                    .verifying_key()
                    .serialize()
                    .expect("serialize"),
            );
        }
        assert!(group_keys.windows(2).all(|w| w[0] == w[1]));
    }

    /// A device-loss-and-addition reshare (3 survivors -> a 3-member new
    /// committee dropping one original device and adding a brand-new one)
    /// over this module's own network orchestration, preserving the
    /// group's Ed25519 verifying key -- the scenario wire-mesh#177 itself
    /// names as the required end-to-end proof, exercised here at the unit
    /// level (a loopback sender, not real TCP) before the real
    /// `tests/keygen_network_session.rs` proves the identical choreography
    /// over actual connections.
    #[tokio::test]
    async fn reshare_to_a_different_committee_preserves_the_group_key() {
        let old_ids = [device_id(1), device_id(2), device_id(3)];
        let dkg_session_id = 1;
        let (dkg_senders, dkg_collectors) = loopback_senders(&old_ids, dkg_session_id);
        let scope = crate::network::threshold_group_scope();

        let mut dkg_handles = Vec::new();
        for (index, sender) in dkg_senders.into_iter().enumerate() {
            let own_device_id = old_ids[index];
            let other_participants: Vec<DeviceId> = old_ids
                .iter()
                .copied()
                .filter(|&d| d != own_device_id)
                .collect();
            let collectors = Arc::clone(&dkg_collectors[index]);
            let scope = scope.clone();
            dkg_handles.push(tokio::spawn(async move {
                run_fresh_threshold_dkg(RunFreshThresholdDkg {
                    sender: &sender,
                    collectors: &collectors,
                    own_device_id,
                    other_participants,
                    threshold: 2,
                    session_id: dkg_session_id,
                    scope,
                    token: None,
                })
                .await
            }));
        }
        let mut old_key_packages = HashMap::new();
        let mut original_group_key = None;
        for (index, handle) in dkg_handles.into_iter().enumerate() {
            let (key_package, public_key_package) =
                handle.await.expect("task join").expect("fresh dkg");
            original_group_key = Some(
                public_key_package
                    .verifying_key()
                    .serialize()
                    .expect("serialize"),
            );
            old_key_packages.insert(old_ids[index], key_package);
        }
        let original_group_key = original_group_key.expect("at least one participant");

        // Survivors: devices 1 and 2 -- both REMAIN in the new committee (device 3 is dropped, a brand-new device 4 is added), so both run compute+send+join concurrently, never `contribute_threshold_reshare`'s "leaving" path (which would never send a confirm, and every OTHER new participant's own confirm round would then hang forever waiting on a peer who never joins).
        let survivors = [old_ids[0], old_ids[1]];
        let new_device = device_id(4);
        let new_participants = [survivors[0], survivors[1], new_device];
        let new_threshold = 2u16;
        let reshare_session_id = 2;

        let all_reshare_parties = [survivors[0], survivors[1], new_device];
        let (reshare_senders, reshare_collectors) =
            loopback_senders(&all_reshare_parties, reshare_session_id);
        let sender_of = |device: DeviceId| {
            let index = all_reshare_parties
                .iter()
                .position(|&d| d == device)
                .expect("known party");
            &reshare_senders[index]
        };
        let collectors_of = |device: DeviceId| {
            let index = all_reshare_parties
                .iter()
                .position(|&d| d == device)
                .expect("known party");
            Arc::clone(&reshare_collectors[index])
        };

        // Both survivors compute their own contribution FIRST (synchronous, no network I/O) so each can start `join_threshold_reshare` with its own commitment/share-to-self known locally BEFORE `send_reshare_contribution` goes out -- per this module's own doc comment on the two-devices-both-survivors-and-both-new- participants deadlock.
        let survivor1_contribution = compute_reshare_contribution(
            survivors[0],
            old_key_packages.get(&survivors[0]).expect("kp"),
            &survivors,
            &new_participants,
            new_threshold,
        )
        .expect("compute contribution 1");
        let survivor1_own_contribution = ReshareOwnContribution {
            commitment: survivor1_contribution.commitment.clone(),
            share_to_self: survivor1_contribution
                .share_to_self
                .clone()
                .expect("survivor1 stays in the new committee"),
        };
        let survivor2_contribution = compute_reshare_contribution(
            survivors[1],
            old_key_packages.get(&survivors[1]).expect("kp"),
            &survivors,
            &new_participants,
            new_threshold,
        )
        .expect("compute contribution 2");
        let survivor2_own_contribution = ReshareOwnContribution {
            commitment: survivor2_contribution.commitment.clone(),
            share_to_self: survivor2_contribution
                .share_to_self
                .clone()
                .expect("survivor2 stays in the new committee"),
        };

        let survivor1_send_sender = sender_of(survivors[0]);
        let survivor1_send_options = SendReshareContribution {
            sender: survivor1_send_sender,
            own_device_id: survivors[0],
            new_participants: new_participants.to_vec(),
            new_threshold,
            existing_group_key: original_group_key.clone(),
            session_id: reshare_session_id,
            scope: scope.clone(),
            token: None,
        };
        let survivor1_send_task =
            send_reshare_contribution(survivor1_send_options, &survivor1_contribution);

        let survivor2_send_sender = sender_of(survivors[1]);
        let survivor2_send_options = SendReshareContribution {
            sender: survivor2_send_sender,
            own_device_id: survivors[1],
            new_participants: new_participants.to_vec(),
            new_threshold,
            existing_group_key: original_group_key.clone(),
            session_id: reshare_session_id,
            scope: scope.clone(),
            token: None,
        };
        let survivor2_send_task =
            send_reshare_contribution(survivor2_send_options, &survivor2_contribution);

        let survivor1_join_sender = sender_of(survivors[0]);
        let survivor1_join_collectors = collectors_of(survivors[0]);
        let survivor1_join_options = JoinThresholdReshare {
            sender: survivor1_join_sender,
            collectors: &survivor1_join_collectors,
            own_device_id: survivors[0],
            other_survivors: vec![survivors[1]],
            own_contribution: Some(survivor1_own_contribution),
            new_participants: new_participants.to_vec(),
            new_threshold,
            existing_group_key: original_group_key.clone(),
            session_id: reshare_session_id,
            scope: scope.clone(),
            token: None,
        };
        let survivor1_join_task = join_threshold_reshare(survivor1_join_options);

        let survivor2_join_sender = sender_of(survivors[1]);
        let survivor2_join_collectors = collectors_of(survivors[1]);
        let survivor2_join_options = JoinThresholdReshare {
            sender: survivor2_join_sender,
            collectors: &survivor2_join_collectors,
            own_device_id: survivors[1],
            other_survivors: vec![survivors[0]],
            own_contribution: Some(survivor2_own_contribution),
            new_participants: new_participants.to_vec(),
            new_threshold,
            existing_group_key: original_group_key.clone(),
            session_id: reshare_session_id,
            scope: scope.clone(),
            token: None,
        };
        let survivor2_join_task = join_threshold_reshare(survivor2_join_options);

        let new_device_sender = sender_of(new_device);
        let new_device_collectors = collectors_of(new_device);
        let new_device_options = JoinThresholdReshare {
            sender: new_device_sender,
            collectors: &new_device_collectors,
            own_device_id: new_device,
            other_survivors: survivors.to_vec(),
            own_contribution: None,
            new_participants: new_participants.to_vec(),
            new_threshold,
            existing_group_key: original_group_key.clone(),
            session_id: reshare_session_id,
            scope: scope.clone(),
            token: None,
        };
        let new_device_join_task = join_threshold_reshare(new_device_options);

        let (
            survivor1_send_result,
            survivor2_send_result,
            survivor1_join_result,
            survivor2_join_result,
            new_device_result,
        ) = tokio::join!(
            survivor1_send_task,
            survivor2_send_task,
            survivor1_join_task,
            survivor2_join_task,
            new_device_join_task,
        );
        survivor1_send_result.expect("survivor 1 sends its contribution");
        survivor2_send_result.expect("survivor 2 sends its contribution");
        let (survivor1_key_package, survivor1_pkp) =
            survivor1_join_result.expect("survivor 1 joins the new committee");
        let (_survivor2_key_package, survivor2_pkp) =
            survivor2_join_result.expect("survivor 2 joins the new committee");
        let (new_device_key_package, new_device_pkp) =
            new_device_result.expect("the new device joins the committee");

        assert_eq!(
            survivor1_pkp
                .verifying_key()
                .serialize()
                .expect("serialize"),
            original_group_key,
            "the reshared group key must match the original"
        );
        assert_eq!(
            survivor2_pkp
                .verifying_key()
                .serialize()
                .expect("serialize"),
            original_group_key,
            "every new participant derives the identical, unchanged group key"
        );
        assert_eq!(
            new_device_pkp
                .verifying_key()
                .serialize()
                .expect("serialize"),
            original_group_key,
            "every new participant derives the identical, unchanged group key"
        );

        // The two new key packages -- one from a survivor, one from a
        // device that never held a share of the original group -- must
        // actually be usable together to produce a valid signature under
        // the ORIGINAL group's public key.
        let message = b"reshare-over-the-network-orchestration-preserves-signing";
        let store_a = crate::nonce_store::InMemoryNonceStore::new();
        let store_b = crate::nonce_store::InMemoryNonceStore::new();
        let (nonces_a, commitments_a) = frost_ed25519::round1::commit(
            survivor1_key_package.signing_share(),
            &mut rand::rngs::OsRng,
        );
        let (nonces_b, commitments_b) = frost_ed25519::round1::commit(
            new_device_key_package.signing_share(),
            &mut rand::rngs::OsRng,
        );
        crate::nonce_store::NonceStore::persist(&store_a, 1, nonces_a).expect("persist a");
        crate::nonce_store::NonceStore::persist(&store_b, 1, nonces_b).expect("persist b");
        let mut package_commitments = BTreeMap::new();
        package_commitments.insert(
            identifier_for_device(&survivors[0]).expect("id"),
            commitments_a,
        );
        package_commitments.insert(
            identifier_for_device(&new_device).expect("id"),
            commitments_b,
        );
        let signing_package = frost_ed25519::SigningPackage::new(package_commitments, message);

        let share_a = frost_ed25519::round2::sign(
            &signing_package,
            &crate::nonce_store::NonceStore::take(&store_a, 1).expect("take a"),
            &survivor1_key_package,
        )
        .expect("sign a");
        let share_b = frost_ed25519::round2::sign(
            &signing_package,
            &crate::nonce_store::NonceStore::take(&store_b, 1).expect("take b"),
            &new_device_key_package,
        )
        .expect("sign b");
        let mut shares = BTreeMap::new();
        shares.insert(identifier_for_device(&survivors[0]).expect("id"), share_a);
        shares.insert(identifier_for_device(&new_device).expect("id"), share_b);

        let signature =
            frost_ed25519::aggregate(&signing_package, &shares, &survivor1_pkp).expect("aggregate");
        assert!(
            survivor1_pkp
                .verifying_key()
                .verify(message, &signature)
                .is_ok(),
            "the reshared committee's aggregate signature verifies against the original group key"
        );
    }

    /// Wraps a [`LoopbackSender`], corrupting the transcript digest on any
    /// outgoing `threshold-keygen-confirm` before delivering it -- standing
    /// in for a peer that equivocated between what it broadcast on round1
    /// and what it echoes on confirm, the exact failure
    /// `threshold-keygen-confirm` exists to catch. Round1/round2 pass
    /// through unmodified, so only the confirm-time comparison is exercised.
    struct TamperingConfirmSender {
        inner: LoopbackSender,
    }

    #[async_trait::async_trait]
    impl ManageRequestSender for TamperingConfirmSender {
        async fn send_manage_request(
            &self,
            target: DeviceId,
            mut command: ManageCommand,
            scope: CapabilityScope,
            token: Option<CoseSign1>,
        ) -> Result<ManageOutcome, CoreError> {
            if let ManageParams::ThresholdKeygenConfirm(params) = &mut command.params {
                params.transcript_digest = vec![0xff; 32];
            }
            self.inner
                .send_manage_request(target, command, scope, token)
                .await
        }
    }

    /// A confirm round carrying a transcript digest that does not match
    /// what a device itself derived MUST abort the whole ceremony for the
    /// device on the receiving end -- the echo-broadcast confirm round's
    /// entire reason for existing, per `dkg::confirm_matches`'s own
    /// verifier obligation. The tampering peer's own run, in contrast,
    /// completes normally: it never sees anything but the honest values
    /// its counterpart actually sent it.
    #[tokio::test]
    async fn a_confirm_round_mismatch_aborts_the_receiving_device_only() {
        let device_ids = [device_id(11), device_id(12)];
        let session_id = 7;
        let (mut senders, collectors) = loopback_senders(&device_ids, session_id);
        let scope = crate::network::threshold_group_scope();

        // Device 12's sender corrupts its own outgoing confirm to device 11.
        let tampering_sender = TamperingConfirmSender {
            inner: senders.remove(1),
        };
        let honest_sender = senders.remove(0);

        let honest = tokio::spawn({
            let collectors = Arc::clone(&collectors[0]);
            let own_device_id = device_ids[0];
            let other_participants = vec![device_ids[1]];
            let scope = scope.clone();
            async move {
                run_fresh_threshold_dkg(RunFreshThresholdDkg {
                    sender: &honest_sender,
                    collectors: &collectors,
                    own_device_id,
                    other_participants,
                    threshold: 2,
                    session_id,
                    scope,
                    token: None,
                })
                .await
            }
        });

        let tamperer = tokio::spawn({
            let collectors = Arc::clone(&collectors[1]);
            let own_device_id = device_ids[1];
            let other_participants = vec![device_ids[0]];
            let scope = scope.clone();
            async move {
                run_fresh_threshold_dkg(RunFreshThresholdDkg {
                    sender: &tampering_sender,
                    collectors: &collectors,
                    own_device_id,
                    other_participants,
                    threshold: 2,
                    session_id,
                    scope,
                    token: None,
                })
                .await
            }
        });

        let (result_honest, result_tamperer) = tokio::join!(honest, tamperer);
        let result_honest = result_honest.expect("task join");
        let result_tamperer = result_tamperer.expect("task join");
        assert!(
            matches!(result_honest, Err(DkgNetworkError::TranscriptMismatch { peer }) if peer == device_ids[1]),
            "expected the honest device to abort on a transcript mismatch, got {result_honest:?}"
        );
        assert!(
            result_tamperer.is_ok(),
            "the tampering device's own view of its counterpart was never corrupted, so its own run should succeed: {result_tamperer:?}"
        );
    }
}
