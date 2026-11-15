//! core/management's `path:trace` (wire-mesh#181), ported from `path-trace.ts`: whether the path to a peer is direct or relayed, through which hub, and the real round-trip time. A connection is either direct or exactly one relay hop through a hub, so this is the narrower, honest analogue of a traceroute the transport model supports.
//!
//! Ungated: `path:trace` names no capability at all, and is registered only as a namespaced wire identifier so that `manage-command.verb` has something syntactically valid to carry.
//!
//! The Rust [`Session`](crate::domain::session::Session) has no relay routing, so what the TypeScript derives from a `targetDevice` and from an incoming request's `fromDevice` is stated by the caller here: whether the traced path is relayed, and whether a request arrived relayed.

use std::time::Duration;

use wire_mesh_wire::error::DecodeError;
use wire_mesh_wire::introspection::{PathTrace, PathTraceOk};
use wire_mesh_wire::management::{ManageCommand, ManageOutcome, ManageParams};
use wire_mesh_wire::tokens::{CapabilityScope, CapabilityVerb, CoseSign1};

use crate::ports::{Clock, CoreError};

/// `path:trace` names no real capability: see `spec/management.cddl`.
pub const PATH_TRACE_VERB: &str = "path:trace";

/// The scope a `path.trace` carries: no path, since only the node itself is involved. It is carried on the wire and never checked, since `path.trace` verifies no scope or token.
#[must_use]
pub fn path_trace_scope() -> CapabilityScope {
    CapabilityScope {
        kind: "node".to_owned(),
        path: None,
    }
}

/// Whether `params` is a `path.trace`.
#[must_use]
pub fn is_path_trace(params: &ManageParams) -> bool {
    matches!(params, ManageParams::PathTrace(_))
}

/// The `path.trace` manage-command.
#[must_use]
pub fn build_path_trace_command() -> ManageCommand {
    ManageCommand {
        verb: CapabilityVerb(PATH_TRACE_VERB.to_owned()),
        params: ManageParams::PathTrace(PathTrace),
    }
}

/// This side's answer to an incoming `path.trace`. `relayed` is whether the request arrived wrapped in relay-data, and `hub_address`, when given and relayed, is the address this receiver itself dialled to reach that hub. The address is left out when not relayed and when the caller has none to report.
#[must_use]
pub fn build_path_trace_response(relayed: bool, hub_address: Option<&str>) -> ManageOutcome {
    ManageOutcome::Ok(
        PathTraceOk {
            relayed,
            hub_address: if relayed {
                hub_address.map(str::to_owned)
            } else {
                None
            },
            extra: wire_mesh_wire::Extra::new(),
        }
        .into_ok(),
    )
}

/// What [`trace_path`] needs of a session: sending one manage-request and resolving with its correlated outcome.
#[async_trait::async_trait]
pub trait ManageRequestSender: Send + Sync {
    /// Sends `command` and resolves with the outcome, or `Err` when the connection ends first. A timeout is an ordinary outcome (`code: "timeout"`), not an error.
    async fn send_manage_request(
        &self,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<CoseSign1>,
        timeout: Option<Duration>,
    ) -> Result<ManageOutcome, CoreError>;
}

#[cfg(feature = "net")]
#[async_trait::async_trait]
impl ManageRequestSender for crate::domain::session::Session {
    async fn send_manage_request(
        &self,
        command: ManageCommand,
        scope: CapabilityScope,
        token: Option<CoseSign1>,
        timeout: Option<Duration>,
    ) -> Result<ManageOutcome, CoreError> {
        crate::domain::session::Session::send_manage_request(self, command, scope, token, timeout)
            .await
    }
}

/// This side's own knowledge of the traced path, needing no wire round trip.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTraceLocal {
    /// Whether reaching the traced device required an established relay pairing.
    pub relayed: bool,
    /// The address this session dialled to reach the hub, when relayed and known.
    pub hub_address: Option<String>,
}

/// The receiver's own reported relay knowledge, read from `path-trace-ok`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTraceRemote {
    pub relayed: bool,
    pub hub_address: Option<String>,
}

/// The result of a trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathTraceResult {
    /// The elapsed time, in milliseconds of the injected clock, between sending `path.trace` and receiving its response: the real end-to-end round trip. A clock that went backwards reads as 0.
    pub rtt_ms: u64,
    pub local: PathTraceLocal,
    /// The receiver's report. `None` when the outcome was a `manage-error`, which `outcome` carries for a caller that wants its code.
    pub remote: Option<PathTraceRemote>,
    /// The raw outcome.
    pub outcome: ManageOutcome,
}

/// Why a trace produced no result.
#[derive(Debug)]
pub enum PathTraceError {
    /// The request could not be sent or its connection ended.
    Send(CoreError),
    /// The outcome was `ok` but not the shape of `path-trace-ok`: a receiver that answers `path.trace` at all is expected to answer it correctly, so this is a protocol violation, not an unknown remote.
    Malformed(DecodeError),
}

impl std::fmt::Display for PathTraceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PathTraceError::Send(error) => write!(f, "path.trace could not be sent: {error}"),
            PathTraceError::Malformed(error) => {
                write!(
                    f,
                    "path.trace response did not match path-trace-ok: {error}"
                )
            }
        }
    }
}

impl std::error::Error for PathTraceError {}

/// What [`trace_path`] is given.
pub struct TracePath<'a> {
    pub sender: &'a dyn ManageRequestSender,
    pub clock: &'a dyn Clock,
    /// The scope to carry; [`path_trace_scope`] when `None`.
    pub scope: Option<CapabilityScope>,
    pub token: Option<CoseSign1>,
    pub timeout: Option<Duration>,
    /// Whether reaching the traced device requires a relay pairing on this session.
    pub relayed: bool,
    /// The address this session dialled to reach the hub, reported as the local hub address when `relayed`.
    pub local_hub_address: Option<String>,
}

/// Sends `path.trace` and measures the real round trip, combining it with this side's own local relay knowledge and the receiver's reported knowledge.
///
/// # Errors
///
/// [`PathTraceError::Send`] when the request cannot be sent or the connection ends first, and [`PathTraceError::Malformed`] when the outcome is `ok` but not a `path-trace-ok`.
pub async fn trace_path(options: TracePath<'_>) -> Result<PathTraceResult, PathTraceError> {
    let started_at = options.clock.now_unix_ms();
    let outcome = options
        .sender
        .send_manage_request(
            build_path_trace_command(),
            options.scope.unwrap_or_else(path_trace_scope),
            options.token,
            options.timeout,
        )
        .await
        .map_err(PathTraceError::Send)?;
    let rtt_ms = options.clock.now_unix_ms().saturating_sub(started_at);
    let local = PathTraceLocal {
        relayed: options.relayed,
        hub_address: if options.relayed {
            options.local_hub_address
        } else {
            None
        },
    };
    let ManageOutcome::Ok(ok) = &outcome else {
        return Ok(PathTraceResult {
            rtt_ms,
            local,
            remote: None,
            outcome,
        });
    };
    let parsed = PathTraceOk::from_ok(ok).map_err(PathTraceError::Malformed)?;
    let remote = PathTraceRemote {
        relayed: parsed.relayed,
        hub_address: parsed.hub_address,
    };
    Ok(PathTraceResult {
        rtt_ms,
        local,
        remote: Some(remote),
        outcome,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use wire_mesh_wire::management::{ManageError, ManageOk};
    use wire_mesh_wire::value::{CanonicalMap, CborValue};

    struct Ticks(Mutex<Vec<u64>>);

    impl Clock for Ticks {
        fn now_unix_ms(&self) -> u64 {
            self.0.lock().expect("clock").remove(0)
        }
    }

    struct Scripted(Result<ManageOutcome, String>);

    #[async_trait::async_trait]
    impl ManageRequestSender for Scripted {
        async fn send_manage_request(
            &self,
            command: ManageCommand,
            scope: CapabilityScope,
            token: Option<CoseSign1>,
            timeout: Option<Duration>,
        ) -> Result<ManageOutcome, CoreError> {
            assert_eq!(command, build_path_trace_command());
            assert_eq!(scope, path_trace_scope());
            assert_eq!(token, None);
            assert_eq!(timeout, None);
            self.0.clone().map_err(CoreError::Transport)
        }
    }

    fn options<'a>(sender: &'a Scripted, clock: &'a Ticks) -> TracePath<'a> {
        TracePath {
            sender,
            clock,
            scope: None,
            token: None,
            timeout: None,
            relayed: true,
            local_hub_address: Some("hub:1".to_owned()),
        }
    }

    #[tokio::test]
    async fn a_trace_measures_the_round_trip_and_reports_both_sides() {
        let sender = Scripted(Ok(build_path_trace_response(true, Some("peer-hub:2"))));
        let clock = Ticks(Mutex::new(vec![1_000, 1_042]));
        let result = trace_path(options(&sender, &clock)).await.expect("a trace");
        assert_eq!(result.rtt_ms, 42);
        assert_eq!(
            result.local,
            PathTraceLocal {
                relayed: true,
                hub_address: Some("hub:1".to_owned())
            }
        );
        assert_eq!(
            result.remote,
            Some(PathTraceRemote {
                relayed: true,
                hub_address: Some("peer-hub:2".to_owned())
            })
        );
    }

    #[tokio::test]
    async fn a_direct_path_reports_no_hub_address_on_either_side() {
        let sender = Scripted(Ok(build_path_trace_response(false, Some("ignored"))));
        let clock = Ticks(Mutex::new(vec![5, 5]));
        let mut direct = options(&sender, &clock);
        direct.relayed = false;
        let result = trace_path(direct).await.expect("a trace");
        assert_eq!(result.local.hub_address, None);
        assert_eq!(result.remote.expect("remote").hub_address, None);
    }

    #[tokio::test]
    async fn a_clock_that_went_backwards_reads_as_zero() {
        let sender = Scripted(Ok(build_path_trace_response(false, None)));
        let clock = Ticks(Mutex::new(vec![100, 90]));
        let result = trace_path(options(&sender, &clock)).await.expect("a trace");
        assert_eq!(result.rtt_ms, 0);
    }

    #[tokio::test]
    async fn an_error_outcome_is_returned_with_no_remote() {
        let error = ManageOutcome::Error(ManageError {
            code: "denied".to_owned(),
            message: None,
        });
        let sender = Scripted(Ok(error.clone()));
        let clock = Ticks(Mutex::new(vec![1, 2]));
        let result = trace_path(options(&sender, &clock)).await.expect("a trace");
        assert_eq!(result.remote, None);
        assert_eq!(result.outcome, error);
    }

    #[tokio::test]
    async fn an_ok_that_is_not_a_path_trace_ok_is_a_protocol_violation() {
        let mut extra = CanonicalMap::new();
        extra
            .insert("relayed".to_owned(), CborValue::Text("yes".to_owned()))
            .expect("unique");
        let sender = Scripted(Ok(ManageOutcome::Ok(ManageOk { extra })));
        let clock = Ticks(Mutex::new(vec![1, 2]));
        assert!(matches!(
            trace_path(options(&sender, &clock)).await,
            Err(PathTraceError::Malformed(_))
        ));
    }

    #[tokio::test]
    async fn a_connection_that_ends_is_a_send_error() {
        let sender = Scripted(Err("closed".to_owned()));
        let clock = Ticks(Mutex::new(vec![1]));
        assert!(matches!(
            trace_path(options(&sender, &clock)).await,
            Err(PathTraceError::Send(_))
        ));
    }
}
