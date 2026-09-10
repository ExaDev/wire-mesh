// Injected time source, never pulled from global Date.now() directly in domain logic -- lets token-expiry and revocation-timestamp checks be tested deterministically and lets a consumer substitute a synchronised network clock later without touching domain code.
export interface Clock {
  /** Current time as Unix milliseconds, matching every uint timestamp field in the protocol (token-claims.expires, revocation-entry.revoked-at, handshake params, etc.). */
  now: () => number;
}
