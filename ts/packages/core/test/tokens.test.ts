import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { cdeEncodeOptions, encode } from "cbor2";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import { createSystemClock } from "../src/adapters/system-clock.js";
import {
  verifyCapabilityToken,
  type RevocationCheck,
} from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  TokenClaims,
} from "../src/generated/protocol.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const P256_SIGNATURE_BYTE_LENGTH = 64; // raw ECDSA P-256 signature length

let issuedTokenIds = 0;
/** A fresh, distinct token-id per call -- the tests only need each token to be distinguishable from the others, not any particular byte value. */
function nextTokenId(): Uint8Array<ArrayBuffer> {
  issuedTokenIds += 1;
  return buf([issuedTokenIds]);
}

/** Normalises to a fresh, non-shared, whole-buffer Uint8Array -- cbor2's encode() and array-literal Uint8Array construction both produce the broader Uint8Array<ArrayBufferLike>, which the generated schemas' concrete Uint8Array<ArrayBuffer> fields correctly reject. */
function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

async function generateEs256Identity(): Promise<IdentityPort> {
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

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

const neverRevoked: RevocationCheck = {
  isRevoked: async () => Promise.resolve(false),
};

interface TokenSeed {
  tokenId: Uint8Array<ArrayBuffer>;
  bearer: DeviceId;
  scope: CapabilityScope;
  expires: number;
  parent?: Uint8Array<ArrayBuffer>;
}

/** Builds and signs one capability token as `identity` -- explicit field-by-field construction rather than spreading a partial claims object, since TokenClaims' own `.catchall(z.unknown())` index signature (the spec's forward-compatible extension-field pattern) makes a spread-based Omit<TokenClaims, ...> lose the specific field types. */
async function signToken(
  identity: IdentityPort,
  seed: TokenSeed,
): Promise<CapabilityToken> {
  const claims: TokenClaims = {
    "token-id": seed.tokenId,
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    bearer: seed.bearer,
    capability: "exec:pty",
    scope: seed.scope,
    expires: seed.expires,
    ...(seed.parent !== undefined ? { parent: seed.parent } : {}),
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

describe("verifyCapabilityToken", () => {
  let issuer: IdentityPort;
  let bearerIdentity: IdentityPort;
  let bearerDeviceId: DeviceId;

  beforeAll(async () => {
    issuer = await generateEs256Identity();
    // Kept in full, not just its device-id: a delegated token's own self-certifying issuer-key must belong to whichever identity actually signs it, so the tests that have this device delegate a narrower token need to sign as it, not merely reference its device-id.
    bearerIdentity = await generateEs256Identity();
    bearerDeviceId = bearerIdentity.deviceId;
  });

  const now = 1_893_456_000_000;
  const workScope: CapabilityScope = { kind: "folder", path: "/work" };

  it("accepts a validly signed, unexpired, unrevoked token", async () => {
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + HOUR_MS,
    });

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects a token whose signature doesn't match its claimed issuer", async () => {
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + HOUR_MS,
    });
    const tampered: CapabilityToken = [
      token[0],
      token[1],
      token[2],
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ];

    const verdict = await verifyCapabilityToken(tampered, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token", async () => {
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now - 1,
    });

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects a revoked token", async () => {
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + HOUR_MS,
    });
    const revoked: RevocationCheck = {
      isRevoked: async () => Promise.resolve(true),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "revoked" });
  });

  it("rejects a token presented by a device other than its bearer", async () => {
    const token = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + HOUR_MS,
    });
    const someoneElse = (await generateEs256Identity()).deviceId;

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
      expectedBearer: someoneElse,
    });

    expect(verdict).toEqual({ ok: false, reason: "bearer_mismatch" });
  });

  it("accepts a delegated token whose expiry narrows the parent's", async () => {
    const rootExpiry = now + 2 * HOUR_MS;
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: rootExpiry,
    });

    const delegate = await generateEs256Identity();
    // Signed by bearerIdentity, not issuer: the root's bearer is the one delegating, so it must be the actual signer of the child token -- a self-certifying token's issuer-key has to belong to whoever actually signed it (checked independently by "wrong_issuer"), and delegation requires the child's issuer to equal the parent's bearer.
    const claims: TokenClaims = {
      "token-id": nextTokenId(),
      issuer: bearerDeviceId,
      "issuer-key": bearerIdentity.identityKey,
      bearer: delegate.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      expires: now + HOUR_MS,
      parent: encodeBuf(root),
    };
    const payload = encodeBuf(claims);
    const protectedHeader = encodeBuf({});
    const toBeSigned = encodeBuf([
      "Signature1",
      protectedHeader,
      new Uint8Array(0),
      payload,
    ]);
    const signature = await bearerIdentity.sign(toBeSigned);
    const delegated: CapabilityToken = [
      protectedHeader,
      {},
      payload,
      signature,
    ];

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects a delegated token whose expiry exceeds its parent's", async () => {
    const rootExpiry = now + HOUR_MS;
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: rootExpiry,
    });

    const delegate = await generateEs256Identity();
    const claims: TokenClaims = {
      "token-id": nextTokenId(),
      issuer: bearerDeviceId,
      "issuer-key": bearerIdentity.identityKey,
      bearer: delegate.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      expires: rootExpiry + HOUR_MS, // wider than the parent -- must be rejected
      parent: encodeBuf(root),
    };
    const payload = encodeBuf(claims);
    const protectedHeader = encodeBuf({});
    const toBeSigned = encodeBuf([
      "Signature1",
      protectedHeader,
      new Uint8Array(0),
      payload,
    ]);
    const signature = await bearerIdentity.sign(toBeSigned);
    const widened: CapabilityToken = [protectedHeader, {}, payload, signature];

    const verdict = await verifyCapabilityToken(widened, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "delegation_exceeds_parent" });
  });
});

describe("createMemoryStorage / createSystemClock", () => {
  it("round-trips a value through memory storage", async () => {
    const storage = createMemoryStorage();
    const sampleBytes = new TextEncoder().encode("sample");
    await storage.set("k", sampleBytes);
    expect(await storage.get("k")).toEqual(sampleBytes);
    await storage.delete("k");
    expect(await storage.get("k")).toBeUndefined();
  });

  it("lists keys by prefix", async () => {
    const storage = createMemoryStorage();
    await storage.set("a/1", new Uint8Array());
    await storage.set("a/2", new Uint8Array());
    await storage.set("b/1", new Uint8Array());
    expect(new Set(await storage.keys("a/"))).toEqual(new Set(["a/1", "a/2"]));
  });

  it("reports the current time", () => {
    const clock = createSystemClock();
    const before = Date.now();
    const reported = clock.now();
    const after = Date.now();
    expect(reported).toBeGreaterThanOrEqual(before);
    expect(reported).toBeLessThanOrEqual(after);
  });
});
