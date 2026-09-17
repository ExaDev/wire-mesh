import { beforeAll, describe, expect, it } from "vitest";
import {
  canGrant,
  mintCapabilityToken,
  mintRevocationEntry,
  verifyCapabilityToken,
  verifyRevocationEntry,
} from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  CapabilityScope,
  CapabilityToken,
} from "../src/generated/protocol.js";
import {
  HOUR_MS,
  P256_SIGNATURE_BYTE_LENGTH,
  ROOM_MEMBER_ROOM_PATH,
  fixedClock,
  generateEs256Identity,
  neverRevoked,
  nextTokenId,
} from "./tokens-fixtures.js";

describe("mintCapabilityToken", () => {
  let issuer: IdentityPort;
  let bearerIdentity: IdentityPort;

  beforeAll(async () => {
    issuer = await generateEs256Identity();
    bearerIdentity = await generateEs256Identity();
  });

  const now = 1_893_456_000_000;
  const workScope: CapabilityScope = { kind: "folder", path: "/work" };

  it("mints a root token that verifyCapabilityToken accepts", async () => {
    const verdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;

    const verified = await verifyCapabilityToken(verdict.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims.bearer).toEqual(bearerIdentity.deviceId);
    expect(verified.claims.capability).toBe("exec:pty");
  });

  it("mints a delegated token, signed as the parent's own bearer, that verifyCapabilityToken accepts", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 1,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    const delegate = await generateEs256Identity();
    const delegatedVerdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: delegate.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 0,
      parent: rootVerdict.token,
    });
    expect(delegatedVerdict.ok).toBe(true);
    if (!delegatedVerdict.ok) return;

    const verified = await verifyCapabilityToken(delegatedVerdict.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verified.ok).toBe(true);
  });

  it("refuses to mint an already-expired token", async () => {
    const verdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now - 1,
    });
    expect(verdict).toEqual({ ok: false, reason: "already_expired" });
  });

  it("refuses to mint against a malformed parent", async () => {
    const malformedParent: CapabilityToken = [
      new Uint8Array(),
      {},
      null,
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ];
    const verdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
      parent: malformedParent,
    });
    expect(verdict).toEqual({ ok: false, reason: "parent_malformed" });
  });

  it("refuses to mint a delegation the issuer's own device does not hold the parent's bearer for", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    // Minting as `issuer` itself, not `bearerIdentity` -- the parent's bearer is bearerIdentity, not issuer, so issuer cannot delegate from it.
    const verdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
      parent: rootVerdict.token,
    });
    expect(verdict).toEqual({ ok: false, reason: "parent_bearer_mismatch" });
  });

  it("refuses to mint a delegation whose expiry exceeds its parent's", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    const verdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + 2 * HOUR_MS,
      parent: rootVerdict.token,
    });
    expect(verdict).toEqual({ ok: false, reason: "expires_exceeds_parent" });
  });

  it("refuses to mint a delegation whose scope does not narrow its parent's", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    const verdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/elsewhere" },
      expires: now + HOUR_MS,
      parent: rootVerdict.token,
    });
    expect(verdict).toEqual({ ok: false, reason: "scope_does_not_narrow" });
  });

  it("refuses to mint a delegation with a different capability than its parent's", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    const verdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      capability: "exec:proc",
      scope: workScope,
      expires: now + HOUR_MS,
      parent: rootVerdict.token,
    });
    expect(verdict).toEqual({ ok: false, reason: "capability_mismatch" });
  });

  it("refuses to mint a delegation whose delegations-remaining is not strictly less than its parent's", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 1,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    // Equal to the parent's own delegations-remaining (1), not strictly less.
    const verdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 1,
      parent: rootVerdict.token,
    });
    expect(verdict).toEqual({ ok: false, reason: "delegation_exceeds_parent" });
  });

  it("refuses to mint an unbounded delegation under a parent that itself bounds re-delegation", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 1,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    // No delegationsRemaining at all -- unbounded, which is wider than the parent's bounded 1.
    const verdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      parent: rootVerdict.token,
    });
    expect(verdict).toEqual({ ok: false, reason: "delegation_exceeds_parent" });
  });

  it("mints a second, independent root-level grant for a different bearer even though an earlier root grant this issuer minted has delegationsRemaining: 0", async () => {
    const firstRoot = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 0,
    });
    expect(firstRoot.ok).toBe(true);

    // No `parent` at all -- a second, independent root-level grant for a different bearer, never checked against firstRoot's own (unrelated) delegationsRemaining.
    const secondBearer = await generateEs256Identity();
    const secondRoot = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: secondBearer.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 0,
    });
    expect(secondRoot.ok).toBe(true);
    if (!secondRoot.ok) return;

    const verified = await verifyCapabilityToken(secondRoot.token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });
    expect(verified.ok).toBe(true);
  });
});

describe("canGrant", () => {
  let issuer: IdentityPort;
  let bearerIdentity: IdentityPort;

  beforeAll(async () => {
    issuer = await generateEs256Identity();
    bearerIdentity = await generateEs256Identity();
  });

  const now = 1_893_456_000_000;
  const workScope: CapabilityScope = { kind: "folder", path: "/work" };

  it("agrees with a real mint's own verdict: true when narrowing succeeds", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 1,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    const candidate = {
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH } as CapabilityScope,
      expires: now + HOUR_MS,
      delegationsRemaining: 0,
    };
    expect(
      await canGrant(
        rootVerdict.token,
        bearerIdentity.deviceId,
        candidate,
        now,
      ),
    ).toBe(true);

    const delegatedVerdict = await mintCapabilityToken({
      identity: bearerIdentity,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: (await generateEs256Identity()).deviceId,
      ...candidate,
      parent: rootVerdict.token,
    });
    expect(delegatedVerdict.ok).toBe(true);
  });

  it("agrees with a real mint's own verdict: false when the querying device does not hold the token's bearer", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    expect(
      await canGrant(
        rootVerdict.token,
        issuer.deviceId,
        {
          capability: "exec:pty",
          scope: workScope,
          expires: now + HOUR_MS,
        },
        now,
      ),
    ).toBe(false);
  });

  it("agrees with a real mint's own verdict: false when the candidate's expiry exceeds the held token's", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    expect(
      await canGrant(
        rootVerdict.token,
        bearerIdentity.deviceId,
        {
          capability: "exec:pty",
          scope: workScope,
          expires: now + HOUR_MS + 1,
        },
        now,
      ),
    ).toBe(false);
  });

  it("agrees with a real mint's own verdict: false when the candidate's scope does not narrow the held token's", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    expect(
      await canGrant(
        rootVerdict.token,
        bearerIdentity.deviceId,
        {
          capability: "exec:pty",
          scope: { kind: "folder", path: "/elsewhere" },
          expires: now + HOUR_MS,
        },
        now,
      ),
    ).toBe(false);
  });

  it("agrees with a real mint's own verdict: false when the candidate's capability differs", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    expect(
      await canGrant(
        rootVerdict.token,
        bearerIdentity.deviceId,
        {
          capability: "room:member",
          scope: workScope,
          expires: now + HOUR_MS,
        },
        now,
      ),
    ).toBe(false);
  });

  it("agrees with a real mint's own verdict: false when the candidate's delegations-remaining would not be strictly less than the held token's", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
      expires: now + HOUR_MS,
      delegationsRemaining: 1,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    expect(
      await canGrant(
        rootVerdict.token,
        bearerIdentity.deviceId,
        {
          capability: "room:member",
          scope: { kind: "room", path: ROOM_MEMBER_ROOM_PATH },
          expires: now + HOUR_MS,
          delegationsRemaining: 1,
        },
        now,
      ),
    ).toBe(false);
  });

  it("returns false for a candidate that is already expired, without needing to consult the held token at all", async () => {
    const rootVerdict = await mintCapabilityToken({
      identity: issuer,
      clock: fixedClock(now),
      tokenId: nextTokenId(),
      bearer: bearerIdentity.deviceId,
      capability: "exec:pty",
      scope: workScope,
      expires: now + HOUR_MS,
    });
    expect(rootVerdict.ok).toBe(true);
    if (!rootVerdict.ok) return;

    expect(
      await canGrant(
        rootVerdict.token,
        bearerIdentity.deviceId,
        {
          capability: "exec:pty",
          scope: workScope,
          expires: now - 1,
        },
        now,
      ),
    ).toBe(false);
  });

  it("returns false for a malformed held token", async () => {
    const malformedToken: CapabilityToken = [
      new Uint8Array(),
      {},
      null,
      new Uint8Array(P256_SIGNATURE_BYTE_LENGTH),
    ];
    expect(
      await canGrant(
        malformedToken,
        bearerIdentity.deviceId,
        {
          capability: "exec:pty",
          scope: workScope,
          expires: now + HOUR_MS,
        },
        now,
      ),
    ).toBe(false);
  });
});

describe("mintRevocationEntry", () => {
  it("mints a revocation entry that verifyRevocationEntry accepts", async () => {
    const issuer = await generateEs256Identity();
    const tokenId = nextTokenId();

    const entry = await mintRevocationEntry({
      identity: issuer,
      tokenId,
      revokedAt: 1_893_456_000_000,
    });

    const verdict = await verifyRevocationEntry(entry, { identity: issuer });
    expect(verdict).toEqual({
      ok: true,
      claims: {
        "token-id": tokenId,
        issuer: issuer.deviceId,
        "issuer-key": issuer.identityKey,
        "revoked-at": 1_893_456_000_000,
      },
    });
  });
});
