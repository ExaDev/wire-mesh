// The per-room secrets a conversation needs to survive a reload: the content keys of its notice board and the membership token this device holds for it. Kept over the portable KeyValueStorage port; a token is verified again when it is read back, so a stored token that has since expired or been tampered with is dropped rather than trusted.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  capabilityTokenSchema,
  type CapabilityToken,
} from "wire-mesh-core/generated/protocol";
import type { RoomKeyStore } from "wire-mesh-core/domain/notice-board";
import { verifyCapabilityToken } from "wire-mesh-core/domain/tokens";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import { noRevocationCheck } from "./webrtc-negotiation.js";

const KEY_PREFIX = "room-key/";
const TOKEN_PREFIX = "room-token/";

/** Epoch numbers are zero-padded to this width so the storage keys of one room sort in epoch order. */
const EPOCH_KEY_WIDTH = String(Number.MAX_SAFE_INTEGER).length;

export interface RoomTokenStore {
  /** The token held for `room` if it is still valid for this device, otherwise undefined (an invalid stored token is removed). */
  get: (room: string) => Promise<CapabilityToken | undefined>;
  set: (room: string, token: Readonly<CapabilityToken>) => Promise<void>;
}

function epochKey(room: string, epoch: number): string {
  return `${KEY_PREFIX}${room}/${String(epoch).padStart(EPOCH_KEY_WIDTH, "0")}`;
}

/** Content keys persisted per room and epoch. */
export function createPersistentRoomKeyStore(
  storage: Readonly<KeyValueStorage>,
): RoomKeyStore {
  return {
    get: async (room, epoch) => storage.get(epochKey(room, epoch)),
    set: async (room, epoch, key) => {
      await storage.set(epochKey(room, epoch), new Uint8Array(key));
    },
    currentEpoch: async (room) => {
      const keys = (await storage.keys(`${KEY_PREFIX}${room}/`)).sort();
      const last = keys.at(-1);
      return last === undefined
        ? undefined
        : Number(last.slice(last.lastIndexOf("/") + 1));
    },
  };
}

/** Membership tokens persisted per room, each checked against the clock and this identity's trust when read back. */
export function createPersistentRoomTokenStore(
  storage: Readonly<KeyValueStorage>,
  identity: IdentityPort,
  clock: Readonly<Clock>,
): RoomTokenStore {
  return {
    get: async (room) => {
      const key = TOKEN_PREFIX + room;
      const stored = await storage.get(key);
      if (stored === undefined) return undefined;
      const parsed = capabilityTokenSchema.safeParse(
        decode(stored, cdeDecodeOptions),
      );
      if (parsed.success) {
        const verdict = await verifyCapabilityToken(parsed.data, {
          identity,
          clock,
          revocation: noRevocationCheck,
          expectedBearer: identity.deviceId,
        });
        if (verdict.ok) return parsed.data;
      }
      await storage.delete(key);
      return undefined;
    },
    set: async (room, token) => {
      await storage.set(
        TOKEN_PREFIX + room,
        new Uint8Array(encode(token, cdeEncodeOptions)),
      );
    },
  };
}
