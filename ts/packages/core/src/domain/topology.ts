/**
 * Topology introspection (wire-mesh#180): assembling a connection graph out of every device's own self-reported `topology/peers` gossip extension (mesh-session.ts's buildSelfAdvert computes and injects it automatically -- nothing here writes to it), and answering the on-demand `topology.get` manage-command for a live, cache-bust read instead of a possibly-stale gossiped one. `topology:get` is deliberately ungated, per management.cddl's own comment on `topology-get` and this registry entry -- no token/scope check anywhere in this module, mirroring how core/room's room.join/room.invite are ungated in room-client.ts.
 */

import {
  topologyGetSchema,
  topologyPeersSchema,
  type CapabilityScope,
  type DeviceId,
  type ManageCommand,
  type PeerAdvert,
  type TopologyPeers,
} from "../generated/protocol.js";
import type {
  DirectoryEntry,
  IncomingManageRequest,
  MeshSession,
} from "./mesh-session.js";
import { TOPOLOGY_PEERS_GOSSIP_KEY } from "./gossip-extensions.js";

export const TOPOLOGY_GET_CAPABILITY = "topology:get";

/** `topology:get`'s own registry scope kind (spec/registry/core-capabilities.md) -- fixed and uninteresting for an ungated, whole-node query, so sendTopologyGet hardcodes it rather than asking every caller to supply the same `{kind:"node"}` literal themselves. */
const TOPOLOGY_SCOPE: CapabilityScope = { kind: "node" };

/** Builds the topology.get manage-command per management.cddl: the outer verb is the registered `topology:get` capability, matching every other domain-specific (non-generic) manage-command's own "outer verb is a real capability-verb" convention. */
export function buildTopologyGetCommand(): ManageCommand {
  return { verb: TOPOLOGY_GET_CAPABILITY, params: { verb: "topology.get" } };
}

/**
 * Reads a peer-advert's own `topology/peers` gossip extension, returning undefined for anything absent or malformed rather than throwing -- an older peer's advert simply carries no topology yet, and a malformed one is no different from an absent one to a consumer building a best-effort graph. peer-advert's own extension tail is untyped at the wire-schema level (`* tstr => any`, see peerAdvertSchema's `catchall(z.unknown())`), so PeerAdvert's inferred index signature already types this lookup as `unknown` with no cast needed; topologyPeersSchema (generated from management.cddl's own `topology-peers` type) is the actual validation.
 */
export function readTopologyPeers(
  advert: Readonly<PeerAdvert>,
): TopologyPeers | undefined {
  const raw = advert[TOPOLOGY_PEERS_GOSSIP_KEY];
  if (raw === undefined) {
    return undefined;
  }
  const parsed = topologyPeersSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export type TopologyEdge =
  | { kind: "direct"; from: DeviceId; to: DeviceId }
  | { kind: "relay"; from: DeviceId; to: DeviceId; via?: DeviceId };

export interface TopologyGraph {
  /** Every device known in the given directory, regardless of whether it self-reported any topology of its own. */
  nodes: DeviceId[];
  edges: TopologyEdge[];
}

/**
 * Assembles a best-effort connection graph out of a directory of peer-adverts (SessionEvent.directory, or any other DirectoryEntry list a caller has accumulated), each edge attributed to whichever device's own advert reported it -- a direct edge (that device's own connection) or a relay edge (a pairing it holds, and the hub it is reached via, when known). Directed and unreconciled by design: two devices reporting the same connection from either end produce two separate edges rather than being merged into one, since deduplicating would need a judgement call about which side's report to trust that this module has no basis for making, and keeping both is strictly more informative (e.g. it surfaces an asymmetric or stale gossip view rather than silently hiding it). The actual graph query/rendering is a consuming application's own concern (agent-comms#199), not this helper's.
 */
export function assembleTopologyGraph(
  directory: readonly DirectoryEntry[],
): TopologyGraph {
  const nodes = directory.map((entry) => entry.device);
  const edges: TopologyEdge[] = [];
  for (const entry of directory) {
    const topology = readTopologyPeers(entry.advert);
    if (topology === undefined) {
      continue;
    }
    for (const to of topology.direct) {
      edges.push({ kind: "direct", from: entry.device, to });
    }
    for (const relayed of topology.relayed) {
      edges.push({
        kind: "relay",
        from: entry.device,
        to: relayed.device,
        ...(relayed.via !== undefined ? { via: relayed.via } : {}),
      });
    }
  }
  return { nodes, edges };
}

/**
 * Sends topology.get and resolves with the peer's own live TopologyPeers, parsed back out of the manage-ok response's own open `* tstr => any` tail -- the on-demand, cache-bust counterpart to reading a possibly-stale `topology/peers` gossip extension off the directory. targetDevice/timeoutMs forward directly to MeshSession.sendManageRequest's own identically-named parameters (relay routing and a requester-side give-up bound respectively), exactly as requestCapability already does for capability-request.
 */
export async function sendTopologyGet(
  session: Readonly<MeshSession>,
  targetDevice?: DeviceId,
  timeoutMs?: number,
): Promise<TopologyPeers> {
  const outcome = await session.sendManageRequest(
    buildTopologyGetCommand(),
    TOPOLOGY_SCOPE,
    targetDevice,
    undefined,
    timeoutMs,
  );
  if (outcome.result !== "ok") {
    throw new Error(`topology.get was refused (${outcome.code})`);
  }
  const parsed = topologyPeersSchema.safeParse(outcome.peers);
  if (!parsed.success) {
    throw new Error("topology.get response was malformed");
  }
  return parsed.data;
}

/**
 * Answers an incoming topology.get manage-request directly off the given session's own live MeshSession.getTopologyPeers() -- deliberately ungated, per management.cddl's own `topology-get` comment: no token/scope check at all, matching room.join/room.invite's identical "no gate" treatment in room-client.ts. Assumes the caller's own incomingManageRequests dispatch has already routed here for a request whose command.params.verb is "topology.get" (the same assumption createCapabilityRequestHandler already makes for capability-request) -- anything that doesn't parse as topology-get is answered `{result:"error", code:"malformed"}` rather than silently ignored, since reaching this handler at all means the caller believed it was one.
 */
export function createTopologyGetHandler(
  session: Readonly<MeshSession>,
): (incoming: Readonly<IncomingManageRequest>) => Promise<void> {
  return async function handleTopologyGet(
    incoming: Readonly<IncomingManageRequest>,
  ): Promise<void> {
    const parsed = topologyGetSchema.safeParse(incoming.command.params);
    if (!parsed.success) {
      await incoming.respond({ result: "error", code: "malformed" });
      return;
    }
    await incoming.respond({ result: "ok", peers: session.getTopologyPeers() });
  };
}
