import { describe, expect, it } from "vitest";
import { createMemoryNonceStore } from "../src/adapters/memory-nonce-store.js";
import { NonceStoreError } from "../src/ports/nonce-store.js";

const SESSION_A = 1n;
const SESSION_B = 2n;
const UNKNOWN_SESSION = 999n;
const THIRD_NONCE_BYTE = 3;
const NONCE_BYTES = [1, 2, THIRD_NONCE_BYTE];
const SOLE_NONCE_BYTE = 9;
const OTHER_NONCE_BYTES = [SOLE_NONCE_BYTE];

describe("memory-nonce-store: createMemoryNonceStore", () => {
  it("take is one-shot -- a second call for the same session rejects", async () => {
    const store = createMemoryNonceStore();
    await store.persist(SESSION_A, new Uint8Array(NONCE_BYTES));
    await expect(store.take(SESSION_A)).resolves.toEqual(
      new Uint8Array(NONCE_BYTES),
    );
    await expect(store.take(SESSION_A)).rejects.toThrow(NonceStoreError);
  });

  it("persist refuses to overwrite an existing session", async () => {
    const store = createMemoryNonceStore();
    await store.persist(SESSION_A, new Uint8Array(NONCE_BYTES));
    await expect(
      store.persist(SESSION_A, new Uint8Array(OTHER_NONCE_BYTES)),
    ).rejects.toThrow(NonceStoreError);
  });

  it("discard makes a later take fail closed", async () => {
    const store = createMemoryNonceStore();
    await store.persist(SESSION_A, new Uint8Array(OTHER_NONCE_BYTES));
    await store.discard(SESSION_A);
    await expect(store.take(SESSION_A)).rejects.toThrow(NonceStoreError);
  });

  it("discard of an unknown session is a no-op, never rejects", async () => {
    const store = createMemoryNonceStore();
    await expect(store.discard(UNKNOWN_SESSION)).resolves.toBeUndefined();
  });

  it("keeps sessions independent by session-id", async () => {
    const store = createMemoryNonceStore();
    const bytesA = new Uint8Array([1]);
    const bytesB = new Uint8Array([2]);
    await store.persist(SESSION_A, bytesA);
    await store.persist(SESSION_B, bytesB);
    await expect(store.take(SESSION_B)).resolves.toEqual(bytesB);
    await expect(store.take(SESSION_A)).resolves.toEqual(bytesA);
  });
});
