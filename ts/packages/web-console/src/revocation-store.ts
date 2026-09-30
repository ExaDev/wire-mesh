// The console's revocations: the ones it mints for grants it issued and the ones it hears from nodes, verified by core's revocation view and kept over the portable KeyValueStorage port so a revoked grant stays revoked after a reload. The view it hands out is what every token check in the console consults.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  revocationEntrySchema,
  type RevocationEntry,
} from "wire-mesh-core/generated/protocol";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import {
  mintRevocationEntry,
  type RevocationCheck,
  type RevocationEntryVerdict,
} from "wire-mesh-core/domain/tokens";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";

const KEY_PREFIX = "revocation/";

export interface RevocationStore {
  /** What token verification consults. */
  view: RevocationCheck;
  /** Calls `listener` after every revocation that is newly recorded, returning a function that stops it. */
  subscribe: (listener: () => void) => () => void;
  /** Verifies a revocation entry (one heard from a node, or one minted here) and, if it verifies, records and keeps it. */
  ingest: (entry: RevocationEntry) => Promise<RevocationEntryVerdict>;
  /**
   * Revokes a token this device issued: mints the signed entry, records it, and returns it so the caller can announce it.
   * @throws Error when the entry this device just signed does not verify, which would be a fault in the identity.
   */
  revoke: (tokenId: Uint8Array<ArrayBuffer>) => Promise<RevocationEntry>;
}

export interface RevocationStoreOptions {
  storage: KeyValueStorage;
  identity: IdentityPort;
  clock: Clock;
}

/**
 * Builds the store and loads every persisted entry into its view.
 * @throws Error when a persisted entry is malformed or no longer verifies, rather than starting with some revocations silently missing.
 */
export async function createRevocationStore(
  options: Readonly<RevocationStoreOptions>,
): Promise<RevocationStore> {
  const { storage, identity, clock } = options;
  const view = createRevocationView();
  const listeners = new Set<() => void>();

  async function ingest(
    entry: RevocationEntry,
  ): Promise<RevocationEntryVerdict> {
    const verdict = await view.record(entry, { identity });
    if (verdict.ok) {
      const key = `${KEY_PREFIX}${bytesToHex(verdict.claims.issuer)}/${bytesToHex(verdict.claims["token-id"])}`;
      await storage.set(key, new Uint8Array(encode(entry, cdeEncodeOptions)));
      for (const listener of listeners) listener();
    }
    return verdict;
  }

  for (const key of await storage.keys(KEY_PREFIX)) {
    const value = await storage.get(key);
    if (value === undefined) continue;
    const parsed = revocationEntrySchema.safeParse(
      decode(value, cdeDecodeOptions),
    );
    if (!parsed.success) {
      throw new Error(`stored revocation at ${key} is malformed`);
    }
    const verdict = await view.record(parsed.data, { identity });
    if (!verdict.ok) {
      throw new Error(
        `stored revocation at ${key} no longer verifies (${verdict.reason})`,
      );
    }
  }

  return {
    view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ingest,
    async revoke(tokenId) {
      const entry = await mintRevocationEntry({
        identity,
        tokenId,
        revokedAt: clock.now(),
      });
      const verdict = await ingest(entry);
      if (!verdict.ok) {
        throw new Error(
          `the revocation this device signed does not verify (${verdict.reason})`,
        );
      }
      return entry;
    },
  };
}
