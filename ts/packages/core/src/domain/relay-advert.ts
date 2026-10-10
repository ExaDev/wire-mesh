/* Relay offers carried in peer-advert's open extension tail, so a node's relay capability is discovered by the gossip that already propagates adverts rather than only learned in-band from a relay-offer-frame on a connection already established (spec/transport.cddl's relay role). A client choosing a relay, rather than just using one it was given, reads this extension from the directory and knows which peers offer relay service at which addresses.

   The value is the identical address list relay-offer-frame itself carries (`[* tstr]`), under the `wire-mesh` domain the core's own gossiped facts already occupy (wire-mesh/version), per spec/CONVENTIONS.md's domain-qualification rule. It is deliberately a caller-supplied fact rather than a session-managed one: which addresses a deployment offers relay on is the operator's choice (an operator may gate relay use, the same way the spec leaves relay gating to an ordinary core/management verb), so the caller passes buildRelayOfferExtension's result to sendGossipUpdate exactly like a presence extension, and nothing here reserves the key against callers.

   Reading is fail-safe by design: an extension that is not an array of strings is treated as no offer at all rather than guessed at or thrown, because an offer is an opportunity a receiver may act on, never an obligation, and a malformed entry must not break directory rendering for the advert's other facts. */

import type { PeerAdvert } from "../generated/protocol.js";

/** The domain-qualified gossip extension key a node's relay offer rides under, the same `wire-mesh` domain the core's own gossiped version fact occupies. */
export const RELAY_OFFER_GOSSIP_KEY = "wire-mesh/relay-offer";

/**
 * Builds the relay-offer extension bag for `sendGossipUpdate`, carrying exactly the address list `relay-offer-frame` itself would name. Throws on an empty list or a non-string entry: an empty offer is not an offer (the caller should simply not advertise), and a malformed address on the wire would be every reader's problem rather than one caller's bug caught at the call site.
 */
export function buildRelayOfferExtension(
  addresses: readonly string[],
): Record<string, unknown> {
  if (addresses.length === 0) {
    throw new Error("a relay offer names at least one address");
  }
  for (const address of addresses) {
    if (typeof address !== "string") {
      throw new Error(
        `a relay offer address is a string, got ${JSON.stringify(address)}`,
      );
    }
  }

  return { [RELAY_OFFER_GOSSIP_KEY]: [...addresses] };
}

/**
 * Reads a peer's relay offer from its advert: the addresses it offers relay service at, or undefined when the peer advertises no offer (or the extension is malformed, which reads as no offer rather than an error). A receiver still decides for itself whether to use any offered address, exactly as it would an in-band relay-offer-frame.
 */
export function readRelayOffer(
  advert: Readonly<PeerAdvert>,
): readonly string[] | undefined {
  const value: unknown = advert[RELAY_OFFER_GOSSIP_KEY];
  if (!Array.isArray(value)) return undefined;
  const addresses: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    addresses.push(entry);
  }
  if (addresses.length === 0) return undefined;

  return addresses;
}
