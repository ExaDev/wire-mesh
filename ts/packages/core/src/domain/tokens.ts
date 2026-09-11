import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  capabilityTokenSchema,
  revocationClaimsSchema,
  tokenClaimsSchema,
  type CapabilityToken,
  type DeviceId,
  type RevocationClaims,
  type RevocationEntry,
  type TokenClaims,
} from "../generated/protocol.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";

/**
 * The revocation view a verifier consults. Contract per management.cddl: an entry counts against a token only when BOTH its token-id and its issuer match the token's own -- only a token's own issuer may revoke it, so a third party's entry for someone else's token-id must be ignored. Implementations ingest gossiped revocation-announce frames via verifyRevocationEntry (which enforces each entry's own signature and self-certification) and key the resulting claims by token-id + issuer.
 */
export interface RevocationCheck {
  isRevoked: (tokenId: Uint8Array, issuer: DeviceId) => Promise<boolean>;
}

export type TokenVerdictReason =
  | "malformed"
  | "bad_signature"
  | "wrong_issuer"
  | "bearer_mismatch"
  | "expired"
  | "not_yet_valid"
  | "revoked"
  | "delegation_exceeds_parent"
  | "parent_invalid";

export type TokenVerdict =
  | {
      ok: true;
      claims: TokenClaims;
      /** The device-id at the root of this token's delegation chain: its own issuer when it carries no parent, otherwise the root of its parent's chain. Lets a caller (e.g. core/room's obligation that a chain must terminate at the path's own owner, or the verifier itself for a DM) check the chain's root with one equality comparison instead of re-walking the parent chain a second time. */
      rootIssuer: DeviceId;
      /** How many delegation hops this token is from its own root -- 0 for a root grant. Costs nothing extra once rootIssuer is being tracked, and makes the delegation bound observable for diagnostics. */
      depth: number;
    }
  | { ok: false; reason: TokenVerdictReason };

export interface VerifyCapabilityTokenOptions {
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /** When given, the token must bear this device -- the caller presenting a token to authorise itself, not someone else. */
  expectedBearer?: DeviceId;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True when the path contains a "." or ".." segment. Purely lexical prefix comparison would let "/work/../org" pass under "/work" -- a path that normalises outside the parent -- so any relative segment fails the narrowing comparison wholesale: fail-closed rather than reimplementing path normalisation, consistent with how empty, case-different, and non-boundary-prefixed paths already behave. */
function hasRelativeSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/** True when childPath is parentPath or a descendant of it, compared on "/"-segment boundaries: "/work/sub" narrows "/work", but "/workbook" does NOT narrow "/work" despite the string prefix, because "book" continues the same segment. Paths containing "." or ".." segments never narrow anything (see hasRelativeSegment). */
function pathNarrows(childPath: string, parentPath: string): boolean {
  if (hasRelativeSegment(childPath) || hasRelativeSegment(parentPath)) {
    return false;
  }
  if (childPath === parentPath) return true;
  if (!childPath.startsWith(parentPath)) return false;
  if (parentPath.endsWith("/")) return true;
  return childPath.charAt(parentPath.length) === "/";
}

/**
 * True when childScope narrows parentScope per tokens.cddl ("each hop can only narrow authority, never widen it"): the kind must be identical (a different kind is a different kind of authority, not a narrower one), and a parent with a path requires the child to carry an equal-or-descendant path -- an absent child path means the kind's whole-scope root, which is wider than any path-narrowed parent. A parent with no path (whole-scope root) lets any child path under the same kind through.
 */
function scopeNarrows(
  parent: TokenClaims["scope"],
  child: TokenClaims["scope"],
): boolean {
  if (parent.kind !== child.kind) return false;
  if (parent.path === undefined) return true;
  if (child.path === undefined) return false;
  return pathNarrows(child.path, parent.path);
}

/** RFC 9052 §4.4 Sig_structure for a COSE_Sign1 with no external AAD: ["Signature1", protected, external_aad, payload]. */
function sig1ToBeSigned(
  protectedHeader: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  return encode(
    ["Signature1", protectedHeader, new Uint8Array(0), payload],
    cdeEncodeOptions,
  );
}

/** Normalises cbor2's encode() (and any other Uint8Array<ArrayBufferLike>-typed construction) to a fresh, non-shared, whole-buffer Uint8Array<ArrayBuffer> -- what the generated schemas' concrete-typed fields require. */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

/** The COSE protected header every capability-token/revocation-entry envelope in this codebase actually signs over: label 1 (alg) and label 4 (kid, the issuer's own device-id) -- matching the frozen conformance vectors, not the empty header a token merely needs to verify against itself. */
function protectedHeaderFor(identity: IdentityPort): Uint8Array<ArrayBuffer> {
  return encodeBuf({ 1: identity.identityKey.alg, 4: identity.deviceId });
}

/** Decodes and validates a parent token's own claims from its raw CapabilityToken tuple -- the same decode `verifyTokenChain` performs on `claims.parent`, extracted here so mint can check narrowing against a parent's real claims without duplicating the CBOR/schema plumbing. Returns undefined for anything that doesn't parse; the caller turns that into its own refusal reason since "malformed" means something different at mint time than at verify time. */
function decodeTokenClaims(token: CapabilityToken): TokenClaims | undefined {
  const [, , payload] = token;
  if (payload === null) return undefined;
  let decoded: unknown;
  try {
    decoded = decode(payload, cdeDecodeOptions);
  } catch {
    return undefined;
  }
  const result = tokenClaimsSchema.safeParse(decoded);
  return result.success ? result.data : undefined;
}

/**
 * Verifies one capability token per tokens.cddl's own documented rules: the token is a well-formed COSE_Sign1 whose signature actually verifies against its own embedded issuer-key, that issuer-key is self-certifying (sha256(issuer-key.public-key) equals the claimed issuer device-id -- no shared secret needed to check this), the token is currently valid (not expired, not before not-before, not revoked by its own issuer), and -- recursively -- any parent delegation narrows rather than widens across all three axes of authority: the parent's bearer must be this token's issuer (the delegation chain is unbroken), this token's expiry must not exceed its parent's, and this token's scope must narrow its parent's (same kind; equal-or-descendant path when the parent carries one) with an identical capability verb (the capability-verb grammar has no sub-verb relation, so a different verb is a different authority, not a narrower one). Undecodable payload bytes return "malformed" and undecodable parent bytes return "parent_invalid" -- hostile input produces a verdict, never a throw.
 */
export async function verifyCapabilityToken(
  token: CapabilityToken,
  options: VerifyCapabilityTokenOptions,
): Promise<TokenVerdict> {
  // expectedBearer applies to the leaf only: in any valid chain the parent's bearer is the child's issuer (structurally enforced below), never the leaf's presenter, so consulting it during the recursive walk would wrongly fail every ancestor.
  const verdict = await verifyTokenChain(token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
  });
  if (!verdict.ok) {
    return verdict;
  }
  if (
    options.expectedBearer !== undefined &&
    !bytesEqual(verdict.claims.bearer, options.expectedBearer)
  ) {
    return { ok: false, reason: "bearer_mismatch" };
  }
  return verdict;
}

async function verifyTokenChain(
  token: CapabilityToken,
  options: Omit<VerifyCapabilityTokenOptions, "expectedBearer">,
): Promise<TokenVerdict> {
  const [protectedHeader, , payload, signature] = token;
  if (payload === null) {
    return { ok: false, reason: "malformed" };
  }

  let decodedClaims: unknown;
  try {
    decodedClaims = decode(payload, cdeDecodeOptions);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const claimsResult = tokenClaimsSchema.safeParse(decodedClaims);
  if (!claimsResult.success) {
    return { ok: false, reason: "malformed" };
  }
  const claims = claimsResult.data;

  const signatureOk = await options.identity.verify(
    claims["issuer-key"],
    sig1ToBeSigned(protectedHeader, payload),
    signature,
  );
  if (!signatureOk) {
    return { ok: false, reason: "bad_signature" };
  }

  const derivedIssuerId = await options.identity.deriveDeviceId(
    claims["issuer-key"]["public-key"],
  );
  if (!bytesEqual(derivedIssuerId, claims.issuer)) {
    return { ok: false, reason: "wrong_issuer" };
  }

  const now = options.clock.now();
  if (claims.expires <= now) {
    return { ok: false, reason: "expired" };
  }
  if (claims["not-before"] !== undefined && claims["not-before"] > now) {
    return { ok: false, reason: "not_yet_valid" };
  }

  if (await options.revocation.isRevoked(claims["token-id"], claims.issuer)) {
    return { ok: false, reason: "revoked" };
  }

  if (claims.parent !== undefined) {
    let decodedParent: unknown;
    try {
      decodedParent = decode(claims.parent, cdeDecodeOptions);
    } catch {
      return { ok: false, reason: "parent_invalid" };
    }
    const parentResult = capabilityTokenSchema.safeParse(decodedParent);
    if (!parentResult.success) {
      return { ok: false, reason: "parent_invalid" };
    }
    const parentVerdict = await verifyTokenChain(parentResult.data, options);
    if (!parentVerdict.ok) {
      return { ok: false, reason: "parent_invalid" };
    }
    if (!bytesEqual(parentVerdict.claims.bearer, claims.issuer)) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
    if (claims.expires > parentVerdict.claims.expires) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
    if (!scopeNarrows(parentVerdict.claims.scope, claims.scope)) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
    if (parentVerdict.claims.capability !== claims.capability) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
    // Narrowing applies to delegations-remaining too: a parent that bounds further re-delegation must not be re-delegatable into an unbounded (or merely equal) child -- that would let any bearer of a bounded grant mint an unboundedly-redelegatable one, defeating the entire point of the claim. A parent carrying none is itself unbounded, so any child value is admissible.
    const parentRemaining = parentVerdict.claims["delegations-remaining"];
    if (
      parentRemaining !== undefined &&
      (claims["delegations-remaining"] === undefined ||
        claims["delegations-remaining"] >= parentRemaining)
    ) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
    return {
      ok: true,
      claims,
      rootIssuer: parentVerdict.rootIssuer,
      depth: parentVerdict.depth + 1,
    };
  }

  return { ok: true, claims, rootIssuer: claims.issuer, depth: 0 };
}

export type RevocationEntryVerdictReason =
  "malformed" | "bad_signature" | "wrong_issuer";

export type RevocationEntryVerdict =
  | { ok: true; claims: RevocationClaims }
  | { ok: false; reason: RevocationEntryVerdictReason };

export interface VerifyRevocationEntryOptions {
  /** Crypto primitives only -- any IdentityPort instance can verify any entry, since everything needed to check one travels inside the entry itself. */
  identity: IdentityPort;
}

/**
 * Verifies one gossiped revocation-entry (management.cddl): a well-formed COSE_Sign1 whose signature verifies against its own embedded issuer-key, where that issuer-key is self-certifying (sha256(issuer-key.public-key) equals the claimed issuer device-id). A verifier that ingests a revocation-announce frame runs each entry through this before recording it in its revocation view; entries failing here are dropped, not stored. The issuer-match against a specific token's own issuer (only a token's own issuer may revoke it) is deliberately NOT checked here -- it happens at lookup time in RevocationCheck, against whichever token is being verified.
 */
export async function verifyRevocationEntry(
  entry: RevocationEntry,
  options: VerifyRevocationEntryOptions,
): Promise<RevocationEntryVerdict> {
  const [protectedHeader, , payload, signature] = entry;
  if (payload === null) {
    return { ok: false, reason: "malformed" };
  }

  let decodedClaims: unknown;
  try {
    decodedClaims = decode(payload, cdeDecodeOptions);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const claimsResult = revocationClaimsSchema.safeParse(decodedClaims);
  if (!claimsResult.success) {
    return { ok: false, reason: "malformed" };
  }
  const claims = claimsResult.data;

  const signatureOk = await options.identity.verify(
    claims["issuer-key"],
    sig1ToBeSigned(protectedHeader, payload),
    signature,
  );
  if (!signatureOk) {
    return { ok: false, reason: "bad_signature" };
  }

  const derivedIssuerId = await options.identity.deriveDeviceId(
    claims["issuer-key"]["public-key"],
  );
  if (!bytesEqual(derivedIssuerId, claims.issuer)) {
    return { ok: false, reason: "wrong_issuer" };
  }

  return { ok: true, claims };
}

export type MintRefusalReason =
  | "already_expired"
  | "parent_malformed"
  | "parent_bearer_mismatch"
  | "expires_exceeds_parent"
  | "scope_does_not_narrow"
  | "capability_mismatch"
  | "delegation_exceeds_parent";

export type MintVerdict =
  | { ok: true; token: CapabilityToken }
  | { ok: false; reason: MintRefusalReason };

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
export async function mintCapabilityToken(
  options: MintCapabilityTokenOptions,
): Promise<MintVerdict> {
  if (options.expires <= options.clock.now()) {
    return { ok: false, reason: "already_expired" };
  }

  let parentBytes: Uint8Array<ArrayBuffer> | undefined;
  if (options.parent !== undefined) {
    const parentClaims = decodeTokenClaims(options.parent);
    if (parentClaims === undefined) {
      return { ok: false, reason: "parent_malformed" };
    }
    if (!bytesEqual(parentClaims.bearer, options.identity.deviceId)) {
      return { ok: false, reason: "parent_bearer_mismatch" };
    }
    if (options.expires > parentClaims.expires) {
      return { ok: false, reason: "expires_exceeds_parent" };
    }
    if (!scopeNarrows(parentClaims.scope, options.scope)) {
      return { ok: false, reason: "scope_does_not_narrow" };
    }
    if (parentClaims.capability !== options.capability) {
      return { ok: false, reason: "capability_mismatch" };
    }
    const parentRemaining = parentClaims["delegations-remaining"];
    if (
      parentRemaining !== undefined &&
      (options.delegationsRemaining === undefined ||
        options.delegationsRemaining >= parentRemaining)
    ) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
    parentBytes = encodeBuf(options.parent);
  }

  const claims: TokenClaims = {
    "token-id": options.tokenId,
    issuer: options.identity.deviceId,
    "issuer-key": options.identity.identityKey,
    bearer: options.bearer,
    capability: options.capability,
    scope: options.scope,
    expires: options.expires,
    ...(options.notBefore !== undefined
      ? { "not-before": options.notBefore }
      : {}),
    ...(parentBytes !== undefined ? { parent: parentBytes } : {}),
    ...(options.delegationsRemaining !== undefined
      ? { "delegations-remaining": options.delegationsRemaining }
      : {}),
  };

  const payload = encodeBuf(claims);
  const protectedHeader = protectedHeaderFor(options.identity);
  const signature = await options.identity.sign(
    sig1ToBeSigned(protectedHeader, payload),
  );
  return { ok: true, token: [protectedHeader, {}, payload, signature] };
}

export interface MintRevocationEntryOptions {
  /** The token's own issuer -- only a token's own issuer may revoke it (management.cddl), so this must be the same identity that minted the token being revoked. */
  identity: IdentityPort;
  tokenId: Uint8Array<ArrayBuffer>;
  revokedAt: number;
}

/** Mints one revocation-entry (management.cddl): a COSE_Sign1 over revocation-claims, signed the same way mintCapabilityToken signs a token. No narrowing chain to check -- a revocation entry has no parent and cannot fail to be issuable the way a delegated token can, so this returns the entry directly rather than a verdict. */
export async function mintRevocationEntry(
  options: MintRevocationEntryOptions,
): Promise<RevocationEntry> {
  const claims: RevocationClaims = {
    "token-id": options.tokenId,
    issuer: options.identity.deviceId,
    "issuer-key": options.identity.identityKey,
    "revoked-at": options.revokedAt,
  };
  const payload = encodeBuf(claims);
  const protectedHeader = protectedHeaderFor(options.identity);
  const signature = await options.identity.sign(
    sig1ToBeSigned(protectedHeader, payload),
  );
  return [protectedHeader, {}, payload, signature];
}
