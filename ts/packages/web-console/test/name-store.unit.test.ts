import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createNameStore } from "../src/name-store.js";

describe("name store", () => {
  it("holds a petname per device and returns them all", async () => {
    const store = createNameStore(createMemoryStorage());
    await store.setPetname("aa", "Ada");
    await store.setPetname("bb", "Grace");

    expect(await store.petnames()).toEqual(
      new Map([
        ["aa", "Ada"],
        ["bb", "Grace"],
      ]),
    );
  });

  it("removes a petname when it is set blank", async () => {
    const store = createNameStore(createMemoryStorage());
    await store.setPetname("aa", "Ada");
    await store.setPetname("aa", "  ");

    expect(await store.petnames()).toEqual(new Map());
  });

  it("keeps petnames across store instances over the same storage", async () => {
    const storage = createMemoryStorage();
    await createNameStore(storage).setPetname("aa", "Ada");

    expect(await createNameStore(storage).petnames()).toEqual(
      new Map([["aa", "Ada"]]),
    );
  });

  it("keeps the console's own display name apart from petnames", async () => {
    const store = createNameStore(createMemoryStorage());
    expect(await store.selfName()).toBeUndefined();

    await store.setSelfName("  Me  ");

    expect(await store.selfName()).toBe("Me");
    expect(await store.petnames()).toEqual(new Map());

    await store.setSelfName("");
    expect(await store.selfName()).toBeUndefined();
  });
});
