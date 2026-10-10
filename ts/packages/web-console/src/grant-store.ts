// The grants this device holds (issued to it) and has issued (minted by it), kept over the portable KeyValueStorage port so they survive a reload. A token is recorded once, by its token-id, in the direction it was first recorded; what the grant is worth now is always judged afresh by core's verifier, never stored.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  capabilityTokenSchema,
  type CapabilityToken,
  type TokenClaims,
} from "wire-mesh-core/generated/protocol";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import { decodeGrantClaims } from "./grants.js";

export type GrantDirection = "held" | "issued";

export interface GrantRecord {
  /** Hex of the token's token-id. */
  tokenId: string;
  direction: GrantDirection;
  token: CapabilityToken;
  claims: TokenClaims;
  /** When the console recorded it, in milliseconds since the epoch. */
  recordedAt: number;
}

export interface GrantStore {
  /**
   * Records a token in `direction`, unless a token with the same token-id is already recorded there.
   * @throws Error when the token's claims cannot be read.
   */
  record: (
    direction: GrantDirection,
    token: CapabilityToken,
    at: number,
  ) => Promise<void>;
  /** Every recorded grant, most recently recorded first. */
  list: () => Promise<GrantRecord[]>;
  /** Calls `listener` after every change made through `record`, returning a function that stops it. */
  subscribe: (listener: () => void) => () => void;
}

const KEY_PREFIX = "grant/";

function keyFor(direction: GrantDirection, tokenId: string): string {
  return `${KEY_PREFIX}${direction}/${tokenId}`;
}

function directionOfKey(key: string): GrantDirection {
  const direction = key.slice(KEY_PREFIX.length).split("/")[0];
  if (direction === "held" || direction === "issued") return direction;
  throw new Error(`stored grant key ${key} names no direction`);
}

function isStoredGrant(
  value: unknown,
): value is { token: unknown; recordedAt: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "token" in value &&
    "recordedAt" in value &&
    typeof value.recordedAt === "number"
  );
}

export function createGrantStore(
  storage: Readonly<KeyValueStorage>,
): GrantStore {
  const listeners = new Set<() => void>();

  return {
    async record(direction, token, at) {
      const claims = decodeGrantClaims(token);
      if (claims === undefined) {
        throw new Error("a grant must carry readable token claims");
      }
      const key = keyFor(direction, bytesToHex(claims["token-id"]));
      if ((await storage.get(key)) !== undefined) return;
      await storage.set(
        key,
        new Uint8Array(encode({ token, recordedAt: at }, cdeEncodeOptions)),
      );
      for (const listener of listeners) listener();
    },
    async list() {
      const records: GrantRecord[] = [];
      const keys = await storage.keys(KEY_PREFIX);
      const entries = await Promise.all(
        keys.map(async (key) => ({ key, value: await storage.get(key) })),
      );
      for (const { key, value } of entries) {
        if (value === undefined) continue;
        const stored: unknown = decode(value, cdeDecodeOptions);
        if (!isStoredGrant(stored)) {
          throw new Error(`stored grant at ${key} is malformed`);
        }
        const token = capabilityTokenSchema.safeParse(stored.token);
        if (!token.success) {
          throw new Error(`stored grant at ${key} is malformed`);
        }
        const claims = decodeGrantClaims(token.data);
        if (claims === undefined) {
          throw new Error(`stored grant at ${key} has unreadable claims`);
        }
        records.push({
          tokenId: bytesToHex(claims["token-id"]),
          direction: directionOfKey(key),
          token: token.data,
          claims,
          recordedAt: stored.recordedAt,
        });
      }

      return records.sort((a, b) => b.recordedAt - a.recordedAt);
    },
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
