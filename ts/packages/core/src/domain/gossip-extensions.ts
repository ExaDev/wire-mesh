// Validation for sendGossipUpdate's own extension bag, extracted out of mesh-session.ts as a pure, closure-free helper -- the same "no dependency on session state" property ping-round-trips.ts's own extraction already relies on, and the mechanism that keeps mesh-session.ts itself under this repo's own max-lines cap as new capability (wire-mesh#180's topology self-advertisement, wire-mesh#181's ping/pong RTT plumbing, and wire-mesh#179's own version.get/gossip plumbing) grows it.

import { CORE_VERSION_GOSSIP_KEY } from "./own-version.js";

/** peer-advert's own three typed fields -- reserved so a `sendGossipUpdate` caller can never override the session's own device-id, address list, or freshness timestamp by supplying an extension of the same name. */
const RESERVED_PEER_ADVERT_KEYS = new Set([
  "device",
  "addresses",
  "snapshot-seconds",
]);

/** The gossip extension key topology self-advertisement (wire-mesh#180) is carried under -- session-managed, computed fresh from this session's own connection/relayPairings state on every self-advert, never a caller-supplied fact. */
export const TOPOLOGY_PEERS_GOSSIP_KEY = "topology/peers";

/** A gossip extension key must be domain-qualified as `<domain>/<field>` (lowercase kebab-case each side), per `spec/CONVENTIONS.md`'s gossip-extension-namespacing convention -- this is what stops two independent applications sharing one gossip tail from silently colliding on a bare name like "status". */
const GOSSIP_EXTENSION_KEY_PATTERN = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** Rejects a `sendGossipUpdate` extension bag that would shadow one of peer-advert's own mandatory fields, shadow topology/peers (a field the session itself already computes and injects automatically, wire-mesh#180), use the key wire-mesh-core itself reserves for its own self-reported version (wire-mesh#179), or use a bare, non-domain-qualified key -- all are caller bugs that must fail loudly at the call site, not silently corrupt or ambiguously merge into the wire frame. */
export function validateGossipExtensions(
  extensions: Record<string, unknown>,
): void {
  for (const key of Object.keys(extensions)) {
    if (RESERVED_PEER_ADVERT_KEYS.has(key)) {
      throw new Error(
        `sendGossipUpdate extension key "${key}" collides with a mandatory peer-advert field`,
      );
    }
    if (key === TOPOLOGY_PEERS_GOSSIP_KEY) {
      throw new Error(
        `sendGossipUpdate extension key "${key}" collides with a session-managed gossip field`,
      );
    }
    if (key === CORE_VERSION_GOSSIP_KEY) {
      throw new Error(
        `sendGossipUpdate extension key "${key}" is reserved for wire-mesh-core's own self-reported version`,
      );
    }
    if (!GOSSIP_EXTENSION_KEY_PATTERN.test(key)) {
      throw new Error(
        `sendGossipUpdate extension key "${key}" must be domain-qualified as "<domain>/<field>" (e.g. "presence/status")`,
      );
    }
  }
}
