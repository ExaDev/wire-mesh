import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import { createSystemClock } from "../src/adapters/system-clock.js";
import { verifyRevocationEntry } from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  RevocationClaims,
  RevocationEntry,
} from "../src/generated/protocol.js";
import {
  LOW_BYTE_MASK,
  P256_SIGNATURE_BYTE_LENGTH,
  buf,
  encodeBuf,
  equalBytes,
  generateEs256Identity,
  nextTokenId,
  signRevocationEntry,
} from "./tokens-fixtures.js";

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

  it("returns malformed for an entry whose payload bytes are not CBOR, instead of throwing", async () => {
    // This function's whole purpose is ingesting hostile gossiped entries: a lone top-level CBOR BREAK byte must produce the malformed verdict, never a throw
    const garbage = buf(Buffer.from("ff", "hex"));
    const hostile: RevocationEntry = [
      encodeBuf({}),
      {},
      garbage,
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ];

    const verdict = await verifyRevocationEntry(hostile, { identity: issuer });

    expect(verdict).toEqual({ ok: false, reason: "malformed" });
  });

  it("returns malformed for an entry whose payload map keys are not canonically ordered, instead of throwing", async () => {
    const nonCanonical = buf(Buffer.from("a2627a7a01616102", "hex"));
    const hostile: RevocationEntry = [
      encodeBuf({}),
      {},
      nonCanonical,
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ];

    const verdict = await verifyRevocationEntry(hostile, { identity: issuer });

    expect(verdict).toEqual({ ok: false, reason: "malformed" });
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
