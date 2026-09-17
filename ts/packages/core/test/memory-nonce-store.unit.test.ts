import { describe, expect, it } from "vitest";
import { createMemoryNonceStore } from "../src/adapters/memory-nonce-store.js";
import { NonceStoreError } from "../src/ports/nonce-store.js";

describe("memory-nonce-store: createMemoryNonceStore", () => {
  it("take is one-shot -- a second call for the same session rejects", async () => {
    const store = createMemoryNonceStore();
    await store.persist(1n, new Uint8Array([1, 2, 3]));
    await expect(store.take(1n)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(store.take(1n)).rejects.toThrow(NonceStoreError);
  });

  it("persist refuses to overwrite an existing session", async () => {
    const store = createMemoryNonceStore();
    await store.persist(1n, new Uint8Array([1]));
    await expect(store.persist(1n, new Uint8Array([2]))).rejects.toThrow(
      NonceStoreError,
    );
  });

  it("discard makes a later take fail closed", async () => {
    const store = createMemoryNonceStore();
    await store.persist(1n, new Uint8Array([9]));
    await store.discard(1n);
    await expect(store.take(1n)).rejects.toThrow(NonceStoreError);
  });

  it("discard of an unknown session is a no-op, never rejects", async () => {
    const store = createMemoryNonceStore();
    await expect(store.discard(999n)).resolves.toBeUndefined();
  });

  it("keeps sessions independent by session-id", async () => {
    const store = createMemoryNonceStore();
    await store.persist(1n, new Uint8Array([1]));
    await store.persist(2n, new Uint8Array([2]));
    await expect(store.take(2n)).resolves.toEqual(new Uint8Array([2]));
    await expect(store.take(1n)).resolves.toEqual(new Uint8Array([1]));
  });
});
