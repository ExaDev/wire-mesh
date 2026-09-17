import { NonceStoreError, type NonceStore } from "../ports/nonce-store.js";

/** An in-process NonceStore for tests and single-process development only -- a Map guards a single take-then-remove critical section (JS's own single-threaded execution already gives it the atomicity `wire_mesh_threshold::nonce_store::InMemoryNonceStore`'s Mutex provides on the Rust side), but not durability: a process crash loses everything, so a real deployment MUST supply a persistent adapter (e.g. IndexedDB-backed) behind the same contract instead. */
export function createMemoryNonceStore(): NonceStore {
  const nonces = new Map<bigint, Uint8Array>();

  return {
    persist: async (sessionId, value) => {
      if (nonces.has(sessionId)) {
        throw new NonceStoreError(
          `session-id ${sessionId.toString()} already has a persisted nonce pair`,
          sessionId,
        );
      }
      nonces.set(sessionId, value);
      return Promise.resolve();
    },
    take: async (sessionId) => {
      const value = nonces.get(sessionId);
      if (value === undefined) {
        throw new NonceStoreError(
          `no persisted, unused nonce pair for session-id ${sessionId.toString()}`,
          sessionId,
        );
      }
      nonces.delete(sessionId);
      return Promise.resolve(Uint8Array.from(value));
    },
    discard: async (sessionId) => {
      nonces.delete(sessionId);
      return Promise.resolve();
    },
  };
}
