// A Durable Object's transactional storage as core's KeyValueStorage port, so the mailbox the relay hub serves (hub-mailbox.ts) writes to storage that survives the instance being evicted. Values are the raw bytes core hands over: the runtime stores a Uint8Array as it is, and hands back a copy.

import type { KeyValueStorage } from "wire-mesh-core/ports/storage";

/** The part of a Durable Object's storage this adapter uses. The runtime's own `DurableObjectStorage` satisfies it structurally, so nothing is cast at the call site. */
export interface DurableObjectKeyValues {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: Uint8Array<ArrayBuffer>) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  list: (
    options: Readonly<{ prefix: string }>,
  ) => Promise<Map<string, unknown>>;
}

function isBytes(value: unknown): value is Uint8Array<ArrayBuffer> {
  return value instanceof Uint8Array;
}

export function durableObjectStorage(
  storage: Readonly<DurableObjectKeyValues>,
): KeyValueStorage {
  return {
    async get(key) {
      const value = await storage.get(key);
      if (value === undefined) return undefined;
      if (!isBytes(value)) {
        throw new Error(`storage value at ${key} is not bytes`);
      }
      return value;
    },
    async set(key, value) {
      await storage.put(key, value);
    },
    async delete(key) {
      await storage.delete(key);
    },
    async keys(prefix) {
      return [...(await storage.list({ prefix })).keys()];
    },
  };
}
