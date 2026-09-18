// core/management's path:trace (wire-mesh#181): "is my path to a peer direct or relayed, and via which hub, and what's the real round-trip time" -- the honest, narrower analogue of IP traceroute this protocol's own transport model actually supports (relay-hub.ts's own header: a connection is either direct, or exactly one relay hop through a hub, never more). Deliberately ungated -- see spec/management.cddl's own path-trace/path-trace-ok comment for why this names no real capability at all, unlike room:member/webrtc:signal.

import {
  pathTraceOkSchema,
  type CapabilityScope,
  type CapabilityToken,
  type DeviceId,
  type ManageCommand,
  type ManageCommandParams,
  type PathTrace,
} from "../generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "./mesh-session.js";
import type { Clock } from "../ports/clock.js";

/** path:trace names no real capability -- see spec/management.cddl's own comment -- and is registered purely as a namespaced wire identifier so manage-command.verb's own capability-verb grammar has something syntactically valid to carry (registry/core-capabilities.md). */
export const PATH_TRACE_VERB = "path:trace";

/** No path: there is no filesystem subtree or other resource involved, only the node itself -- carried on the wire but never actually checked, since path.trace verifies no scope or token at all. */
export const PATH_TRACE_SCOPE: CapabilityScope = { kind: "node" };

export function isPathTrace(params: ManageCommandParams): params is PathTrace {
  return (
    typeof params === "object" &&
    "verb" in params &&
    params.verb === "path.trace"
  );
}

export function buildPathTraceCommand(): ManageCommand {
  return { verb: PATH_TRACE_VERB, params: { verb: "path.trace" } };
}

/** Builds this side's own answer to an incoming path.trace. relayed is exactly whether THIS request arrived wrapped in relay-data -- incoming.fromDevice is only ever set for a relay-wrapped request (see mesh-session.ts's own applyManageRequest) -- and hubAddress, when given and relayed, is the address this receiver itself dialled to reach the hub the request arrived over, ordinarily read straight off this session's own ConnectionState.address (already tracked by every caller consuming session.events, no new bookkeeping needed). Omitted entirely when not relayed, or when the caller has no address to report (e.g. an accepted, never-dialled connection). */
export function buildPathTraceResponse(
  incoming: Readonly<IncomingManageRequest>,
  hubAddress?: string,
): ManageOutcome {
  const relayed = incoming.fromDevice !== undefined;
  return {
    result: "ok",
    relayed,
    ...(relayed && hubAddress !== undefined
      ? { "hub-address": hubAddress }
      : {}),
  };
}

export interface PathTraceLocal {
  /** Whether reaching the traced device required an established relay pairing on this session -- true exactly when targetDevice was given, mirroring sendManageRequest's own targetDevice semantics (mesh-session.ts): a session holds at most one connection at a time, so relaying to ANY device on it means every relay pairing rides the identical hub connection. */
  relayed: boolean;
  /** The address this session dialled to reach that hub, when relayed and known -- this side's own equivalent of the remote's reported hub-address, needing no wire round trip since it is already local knowledge. */
  hubAddress?: string;
}

export interface PathTraceRemote {
  relayed: boolean;
  hubAddress?: string;
}

export interface PathTraceResult {
  /** Real end-to-end round-trip time in milliseconds: the elapsed time between sending path.trace and receiving its manage-response, exactly what the manage-request/manage-response round trip already gives for free. */
  rttMs: number;
  local: PathTraceLocal;
  /** The receiver's own reported relayed/hub-address, parsed from path-trace-ok's own extension fields -- absent when the outcome was a manage-error rather than a malformed/missing pathTraceOkSchema match, since a malformed ok response is a protocol violation this function surfaces by throwing, not by silently reporting "unknown". */
  remote?: PathTraceRemote;
  /** The raw manage-response outcome, for a caller that wants to inspect a manage-error's own code/message directly rather than only knowing remote is absent. */
  outcome: ManageOutcome;
}

export interface TracePathOptions {
  session: Pick<MeshSession, "sendManageRequest">;
  clock: Pick<Clock, "now">;
  scope?: CapabilityScope;
  targetDevice?: DeviceId;
  token?: CapabilityToken;
  timeoutMs?: number;
  /** This session's own currently-dialled address, reported back as local.hubAddress when targetDevice makes this a relayed trace -- omit when unknown (e.g. this session never dialled anything itself). */
  localHubAddress?: string;
}

/** Sends path.trace and measures the real end-to-end round trip, combining it with this side's own local relay knowledge (no wire round trip needed for that half -- see PathTraceLocal's own doc comment) and the receiver's reported relay knowledge parsed out of a successful outcome's own extension fields. Throws if the outcome resolves ok but its extension fields don't match path-trace-ok's own shape (relayed missing or the wrong type) -- a receiver that answers path.trace at all is expected to answer it correctly; this is a protocol violation to surface loudly, not a case to silently treat as "remote unknown". */
export async function tracePath(
  options: Readonly<TracePathOptions>,
): Promise<PathTraceResult> {
  const startedAt = options.clock.now();
  const outcome = await options.session.sendManageRequest(
    buildPathTraceCommand(),
    options.scope ?? PATH_TRACE_SCOPE,
    options.targetDevice,
    options.token,
    options.timeoutMs,
  );
  const rttMs = options.clock.now() - startedAt;
  const local: PathTraceLocal = {
    relayed: options.targetDevice !== undefined,
    ...(options.targetDevice !== undefined &&
    options.localHubAddress !== undefined
      ? { hubAddress: options.localHubAddress }
      : {}),
  };
  if (outcome.result === "error") {
    return { rttMs, local, outcome };
  }
  const parsed = pathTraceOkSchema.safeParse(outcome);
  if (!parsed.success) {
    throw new Error(
      `path.trace response did not match path-trace-ok's own shape: ${parsed.error.message}`,
    );
  }
  const remote: PathTraceRemote = {
    relayed: parsed.data.relayed,
    ...(parsed.data["hub-address"] !== undefined
      ? { hubAddress: parsed.data["hub-address"] }
      : {}),
  };
  return { rttMs, local, remote, outcome };
}
