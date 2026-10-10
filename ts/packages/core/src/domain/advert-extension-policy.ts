// What a hub is willing to hold and forward of a peer-advert's open extension tail. A peer-advert's signature covers every entry, so a hub cannot strip a field from an advert on the way through without invalidating it for every receiver; the only choices it has are to forward an advert whole or to refuse it. A hub that every client of is part of one mesh can forward everything. A hub open to anyone cannot: whatever an application put in its tail reaches every client that connects, whether or not it has any relationship to the sender. This module is how such a hub says which extension entries it will carry.

import { CORE_VERSION_GOSSIP_KEY } from "./own-version.js";
import {
  RESERVED_PEER_ADVERT_KEYS,
  TOPOLOGY_PEERS_GOSSIP_KEY,
} from "./gossip-extensions.js";
import type { PeerAdvert } from "../generated/protocol.js";

/** Whether one extension entry's value is one the hub will carry. Must be strict: a value with a field the validator did not expect is refused, since the point is that nothing unexpected is published. */
export type ExtensionValidator = (value: unknown) => boolean;

export interface AdvertExtensionPolicy {
  /**
   * The application extensions the hub carries, each with the validator its value must pass. An advert holding any extension key not listed here, or a listed key whose value fails its validator, is refused whole. wire-mesh-core's own extensions (topology and version) are always carried and need no entry.
   */
  readonly allowed: Readonly<Record<string, ExtensionValidator>>;
}

export type AdvertExtensionVerdict =
  { readonly ok: true } | { readonly ok: false; readonly key: string };

/** The extension keys wire-mesh-core itself writes on every self-advert, which a policy never has to list. */
const CORE_EXTENSION_KEYS: ReadonlySet<string> = new Set([
  TOPOLOGY_PEERS_GOSSIP_KEY,
  CORE_VERSION_GOSSIP_KEY,
]);

/**
 * Checks every extension entry of an advert against a policy. Refuses on the first entry that is not allowed and names its key, so the host can say why.
 */
export function checkAdvertExtensions(
  advert: Readonly<PeerAdvert>,
  policy: Readonly<AdvertExtensionPolicy>,
): AdvertExtensionVerdict {
  for (const [key, value] of Object.entries(advert)) {
    if (RESERVED_PEER_ADVERT_KEYS.has(key) || CORE_EXTENSION_KEYS.has(key)) {
      continue;
    }
    const validator = Object.hasOwn(policy.allowed, key)
      ? policy.allowed[key]
      : undefined;
    if (validator?.(value) !== true) {
      return { ok: false, key };
    }
  }

  return { ok: true };
}
