// "Discover once connected, expand outward" (wire-mesh#187): a session's own gossip directory already carries other known peers' own advertised addresses (peer-advert.addresses), but nothing dials them on its own -- a client otherwise only ever talks to the one node it dialled first. This module observes a session's own peer-adverts (fed to it via createMeshSession's/AcceptedMeshSessionOptions' own onPeerAdvert hook, never by a second, competing consumer of that session's single-reader events stream) and, for each newly-discovered device carrying at least one address, asks a caller-supplied policy whether to dial it. Blindly auto-dialling every gossiped address is the same class of risk as a webpage probing a user's internal network (Private Network Access attacks): a compromised or lying peer in the directory can advertise an address that isn't even a wire-mesh node at all, so this module deliberately holds no trust logic of its own -- shouldExpand is the caller's own gate (an allow-list, an existing session relationship, or a UI confirmation prompt), and an unconditional "always true" policy is a caller's explicit choice, never this module's default.

import type { DeviceId, PeerAdvert } from "../generated/protocol.js";
import { deviceIdToHex } from "./device-id.js";
import type { MeshSession } from "./mesh-session.js";

/** One not-yet-considered device this session's gossip directory has surfaced, carrying only what a dial/trust decision needs: the device-id to decide identity, and the "host:port" addresses its own peer-advert claims are directly reachable at, in the order it advertised them. */
export interface GossipExpansionCandidate {
  readonly device: DeviceId;
  readonly addresses: readonly string[];
}

export interface GossipExpansionOptions {
  /** This session's own device-id, so its own self-advert (looped back through gossip forwarding or a hub's catch-up frame) is never offered to shouldExpand as if it were a distinct peer. */
  selfDeviceId: DeviceId;
  /** Decides whether to attempt a direct connection to a newly-discovered device at all -- called at most once per device for this GossipExpansion instance's lifetime, never re-asked if the same device later re-adverts (an address change, a fresher snapshot-seconds). Returning true does not guarantee a connection: dial may still fail for every one of the candidate's addresses, reported via onExpansionFailed. */
  shouldExpand: (
    candidate: Readonly<GossipExpansionCandidate>,
  ) => Promise<boolean> | boolean;
  /** Attempts one direct connection to `address`, resolving with a fully connected MeshSession or rejecting if the dial/handshake fails. Typically wraps createMeshSession(transport, identity, ...) followed by session.connect(address, localDomains). Called once per address of an approved candidate, in the order it advertised them, stopping at the first that succeeds -- the caller owns cleanup of any partially-established session behind a rejected dial, since this module never holds a reference to one that didn't resolve. */
  dial: (address: string) => Promise<MeshSession>;
  /** Called once a candidate's dial succeeds, with the now-connected session so the caller can wire it into whatever it already does for its own sessions (render it, merge its directory, route messages). */
  onExpanded: (
    candidate: Readonly<GossipExpansionCandidate>,
    session: MeshSession,
  ) => void;
  /** Called when shouldExpand itself declines a candidate. */
  onExpansionDeclined?: (candidate: Readonly<GossipExpansionCandidate>) => void;
  /** Called once every one of an approved candidate's addresses has failed to connect, or shouldExpand itself rejected -- in the latter case, errors holds exactly the one rejection reason, so a caller doesn't need two separate failure channels to observe every way expansion can fail short of success. */
  onExpansionFailed?: (
    candidate: Readonly<GossipExpansionCandidate>,
    errors: readonly Error[],
  ) => void;
}

export interface GossipExpansion {
  /** Feed one just-received peer-advert -- from the session whose peer-adverts this expansion watches, via its own onPeerAdvert hook -- to decide whether it names a newly-discoverable peer worth expanding to, and if so kick off an expansion attempt for it. Never awaits a dial to completion inline: expansion happens in the background, observable only through onExpanded/onExpansionDeclined/onExpansionFailed. */
  considerAdvert: (advert: Readonly<PeerAdvert>) => void;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Builds the per-device expansion state machine: ask once, dial every advertised address in order on approval, report exactly one outcome. */
export function createGossipExpansion(
  options: Readonly<GossipExpansionOptions>,
): GossipExpansion {
  const selfHex = deviceIdToHex(options.selfDeviceId);
  const considered = new Set<string>();

  async function expand(
    candidate: Readonly<GossipExpansionCandidate>,
  ): Promise<void> {
    let approved: boolean;
    try {
      approved = await options.shouldExpand(candidate);
    } catch (error) {
      options.onExpansionFailed?.(candidate, [toError(error)]);
      return;
    }
    if (!approved) {
      options.onExpansionDeclined?.(candidate);
      return;
    }
    const errors: Error[] = [];
    for (const address of candidate.addresses) {
      try {
        const session = await options.dial(address);
        options.onExpanded(candidate, session);
        return;
      } catch (error) {
        errors.push(toError(error));
      }
    }
    options.onExpansionFailed?.(candidate, errors);
  }

  return {
    considerAdvert(advert: Readonly<PeerAdvert>): void {
      const hex = deviceIdToHex(advert.device);
      if (
        hex === selfHex ||
        considered.has(hex) ||
        advert.addresses.length === 0
      ) {
        return;
      }
      // Marked considered synchronously, before shouldExpand's own promise ever resolves -- a second considerAdvert() call for the same device while the first is still being decided must not fire a second, racing expansion attempt.
      considered.add(hex);
      void expand({ device: advert.device, addresses: advert.addresses });
    },
  };
}
