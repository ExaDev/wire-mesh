import { webcrypto } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { cdeEncodeOptions, encode } from "cbor2";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import { createSystemClock } from "../src/adapters/system-clock.js";
import {
  verifyCapabilityToken,
  verifyRevocationEntry,
  type RevocationCheck,
} from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  RevocationClaims,
  RevocationEntry,
  TokenClaims,
} from "../src/generated/protocol.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const REVOKED_SHORTLY_BEFORE_NOW_MS = 1_000; // revoked-at sits just before `now` in these tests -- the value only needs to be in the past, not any particular distance
const P256_SIGNATURE_BYTE_LENGTH = 64; // raw ECDSA P-256 signature length
const LOW_BYTE_MASK = 0xff; // XOR operand keeping the corrupted byte within one octet when tampering with a signature in tests

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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const neverRevoked: RevocationCheck = {
  isRevoked: async () => Promise.resolve(false),
};

/** A RevocationCheck over an explicit set of already-verified revocation claims, applying the port's own contract: an entry only counts against a token when BOTH its token-id and its issuer match the token's own -- a revocation signed by some third party must not revoke someone else's token. */
function revocationView(entries: readonly RevocationClaims[]): RevocationCheck {
  return {
    isRevoked: async (tokenId, issuer) =>
      Promise.resolve(
        entries.some(
          (entry) =>
            equalBytes(entry["token-id"], tokenId) &&
            equalBytes(entry.issuer, issuer),
        ),
      ),
  };
}

/** Builds and signs one revocation-entry (a cose-sign1 over revocation-claims) as `identity`, mirroring signToken's construction. */
async function signRevocationEntry(
  identity: IdentityPort,
  tokenId: Uint8Array<ArrayBuffer>,
): Promise<RevocationEntry> {
  const claims: RevocationClaims = {
    "token-id": tokenId,
    issuer: identity.deviceId,
    "issuer-key": identity.identityKey,
    "revoked-at": 0,
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

  it("rejects a token revoked by its own issuer's entry", async () => {
    const tokenId = nextTokenId();
    const token = await signToken(issuer, {
      tokenId,
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + HOUR_MS,
    });
    const ownIssuerEntry: RevocationClaims = {
      "token-id": tokenId,
      issuer: issuer.deviceId,
      "issuer-key": issuer.identityKey,
      "revoked-at": now - REVOKED_SHORTLY_BEFORE_NOW_MS,
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([ownIssuerEntry]),
    });

    expect(verdict).toEqual({ ok: false, reason: "revoked" });
  });

  it("accepts a token whose revocation entry was signed by a third party, not its own issuer", async () => {
    const tokenId = nextTokenId();
    const token = await signToken(issuer, {
      tokenId,
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + HOUR_MS,
    });
    // Same token-id, but revoked-at attributed to a different issuer -- only a token's own issuer may revoke it, so this entry must not count.
    const thirdParty = await generateEs256Identity();
    const thirdPartyEntry: RevocationClaims = {
      "token-id": tokenId,
      issuer: thirdParty.deviceId,
      "issuer-key": thirdParty.identityKey,
      "revoked-at": now - REVOKED_SHORTLY_BEFORE_NOW_MS,
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([thirdPartyEntry]),
    });

    expect(verdict.ok).toBe(true);
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

  it("rejects a delegated token whose ancestor is revoked, even though the leaf itself is not", async () => {
    const rootTokenId = nextTokenId();
    const root = await signToken(issuer, {
      tokenId: rootTokenId,
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + 2 * HOUR_MS,
    });

    const delegate = await generateEs256Identity();
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

    // Only the ROOT is revoked, by the root's own issuer -- the sweep must reach it through the delegation chain, not stop at the leaf.
    const rootRevokedByIssuer: RevocationClaims = {
      "token-id": rootTokenId,
      issuer: issuer.deviceId,
      "issuer-key": issuer.identityKey,
      "revoked-at": now - REVOKED_SHORTLY_BEFORE_NOW_MS,
    };

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([rootRevokedByIssuer]),
    });

    expect(verdict).toEqual({ ok: false, reason: "parent_invalid" });
  });

  // -- Delegation must narrow scope and capability, not just expiry --

  interface DelegatedSeed {
    tokenId: Uint8Array<ArrayBuffer>;
    bearer: DeviceId;
    scope: CapabilityScope;
    capability?: string;
    expires: number;
    parent: CapabilityToken;
  }

  /** Signs a child token as `identity` with an explicit parent token embedded -- the parent's own claims are recoverable by the verifier's own recursion, so they are not restated here. */
  async function signDelegated(
    identity: IdentityPort,
    seed: DelegatedSeed,
  ): Promise<CapabilityToken> {
    const claims: TokenClaims = {
      "token-id": seed.tokenId,
      issuer: identity.deviceId,
      "issuer-key": identity.identityKey,
      bearer: seed.bearer,
      capability: seed.capability ?? "exec:pty",
      scope: seed.scope,
      expires: seed.expires,
      parent: encodeBuf(seed.parent),
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

  /** A root /work-folder token plus a helper to delegate under it, signed by the root's bearer (bearerIdentity), keeping the common expiry/scope consistent across the narrowing tests. */
  async function delegateUnderWorkRoot(
    childScope: Readonly<CapabilityScope>,
    childCapability?: string,
  ): Promise<CapabilityToken> {
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + 2 * HOUR_MS,
    });
    const delegate = await generateEs256Identity();
    return signDelegated(bearerIdentity, {
      tokenId: nextTokenId(),
      bearer: delegate.deviceId,
      scope: childScope,
      ...(childCapability !== undefined ? { capability: childCapability } : {}),
      expires: now + HOUR_MS,
      parent: root,
    });
  }

  it("accepts a delegated token with the same scope as its parent", async () => {
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/work",
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(true);
  });

  it("accepts a delegated token whose path descends from the parent's", async () => {
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/work/subdir/deeper",
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects a delegated token whose scope kind differs from the parent's", async () => {
    // kind:"org" is a different kind of authority, not a narrower one -- even though its path textually starts with /work
    const delegated = await delegateUnderWorkRoot({
      kind: "org",
      path: "/work",
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({
      ok: false,
      reason: "delegation_exceeds_parent",
    });
  });

  it("rejects a delegated token whose path is a sibling, not a descendant", async () => {
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/home/private",
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({
      ok: false,
      reason: "delegation_exceeds_parent",
    });
  });

  it("rejects a delegated token whose path merely prefixes the parent's without a segment boundary", async () => {
    // "/workbook" starts with "/work" as a string but is a different path, not a descendant
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/workbook",
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({
      ok: false,
      reason: "delegation_exceeds_parent",
    });
  });

  it("rejects a delegated token with no path under a path-narrowed parent", async () => {
    // Absent path means the kind's whole-scope root, which is wider than the parent's /work
    const delegated = await delegateUnderWorkRoot({ kind: "folder" });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({
      ok: false,
      reason: "delegation_exceeds_parent",
    });
  });

  it("rejects a delegated token whose capability verb differs from the parent's", async () => {
    const delegated = await delegateUnderWorkRoot(
      { kind: "folder", path: "/work" },
      "exec:proc",
    );

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({
      ok: false,
      reason: "delegation_exceeds_parent",
    });
  });

  it("applies expectedBearer to the leaf only, never to ancestors in the chain", async () => {
    // The parent's bearer is the child's issuer (bearerIdentity), NOT the leaf's presenter: a leaf presented by its own delegate must verify even though the ancestor's bearer differs.
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + 2 * HOUR_MS,
    });
    const delegate = await generateEs256Identity();
    const delegated = await signDelegated(bearerIdentity, {
      tokenId: nextTokenId(),
      bearer: delegate.deviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + HOUR_MS,
      parent: root,
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
      expectedBearer: delegate.deviceId,
    });

    expect(verdict.ok).toBe(true);
  });

  // -- Hostile input must produce verdicts, not throws --

  it("returns malformed for a payload whose bytes are not CBOR at all", async () => {
    // A wrapped CBOR break byte: decodes to a bstr rather than token-claims, so this exercises schema rejection of a decodable-but-wrong payload
    const garbage = encodeBuf(buf(Buffer.from("ff", "hex")));
    const hostile: CapabilityToken = [
      encodeBuf({}),
      {},
      garbage,
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ];

    const verdict = await verifyCapabilityToken(hostile, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "malformed" });
  });

  it("returns malformed for a payload whose CBOR map keys are not canonically ordered", async () => {
    // CDE requires canonical (length-first) map-key ordering; cbor2's cdeDecodeOptions rejects this encoding
    const reversedKeys = buf(Buffer.from("a2627a7a01616102", "hex"));
    const hostile: CapabilityToken = [
      encodeBuf({}),
      {},
      reversedKeys,
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ];

    const verdict = await verifyCapabilityToken(hostile, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "malformed" });
  });

  it("returns parent_invalid for a parent whose bytes are not CBOR", async () => {
    // Raw, unwrapped 0xff (a top-level CBOR BREAK -- decode throws): wrapped via encode() it would become a well-formed bstr and exercise schema rejection instead of the decode-throw path this test exists for
    const garbageParent = buf(new Uint8Array([LOW_BYTE_MASK]));
    // Signed with real claims but a garbage parent field, so the token itself is otherwise well-formed and the failure is isolated to parent decoding
    const claims: TokenClaims = {
      "token-id": nextTokenId(),
      issuer: bearerDeviceId,
      "issuer-key": bearerIdentity.identityKey,
      bearer: (await generateEs256Identity()).deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work" },
      expires: now + HOUR_MS,
      parent: garbageParent,
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
    const hostile: CapabilityToken = [protectedHeader, {}, payload, signature];

    const verdict = await verifyCapabilityToken(hostile, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "parent_invalid" });
  });
});

describe("verifyRevocationEntry", () => {
  let issuer: IdentityPort;

  beforeAll(async () => {
    issuer = await generateEs256Identity();
  });

  it("accepts a validly signed, self-certifying revocation entry and returns its claims", async () => {
    const tokenId = nextTokenId();
    const entry = await signRevocationEntry(issuer, tokenId);

    const verdict = await verifyRevocationEntry(entry, { identity: issuer });

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(equalBytes(verdict.claims["token-id"], tokenId)).toBe(true);
      expect(equalBytes(verdict.claims.issuer, issuer.deviceId)).toBe(true);
    }
  });

  it("rejects an entry whose signature doesn't verify against its embedded issuer-key", async () => {
    const entry = await signRevocationEntry(issuer, nextTokenId());
    // Corrupt the signature bytes themselves: the identity port only supplies crypto primitives and checks against the entry's own embedded key, so swapping port instances proves nothing (the neighbouring test covers exactly that) -- a genuinely bad signature must be forged in the bytes.
    const [protectedHeader, unprotected, payload, signature] = entry;
    const tampered = Uint8Array.from(signature);
    const firstByte = tampered.at(0);
    if (firstByte === undefined) {
      throw new Error("test setup: signature has no bytes to corrupt");
    }
    tampered[0] = firstByte ^ LOW_BYTE_MASK;
    const forged: RevocationEntry = [
      protectedHeader,
      unprotected,
      payload,
      tampered,
    ];

    const verdict = await verifyRevocationEntry(forged, { identity: issuer });

    expect(verdict).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an entry whose issuer-key does not derive its claimed issuer device-id", async () => {
    // Sign as one identity but claim a different issuer: the signature verifies (it was really signed by the embedded key) but sha256(public-key) != the claimed issuer, so the entry is not self-certifying.
    const actualSigner = await generateEs256Identity();
    const claimedIssuer = await generateEs256Identity();
    const claims: RevocationClaims = {
      "token-id": nextTokenId(),
      issuer: claimedIssuer.deviceId,
      "issuer-key": actualSigner.identityKey,
      "revoked-at": 0,
    };
    const payload = encodeBuf(claims);
    const protectedHeader = encodeBuf({});
    const toBeSigned = encodeBuf([
      "Signature1",
      protectedHeader,
      new Uint8Array(0),
      payload,
    ]);
    const signature = await actualSigner.sign(toBeSigned);
    const forged: RevocationEntry = [protectedHeader, {}, payload, signature];

    const verdict = await verifyRevocationEntry(forged, {
      identity: actualSigner,
    });

    expect(verdict).toEqual({ ok: false, reason: "wrong_issuer" });
  });

  it("rejects an entry whose payload doesn't parse as revocation-claims", async () => {
    const payload = encodeBuf({ nonsense: true });
    const protectedHeader = encodeBuf({});
    const toBeSigned = encodeBuf([
      "Signature1",
      protectedHeader,
      new Uint8Array(0),
      payload,
    ]);
    const signature = await issuer.sign(toBeSigned);
    const malformed: RevocationEntry = [
      protectedHeader,
      {},
      payload,
      signature,
    ];

    const verdict = await verifyRevocationEntry(malformed, {
      identity: issuer,
    });

    expect(verdict).toEqual({ ok: false, reason: "malformed" });
  });

  it("ignores bearer identity: an entry is about the issuer's token, not who presented the frame", async () => {
    const entry = await signRevocationEntry(issuer, nextTokenId());
    const anyOtherViewer = await generateEs256Identity();

    const verdict = await verifyRevocationEntry(entry, {
      identity: anyOtherViewer,
    });

    // The identity port supplies only crypto primitives (verify/derive); verification succeeds regardless of which port instance performs it.
    expect(verdict.ok).toBe(true);
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
