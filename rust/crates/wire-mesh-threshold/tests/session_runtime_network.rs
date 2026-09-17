//! Real, end-to-end proof that wire-mesh#173's session runtime is
//! actually usable by wire-mesh#171's threshold network integration --
//! not against `FakeSender`/`FakeParticipant` test doubles (as
//! `src/network.rs`'s own unit test already covers), but over two real
//! TCP connections carrying real `manage-request`/`manage-response`
//! frames through `wire_mesh_core::domain::session::Session`.
//!
//! `wire-mesh-core` is a normal ([dependencies]) dependency of this crate
//! with its "net" feature off, so `wire-mesh-threshold-wasm`'s
//! wasm32-unknown-unknown build never pulls in tokio's networking stack
//! (see this crate's own Cargo.toml comment). This test file is built
//! only for `cargo test`, which unifies this crate's own
//! `[dev-dependencies]` (declaring `wire-mesh-core` with its default,
//! "net"-on, features) into the test binary's dependency graph -- a
//! unification that never reaches the wasm crate, since it depends on
//! `wire-mesh-threshold` as an ordinary dependency and never builds this
//! crate's own tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use frost_ed25519::keys::{KeyPackage, PublicKeyPackage};
use wire_mesh_core::adapters::node_identity::{derive_device_id_from_public_key, NodeIdentity};
use wire_mesh_core::domain::session::{
    HandlerRegistry, IncomingManageRequest, ManageRequestHandler, Session,
};
use wire_mesh_core::ports::{Connection, CoreError, Identity, OnConnection, Transport};
use wire_mesh_threshold::dkg::{round1 as dkg_round1, round2 as dkg_round2, round3 as dkg_round3};
use wire_mesh_threshold::identifiers::identifier_for_device;
use wire_mesh_threshold::identity::ThresholdCoordinator;
use wire_mesh_threshold::network::{
    handle_threshold_abort, handle_threshold_commit, handle_threshold_sign, ManageRequestSender,
    NetworkThresholdCoordinator, SigningSessionState, THRESHOLD_SIGN_VERB,
};
use wire_mesh_threshold::nonce_store::InMemoryNonceStore;
use wire_mesh_threshold::signing::{aggregate, build_signing_package};
use wire_mesh_threshold::subject::{to_be_signed, ThresholdSubject};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::{
    ManageCommand, ManageError, ManageOk, ManageOutcome, ManageParams,
};
use wire_mesh_wire::tokens::{CapabilityScope, CoseSign1};
use wire_mesh_wire::value::{CanonicalMap, CborValue};

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock is after the Unix epoch")
        .as_millis() as u64
}

fn manage_ok(fields: Vec<(&str, Vec<u8>)>) -> ManageOutcome {
    let mut extra = CanonicalMap::new();
    for (key, value) in fields {
        extra
            .insert(key.to_owned(), CborValue::Bytes(value))
            .expect("unique key");
    }
    ManageOutcome::Ok(ManageOk { extra })
}

fn manage_error(code: &str) -> ManageOutcome {
    ManageOutcome::Error(ManageError {
        code: code.to_owned(),
        message: None,
    })
}

/// A fresh T=2-of-2 DKG purely as test fixture setup, identical in shape
/// to `src/network.rs`'s own `dkg_fixture` (private to that module, so
/// reproduced here rather than reused) -- see that copy's own doc comment
/// for why `device_ids` must be each participant's REAL personal
/// device-id.
fn dkg_fixture(
    device_ids: &[DeviceId],
) -> (
    HashMap<frost_ed25519::Identifier, KeyPackage>,
    DeviceId,
    PublicKeyPackage,
) {
    use std::collections::BTreeMap as Map;

    let ids: Vec<frost_ed25519::Identifier> = device_ids
        .iter()
        .map(|d| identifier_for_device(d).expect("derives"))
        .collect();

    let mut secrets1 = Map::new();
    let mut packages1: Map<frost_ed25519::Identifier, frost_ed25519::keys::dkg::round1::Package> =
        Map::new();
    for &id in &ids {
        let (s, p) = dkg_round1(id, ids.len() as u16, 2).expect("round1");
        secrets1.insert(id, s);
        packages1.insert(id, p);
    }

    let mut round2_inbox: Map<
        frost_ed25519::Identifier,
        Map<frost_ed25519::Identifier, frost_ed25519::keys::dkg::round2::Package>,
    > = Map::new();
    let mut secrets2 = Map::new();
    for &id in &ids {
        let own = secrets1.remove(&id).expect("secret1");
        let others: Map<_, _> = packages1
            .iter()
            .filter(|(&p, _)| p != id)
            .map(|(&p, v)| (p, v.clone()))
            .collect();
        let (s2, outgoing) = dkg_round2(own, &others).expect("round2");
        secrets2.insert(id, s2);
        for (recipient, package) in outgoing {
            round2_inbox
                .entry(recipient)
                .or_default()
                .insert(id, package);
        }
    }

    let mut key_packages = HashMap::new();
    let mut group_device_id = None;
    let mut group_public_key_package = None;
    for &id in &ids {
        let s2 = secrets2.get(&id).expect("secret2");
        let others1: Map<_, _> = packages1
            .iter()
            .filter(|(&p, _)| p != id)
            .map(|(&p, v)| (p, v.clone()))
            .collect();
        let inbox = round2_inbox.get(&id).expect("inbox");
        let (kp, pkp) = dkg_round3(s2, &others1, inbox).expect("round3");
        group_device_id = Some(derive_device_id_from_public_key(
            &pkp.verifying_key().serialize().expect("serialize"),
        ));
        group_public_key_package = Some(pkp);
        key_packages.insert(id, kp);
    }

    (
        key_packages,
        group_device_id.expect("at least one participant"),
        group_public_key_package.expect("at least one participant"),
    )
}

/// The participant side of the wire-mesh#171 protocol, wired onto
/// wire-mesh#173's session runtime as a
/// [`wire_mesh_core::domain::session::ManageRequestHandler`] registered
/// for [`THRESHOLD_SIGN_VERB`]: dispatches an incoming manage-request's
/// decoded `ManageParams` variant to the matching `handle_threshold_*`
/// function, exactly the wiring `network.rs`'s own module doc comment
/// says this codebase lacked before this session runtime existed.
struct ThresholdParticipant {
    own_device_id: DeviceId,
    key_package: KeyPackage,
    identity: NodeIdentity,
    group: DeviceId,
    nonce_store: InMemoryNonceStore,
    session_state: StdMutex<HashMap<u64, SigningSessionState>>,
}

#[async_trait::async_trait]
impl ManageRequestHandler for ThresholdParticipant {
    async fn handle(&self, request: IncomingManageRequest) -> ManageOutcome {
        match request.command.params {
            ManageParams::ThresholdCommit(params) => {
                let result = handle_threshold_commit(
                    &params,
                    self.own_device_id,
                    |group| {
                        if *group == self.group {
                            Some(self.key_package.clone())
                        } else {
                            None
                        }
                    },
                    &self.nonce_store,
                    now_unix_ms(),
                    |_subject: &ThresholdSubject| None,
                );
                match result {
                    Ok((response, state)) => {
                        self.session_state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(params.session_id, state);
                        manage_ok(vec![
                            ("participant", response.participant.as_ref().to_vec()),
                            ("hiding", response.hiding),
                            ("binding", response.binding),
                        ])
                    }
                    Err(error) => manage_error(&error.to_string()),
                }
            }
            ManageParams::ThresholdSign(params) => {
                let state = self
                    .session_state
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&params.session_id);
                let Some(state) = state else {
                    return manage_error("no-such-session");
                };
                let result = handle_threshold_sign(
                    &params,
                    &state,
                    &self.key_package,
                    &self.nonce_store,
                    &self.identity,
                    self.group,
                )
                .await;
                match result {
                    Ok(envelope) => manage_ok(vec![("share", envelope.encode_to_vec())]),
                    Err(error) => manage_error(&error.to_string()),
                }
            }
            ManageParams::ThresholdAbort(params) => {
                handle_threshold_abort(params.session_id, &self.nonce_store);
                manage_ok(vec![])
            }
            _ => manage_error("unsupported"),
        }
    }
}

/// The coordinator side: a [`ManageRequestSender`] that routes each
/// outbound manage-request to the [`Session`] already dialled to that
/// target device, proving [`NetworkThresholdCoordinator`] (built and
/// tested in `src/network.rs` against a fake sender) drives a real
/// session exactly the same way.
struct SessionManageRequestSender {
    sessions: HashMap<DeviceId, Session>,
}

#[async_trait::async_trait]
impl ManageRequestSender for SessionManageRequestSender {
    async fn send_manage_request(
        &self,
        target: DeviceId,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<CoseSign1>,
    ) -> Result<ManageOutcome, CoreError> {
        let session = self
            .sessions
            .get(&target)
            .expect("test fixture: unknown target device");
        session
            .send_manage_request(command, scope, token, Some(Duration::from_secs(5)))
            .await
    }
}

#[tokio::test]
async fn threshold_signing_round_trips_over_real_tcp_sessions() {
    // Personal identities are generated FIRST, and the DKG fixture is
    // built around their own real device-ids -- see the fixture's own
    // doc comment for why a synthetic placeholder device-id would
    // silently derive the wrong FROST identifier.
    let personal_identities: Vec<NodeIdentity> =
        (0..2).map(|_| NodeIdentity::generate_ed25519()).collect();
    let device_ids: Vec<DeviceId> = personal_identities
        .iter()
        .map(|identity| *identity.device_id())
        .collect();
    let (key_packages, group, public_key_package) = dkg_fixture(&device_ids);

    let transport = wire_mesh_core::adapters::TcpTransport::new();

    // One TCP listener per participant, kept alive for the whole test
    // via `_listen_guards` (dropping a guard stops that listener).
    let mut listen_guards = Vec::new();
    let mut participant_addrs = Vec::new();
    let mut accepted_rxs = Vec::new();
    for _ in &device_ids {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Box<dyn Connection>>();
        let on_connection: OnConnection = Arc::new(move |connection| {
            let _ = tx.send(connection);
        });
        let guard = transport
            .listen("127.0.0.1:0", on_connection)
            .await
            .expect("listen");
        participant_addrs.push(guard.address());
        listen_guards.push(guard);
        accepted_rxs.push(rx);
    }

    // The coordinator dials every participant and wires each connection
    // up as a Session -- it registers no handlers of its own, since it
    // never receives a manage-request in this protocol, only sends them.
    let mut coordinator_sessions = HashMap::new();
    for (device_id, addr) in device_ids.iter().zip(participant_addrs.iter()) {
        let connection = transport.connect(addr).await.expect("connect");
        let (session, _events) = Session::accept(connection, [], HandlerRegistry::new())
            .await
            .expect("coordinator-side accept");
        coordinator_sessions.insert(*device_id, session);
    }

    // Each participant accepts its inbound connection from the
    // coordinator and wires it up with a real ThresholdParticipant
    // handler registered for THRESHOLD_SIGN_VERB. The returned Session/
    // event-receiver pair is intentionally dropped: the dispatch loop
    // that actually answers requests runs as an independent, already-
    // spawned background task holding its own connection/registry
    // handles, so nothing here needs to keep the caller's own Session
    // value alive for the loop to keep running.
    for ((device_id, identity), mut accepted_rx) in device_ids
        .iter()
        .zip(personal_identities.into_iter())
        .zip(accepted_rxs.into_iter())
    {
        let connection = accepted_rx.recv().await.expect("accepted connection");
        let identifier = identifier_for_device(device_id).expect("derives");
        let key_package = key_packages.get(&identifier).expect("key package").clone();
        let handler = Arc::new(ThresholdParticipant {
            own_device_id: *device_id,
            key_package,
            identity,
            group,
            nonce_store: InMemoryNonceStore::new(),
            session_state: StdMutex::new(HashMap::new()),
        });
        let registry = HandlerRegistry::new().register(THRESHOLD_SIGN_VERB, handler);
        let (_session, _events) = Session::accept(connection, [], registry)
            .await
            .expect("participant-side accept");
    }

    let sender = SessionManageRequestSender {
        sessions: coordinator_sessions,
    };
    let verifier_identity: Arc<dyn Identity> = Arc::new(NodeIdentity::generate_ed25519());
    let coordinator = NetworkThresholdCoordinator::new(sender, group, verifier_identity);

    let subject = ThresholdSubject {
        kind: "capability-token".to_owned(),
        protected: vec![0xa1, 0x01, 0x27],
        payload: vec![0xa1, 0x00, 0x01],
    };
    let message = to_be_signed(&subject);

    let commitments = coordinator
        .commit_round(1, &device_ids, &subject, u64::MAX)
        .await
        .expect("commit_round");
    assert_eq!(commitments.len(), 2, "both participants committed");

    let shares = coordinator
        .sign_round(1, &commitments)
        .await
        .expect("sign_round");
    assert_eq!(shares.len(), 2, "both participants released a share");

    let commitments_map: std::collections::BTreeMap<_, _> = commitments.into_iter().collect();
    let signing_package = build_signing_package(commitments_map, &message);
    let shares_map: std::collections::BTreeMap<_, _> = shares.into_iter().collect();

    let signature =
        aggregate(&signing_package, &shares_map, &public_key_package).expect("aggregate");
    assert!(
        public_key_package
            .verifying_key()
            .verify(&message, &signature)
            .is_ok(),
        "the aggregated signature verifies against the group's public key"
    );
}
