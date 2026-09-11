import { Et as TokenClaims, ct as RevocationEntry, i as CapabilityToken, st as RevocationClaims, v as DeviceId } from "../protocol-B26-5VX7.cjs";
import { IdentityPort } from "../ports/identity.cjs";
import { Clock } from "../ports/clock.cjs";
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
  /** The device-id at the root of this token's delegation chain: its own issuer when it carries no parent, otherwise the root of its parent's chain. Lets a caller (e.g. core/room's obligation that a chain must terminate at the path's own owner, or the verifier itself for a DM) check the chain's root with one equality comparison instead of re-walking the parent chain a second time. */
  rootIssuer: DeviceId;
  /** How many delegation hops this token is from its own root -- 0 for a root grant. Costs nothing extra once rootIssuer is being tracked, and makes the delegation bound observable for diagnostics. */
  depth: number;
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
export type MintRefusalReason = "already_expired" | "parent_malformed" | "parent_bearer_mismatch" | "expires_exceeds_parent" | "scope_does_not_narrow" | "capability_mismatch" | "delegation_exceeds_parent";
export type MintVerdict = {
  ok: true;
  token: CapabilityToken;
} | {
  ok: false;
  reason: MintRefusalReason;
};
export interface MintCapabilityTokenOptions {
  /** The issuer -- signs the token, and supplies the self-certifying issuer/issuer-key claims. */
  identity: IdentityPort;
  clock: Clock;
  tokenId: Uint8Array<ArrayBuffer>;
  bearer: DeviceId;
  capability: TokenClaims["capability"];
  scope: TokenClaims["scope"];
  expires: number;
  notBefore?: number;
  delegationsRemaining?: number;
  /** The issuer's own token, when this is a delegation rather than a root grant. Its claims are checked against every narrowing rule below -- mint refuses rather than producing a token verifyCapabilityToken would reject anyway. */
  parent?: CapabilityToken;
}
/**
 * Mints one capability token: builds token-claims from the given fields, signs it as a COSE_Sign1 under `identity`'s own key, with a protected header matching what the frozen conformance vectors actually encode (`{1: alg, 4: issuer device-id}`, not the empty header a token merely needs to verify against itself).
 *
 * When `parent` is given, every one of `tokens.cddl`'s own narrowing obligations is enforced here, at issuance, rather than left for the far end to discover minutes or hours later as a bare `delegation_exceeds_parent` from `verifyCapabilityToken` -- the same "fail loudly, fail early" reasoning that governs every other boundary in this codebase. An issuer minting an invalid delegation is a bug in the caller; this function refuses rather than producing a token indistinguishable from a valid one until someone else verifies it.
 */
export declare function mintCapabilityToken(options: MintCapabilityTokenOptions): Promise<MintVerdict>;
export interface MintRevocationEntryOptions {
  /** The token's own issuer -- only a token's own issuer may revoke it (management.cddl), so this must be the same identity that minted the token being revoked. */
  identity: IdentityPort;
  tokenId: Uint8Array<ArrayBuffer>;
  revokedAt: number;
}
/** Mints one revocation-entry (management.cddl): a COSE_Sign1 over revocation-claims, signed the same way mintCapabilityToken signs a token. No narrowing chain to check -- a revocation entry has no parent and cannot fail to be issuable the way a delegated token can, so this returns the entry directly rather than a verdict. */
export declare function mintRevocationEntry(options: MintRevocationEntryOptions): Promise<RevocationEntry>;
//#endregion