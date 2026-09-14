import { beforeAll, describe, expect, it } from "vitest";
import { verifyCapabilityToken } from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  RevocationClaims,
  TokenClaims,
} from "../src/generated/protocol.js";
import {
  HOUR_MS,
  LOW_BYTE_MASK,
  P256_SIGNATURE_BYTE_LENGTH,
  REVOKED_SHORTLY_BEFORE_NOW_MS,
  buf,
  encodeBuf,
  fixedClock,
  generateEs256Identity,
  neverRevoked,
  nextTokenId,
  revocationView,
  signToken,
} from "./tokens-fixtures.js";

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
