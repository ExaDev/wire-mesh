//! Real, end-to-end proof that wire-mesh#177's DKG/reshare network
//! orchestration (`wire_mesh_threshold::keygen_network`) is actually usable
//! over `wire_mesh_core::domain::session::Session` -- not a loopback sender
//! (`keygen_network`'s own `#[cfg(test)]` unit tests already cover that),
//! but over real TCP connections, exactly the discipline
//! `tests/session_runtime_network.rs` already established for threshold
//! SIGNING (wire-mesh#171): a fresh DKG across three real participant
//! connections producing a working group key, then a reshare to a
//! different committee (one device dropped, one added), producing shares
//! from two devices that never held a share together before the reshare,
//! verified by actually signing something with the resulting key against
//! the ORIGINAL group's public key.
//!
//! Every phase (fresh DKG, reshare, signing) uses its OWN fresh TCP
//! connections rather than reusing one connection across phases: a
//! `Session`'s `HandlerRegistry` is fixed at `Session::accept` time, and the
//! signing phase's own handler needs the post-reshare `KeyPackage`, which
//! does not exist yet when the reshare phase's connections are first
//! accepted. Re-establishing connections between phases sidesteps that
//! chicken-and-egg problem entirely, at the cost of a few extra TCP
//! connections a real long-lived node would instead keep open and
//! re-register handlers on incrementally.
//!
//! Devices: A, B, C hold the original 2-of-3 group; C is then dropped and D
//! (a brand-new device with no prior share at all) is added, leaving A and
//! B as the two ORIGINAL members who survive into the new 2-of-3 committee
//! `{A, B, D}`. A acts as reshare survivor/dealer throughout and as the
//! signing coordinator at the end (never itself signing); B and D are the
//! two devices that actually sign -- B held a share of the OLD group, D
//! never held any share before the reshare, so together they are exactly
//! "two devices that never held a share together before the reshare".

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use frost_ed25519::keys::KeyPackage;
use wire_mesh_core::adapters::node_identity::NodeIdentity;
use wire_mesh_core::adapters::TcpTransport;
use wire_mesh_core::domain::session::{
    HandlerRegistry, IncomingManageRequest, ManageRequestHandler, Session,
};
use wire_mesh_core::ports::{Connection, CoreError, Identity, OnConnection, Transport};
use wire_mesh_threshold::identity::ThresholdCoordinator;
use wire_mesh_threshold::keygen_network::{
    compute_reshare_contribution, handle_keygen_confirm, handle_keygen_round1,
    handle_keygen_round2, join_threshold_reshare, run_fresh_threshold_dkg,
    send_reshare_contribution, JoinThresholdReshare, KeygenRoundCollectors, ReshareOwnContribution,
    RunFreshThresholdDkg, SendReshareContribution,
};
use wire_mesh_threshold::network::{
    handle_threshold_commit, handle_threshold_sign, ManageRequestSender,
    NetworkThresholdCoordinator, SigningSessionState, THRESHOLD_SIGN_VERB,
};
use wire_mesh_threshold::nonce_store::InMemoryNonceStore;
use wire_mesh_threshold::signing::{aggregate, build_signing_package};
use wire_mesh_threshold::subject::{to_be_signed, ThresholdSubject};
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::management::{
    ManageCommand, ManageError, ManageOk, ManageOutcome, ManageParams,
};
use wire_mesh_wire::tokens::CapabilityScope;
use wire_mesh_wire::value::CanonicalMap;

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
            .insert(
                key.to_owned(),
                wire_mesh_wire::value::CborValue::Bytes(value),
            )
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

fn threshold_group_scope() -> CapabilityScope {
    CapabilityScope {
        kind: "group".to_owned(),
        path: None,
    }
}

/// Binds a fresh TCP loopback pair -- one side accepted via
/// `Transport::listen`, the other dialled via `Transport::connect` -- so
/// every connection this test uses exercises real TCP, never a hand-rolled
/// test double. Mirrors `wire-mesh-core`'s own `session.rs` test helper of
/// the same name (private to that module, so reproduced here).
async fn tcp_pair(transport: &TcpTransport) -> (Box<dyn Connection>, Box<dyn Connection>) {
    let (accepted_tx, mut accepted_rx) =
        tokio::sync::mpsc::unbounded_channel::<Box<dyn Connection>>();
    let on_connection: OnConnection = Arc::new(move |connection| {
        let _ = accepted_tx.send(connection);
    });
    let guard = transport
        .listen("127.0.0.1:0", on_connection)
        .await
        .expect("listen");
    let dialled = transport.connect(&guard.address()).await.expect("connect");
    let accepted = accepted_rx.recv().await.expect("accepted connection");
    (dialled, accepted)
}

/// Routes an outbound `send_manage_request` to whichever already-accepted
/// [`Session`] this device holds for the named target -- the real-transport
/// counterpart to `keygen_network`'s own `#[cfg(test)]` `LoopbackSender`,
/// and structurally identical to `session_runtime_network.rs`'s own
/// `SessionManageRequestSender`, generalised from "one coordinator, many
/// participants" to "any device, any set of peer sessions", since every
/// device in this test plays both sender and receiver roles.
struct DeviceSender {
    sessions: HashMap<DeviceId, Session>,
}

#[async_trait::async_trait]
impl ManageRequestSender for DeviceSender {
    async fn send_manage_request(
        &self,
        target: DeviceId,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<wire_mesh_wire::tokens::CoseSign1>,
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

/// The [`ManageRequestHandler`] registered on one peer connection for a
/// keygen/reshare ceremony -- dispatches `request.command.params`'s decoded
/// variant onto `keygen_network`'s own plain `handle_keygen_round1`/
/// `round2`/`confirm` functions, exactly the wiring `keygen_network`'s own
/// module doc comment describes as this crate's established pattern
/// (`tests/session_runtime_network.rs`'s `ThresholdParticipant` does the
/// identical thing for `handle_threshold_commit`/`handle_threshold_sign`).
struct KeygenDispatch {
    peer: DeviceId,
    session_id: u64,
    collectors: Arc<KeygenRoundCollectors>,
}

#[async_trait::async_trait]
impl ManageRequestHandler for KeygenDispatch {
    async fn handle(&self, request: IncomingManageRequest) -> ManageOutcome {
        match request.command.params {
            ManageParams::ThresholdKeygenRound1(params) => {
                handle_keygen_round1(&self.collectors, self.session_id, self.peer, params)
            }
            ManageParams::ThresholdKeygenRound2(params) => {
                handle_keygen_round2(&self.collectors, self.session_id, self.peer, params)
            }
            ManageParams::ThresholdKeygenConfirm(params) => {
                handle_keygen_confirm(&self.collectors, self.session_id, self.peer, params)
            }
            _ => manage_error("unsupported"),
        }
    }
}

/// The signing-participant side, wired onto the session runtime -- an exact
/// copy of `tests/session_runtime_network.rs`'s own `ThresholdParticipant`
/// (a separate `tests/*.rs` file compiles as its own crate, so it cannot be
/// imported from there).
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
            _ => manage_error("unsupported"),
        }
    }
}

#[tokio::test]
async fn fresh_dkg_then_reshare_to_a_different_committee_then_sign_over_real_tcp_sessions() {
    // A and C need only their device-ids in this test (A never signs; C is dropped after the fresh DKG phase) -- their `NodeIdentity` values are otherwise unused and dropped immediately. B and D are kept as owned bindings since both are moved into their own `ThresholdParticipant` signing handler once the reshare produces their new key packages.
    let identity_b = NodeIdentity::generate_ed25519();
    let identity_d = NodeIdentity::generate_ed25519();
    let a = *NodeIdentity::generate_ed25519().device_id();
    let b = *identity_b.device_id();
    let c = *NodeIdentity::generate_ed25519().device_id();
    let d = *identity_d.device_id();

    let transport = TcpTransport::new();
    let scope = threshold_group_scope();

    // --- Phase 1: fresh DKG among A, B, C (T=2) --------------------------
    let dkg_session_id = 1;
    let dkg_collectors_a = Arc::new(KeygenRoundCollectors::new());
    let dkg_collectors_b = Arc::new(KeygenRoundCollectors::new());
    let dkg_collectors_c = Arc::new(KeygenRoundCollectors::new());

    let (conn_ab_dial, conn_ab_accept) = tcp_pair(&transport).await;
    let (session_a_to_b, _events) = Session::accept(
        conn_ab_dial,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_KEYGEN_VERB,
            Arc::new(KeygenDispatch {
                peer: b,
                session_id: dkg_session_id,
                collectors: Arc::clone(&dkg_collectors_a),
            }),
        ),
    )
    .await
    .expect("accept a->b (dkg)");
    let (session_b_to_a, _events) = Session::accept(
        conn_ab_accept,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_KEYGEN_VERB,
            Arc::new(KeygenDispatch {
                peer: a,
                session_id: dkg_session_id,
                collectors: Arc::clone(&dkg_collectors_b),
            }),
        ),
    )
    .await
    .expect("accept b->a (dkg)");

    let (conn_ac_dial, conn_ac_accept) = tcp_pair(&transport).await;
    let (session_a_to_c, _events) = Session::accept(
        conn_ac_dial,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_KEYGEN_VERB,
            Arc::new(KeygenDispatch {
                peer: c,
                session_id: dkg_session_id,
                collectors: Arc::clone(&dkg_collectors_a),
            }),
        ),
    )
    .await
    .expect("accept a->c (dkg)");
    let (session_c_to_a, _events) = Session::accept(
        conn_ac_accept,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_KEYGEN_VERB,
            Arc::new(KeygenDispatch {
                peer: a,
                session_id: dkg_session_id,
                collectors: Arc::clone(&dkg_collectors_c),
            }),
        ),
    )
    .await
    .expect("accept c->a (dkg)");

    let (conn_bc_dial, conn_bc_accept) = tcp_pair(&transport).await;
    let (session_b_to_c, _events) = Session::accept(
        conn_bc_dial,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_KEYGEN_VERB,
            Arc::new(KeygenDispatch {
                peer: c,
                session_id: dkg_session_id,
                collectors: Arc::clone(&dkg_collectors_b),
            }),
        ),
    )
    .await
    .expect("accept b->c (dkg)");
    let (session_c_to_b, _events) = Session::accept(
        conn_bc_accept,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_KEYGEN_VERB,
            Arc::new(KeygenDispatch {
                peer: b,
                session_id: dkg_session_id,
                collectors: Arc::clone(&dkg_collectors_c),
            }),
        ),
    )
    .await
    .expect("accept c->b (dkg)");

    let mut sessions_a = HashMap::new();
    sessions_a.insert(b, session_a_to_b);
    sessions_a.insert(c, session_a_to_c);
    let sender_a = DeviceSender {
        sessions: sessions_a,
    };

    let mut sessions_b = HashMap::new();
    sessions_b.insert(a, session_b_to_a);
    sessions_b.insert(c, session_b_to_c);
    let sender_b = DeviceSender {
        sessions: sessions_b,
    };

    let mut sessions_c = HashMap::new();
    sessions_c.insert(a, session_c_to_a);
    sessions_c.insert(b, session_c_to_b);
    let sender_c = DeviceSender {
        sessions: sessions_c,
    };

    let dkg_task_a = run_fresh_threshold_dkg(RunFreshThresholdDkg {
        sender: &sender_a,
        collectors: &dkg_collectors_a,
        own_device_id: a,
        other_participants: vec![b, c],
        threshold: 2,
        session_id: dkg_session_id,
        scope: scope.clone(),
        token: None,
    });
    let dkg_task_b = run_fresh_threshold_dkg(RunFreshThresholdDkg {
        sender: &sender_b,
        collectors: &dkg_collectors_b,
        own_device_id: b,
        other_participants: vec![a, c],
        threshold: 2,
        session_id: dkg_session_id,
        scope: scope.clone(),
        token: None,
    });
    let dkg_task_c = run_fresh_threshold_dkg(RunFreshThresholdDkg {
        sender: &sender_c,
        collectors: &dkg_collectors_c,
        own_device_id: c,
        other_participants: vec![a, b],
        threshold: 2,
        session_id: dkg_session_id,
        scope: scope.clone(),
        token: None,
    });

    let (dkg_result_a, dkg_result_b, dkg_result_c) =
        tokio::join!(dkg_task_a, dkg_task_b, dkg_task_c);
    let (old_key_package_a, old_pkp_a) = dkg_result_a.expect("A's fresh dkg");
    let (old_key_package_b, _old_pkp_b) = dkg_result_b.expect("B's fresh dkg");
    let (_old_key_package_c, _old_pkp_c) = dkg_result_c.expect("C's fresh dkg");
    let original_group_key = old_pkp_a
        .verifying_key()
        .serialize()
        .expect("serialize original group key");

    // --- Phase 2: reshare to {A, B, D} -- C dropped, D added -------------
    let reshare_session_id = 2;
    let new_participants = [a, b, d];
    let new_threshold = 2u16;

    let reshare_collectors_a = Arc::new(KeygenRoundCollectors::new());
    let reshare_collectors_b = Arc::new(KeygenRoundCollectors::new());
    let reshare_collectors_d = Arc::new(KeygenRoundCollectors::new());

    let (conn_ab2_dial, conn_ab2_accept) = tcp_pair(&transport).await;
    let (reshare_session_a_to_b, _events) = Session::accept(
        conn_ab2_dial,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_RESHARE_VERB,
            Arc::new(KeygenDispatch {
                peer: b,
                session_id: reshare_session_id,
                collectors: Arc::clone(&reshare_collectors_a),
            }),
        ),
    )
    .await
    .expect("accept a->b (reshare)");
    let (reshare_session_b_to_a, _events) = Session::accept(
        conn_ab2_accept,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_RESHARE_VERB,
            Arc::new(KeygenDispatch {
                peer: a,
                session_id: reshare_session_id,
                collectors: Arc::clone(&reshare_collectors_b),
            }),
        ),
    )
    .await
    .expect("accept b->a (reshare)");

    let (conn_ad_dial, conn_ad_accept) = tcp_pair(&transport).await;
    let (reshare_session_a_to_d, _events) = Session::accept(
        conn_ad_dial,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_RESHARE_VERB,
            Arc::new(KeygenDispatch {
                peer: d,
                session_id: reshare_session_id,
                collectors: Arc::clone(&reshare_collectors_a),
            }),
        ),
    )
    .await
    .expect("accept a->d (reshare)");
    let (reshare_session_d_to_a, _events) = Session::accept(
        conn_ad_accept,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_RESHARE_VERB,
            Arc::new(KeygenDispatch {
                peer: a,
                session_id: reshare_session_id,
                collectors: Arc::clone(&reshare_collectors_d),
            }),
        ),
    )
    .await
    .expect("accept d->a (reshare)");

    let (conn_bd_dial, conn_bd_accept) = tcp_pair(&transport).await;
    let (reshare_session_b_to_d, _events) = Session::accept(
        conn_bd_dial,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_RESHARE_VERB,
            Arc::new(KeygenDispatch {
                peer: d,
                session_id: reshare_session_id,
                collectors: Arc::clone(&reshare_collectors_b),
            }),
        ),
    )
    .await
    .expect("accept b->d (reshare)");
    let (reshare_session_d_to_b, _events) = Session::accept(
        conn_bd_accept,
        [],
        HandlerRegistry::new().register(
            wire_mesh_threshold::network::THRESHOLD_RESHARE_VERB,
            Arc::new(KeygenDispatch {
                peer: b,
                session_id: reshare_session_id,
                collectors: Arc::clone(&reshare_collectors_d),
            }),
        ),
    )
    .await
    .expect("accept d->b (reshare)");

    let mut reshare_sessions_a = HashMap::new();
    reshare_sessions_a.insert(b, reshare_session_a_to_b);
    reshare_sessions_a.insert(d, reshare_session_a_to_d);
    let reshare_sender_a = DeviceSender {
        sessions: reshare_sessions_a,
    };

    let mut reshare_sessions_b = HashMap::new();
    reshare_sessions_b.insert(a, reshare_session_b_to_a);
    reshare_sessions_b.insert(d, reshare_session_b_to_d);
    let reshare_sender_b = DeviceSender {
        sessions: reshare_sessions_b,
    };

    let mut reshare_sessions_d = HashMap::new();
    reshare_sessions_d.insert(a, reshare_session_d_to_a);
    reshare_sessions_d.insert(b, reshare_session_d_to_b);
    let reshare_sender_d = DeviceSender {
        sessions: reshare_sessions_d,
    };

    let survivors = [a, b];
    let contribution_a = compute_reshare_contribution(
        a,
        &old_key_package_a,
        &survivors,
        &new_participants,
        new_threshold,
    )
    .expect("A computes its reshare contribution");
    let own_contribution_a = ReshareOwnContribution {
        commitment: contribution_a.commitment.clone(),
        share_to_self: contribution_a
            .share_to_self
            .clone()
            .expect("A stays in the new committee"),
    };
    let contribution_b = compute_reshare_contribution(
        b,
        &old_key_package_b,
        &survivors,
        &new_participants,
        new_threshold,
    )
    .expect("B computes its reshare contribution");
    let own_contribution_b = ReshareOwnContribution {
        commitment: contribution_b.commitment.clone(),
        share_to_self: contribution_b
            .share_to_self
            .clone()
            .expect("B stays in the new committee"),
    };

    let send_task_a = send_reshare_contribution(
        SendReshareContribution {
            sender: &reshare_sender_a,
            own_device_id: a,
            new_participants: new_participants.to_vec(),
            new_threshold,
            existing_group_key: original_group_key.clone(),
            session_id: reshare_session_id,
            scope: scope.clone(),
            token: None,
        },
        &contribution_a,
    );
    let send_task_b = send_reshare_contribution(
        SendReshareContribution {
            sender: &reshare_sender_b,
            own_device_id: b,
            new_participants: new_participants.to_vec(),
            new_threshold,
            existing_group_key: original_group_key.clone(),
            session_id: reshare_session_id,
            scope: scope.clone(),
            token: None,
        },
        &contribution_b,
    );
    let join_task_a = join_threshold_reshare(JoinThresholdReshare {
        sender: &reshare_sender_a,
        collectors: &reshare_collectors_a,
        own_device_id: a,
        other_survivors: vec![b],
        own_contribution: Some(own_contribution_a),
        new_participants: new_participants.to_vec(),
        new_threshold,
        existing_group_key: original_group_key.clone(),
        session_id: reshare_session_id,
        scope: scope.clone(),
        token: None,
    });
    let join_task_b = join_threshold_reshare(JoinThresholdReshare {
        sender: &reshare_sender_b,
        collectors: &reshare_collectors_b,
        own_device_id: b,
        other_survivors: vec![a],
        own_contribution: Some(own_contribution_b),
        new_participants: new_participants.to_vec(),
        new_threshold,
        existing_group_key: original_group_key.clone(),
        session_id: reshare_session_id,
        scope: scope.clone(),
        token: None,
    });
    let join_task_d = join_threshold_reshare(JoinThresholdReshare {
        sender: &reshare_sender_d,
        collectors: &reshare_collectors_d,
        own_device_id: d,
        other_survivors: survivors.to_vec(),
        own_contribution: None,
        new_participants: new_participants.to_vec(),
        new_threshold,
        existing_group_key: original_group_key.clone(),
        session_id: reshare_session_id,
        scope: scope.clone(),
        token: None,
    });

    let (send_result_a, send_result_b, join_result_a, join_result_b, join_result_d) = tokio::join!(
        send_task_a,
        send_task_b,
        join_task_a,
        join_task_b,
        join_task_d
    );
    send_result_a.expect("A sends its reshare contribution");
    send_result_b.expect("B sends its reshare contribution");
    let (_new_key_package_a, new_pkp_a) = join_result_a.expect("A joins the new committee");
    let (new_key_package_b, new_pkp_b) = join_result_b.expect("B joins the new committee");
    let (new_key_package_d, new_pkp_d) = join_result_d.expect("D joins the new committee");

    let reshared_group_key = new_pkp_a
        .verifying_key()
        .serialize()
        .expect("serialize reshared group key");
    assert_eq!(
        reshared_group_key, original_group_key,
        "resharing must never change the group's own verifying key"
    );
    assert_eq!(
        new_pkp_b.verifying_key().serialize().expect("serialize"),
        original_group_key
    );
    assert_eq!(
        new_pkp_d.verifying_key().serialize().expect("serialize"),
        original_group_key
    );

    // --- Phase 3: sign with the RESHARED committee {B, D}, verify against
    // the ORIGINAL group key -- B held a share of the old group; D never
    // held any share before the reshare, so this is exactly "two devices
    // that never held a share together before the reshare" producing a
    // signature the ORIGINAL group key accepts. -------------------------
    let group_device_id = wire_mesh_core::adapters::node_identity::derive_device_id_from_public_key(
        &original_group_key,
    );

    let (conn_ab3_dial, conn_ab3_accept) = tcp_pair(&transport).await;
    let (sign_session_a_to_b, _events) = Session::accept(conn_ab3_dial, [], HandlerRegistry::new())
        .await
        .expect("accept a->b (sign)");
    let (_sign_session_b, _events) = Session::accept(
        conn_ab3_accept,
        [],
        HandlerRegistry::new().register(
            THRESHOLD_SIGN_VERB,
            Arc::new(ThresholdParticipant {
                own_device_id: b,
                key_package: new_key_package_b,
                identity: identity_b,
                group: group_device_id,
                nonce_store: InMemoryNonceStore::new(),
                session_state: StdMutex::new(HashMap::new()),
            }),
        ),
    )
    .await
    .expect("accept b (sign)");

    let (conn_ad2_dial, conn_ad2_accept) = tcp_pair(&transport).await;
    let (sign_session_a_to_d, _events) = Session::accept(conn_ad2_dial, [], HandlerRegistry::new())
        .await
        .expect("accept a->d (sign)");
    let (_sign_session_d, _events) = Session::accept(
        conn_ad2_accept,
        [],
        HandlerRegistry::new().register(
            THRESHOLD_SIGN_VERB,
            Arc::new(ThresholdParticipant {
                own_device_id: d,
                key_package: new_key_package_d,
                identity: identity_d,
                group: group_device_id,
                nonce_store: InMemoryNonceStore::new(),
                session_state: StdMutex::new(HashMap::new()),
            }),
        ),
    )
    .await
    .expect("accept d (sign)");

    let mut sign_sessions_a = HashMap::new();
    sign_sessions_a.insert(b, sign_session_a_to_b);
    sign_sessions_a.insert(d, sign_session_a_to_d);
    let sign_sender_a = DeviceSender {
        sessions: sign_sessions_a,
    };
    let verifier_identity: Arc<dyn Identity> = Arc::new(NodeIdentity::generate_ed25519());
    let coordinator =
        NetworkThresholdCoordinator::new(sign_sender_a, group_device_id, verifier_identity);

    let subject = ThresholdSubject {
        kind: "capability-token".to_owned(),
        protected: vec![0xa1, 0x01, 0x27],
        payload: vec![0xa1, 0x00, 0x01],
    };
    let message = to_be_signed(&subject);

    let commitments = coordinator
        .commit_round(1, &[b, d], &subject, u64::MAX)
        .await
        .expect("commit_round");
    assert_eq!(commitments.len(), 2, "both B and D committed");

    let shares = coordinator
        .sign_round(1, &commitments)
        .await
        .expect("sign_round");
    assert_eq!(shares.len(), 2, "both B and D released a share");

    let commitments_map: std::collections::BTreeMap<_, _> = commitments.into_iter().collect();
    let signing_package = build_signing_package(commitments_map, &message);
    let shares_map: std::collections::BTreeMap<_, _> = shares.into_iter().collect();

    let signature = aggregate(&signing_package, &shares_map, &new_pkp_b).expect("aggregate");
    assert!(
        wire_mesh_threshold::frost::VerifyingKey::deserialize(&original_group_key)
            .expect("deserialize original group key")
            .verify(&message, &signature)
            .is_ok(),
        "the reshared committee's aggregate signature verifies against the ORIGINAL group's public key"
    );
}
