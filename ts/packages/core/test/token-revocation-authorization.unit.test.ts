import { beforeAll, describe, expect, it } from "vitest";
import { verifyCapabilityToken } from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  RevocationClaims,
} from "../src/generated/protocol.js";
import {
  HOUR_MS,
  buf,
  encodeBuf,
  fixedClock,
  generateEs256Identity,
  nextTokenId,
  revocationView,
  signToken,
} from "./tokens-fixtures.js";

describe("verifyCapabilityToken -- revocation via a delegated manage:revoke authorization (wire-mesh#84)", () => {
  let issuer: IdentityPort;
  let bearerIdentity: IdentityPort;
  let bearerDeviceId: DeviceId;
  let securityTeamMember: IdentityPort;

  beforeAll(async () => {
    issuer = await generateEs256Identity();
    bearerIdentity = await generateEs256Identity();
    bearerDeviceId = bearerIdentity.deviceId;
    securityTeamMember = await generateEs256Identity();
  });

  const now = 1_893_456_000_000;
  const workScope: CapabilityScope = { kind: "folder", path: "/work" };

  /** Mints a target token (issued by issuer, held by bearer, "exec:pty" over workScope) unaffected by any revocation entries the caller supplies, purely to keep every test in this file signing the same shape. */
  async function mintTargetToken(
    tokenId: Uint8Array<ArrayBuffer>,
  ): Promise<CapabilityToken> {
    return signToken(issuer, {
      tokenId,
      bearer: bearerDeviceId,
      scope: workScope,
      expires: now + HOUR_MS,
    });
  }

  /** Mints a root-level manage:revoke authorization token, held by securityTeamMember, over authScope -- issued by `issuer` (the same identity that issued the target tokens in this file), matching the realistic case where a token's own issuer delegates revoke authority over its own grants to someone outside that token's issuing chain. */
  async function mintRevokeAuthorization(options: {
    authScope: CapabilityScope;
    expires?: number;
    capability?: string;
  }): Promise<CapabilityToken> {
    return signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: securityTeamMember.deviceId,
      scope: options.authScope,
      expires: options.expires ?? now + HOUR_MS,
      // signToken's own TokenSeed.capability accepts any string at the test-fixture layer (it bypasses mintCapabilityToken's own grammar/narrowing enforcement by design -- see tokens-fixtures.ts's own doc comment), so the "wrong capability" negative test below can mint an otherwise-valid but wrongly-labelled authorization without a second helper.
      capability: options.capability ?? "manage:revoke",
    });
  }

  it("revokes a token via a valid manage:revoke authorization held by a party outside the token's own issuing chain", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const authorization = await mintRevokeAuthorization({
      authScope: workScope,
    });
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(authorization),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict).toEqual({ ok: false, reason: "revoked" });
  });

  it("revokes via an authorization scoped BROADER than the target token -- narrowing runs from the authorization's scope toward the target's, so a wider authorization still covers it", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const authorization = await mintRevokeAuthorization({
      authScope: { kind: "folder" }, // whole-kind root, wider than /work
    });
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(authorization),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict).toEqual({ ok: false, reason: "revoked" });
  });

  it("does NOT revoke when the authorization's own capability is not manage:revoke", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const wrongCapabilityAuthorization = await mintRevokeAuthorization({
      authScope: workScope,
      capability: "exec:pty",
    });
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(wrongCapabilityAuthorization),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict.ok).toBe(true);
  });

  it("does NOT revoke when the authorization's own scope does not narrow into the target token's scope", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const narrowerUnrelatedScopeAuthorization = await mintRevokeAuthorization({
      authScope: { kind: "folder", path: "/other" },
    });
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(narrowerUnrelatedScopeAuthorization),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict.ok).toBe(true);
  });

  it("does NOT revoke when the authorization's bearer does not match this revocation-entry's own issuer -- citing an authorization held by someone else", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const someoneElseEntirely = await generateEs256Identity();
    // Authorization is genuinely valid, but held by securityTeamMember -- someoneElseEntirely is submitting the revocation and citing it anyway.
    const authorizationHeldBySomeoneElse = await mintRevokeAuthorization({
      authScope: workScope,
    });
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: someoneElseEntirely.deviceId,
      "issuer-key": someoneElseEntirely.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(authorizationHeldBySomeoneElse),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict.ok).toBe(true);
  });

  it("does NOT revoke when the authorization itself fails ordinary verification (expired)", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const expiredAuthorization = await mintRevokeAuthorization({
      authScope: workScope,
      expires: now - 1,
    });
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(expiredAuthorization),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict.ok).toBe(true);
  });

  it("does NOT revoke when the authorization itself is revoked", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const authorizationTokenId = nextTokenId();
    const authorization = await signToken(issuer, {
      tokenId: authorizationTokenId,
      bearer: securityTeamMember.deviceId,
      scope: workScope,
      expires: now + HOUR_MS,
      capability: "manage:revoke",
    });
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(authorization),
    };
    const authorizationRevokedEntry: RevocationClaims = {
      "token-id": authorizationTokenId,
      issuer: issuer.deviceId,
      "issuer-key": issuer.identityKey,
      "revoked-at": now,
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry, authorizationRevokedEntry]),
    });

    expect(verdict.ok).toBe(true);
  });

  it("does NOT revoke when the authorization field decodes to something that is not a well-formed capability-token", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf({ nonsense: true }),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict.ok).toBe(true);
  });

  it("does NOT revoke when the authorization field's bytes are not CBOR at all", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const entry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: buf(Buffer.from("ff", "hex")),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([entry]),
    });

    expect(verdict.ok).toBe(true);
  });

  it("the original direct-issuer-match path is completely unaffected by the presence of a failing authorization on a DIFFERENT entry", async () => {
    const tokenId = nextTokenId();
    const token = await mintTargetToken(tokenId);
    const ownIssuerEntry: RevocationClaims = {
      "token-id": tokenId,
      issuer: issuer.deviceId,
      "issuer-key": issuer.identityKey,
      "revoked-at": now,
    };
    const wrongCapabilityAuthorization = await mintRevokeAuthorization({
      authScope: workScope,
      capability: "exec:pty",
    });
    const unrelatedFailingEntry: RevocationClaims = {
      "token-id": tokenId,
      issuer: securityTeamMember.deviceId,
      "issuer-key": securityTeamMember.identityKey,
      "revoked-at": now,
      authorization: encodeBuf(wrongCapabilityAuthorization),
    };

    const verdict = await verifyCapabilityToken(token, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: revocationView([unrelatedFailingEntry, ownIssuerEntry]),
    });

    expect(verdict).toEqual({ ok: false, reason: "revoked" });
  });
});
