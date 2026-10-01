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

/** A stored revocation that could not be loaded, so the grant it revoked is not known to be revoked. */
export interface UnreadableRevocation {
  /** The storage key it is kept under. */
  key: string;
  reason: string;
}

export interface RevocationStore {
  /** What token verification consults. */
  view: RevocationCheck;
  /** Calls `listener` after every revocation that is newly recorded and every unreadable one that is discarded, returning a function that stops it. */
  subscribe: (listener: () => void) => () => void;
  /** The stored revocations that could not be loaded when the store was built. The same array is returned until one is discarded, so it can back a subscription. */
  unreadable: () => readonly UnreadableRevocation[];
  /** Deletes an unreadable stored revocation, the recovery when it cannot be repaired: until then the grant it revoked may read as valid. */
  discardUnreadable: (key: string) => Promise<void>;
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

/** Loads one stored entry into the view, returning why it could not be, or undefined when it was. */
async function loadStored(
  view: Readonly<ReturnType<typeof createRevocationView>>,
  identity: IdentityPort,
  value: Uint8Array,
): Promise<string | undefined> {
  let decoded: unknown;
  try {
    decoded = decode(value, cdeDecodeOptions);
  } catch {
    return "it is not valid CBOR";
  }
  const parsed = revocationEntrySchema.safeParse(decoded);
  if (!parsed.success) {
    return "it is not a revocation entry";
  }
  const verdict = await view.record(parsed.data, { identity });
  return verdict.ok ? undefined : `it no longer verifies (${verdict.reason})`;
}

/**
 * Builds the store and loads every persisted entry into its view. An entry that is malformed or no longer verifies is not loaded, and is listed by `unreadable` so the console can say that some revocations are missing rather than either hiding it or refusing to start.
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

  let unreadable: readonly UnreadableRevocation[] = [];
  for (const key of await storage.keys(KEY_PREFIX)) {
    const value = await storage.get(key);
    if (value === undefined) continue;
    const reason = await loadStored(view, identity, value);
    if (reason !== undefined) {
      unreadable = [...unreadable, { key, reason }];
    }
  }

  return {
    view,
    unreadable: () => unreadable,
    async discardUnreadable(key) {
      await storage.delete(key);
      unreadable = unreadable.filter((entry) => entry.key !== key);
      for (const listener of listeners) listener();
    },
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
