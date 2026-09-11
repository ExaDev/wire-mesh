import { Ct as TokenClaims, ct as RevocationEntry, i as CapabilityToken, st as RevocationClaims, v as DeviceId } from "../protocol-D8yeaquP.mjs";
import { IdentityPort } from "../ports/identity.mjs";
import { Clock } from "../ports/clock.mjs";
//#region src/domain/tokens.d.ts
/**
 * The revocation view a verifier consults. Contract per management.cddl: an entry counts against a token only when BOTH its token-id and its issuer match the token's own -- only a token's own issuer may revoke it, so a third party's entry for someone else's token-id must be ignored. Implementations ingest gossiped revocation-announce frames via verifyRevocationEntry (which enforces each entry's own signature and self-certification) and key the resulting claims by token-id + issuer.
 */
export interface RevocationCheck {
  isRevoked: (tokenId: Uint8Array, issuer: DeviceId) => Promise<boolean>;
}
export type TokenVerdictReason = "malformed" | "bad_signature" | "wrong_issuer" | "bearer_mismatch" | "expired" | "not_yet_valid" | "revoked" | "delegation_exceeds_parent" | "parent_invalid";
export type TokenVerdict = {
  ok: true;
  claims: TokenClaims;
} | {
  ok: false;
  reason: TokenVerdictReason;
};
export interface VerifyCapabilityTokenOptions {
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /** When given, the token must bear this device -- the caller presenting a token to authorise itself, not someone else. */
  expectedBearer?: DeviceId;
}
/**
 * Verifies one capability token per tokens.cddl's own documented rules: the token is a well-formed COSE_Sign1 whose signature actually verifies against its own embedded issuer-key, that issuer-key is self-certifying (sha256(issuer-key.public-key) equals the claimed issuer device-id -- no shared secret needed to check this), the token is currently valid (not expired, not before not-before, not revoked by its own issuer), and -- recursively -- any parent delegation narrows rather than widens across all three axes of authority: the parent's bearer must be this token's issuer (the delegation chain is unbroken), this token's expiry must not exceed its parent's, and this token's scope must narrow its parent's (same kind; equal-or-descendant path when the parent carries one) with an identical capability verb (the capability-verb grammar has no sub-verb relation, so a different verb is a different authority, not a narrower one). Undecodable payload bytes return "malformed" and undecodable parent bytes return "parent_invalid" -- hostile input produces a verdict, never a throw.
 */
export declare function verifyCapabilityToken(token: CapabilityToken, options: VerifyCapabilityTokenOptions): Promise<TokenVerdict>;
export type RevocationEntryVerdictReason = "malformed" | "bad_signature" | "wrong_issuer";
export type RevocationEntryVerdict = {
  ok: true;
  claims: RevocationClaims;
} | {
  ok: false;
  reason: RevocationEntryVerdictReason;
};
export interface VerifyRevocationEntryOptions {
  /** Crypto primitives only -- any IdentityPort instance can verify any entry, since everything needed to check one travels inside the entry itself. */
  identity: IdentityPort;
}
/**
 * Verifies one gossiped revocation-entry (management.cddl): a well-formed COSE_Sign1 whose signature verifies against its own embedded issuer-key, where that issuer-key is self-certifying (sha256(issuer-key.public-key) equals the claimed issuer device-id). A verifier that ingests a revocation-announce frame runs each entry through this before recording it in its revocation view; entries failing here are dropped, not stored. The issuer-match against a specific token's own issuer (only a token's own issuer may revoke it) is deliberately NOT checked here -- it happens at lookup time in RevocationCheck, against whichever token is being verified.
 */
export declare function verifyRevocationEntry(entry: RevocationEntry, options: VerifyRevocationEntryOptions): Promise<RevocationEntryVerdict>;
//#endregion