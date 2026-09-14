import {
  verifyRevocationEntry,
  type RevocationCheck,
  type RevocationEntryVerdict,
  type VerifyRevocationEntryOptions,
} from "./tokens.js";
import { bytesToHex } from "./device-id.js";
import type { RevocationClaims, RevocationEntry } from "../generated/protocol.js";

/**
 * An in-memory RevocationCheck fed by ingested revocation-announce frames. Keyed by token-id alone, per management.cddl's contract: a token-id can legitimately carry multiple recorded entries from different issuers (the token's own issuer, and/or any number of parties holding a delegated "revoke" authorization over it) -- entriesFor returns every one of them unfiltered, since checking which actually apply (issuer-match, or a verified authorization) is verifyTokenChain's own obligation, not this store's.
 */
export interface RevocationView extends RevocationCheck {
  /** Verifies one gossiped revocation-entry via verifyRevocationEntry and, if it verifies, records it. An entry that fails verification is dropped, not stored -- the returned verdict lets a caller log or otherwise report the refusal. */
  record: (
    entry: RevocationEntry,
    options: VerifyRevocationEntryOptions,
  ) => Promise<RevocationEntryVerdict>;
}

function revocationKey(tokenId: Uint8Array): string {
  return bytesToHex(tokenId);
}

export function createRevocationView(): RevocationView {
  const entriesByTokenId = new Map<string, RevocationClaims[]>();

  return {
    async entriesFor(tokenId) {
      return Promise.resolve(entriesByTokenId.get(revocationKey(tokenId)) ?? []);
    },
    async record(entry, options) {
      const verdict = await verifyRevocationEntry(entry, options);
      if (verdict.ok) {
        const key = revocationKey(verdict.claims["token-id"]);
        const existing = entriesByTokenId.get(key);
        if (existing === undefined) {
          entriesByTokenId.set(key, [verdict.claims]);
        } else {
          existing.push(verdict.claims);
        }
      }
      return verdict;
    },
  };
}
