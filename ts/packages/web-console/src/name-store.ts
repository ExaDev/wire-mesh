// Persistence for the names this console keeps about itself and its peers, over the portable KeyValueStorage port. Petnames (device-id to this viewer's own label) and this console's own display name are local to the storage they are written to and are never sent anywhere by this module.

import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import { cleanName } from "./peer-names.js";

const PETNAME_PREFIX = "petname/";
const SELF_NAME_KEY = "self-name";

export interface NameStore {
  /** Every petname held, keyed by device-id hex. */
  petnames: () => Promise<Map<string, string>>;
  /** Sets the petname for a device, or removes it when `name` is blank. */
  setPetname: (deviceHex: string, name: string) => Promise<void>;
  /** This console's own display name, or undefined when none is set. */
  selfName: () => Promise<string | undefined>;
  /** Sets this console's own display name, or clears it when `name` is blank. */
  setSelfName: (name: string) => Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createNameStore(storage: Readonly<KeyValueStorage>): NameStore {
  async function write(key: string, name: string): Promise<void> {
    const cleaned = cleanName(name);
    if (cleaned === undefined) {
      await storage.delete(key);

      return;
    }
    await storage.set(key, new Uint8Array(encoder.encode(cleaned)));
  }

  return {
    async petnames() {
      const names = new Map<string, string>();
      const keys = await storage.keys(PETNAME_PREFIX);
      const entries = await Promise.all(
        keys.map(async (key) => ({ key, value: await storage.get(key) })),
      );
      for (const { key, value } of entries) {
        if (value !== undefined) {
          names.set(key.slice(PETNAME_PREFIX.length), decoder.decode(value));
        }
      }

      return names;
    },
    async setPetname(deviceHex, name) {
      await write(PETNAME_PREFIX + deviceHex, name);
    },
    async selfName() {
      const value = await storage.get(SELF_NAME_KEY);

      return value === undefined ? undefined : decoder.decode(value);
    },
    async setSelfName(name) {
      await write(SELF_NAME_KEY, name);
    },
  };
}
