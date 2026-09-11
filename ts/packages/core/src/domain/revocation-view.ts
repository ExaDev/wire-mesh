import {
  verifyRevocationEntry,
  type RevocationCheck,
  type RevocationEntryVerdict,
  type VerifyRevocationEntryOptions,
} from "./tokens.js";
import { bytesToHex, deviceIdToHex } from "./device-id.js";
import type { DeviceId, RevocationEntry } from "../generated/protocol.js";

/**
 * An in-memory RevocationCheck fed by ingested revocation-announce frames. Keyed by (token-id, issuer) per management.cddl's contract: an entry counts against a token only when both match, so a third party's entry for someone else's token-id is stored (it is a well-formed, self-certifying entry) but never matches a lookup for the token it does not actually govern.
 */
export interface RevocationView extends RevocationCheck {
  /** Verifies one gossiped revocation-entry via verifyRevocationEntry and, if it verifies, records it. An entry that fails verification is dropped, not stored -- the returned verdict lets a caller log or otherwise report the refusal. */
  record: (
    entry: RevocationEntry,
    options: VerifyRevocationEntryOptions,
  ) => Promise<RevocationEntryVerdict>;
}

function revocationKey(tokenId: Uint8Array, issuer: DeviceId): string {
  return `${bytesToHex(tokenId)}:${deviceIdToHex(issuer)}`;
}

export function createRevocationView(): RevocationView {
  const revoked = new Set<string>();

  return {
    async isRevoked(tokenId, issuer) {
      return Promise.resolve(revoked.has(revocationKey(tokenId, issuer)));
    },
    async record(entry, options) {
      const verdict = await verifyRevocationEntry(entry, options);
      if (verdict.ok) {
        revoked.add(
          revocationKey(verdict.claims["token-id"], verdict.claims.issuer),
        );
      }
      return verdict;
    },
  };
}
