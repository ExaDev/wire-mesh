/**
 * Durable per-session FROST signing-nonce persistence -- a storage-boundary port, not a concrete backend, mirroring `wire_mesh_threshold::nonce_store::NonceStore` on the Rust side exactly (same three operations, same one-shot `take` contract). Nonce reuse across two released signature shares is catastrophic: it discloses the participant's long-term key share outright, and T such disclosures reconstruct the group secret. `spec/threshold.cddl`'s own verifier obligations require a participant to durably persist its round-1 nonce pair BEFORE the round-1 response leaves the device, and to mark it used atomically BEFORE the round-2 response leaves the device -- this trait is the contract that obligation is checked against; concrete storage (IndexedDB, a file, `KeyValueStorage`-backed) lives in an adapter, never here.
 */
export interface NonceStore {
  /** Durably persists `nonces` for `sessionId`, keyed so that at most one nonce pair ever exists per session. MUST complete before the caller's own round-1 response is allowed to leave the device -- an obligation this port cannot enforce structurally, only its caller can. Rejects if `sessionId` already has a persisted nonce pair. */
  persist: (sessionId: bigint, nonces: Uint8Array) => Promise<void>;
  /** Atomically retrieves and removes the nonce pair for `sessionId`. A second call for the same `sessionId` MUST reject -- this is what makes "release a second share for one nonce pair" structurally unrepresentable rather than merely discouraged. */
  take: (sessionId: bigint) => Promise<Uint8Array<ArrayBuffer>>;
  /** Discards an abandoned session's nonce without releasing a share -- the `deadline` expiry path and the `threshold.abort` path both call this, never `take`, since neither actually produces a signature. A no-op (never rejects) for an unknown or already-removed session-id. */
  discard: (sessionId: bigint) => Promise<void>;
}

/** Thrown by a `NonceStore` implementation's `persist` (session-id already has a nonce on record) or `take` (no persisted, unused nonce pair for this session-id -- never persisted, already expired, or a share was already released once). Callers MUST treat every `take` rejection identically regardless of which of those three caused it: refuse to sign, never re-derive or fabricate a substitute nonce. */
export class NonceStoreError extends Error {
  constructor(
    message: string,
    readonly sessionId: bigint,
  ) {
    super(message);
    this.name = "NonceStoreError";
  }
}
