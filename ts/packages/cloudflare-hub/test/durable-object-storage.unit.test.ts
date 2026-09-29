import { describe, expect, it } from "vitest";
import {
  durableObjectStorage,
  type DurableObjectKeyValues,
} from "../src/adapters/durable-object-storage.js";

/** The parts of a Durable Object's storage the adapter uses, backed by a Map. Values are cloned on the way in and out, as the runtime's structured-clone storage does. */
function fakeStorage(): DurableObjectKeyValues & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>();
  return {
    raw,
    get: async (key) => Promise.resolve(structuredClone(raw.get(key))),
    put: async (key, value) => {
      raw.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: async (key) => Promise.resolve(raw.delete(key)),
    list: async ({ prefix }) =>
      Promise.resolve(
        new Map([...raw].filter(([key]) => key.startsWith(prefix))),
      ),
  };
}

describe("durableObjectStorage", () => {
  it("returns the bytes it was given, and undefined for a key it was not", async () => {
    const storage = durableObjectStorage(fakeStorage());
    const bytes = new Uint8Array([1, 2]);

    await storage.set("a", bytes);

    expect(await storage.get("a")).toEqual(bytes);
    expect(await storage.get("missing")).toBeUndefined();
  });

  it("forgets a deleted key", async () => {
    const storage = durableObjectStorage(fakeStorage());
    await storage.set("a", new Uint8Array([1]));

    await storage.delete("a");

    expect(await storage.get("a")).toBeUndefined();
  });

  it("lists only the keys under a prefix", async () => {
    const storage = durableObjectStorage(fakeStorage());
    await storage.set("data/a/1", new Uint8Array([1]));
    await storage.set("data/a/2", new Uint8Array([1]));
    await storage.set("other/b", new Uint8Array([1]));

    expect((await storage.keys("data/")).sort()).toEqual([
      "data/a/1",
      "data/a/2",
    ]);
  });

  it("refuses a stored value that is not bytes, rather than passing it on as bytes", async () => {
    const backing = fakeStorage();
    backing.raw.set("a", "text");
    const storage = durableObjectStorage(backing);

    await expect(storage.get("a")).rejects.toThrow("not bytes");
  });
});
