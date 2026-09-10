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
  { ok: true; claims: TokenClaims } | { ok: false; reason: TokenVerdictReason };

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

/**
 * Verifies one capability token per tokens.cddl's own documented rules: the token is a well-formed COSE_Sign1 whose signature actually verifies against its own embedded issuer-key, that issuer-key is self-certifying (sha256(issuer-key.public-key) equals the claimed issuer device-id -- no shared secret needed to check this), the token is currently valid (not expired, not before not-before, not revoked), and -- recursively -- any parent delegation narrows rather than widens: the parent's bearer must be this token's issuer (the delegation chain is unbroken), and this token's expiry must not exceed its parent's.
 */
export async function verifyCapabilityToken(
  token: CapabilityToken,
  options: VerifyCapabilityTokenOptions,
): Promise<TokenVerdict> {
  const [protectedHeader, , payload, signature] = token;
  if (payload === null) {
    return { ok: false, reason: "malformed" };
  }

  const decodedClaims: unknown = decode(payload, cdeDecodeOptions);
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
    const decodedParent: unknown = decode(claims.parent, cdeDecodeOptions);
    const parentResult = capabilityTokenSchema.safeParse(decodedParent);
    if (!parentResult.success) {
      return { ok: false, reason: "parent_invalid" };
    }
    const parentVerdict = await verifyCapabilityToken(
      parentResult.data,
      options,
    );
    if (!parentVerdict.ok) {
      return { ok: false, reason: "parent_invalid" };
    }
    if (!bytesEqual(parentVerdict.claims.bearer, claims.issuer)) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
    if (claims.expires > parentVerdict.claims.expires) {
      return { ok: false, reason: "delegation_exceeds_parent" };
    }
  }

  if (
    options.expectedBearer !== undefined &&
    !bytesEqual(claims.bearer, options.expectedBearer)
  ) {
    return { ok: false, reason: "bearer_mismatch" };
  }

  return { ok: true, claims };
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

  const decodedClaims: unknown = decode(payload, cdeDecodeOptions);
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
