import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createPreferencesStore } from "../src/preferences-store.js";

describe("preferences store", () => {
  it("has not dismissed the intro on a fresh device", async () => {
    expect(
      await createPreferencesStore(createMemoryStorage()).introDismissed(),
    ).toBe(false);
  });

  it("remembers a dismissal across store instances over the same storage, and forgets it when reset", async () => {
    const storage = createMemoryStorage();
    await createPreferencesStore(storage).setIntroDismissed(true);

    expect(await createPreferencesStore(storage).introDismissed()).toBe(true);

    await createPreferencesStore(storage).setIntroDismissed(false);

    expect(await createPreferencesStore(storage).introDismissed()).toBe(false);
  });
});
