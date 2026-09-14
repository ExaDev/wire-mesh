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
  REVOKED_SHORTLY_BEFORE_NOW_MS,
  encodeBuf,
  fixedClock,
  generateEs256Identity,
  neverRevoked,
  nextTokenId,
  revocationView,
  signToken,
} from "./tokens-fixtures.js";

describe("verifyCapabilityToken - delegation narrowing", () => {
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

  it("rejects a delegated token signed by a device other than its parent's own bearer", async () => {
    const rootExpiry = now + 2 * HOUR_MS;
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: workScope,
      expires: rootExpiry,
    });

    // Signed by `issuer`, not `bearerIdentity` -- the root's bearer is bearerIdentity, so only bearerIdentity may delegate from it. This is the bearer-is narrowing check's own failure path at verify time (mint's equivalent is covered by "refuses to mint a delegation the issuer's own device does not hold the parent's bearer for" in token-minting-and-grants.test.ts, which never previously had a verify-side counterpart).
    const delegate = await generateEs256Identity();
    const claims: TokenClaims = {
      "token-id": nextTokenId(),
      issuer: issuer.deviceId,
      "issuer-key": issuer.identityKey,
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
    const signature = await issuer.sign(toBeSigned);
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

    expect(verdict).toEqual({ ok: false, reason: "delegation_exceeds_parent" });
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
    delegationsRemaining?: number;
  }

  /** Signs a child token as `identity` with an explicit parent token embedded -- the parent's own claims are recoverable by the verifier's own recursion, so they are not restated here. Deliberately does none of mintCapabilityToken's own narrowing checks -- tests exercising verifyCapabilityToken's own enforcement need to construct chains mint would refuse to produce. */
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
      ...(seed.delegationsRemaining !== undefined
        ? { "delegations-remaining": seed.delegationsRemaining }
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

  it("rejects a delegated token whose path uses a .. segment to escape the parent's", async () => {
    // Purely lexical prefix comparison would accept "/work/../org" under "/work"; a path that normalises outside the parent is a widening, so any "." or ".." segment fails the narrowing comparison
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/work/../org",
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

  it("rejects a delegated token with a nested .. segment even when it stays inside the parent", async () => {
    // "/work/a/../b" normalises to "/work/b" which would narrow, but relative segments are rejected wholesale: fail-closed rather than reimplementing path normalisation
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/work/a/../b",
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

  it("accepts a delegated token whose child path carries a trailing slash under the parent", async () => {
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/work/",
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects a delegated token whose child path differs only in case", async () => {
    const delegated = await delegateUnderWorkRoot({
      kind: "folder",
      path: "/Work",
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

  it("rejects a delegated token whose delegations-remaining is not strictly less than its parent's", async () => {
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + 2 * HOUR_MS,
      delegationsRemaining: 1,
    });
    const delegate = await generateEs256Identity();
    // Equal to the parent's own delegations-remaining (1), not strictly less -- this is the exact unbounded-admission gap the claim exists to close: without this check, any bearer of a bounded grant could mint an equally-unbounded child.
    const delegated = await signDelegated(bearerIdentity, {
      tokenId: nextTokenId(),
      bearer: delegate.deviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + HOUR_MS,
      parent: root,
      delegationsRemaining: 1,
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

  it("rejects an unbounded delegated token under a parent that itself bounds re-delegation", async () => {
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + 2 * HOUR_MS,
      delegationsRemaining: 1,
    });
    const delegate = await generateEs256Identity();
    // No delegations-remaining at all -- unbounded, which is wider than the parent's bounded 1.
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
    });

    expect(verdict).toEqual({
      ok: false,
      reason: "delegation_exceeds_parent",
    });
  });

  it("accepts a delegated token whose delegations-remaining strictly narrows its parent's, and reports the chain's root and depth", async () => {
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + 2 * HOUR_MS,
      delegationsRemaining: 1,
    });
    const delegate = await generateEs256Identity();
    const delegated = await signDelegated(bearerIdentity, {
      tokenId: nextTokenId(),
      bearer: delegate.deviceId,
      scope: { kind: "folder", path: "/work" },
      expires: now + HOUR_MS,
      parent: root,
      delegationsRemaining: 0,
    });

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.rootIssuer).toEqual(issuer.deviceId);
    expect(verdict.depth).toBe(1);
  });

  it("reports depth 0 and itself as the root for a root grant with no parent", async () => {
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
    if (!verdict.ok) return;
    expect(verdict.rootIssuer).toEqual(issuer.deviceId);
    expect(verdict.depth).toBe(0);
  });

  async function delegateUnderRootRoot(
    childPath: string,
  ): Promise<CapabilityToken> {
    const root = await signToken(issuer, {
      tokenId: nextTokenId(),
      bearer: bearerDeviceId,
      scope: { kind: "folder", path: "/" },
      expires: now + 2 * HOUR_MS,
    });
    const delegate = await generateEs256Identity();
    return signDelegated(bearerIdentity, {
      tokenId: nextTokenId(),
      bearer: delegate.deviceId,
      scope: { kind: "folder", path: childPath },
      expires: now + HOUR_MS,
      parent: root,
    });
  }

  it("accepts any well-formed child path under a whole-root parent path", async () => {
    const delegated = await delegateUnderRootRoot("/anything/at/all");

    const verdict = await verifyCapabilityToken(delegated, {
      identity: issuer,
      clock: fixedClock(now),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(true);
  });

  it("rejects an empty child path", async () => {
    const delegated = await delegateUnderWorkRoot({ kind: "folder", path: "" });

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
});
