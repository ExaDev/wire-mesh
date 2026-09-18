/** Pure computation of a session's own topology self-advertisement (wire-mesh#180) out of primitive facts about its connection -- split out of mesh-session.ts purely to keep that already-large file under this repo's own max-lines lint budget; there is nothing session-shaped about the computation itself, so it takes plain inputs rather than a MeshSession. */
import type { DeviceId, TopologyPeers } from "../generated/protocol.js";

export interface TopologyPeersInputs {
  /** connection?.peerDeviceId -- the transport-authenticated direct peer, when the adapter gives one. Takes priority over firstAdvertisedPeer below. */
  authenticatedPeer?: DeviceId;
  /** The device named by this session's own first-ever peer-advert -- only trustworthy when isAccepted is true; see mesh-session.ts's own firstPeerDevice doc comment for why a dial-side session may end up naming a merely-relayed third device instead. */
  firstAdvertisedPeer: DeviceId | null;
  /** True for an accepted connection (dial === null in mesh-session.ts), where firstAdvertisedPeer is structurally sound; false for a dial-side session, where it is not. */
  isAccepted: boolean;
  /** Every device this session's own connection currently holds a relay pairing with (relayPairings.list()). */
  relayedDevices: readonly DeviceId[];
}

/** This session's own direct peer, when it can be honestly known -- see TopologyPeersInputs' own field comments for the priority order and why the gossip-derived fallback is gated on isAccepted. */
function directPeerDevice(
  inputs: Readonly<TopologyPeersInputs>,
): DeviceId | undefined {
  if (inputs.authenticatedPeer !== undefined) {
    return inputs.authenticatedPeer;
  }
  return inputs.isAccepted
    ? (inputs.firstAdvertisedPeer ?? undefined)
    : undefined;
}

/** This session's own current topology self-advertisement: the peer this connection is directly with, when known, and every device this connection currently holds a relay pairing with, each named alongside the hub it is reached via -- always this same direct peer, since a session has exactly one connection and a relay pairing on it can only ever have been established through that connection's own remote end. `via` is omitted, not guessed, when the hub itself has no known device-id (an anonymous relay-only hub, e.g. wire-mesh-node/cloudflare-hub's bare RelayHub, never gossips a self-advert of its own to learn one from). */
export function computeTopologyPeers(
  inputs: Readonly<TopologyPeersInputs>,
): TopologyPeers {
  const direct = directPeerDevice(inputs);
  return {
    direct: direct !== undefined ? [direct] : [],
    relayed: inputs.relayedDevices.map((device) => ({
      device,
      ...(direct !== undefined ? { via: direct } : {}),
    })),
  };
}

export interface TopologySnapshotSources {
  /** Reads connection?.peerDeviceId live at compute() time -- a closure rather than a plain value, since the connection itself can be replaced (reconnect) between one self-advert and the next. */
  getAuthenticatedPeer: () => DeviceId | undefined;
  /** dial === null, fixed for a session's entire lifetime (never reconnects, so not read live). */
  isAccepted: boolean;
  /** Reads relayPairings.list() live at compute() time. */
  getRelayedDevices: () => readonly DeviceId[];
}

export interface TopologySnapshotTracker {
  /** Records one peer-advert entry as it is applied to a session's own directory -- see TopologyPeersInputs.firstAdvertisedPeer's own comment for what this is used for and why only the first call matters. */
  recordAdvert: (device: DeviceId) => void;
  /** Computes this session's own current TopologyPeers from the live connection/relayPairings state given at createTopologySnapshotTracker's own construction time. */
  compute: () => TopologyPeers;
}

/** Bundles firstAdvertisedPeer's own mutable tracking together with computeTopologyPeers, so mesh-session.ts's createSessionCore holds one small object instead of a bare `let` plus a wrapper function around this module's own computeTopologyPeers -- sources' own closures are captured once here, so compute() itself takes no arguments at either of buildSelfAdvert/getTopologyPeers' own call sites. */
export function createTopologySnapshotTracker(
  sources: Readonly<TopologySnapshotSources>,
): TopologySnapshotTracker {
  let firstAdvertisedPeer: DeviceId | null = null;
  return {
    recordAdvert: (device) => {
      firstAdvertisedPeer ??= device;
    },
    compute: () => {
      const authenticatedPeer = sources.getAuthenticatedPeer();
      return computeTopologyPeers({
        ...(authenticatedPeer !== undefined ? { authenticatedPeer } : {}),
        firstAdvertisedPeer,
        isAccepted: sources.isAccepted,
        relayedDevices: sources.getRelayedDevices(),
      });
    },
  };
}
