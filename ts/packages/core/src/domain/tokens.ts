import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import type { PredicateNode } from "trilean";
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
import {
  conditionsListSchema,
  evaluateConditions,
  evaluateNarrowing,
  type ConditionsContext,
  type NarrowingCandidate,
  type NarrowingSystem,
  type TokenDelegateHandler,
} from "./token-predicates.js";
import { bytesEqual, scopeNarrows } from "./token-scope.js";

/**
 * The revocation view a verifier consults. Returns every recorded, already-signature-verified revocation-claims for tokenId, across every issuer that has ever submitted one -- unfiltered by the store itself. The actual verifier obligation (an entry counts against a token when its own issuer matches the token's own issuer, OR its optional `authorization` grants delegated revoke authority -- management.cddl) is checked by the caller (verifyTokenChain), not here, since that check needs the target token's own scope plus identity/clock to verify a nested authorization token, none of which a store constructed ahead of time has access to. Implementations ingest gossiped revocation-announce frames via verifyRevocationEntry (which enforces each entry's own signature and self-certification) and key the resulting claims by token-id alone -- a token-id can legitimately carry multiple recorded entries from different issuers.
 */
export interface RevocationCheck {
  entriesFor: (tokenId: Uint8Array) => Promise<readonly RevocationClaims[]>;
}

export type TokenVerdictReason =
  | "malformed"
  | "bad_signature"
  | "wrong_issuer"
  | "bearer_mismatch"
  | "expired"
  | "not_yet_valid"
  | "content_expired"
  | "revoked"
  | "delegation_exceeds_parent"
  | "parent_invalid"
  /** claims.conditions is present but its bstr fails CBOR decode, or decodes to something that is not a JSON array of valid trilean PredicateNodes -- fail-closed per CONVENTIONS.md's verifier-obligations glossary, the same treatment "malformed" already gives an undecodable payload. */
  | "conditions_invalid"
  /** claims.conditions decoded and validated, but at least one entry did not evaluate to a definite `true` (indeterminate or false) -- the issuer's own additional restriction was not met. */
  | "conditions_not_satisfied";

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
  /** Registers domain-specific delegate systems a presented token's own `conditions` entries may name, beyond the five mandatory narrowing ops (which are never reachable from `conditions` -- see evaluateConditions's own doc comment). None are registered by wire-mesh-core itself; a domain (a message TTL, #84's future revoke-authorization check) supplies its own here. A `conditions` entry naming a system absent from this map is indeterminate, and therefore fails the whole token -- fail-closed, not a silent no-op. */
  extraPredicateResolvers?: Readonly<
    Record<string, TokenDelegateHandler<ConditionsContext>>
  >;
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
    ...(options.extraPredicateResolvers !== undefined
      ? { extraPredicateResolvers: options.extraPredicateResolvers }
      : {}),
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

/**
 * Does one recorded revocation-claims entry actually revoke targetClaims, per management.cddl's own additive obligation? Valid when EITHER the entry's own issuer equals the target token's own issuer (the original, unconditional rule -- only a token's own issuer may revoke it), OR the entry carries an `authorization` that independently verifies as an ordinary capability-token -- with `expectedBearer` set to THIS entry's own `issuer`, proving the authorization was actually granted to the party submitting this revocation, not merely referenced from someone else's -- whose own `capability` is `"revoke"` and whose own `scope` narrows targetClaims' scope. An authorization that fails any part of this (wrong capability, scope doesn't narrow, fails ordinary verification -- expired, revoked, bad signature, bearer mismatch) makes the entry no more valid than if `authorization` were absent; it never falls back to weakening the issuer-match rule.
 */
async function revocationEntryGrantsRevoke(
  entry: RevocationClaims,
  targetClaims: Readonly<TokenClaims>,
  options: Omit<VerifyCapabilityTokenOptions, "expectedBearer">,
): Promise<boolean> {
  if (bytesEqual(entry.issuer, targetClaims.issuer)) {
    return true;
  }
  if (entry.authorization === undefined) {
    return false;
  }
  let decodedAuthorization: unknown;
  try {
    decodedAuthorization = decode(entry.authorization, cdeDecodeOptions);
  } catch {
    return false;
  }
  const authorizationResult = capabilityTokenSchema.safeParse(
    decodedAuthorization,
  );
  if (!authorizationResult.success) {
    return false;
  }
  const authorizationVerdict = await verifyCapabilityToken(
    authorizationResult.data,
    { ...options, expectedBearer: entry.issuer },
  );
  return (
    authorizationVerdict.ok &&
    authorizationVerdict.claims.capability === "revoke" &&
    scopeNarrows(authorizationVerdict.claims.scope, targetClaims.scope)
  );
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
  const validUntil = claims["valid-until"];
  if (validUntil !== undefined && validUntil <= now) {
    return { ok: false, reason: "content_expired" };
  }

  const revocationEntries = await options.revocation.entriesFor(
    claims["token-id"],
  );
  for (const entry of revocationEntries) {
    if (await revocationEntryGrantsRevoke(entry, claims, options)) {
      return { ok: false, reason: "revoked" };
    }
  }

  // claims.conditions is strictly additive to the narrowing checks below -- it is decoded and evaluated here, uniformly for both root and delegated tokens, entirely independent of whether claims.parent is present. See tokens.cddl's own comment on the field and CONVENTIONS.md's verifier-obligations glossary entry for the fail-closed contract this enforces.
  if (claims.conditions !== undefined) {
    let decodedConditions: unknown;
    try {
      decodedConditions = decode(claims.conditions, cdeDecodeOptions);
    } catch {
      return { ok: false, reason: "conditions_invalid" };
    }
    const conditionsResult = conditionsListSchema.safeParse(decodedConditions);
    if (!conditionsResult.success) {
      return { ok: false, reason: "conditions_invalid" };
    }
    const conditionsVerdict = await evaluateConditions(
      conditionsResult.data,
      claims,
      options.clock,
      options.extraPredicateResolvers,
    );
    if (!conditionsVerdict.ok) {
      return { ok: false, reason: "conditions_not_satisfied" };
    }
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
    const candidate: NarrowingCandidate = {
      capability: claims.capability,
      scope: claims.scope,
      expires: claims.expires,
      ...(claims["delegations-remaining"] !== undefined
        ? { delegationsRemaining: claims["delegations-remaining"] }
        : {}),
    };
    const failedSystem = await evaluateNarrowing(
      parentVerdict.claims,
      claims.issuer,
      candidate,
    );
    if (failedSystem !== undefined) {
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

/** Maps evaluateNarrowing's own NarrowingSystem (the first predicate op that did not hold) to mintCapabilityToken's five distinct refusal reasons -- verifyTokenChain collapses every narrowing failure to a single "delegation_exceeds_parent", but mint has always reported which specific rule was violated, since a caller building the candidate itself benefits from knowing exactly what to fix. */
const NARROWING_SYSTEM_TO_MINT_REFUSAL: Record<
  NarrowingSystem,
  MintRefusalReason
> = {
  "bearer-is": "parent_bearer_mismatch",
  "expires-at": "expires_exceeds_parent",
  "scope-narrows": "scope_does_not_narrow",
  "capability-is": "capability_mismatch",
  "depth-remaining": "delegation_exceeds_parent",
};

/** The narrowing arithmetic tokens.cddl's own delegation obligations require (bearer match, expiry within the parent's, scope narrows, same capability, delegations-remaining strictly less than the parent's) -- shared between mintCapabilityToken (which additionally builds and signs the resulting token) and canGrant (a pure query with no minting side effect at all), so the two can never silently drift into two different ideas of what "narrows" means. Delegates the actual check to evaluateNarrowing (token-predicates.ts), the same generic evaluator verifyTokenChain's own delegation-chain walk uses, so mint and verify share one implementation of each of the five checks rather than two hardcoded copies. Returns the specific refusal reason, or undefined when every rule is satisfied. */
async function checkNarrowing(
  parentClaims: Readonly<TokenClaims>,
  granterDeviceId: DeviceId,
  candidate: Readonly<NarrowingCandidate>,
): Promise<MintRefusalReason | undefined> {
  const failedSystem = await evaluateNarrowing(
    parentClaims,
    granterDeviceId,
    candidate,
  );
  return failedSystem === undefined
    ? undefined
    : NARROWING_SYSTEM_TO_MINT_REFUSAL[failedSystem];
}

/**
 * A pure query: could deviceId, presenting heldToken as its own delegation authority, successfully mint a delegation matching candidate right now -- without attempting (and potentially failing) a real mint just to find out. Reuses mintCapabilityToken's own narrowing arithmetic via checkNarrowing, so the two can never silently drift into different ideas of what "narrows" means.
 *
 * Deliberately narrower than a full mint attempt in one respect: this checks only the narrowing rules tokens.cddl's own delegation obligations require (bearer match, expiry, scope, capability, delegations-remaining), the same scope mintCapabilityToken itself checks a *parent* against -- it does not verify heldToken's own signature or revocation status, exactly as mintCapabilityToken never re-verifies its own parent's signature either. A caller that also needs heldToken's cryptographic validity confirmed calls verifyCapabilityToken separately.
 *
 * Async as of the predicate-list evaluator (issue #85): checkNarrowing now routes through trilean's own evaluatePredicate, which is asynchronous throughout -- there is no synchronous path through a real evaluator call, so this is a genuine, deliberate breaking change to what was previously a synchronous pure function. No existing consumer of wire-mesh-core calls canGrant (confirmed against agent-comms, the only other repo depending on this package), so there is nothing to migrate.
 */
export async function canGrant(
  heldToken: CapabilityToken,
  deviceId: DeviceId,
  candidate: Readonly<NarrowingCandidate>,
  now: number,
): Promise<boolean> {
  if (candidate.expires <= now) {
    return false;
  }
  const heldClaims = decodeTokenClaims(heldToken);
  if (heldClaims === undefined) {
    return false;
  }
  return (await checkNarrowing(heldClaims, deviceId, candidate)) === undefined;
}

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
  /** How many further delegation hops the *resulting* token itself permits below it -- unrelated to, and never a bound on, whether `identity` may mint further tokens of its own at the root level for other bearers. Those are two different facts: a token minted with `delegationsRemaining: 0` genuinely cannot itself be re-delegated (correct -- e.g. a room owner's own self-signed root grant, which should never be handed onward), but that same `0` says nothing about the issuer's own separate, ordinary authority to mint additional independent root-level grants (naming no `parent` at all) for other bearers. Root-level minting for a second bearer is never blocked by any existing token's own `delegationsRemaining`, because it uses no `parent` in the first place -- there is no narrowing check to run. Confirmed live in agent-comms' own room-membership implementation (`ExaDev/agent-comms` PR #72): each member's own join/invite grant is minted as its own independent, parent-less, root-level token precisely because the room owner's `delegationsRemaining: 0` self-grant cannot parent anything -- correct by this same reasoning, not a workaround. */
  delegationsRemaining?: number;
  /** The issuer's own token, when this is a delegation rather than a root grant. Its claims are checked against every narrowing rule below -- mint refuses rather than producing a token verifyCapabilityToken would reject anyway. Omit entirely for a root-level grant (including a second, independent root-level grant for a different bearer under the same capability/scope this issuer already grants elsewhere) -- there is no bound on how many such root grants an issuer may mint, since none of them narrows any other. */
  parent?: CapabilityToken;
  /** Additional, issuer-chosen restrictions beyond the five mandatory narrowing checks (issue #85) -- CBOR-encoded into claims.conditions verbatim, evaluated by every verifier via evaluateConditions. Strictly additive: has no bearing on narrowing, which mint enforces separately above regardless of what's given here. Not re-validated against trilean's own schema before encoding -- the TS type already guarantees a well-formed PredicateNode[] at this call site, unlike the bytes a verifier decodes from an untrusted wire token, which always are. */
  conditions?: PredicateNode[];
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
    const refusal = await checkNarrowing(
      parentClaims,
      options.identity.deviceId,
      {
        capability: options.capability,
        scope: options.scope,
        expires: options.expires,
        ...(options.delegationsRemaining !== undefined
          ? { delegationsRemaining: options.delegationsRemaining }
          : {}),
      },
    );
    if (refusal !== undefined) {
      return { ok: false, reason: refusal };
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
    ...(options.conditions !== undefined
      ? { conditions: encodeBuf(options.conditions) }
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
