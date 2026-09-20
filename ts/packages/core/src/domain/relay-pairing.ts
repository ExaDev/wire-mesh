// Tracks every relay pairing a MeshSession's own connection currently holds, keyed by device hex -- the session-side counterpart to relay-hub.ts's own multiplexed adjacency map (wire-mesh#30): a connection can hold simultaneous pairings with several remote devices, so pairing with a new target must never discard an already-established pairing with a different one. Deliberately holds no addressing logic of its own -- outbound relay-data is always addressed explicitly via the caller's own known target/source device (see mesh-session.ts's transmit/applyManageRequest), and inbound attribution is read solely from each frame's own to-device/from-device fields, never guessed from this set. This exists only to answer "have we already relay-connected to this device", so ensureRelayPairing never sends a redundant relay-connect for a target it is already paired with.

import type { DeviceId } from "../generated/protocol.js";
import { deviceIdToHex } from "./device-id.js";

export interface RelayPairings {
  has: (device: DeviceId) => boolean;
  add: (device: DeviceId) => void;
  /** Forgets the pairing with a device, so the next request to it establishes a fresh one. A no-op for a device that was never paired. */
  remove: (device: DeviceId) => void;
  /** Every device currently paired, in establishment order -- the topology self-advertisement's own read of this set (wire-mesh#180), which needs to enumerate pairings rather than just test one. */
  list: () => DeviceId[];
}

export function createRelayPairings(): RelayPairings {
  const established = new Map<string, DeviceId>();
  return {
    has: (device) => established.has(deviceIdToHex(device)),
    add: (device) => {
      established.set(deviceIdToHex(device), device);
    },
    remove: (device) => {
      established.delete(deviceIdToHex(device));
    },
    list: () => [...established.values()],
  };
}
