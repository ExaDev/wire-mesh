//#region src/ports/clock.d.ts
export interface Clock {
  /** Current time as Unix milliseconds, matching every uint timestamp field in the protocol (token-claims.expires, revocation-entry.revoked-at, handshake params, etc.). */
  now: () => number;
}
//#endregion