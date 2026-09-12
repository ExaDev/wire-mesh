// Persisted per-room message history over the portable KeyValueStorage port, keyed by room-path (a DM's own room-path already names the peer pair uniquely, per room-path.ts's own dmRoomPath, so there is no separate peer-pair keying scheme to maintain). Kept in web-console rather than wire-mesh-core: this is a UI-level display/history concern layered on top of core/room's own wire semantics, not a wire-protocol concept itself.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import { bytesToHex } from "wire-mesh-core/domain/device-id";

export interface StoredMessage {
  direction: "sent" | "received";
  text: string;
  messageId: Uint8Array;
  sentAt: number;
}

export interface MessageStore {
  append: (roomPath: string, message: Readonly<StoredMessage>) => Promise<void>;
  /** Every message stored for this room path, ordered by sentAt then messageId (its own tiebreak for two messages sharing one sentAt value). */
  list: (roomPath: string) => Promise<StoredMessage[]>;
}

// Zero-padding sentAt to this width keeps the storage key's lexicographic string order identical to sentAt's own numeric order -- the width of the largest safe integer bounds every real Date.now() value for the lifetime of this format.
const SENT_AT_KEY_WIDTH = String(Number.MAX_SAFE_INTEGER).length;
const KEY_PREFIX = "message";

function messageKey(
  roomPath: string,
  message: Readonly<StoredMessage>,
): string {
  const sentAtSegment = String(message.sentAt).padStart(SENT_AT_KEY_WIDTH, "0");
  return `${KEY_PREFIX}/${roomPath}/${sentAtSegment}-${bytesToHex(message.messageId)}`;
}

function isDirection(value: unknown): value is StoredMessage["direction"] {
  return value === "sent" || value === "received";
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== "object" || value === null) return false;
  if (!("direction" in value) || !("text" in value)) return false;
  if (!("messageId" in value) || !("sentAt" in value)) return false;
  return (
    isDirection(value.direction) &&
    typeof value.text === "string" &&
    value.messageId instanceof Uint8Array &&
    typeof value.sentAt === "number"
  );
}

export function createMessageStore(
  storage: Readonly<KeyValueStorage>,
): MessageStore {
  return {
    async append(roomPath, message): Promise<void> {
      await storage.set(
        messageKey(roomPath, message),
        new Uint8Array(encode(message, cdeEncodeOptions)),
      );
    },
    async list(roomPath): Promise<StoredMessage[]> {
      const keys = (await storage.keys(`${KEY_PREFIX}/${roomPath}/`)).sort();
      const messages: StoredMessage[] = [];
      for (const key of keys) {
        const value = await storage.get(key);
        if (value === undefined) continue;
        const decoded: unknown = decode(value, cdeDecodeOptions);
        if (!isStoredMessage(decoded)) {
          throw new Error(`stored message at ${key} is malformed`);
        }
        messages.push(decoded);
      }
      return messages;
    },
  };
}
