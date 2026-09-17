import { webcrypto } from "node:crypto";
import { cdeEncodeOptions, encode } from "cbor2";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  CapabilityVerb,
  DeviceId,
  RevocationClaims,
  RevocationEntry,
  TokenClaims,
} from "../src/generated/protocol.js";
import type { RevocationCheck } from "../src/domain/tokens.js";

export const ES256 = -7;
export const EDDSA = -8;
export const HOUR_MS = 3_600_000;
export const REVOKED_SHORTLY_BEFORE_NOW_MS = 1_000; // revoked-at sits just before `now` in these tests -- the value only needs to be in the past, not any particular distance
export const P256_SIGNATURE_BYTE_LENGTH = 64; // raw ECDSA P-256 signature length
export const DEVICE_ID_BYTE_LENGTH = 32; // SHA-256 digest length
export const ROOM_MEMBER_ROOM_PATH =
  "aa".repeat(DEVICE_ID_BYTE_LENGTH) + "/general"; // a syntactically valid owner-named room-path; the tests below never verify path ownership against a real device-id, only scope-narrowing between parent and child
export const LOW_BYTE_MASK = 0xff; // XOR operand keeping the corrupted byte within one octet when tampering with a signature in tests

let issuedTokenIds = 0;
/** A fresh, distinct token-id per call -- the tests only need each token to be distinguishable from the others, not any particular byte value. */
export function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return buf([issuedTokenIds]);
}

/** Normalises to a fresh, non-shared, whole-buffer Uint8Array -- cbor2's encode() and array-literal Uint8Array construction both produce the broader Uint8Array<ArrayBufferLike>, which the generated schemas' concrete Uint8Array<ArrayBuffer> fields correctly reject. */
export function buf(
  bytes: Uint8Array | ArrayLike<number>,
): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

export function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

export async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

/** A fresh Ed25519 IdentityPort -- the personal-device signing key a threshold-share-envelope is minted under (never the group's own key), distinct from generateEs256Identity's P-256 identity. */
export async function generateEd25519Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, EDDSA);
}

export function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

export const neverRevoked: RevocationCheck = {
  entriesFor: async () => Promise.resolve([]),
};

/** A RevocationCheck over an explicit set of already-verified revocation claims, returning every entry recorded for the given token-id, unfiltered -- matching the port's own contract that the actual obligation check (issuer-match, or a verified delegated authorization) is the caller's (verifyTokenChain's) job, not the store's. */
export function revocationView(
  entries: readonly RevocationClaims[],
): RevocationCheck {
  return {
    entriesFor: async (tokenId) =>
      Promise.resolve(
        entries.filter((entry) => equalBytes(entry["token-id"], tokenId)),
      ),
  };
}

/** Builds and signs one revocation-entry (a cose-sign1 over revocation-claims) as `identity`, mirroring signToken's construction. */
export async function signRevocationEntry(
  identity: IdentityPort,
  tokenId: Uint8Array<ArrayBuffer>,
  authorization?: Uint8Array<ArrayBuffer>,
): Promise<RevocationEntry> {
  const claims: RevocationClaims = {
    "token-id": tokenId,
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    "revoked-at": 0,
    ...(authorization !== undefined ? { authorization } : {}),
  };
  const payload = encodeBuf(claims);
  const protectedHeader = encodeBuf({});
  const toBeSigned = encodeBuf([
    "Signature1",
    protectedHeader,
    new Uint8Array(0),
    payload,
  ]);
  const signature = await identity.sign(toBeSigned);
  return [protectedHeader, {}, payload, signature];
}

export interface TokenSeed {
  tokenId: Uint8Array<ArrayBuffer>;
  bearer: DeviceId;
  scope: CapabilityScope;
  expires: number;
  parent?: Uint8Array<ArrayBuffer>;
  delegationsRemaining?: number;
  validUntil?: number;
  /** Defaults to "exec:pty", the value every pre-existing test relies on implicitly. Overridable so a test can mint a manage:revoke-capability authorization token without needing a second signing helper. */
  capability?: CapabilityVerb;
}

/** Builds and signs one capability token as `identity` -- explicit field-by-field construction rather than spreading a partial claims object, since TokenClaims' own `.catchall(z.unknown())` index signature (the spec's forward-compatible extension-field pattern) makes a spread-based `Omit<TokenClaims, ...>` lose the specific field types. Deliberately does none of mintCapabilityToken's own narrowing checks -- tests exercising verifyCapabilityToken's own enforcement need to construct chains mint would refuse to produce. */
export async function signToken(
  identity: IdentityPort,
  seed: TokenSeed,
): Promise<CapabilityToken> {
  const claims: TokenClaims = {
    "token-id": seed.tokenId,
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    bearer: seed.bearer,
    capability: seed.capability ?? "exec:pty",
    scope: seed.scope,
    expires: seed.expires,
    ...(seed.parent !== undefined ? { parent: seed.parent } : {}),
    ...(seed.delegationsRemaining !== undefined
      ? { "delegations-remaining": seed.delegationsRemaining }
      : {}),
    ...(seed.validUntil !== undefined
      ? { "valid-until": seed.validUntil }
      : {}),
  };

  const payload = encodeBuf(claims);
  const protectedHeader = encodeBuf({});
  const toBeSigned = encodeBuf([
    "Signature1",
    protectedHeader,
    new Uint8Array(0),
    payload,
  ]);
  const signature = await identity.sign(toBeSigned);
  return [protectedHeader, {}, payload, signature];
}
