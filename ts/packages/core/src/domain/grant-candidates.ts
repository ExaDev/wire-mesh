/**
 * Gossip-advertised delegable-grant candidates (wire-mesh#87): lets a bearer of a still-delegable held token advertise its own willingness to field a capability-request for a narrower grant, and lets a requester discover the best candidate it can currently see before falling back to a capability's own structural root (that fallback -- e.g. a room's owner device-id -- is the caller's own concern, entirely outside this module; findGrantCandidate only ever returns a nearer-than-root candidate or undefined). Rides peer-advert's existing open extension tail (spec/transport.cddl, wire-mesh#91) under the domain-qualified key "capability-request/candidates" -- no new CDDL, no new wire mechanism, just a structured value on an already-shipped extension point.
 *
 * Honest limit, not closed here: this is only ever as complete as gossip propagation allows. A request can go unanswered by a nearer delegate not because none exists, but because it hasn't been gossiped yet -- the same "detection with propagation delay" honesty this spec already accepts for kick propagation and revocation timing.
 */

import { z } from "zod";
import {
  capabilityScopeSchema,
  type CapabilityScope,
  type DeviceId,
} from "../generated/protocol.js";
import type { DirectoryEntry, MeshSession } from "./mesh-session.js";
import { scopeNarrows } from "./token-scope.js";

const GOSSIP_CANDIDATES_KEY = "capability-request/candidates";

const grantCandidateSchema = z.object({
  capability: z.string(),
  scope: capabilityScopeSchema,
  "delegations-remaining": z.number().int().nonnegative().optional(),
});

export type GrantCandidate = z.infer<typeof grantCandidateSchema>;

const grantCandidateListSchema = z.array(grantCandidateSchema);

/**
 * Advertises this session's own willingness to field a capability-request for each of candidates, via sendGossipUpdate's own re-advertisement mechanism. Callers own their own re-advertisement cadence (there is no timer here, matching sendGossipUpdate's own design) -- calling this again with a fresh list replaces what was previously advertised under this key, exactly as sendGossipUpdate's own peer-advert re-send already does for any other extension field.
 */
export async function advertiseGrantCandidates(
  session: Readonly<MeshSession>,
  candidates: readonly GrantCandidate[],
): Promise<void> {
  await session.sendGossipUpdate({ [GOSSIP_CANDIDATES_KEY]: candidates });
}

/**
 * Scans directory for the best currently-gossiped delegate that could field a capability-request for capability over scope, returning its device-id -- or undefined when nothing closer than the capability's own structural root has been gossiped. A candidate qualifies when its own advertised capability matches exactly and its own advertised scope narrows into the requested scope (scopeNarrows' existing narrowing relation: the candidate's scope is the same as or a broader ancestor of scope), and its own delegations-remaining is either absent (unbounded) or still greater than zero.
 *
 * Selection policy, deliberately simple and explicitly stated rather than left implicit: the first qualifying candidate in directory's own order wins. Gossip carries no distance, latency, or load signal a requester could meaningfully rank candidates by, so no ordering directory provides is more defensible than any other -- "first seen" is exactly as reasonable a tie-break as "highest delegations-remaining" and simplest to implement and reason about.
 *
 * A malformed or non-conforming candidates value (from a misbehaving or out-of-date peer) is silently skipped, not treated as an error: this is a discovery hint over self-asserted, unsigned gossip, not a security check -- the token minted from any candidate this function returns still goes through mintCapabilityToken's own full narrowing checks regardless.
 */
export function findGrantCandidate(
  directory: readonly DirectoryEntry[],
  capability: string,
  scope: Readonly<CapabilityScope>,
): DeviceId | undefined {
  for (const entry of directory) {
    const raw: unknown = entry.advert[GOSSIP_CANDIDATES_KEY];
    if (raw === undefined) continue;
    const parsed = grantCandidateListSchema.safeParse(raw);
    if (!parsed.success) continue;
    for (const candidate of parsed.data) {
      if (candidate.capability !== capability) continue;
      const remaining = candidate["delegations-remaining"];
      if (remaining !== undefined && remaining <= 0) continue;
      if (scopeNarrows(candidate.scope, scope)) {
        return entry.device;
      }
    }
  }
  return undefined;
}
