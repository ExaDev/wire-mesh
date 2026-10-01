import { beforeAll, describe, expect, it } from "vitest";
import type { PredicateNode } from "trilean";
import {
  MANAGE_GRANT_CAPABILITY,
  canGrantVia,
  mintCapabilityToken,
  verifyCapabilityToken,
} from "../src/domain/tokens.js";
import { noSelfGrantBar } from "../src/domain/token-predicates.js";
import { ownerNamedRoomPath } from "../src/domain/room-path.js";
import { verifyRoomToken } from "../src/domain/room-token-verification.js";
import { bytesToHex } from "../src/domain/device-id.js";
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
  encodeBuf,
  equalBytes,
  fixedClock,
  generateEs256Identity,
  neverRevoked,
  nextTokenId,
  revocationView,
  signToken,
} from "./tokens-fixtures.js";

// The authorised-by link (wire-mesh#323): a grant-capability (manage:grant) authorises its bearer to mint other capability tokens, and the authoriser's conditions bind the minted child's claims. Every fixture here is signed directly (not via mint) except where a test is explicitly about mint's own enforcement, so verifyCapabilityToken's enforcement is exercised on chains mint would refuse to produce, the same discipline token-delegation-narrowing.unit.test.ts already follows.

const NOW_MS = 1_893_456_000_000;
const WORK_SCOPE: CapabilityScope = { kind: "folder", path: "/work" };
const DEPTH_CAP = 64;

describe("verifyCapabilityToken - authorised-by", () => {
  let owner: IdentityPort;
  let deputy: IdentityPort;
  let thirdParty: IdentityPort;

  beforeAll(async () => {
    owner = await generateEs256Identity();
    deputy = await generateEs256Identity();
    thirdParty = await generateEs256Identity();
  });

  /** A root manage:grant held by deputy, signed by owner, reporting the token-id it was minted under so a revocation test can name it. */
  async function grantCapability(
    overrides: Partial<{
      grantsCapability: TokenClaims["capability"];
      conditionsBytes: Uint8Array<ArrayBuffer>;
      delegationsRemaining: number;
    }> = {},
  ): Promise<{ token: CapabilityToken; tokenId: Uint8Array<ArrayBuffer> }> {
    const tokenId = nextTokenId();
    const token = await signToken(owner, {
      tokenId,
      bearer: deputy.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      scope: WORK_SCOPE,
      expires: NOW_MS + 2 * HOUR_MS,
      ...(overrides.grantsCapability !== undefined
        ? { grantsCapability: overrides.grantsCapability }
        : {}),
      ...(overrides.conditionsBytes !== undefined
        ? { conditions: overrides.conditionsBytes }
        : {}),
      ...(overrides.delegationsRemaining !== undefined
        ? { delegationsRemaining: overrides.delegationsRemaining }
        : {}),
    });
    return { token, tokenId };
  }

  /** An exec:pty token minted by deputy under a grant-capability. */
  async function mintedUnder(
    authoriser: CapabilityToken,
    overrides: Partial<{
      bearer: DeviceId;
      scope: CapabilityScope;
      expires: number;
      delegationsRemaining: number;
      capability: TokenClaims["capability"];
    }> = {},
  ): Promise<CapabilityToken> {
    return signToken(deputy, {
      tokenId: nextTokenId(),
      bearer: overrides.bearer ?? thirdParty.deviceId,
      capability: overrides.capability ?? "exec:pty",
      scope: overrides.scope ?? { kind: "folder", path: "/work/subdir" },
      expires: overrides.expires ?? NOW_MS + HOUR_MS,
      ...(overrides.delegationsRemaining !== undefined
        ? { delegationsRemaining: overrides.delegationsRemaining }
        : {}),
      authorisedBy: encodeBuf(authoriser),
    });
  }

  function options(
    revocation = neverRevoked,
  ): Parameters<typeof verifyCapabilityToken>[1] {
    return {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation,
    };
  }

  it("verifies a token minted under a grant-capability, threading root and depth from the authoriser's chain", async () => {
    const { token: grant } = await grantCapability({
      grantsCapability: "exec:pty",
    });
    const child = await mintedUnder(grant);

    const verdict = await verifyCapabilityToken(child, options());

    expect(verdict).toMatchObject({
      ok: true,
      rootIssuer: owner.deviceId,
      depth: 1,
    });
    if (verdict.ok) {
      expect(
        equalBytes(
          verdict.rootIssuerKey["public-key"],
          owner.identityKey["public-key"],
        ),
      ).toBe(true);
    }
  });

  it("refuses a child whose capability is not the one the authoriser names", async () => {
    const { token: grant } = await grantCapability({
      grantsCapability: "exec:pty",
    });
    const child = await mintedUnder(grant, { capability: "pin:write" });

    const verdict = await verifyCapabilityToken(child, options());

    expect(verdict).toEqual({ ok: false, reason: "authorisation_invalid" });
  });

  it("treats an absent grants-capability as any verb within scope", async () => {
    const { token: grant } = await grantCapability();
    const child = await mintedUnder(grant, { capability: "pin:write" });

    const verdict = await verifyCapabilityToken(child, options());

    expect(verdict).toMatchObject({ ok: true });
    if (verdict.ok) {
      expect(verdict.claims.capability).toBe("pin:write");
    }
  });

  it("refuses a child minted by someone other than the authoriser's bearer", async () => {
    const { token: grant } = await grantCapability();
    const impostor = await generateEs256Identity();
    const child = await signToken(impostor, {
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      scope: { kind: "folder", path: "/work/subdir" },
      expires: NOW_MS + HOUR_MS,
      authorisedBy: encodeBuf(grant),
    });

    const verdict = await verifyCapabilityToken(child, options());

    expect(verdict).toEqual({ ok: false, reason: "authorisation_invalid" });
  });

  it("refuses a child whose scope widens the authoriser's", async () => {
    const { token: grant } = await grantCapability();
    const child = await mintedUnder(grant, {
      scope: { kind: "folder", path: "/other" },
    });

    const verdict = await verifyCapabilityToken(child, options());

    expect(verdict).toEqual({ ok: false, reason: "authorisation_invalid" });
  });

  it("refuses a child that outlives the authoriser", async () => {
    const { token: grant } = await grantCapability();
    const child = await mintedUnder(grant, {
      expires: NOW_MS + 2 * HOUR_MS + HOUR_MS,
    });

    const verdict = await verifyCapabilityToken(child, options());

    expect(verdict).toEqual({ ok: false, reason: "authorisation_invalid" });
  });

  it("consumes one delegations-remaining hop across the link: a present strictly-smaller child value passes, an absent one is refused, and 0 on the authoriser is inert", async () => {
    const { token: bounded } = await grantCapability({
      delegationsRemaining: 1,
    });
    const okChild = await mintedUnder(bounded, { delegationsRemaining: 0 });
    expect(await verifyCapabilityToken(okChild, options())).toMatchObject({
      ok: true,
    });

    const absentChild = await mintedUnder(bounded);
    expect(await verifyCapabilityToken(absentChild, options())).toEqual({
      ok: false,
      reason: "authorisation_invalid",
    });

    const { token: inert } = await grantCapability({
      delegationsRemaining: 0,
    });
    const underInert = await mintedUnder(inert, { delegationsRemaining: 0 });
    expect(await verifyCapabilityToken(underInert, options())).toEqual({
      ok: false,
      reason: "authorisation_invalid",
    });
  });

  it("evaluates the authoriser's conditions against the child: the delegate-without-use bar refuses a self-borne child and passes a third party's", async () => {
    const { token: grant } = await grantCapability({
      conditionsBytes: encodeBuf([noSelfGrantBar("exec:pty", deputy.deviceId)]),
    });
    const selfBorne = await mintedUnder(grant, {
      bearer: deputy.deviceId,
    });
    const theirs = await mintedUnder(grant, { bearer: thirdParty.deviceId });

    expect(await verifyCapabilityToken(selfBorne, options())).toEqual({
      ok: false,
      reason: "authorisation_invalid",
    });
    expect(await verifyCapabilityToken(theirs, options())).toMatchObject({
      ok: true,
    });
  });

  it("the no-self-perpetuation bar refuses a manage:grant minted to the bearer itself and passes one minted onward", async () => {
    const { token: grant } = await grantCapability({
      conditionsBytes: encodeBuf([
        noSelfGrantBar(MANAGE_GRANT_CAPABILITY, deputy.deviceId),
      ]),
    });
    const selfPerpetuated = await mintedUnder(grant, {
      capability: MANAGE_GRANT_CAPABILITY,
      bearer: deputy.deviceId,
    });
    const passedOn = await mintedUnder(grant, {
      capability: MANAGE_GRANT_CAPABILITY,
      bearer: thirdParty.deviceId,
    });

    expect(await verifyCapabilityToken(selfPerpetuated, options())).toEqual({
      ok: false,
      reason: "authorisation_invalid",
    });
    expect(await verifyCapabilityToken(passedOn, options())).toMatchObject({
      ok: true,
    });
  });

  it("a bar naming someone other than the child's bearer does not refuse the child, pinning that evaluation reads the CHILD's claims", async () => {
    const { token: grant } = await grantCapability({
      conditionsBytes: encodeBuf([noSelfGrantBar("exec:pty", owner.deviceId)]),
    });
    const child = await mintedUnder(grant, { bearer: deputy.deviceId });

    expect(await verifyCapabilityToken(child, options())).toMatchObject({
      ok: true,
    });
  });

  it("fails closed on a subject-mode condition naming an unregistered system", async () => {
    const unregistered: PredicateNode = {
      kind: "compare",
      op: "eq",
      left: {
        kind: "delegate",
        system: "not-a-registered-system",
        payload: null,
      },
      right: { kind: "booleanLiteral", value: true },
    };
    const { token: grant } = await grantCapability({
      conditionsBytes: encodeBuf([unregistered]),
    });
    const child = await mintedUnder(grant);

    expect(await verifyCapabilityToken(child, options())).toEqual({
      ok: false,
      reason: "authorisation_invalid",
    });
  });

  it("a grant-capability carrying child-named conditions does not verify standalone: subject systems are indeterminate with no subject", async () => {
    const { token: grant } = await grantCapability({
      conditionsBytes: encodeBuf([noSelfGrantBar("exec:pty", deputy.deviceId)]),
    });

    expect(await verifyCapabilityToken(grant, options())).toEqual({
      ok: false,
      reason: "conditions_not_satisfied",
    });
  });

  it("refuses a token carrying both parent and authorised-by as malformed", async () => {
    const { token: grant } = await grantCapability();
    const root = await signToken(owner, {
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      scope: WORK_SCOPE,
      expires: NOW_MS + 2 * HOUR_MS,
    });
    const child = await signToken(deputy, {
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      scope: { kind: "folder", path: "/work/subdir" },
      expires: NOW_MS + HOUR_MS,
      parent: encodeBuf(root),
      authorisedBy: encodeBuf(grant),
    });

    expect(await verifyCapabilityToken(child, options())).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a manage:grant token that carries a parent at all", async () => {
    const root = await signToken(owner, {
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      scope: WORK_SCOPE,
      expires: NOW_MS + 2 * HOUR_MS,
    });
    const grantWithParent = await signToken(deputy, {
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      scope: WORK_SCOPE,
      expires: NOW_MS + HOUR_MS,
      parent: encodeBuf(root),
    });

    expect(await verifyCapabilityToken(grantWithParent, options())).toEqual({
      ok: false,
      reason: "authorisation_invalid",
    });
  });

  it("revoking the grant-capability revokes every grant minted under it", async () => {
    const { token: grant, tokenId: grantTokenId } = await grantCapability();
    const child = await mintedUnder(grant);
    const revocation: RevocationClaims = {
      "token-id": grantTokenId,
      issuer: owner.deviceId,
      "issuer-key": owner.identityKey,
      "revoked-at": NOW_MS - 1,
    };

    const verdict = await verifyCapabilityToken(
      child,
      options(revocationView([revocation])),
    );

    // Refusal is the property that matters: revoking the authoriser takes the whole minted subtree with it. The reason collapses the same way a revoked parent already collapses to parent_invalid.
    expect(verdict).toEqual({ ok: false, reason: "authorisation_invalid" });
  });

  it("walks nested grant-capabilities: a token minted under G2, itself minted under G1, roots at G1's issuer", async () => {
    const { token: g1 } = await grantCapability({
      grantsCapability: MANAGE_GRANT_CAPABILITY,
    });
    const g2 = await signToken(deputy, {
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      scope: WORK_SCOPE,
      expires: NOW_MS + HOUR_MS,
      authorisedBy: encodeBuf(g1),
    });
    const leaf = await signToken(thirdParty, {
      tokenId: nextTokenId(),
      bearer: owner.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/deep" },
      expires: NOW_MS + HOUR_MS / 2,
      authorisedBy: encodeBuf(g2),
    });

    const verdict = await verifyCapabilityToken(leaf, options());

    expect(verdict).toMatchObject({
      ok: true,
      rootIssuer: owner.deviceId,
      depth: 2,
    });
  });

  it("a room owner's root check passes across a grant mint", async () => {
    const roomPath = ownerNamedRoomPath(bytesToHex(owner.deviceId), "general");
    const roomGrant = await signToken(owner, {
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      grantsCapability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: NOW_MS + 2 * HOUR_MS,
    });
    const membership = await signToken(deputy, {
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      capability: "room:member",
      scope: { kind: "room", path: roomPath },
      expires: NOW_MS + HOUR_MS,
      authorisedBy: encodeBuf(roomGrant),
    });

    const verdict = await verifyRoomToken(membership, {
      identity: owner,
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
      expectedBearer: thirdParty.deviceId,
      roomPath,
    });

    expect(verdict).toMatchObject({ ok: true });
  });

  it("refuses a chain deeper than the bound", async () => {
    let token = await signToken(owner, {
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      scope: WORK_SCOPE,
      expires: NOW_MS + (DEPTH_CAP + 2) * HOUR_MS,
    });
    for (let hop = 0; hop < DEPTH_CAP; hop += 1) {
      token = await signToken(deputy, {
        tokenId: nextTokenId(),
        bearer: thirdParty.deviceId,
        scope: WORK_SCOPE,
        expires: NOW_MS + (DEPTH_CAP - hop) * HOUR_MS,
        parent: encodeBuf(token),
      });
    }

    const verdict = await verifyCapabilityToken(token, options());

    expect(verdict).toEqual({ ok: false, reason: "chain_too_deep" });
  });
});

describe("mintCapabilityToken - authorisedBy", () => {
  let owner: IdentityPort;
  let deputy: IdentityPort;
  let thirdParty: IdentityPort;

  beforeAll(async () => {
    owner = await generateEs256Identity();
    deputy = await generateEs256Identity();
    thirdParty = await generateEs256Identity();
  });

  async function mintedGrantCapability(
    overrides: Partial<{
      conditions: PredicateNode[];
      grantsCapability: TokenClaims["capability"];
    }> = {},
  ): Promise<CapabilityToken> {
    const verdict = await mintCapabilityToken({
      identity: owner,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      scope: WORK_SCOPE,
      expires: NOW_MS + 2 * HOUR_MS,
      ...(overrides.grantsCapability !== undefined
        ? { grantsCapability: overrides.grantsCapability }
        : {}),
      ...(overrides.conditions !== undefined
        ? { conditions: overrides.conditions }
        : {}),
    });
    if (!verdict.ok) throw new Error(`mint failed: ${verdict.reason}`);
    return verdict.token;
  }

  it("mints under a grant-capability and the result verifies", async () => {
    const grant = await mintedGrantCapability({
      grantsCapability: "exec:pty",
    });
    const verdict = await mintCapabilityToken({
      identity: deputy,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      expires: NOW_MS + HOUR_MS,
      authorisedBy: grant,
    });

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(
        await verifyCapabilityToken(verdict.token, {
          identity: owner,
          clock: fixedClock(NOW_MS),
          revocation: neverRevoked,
        }),
      ).toMatchObject({ ok: true, depth: 1 });
    }
  });

  it("refuses at mint time for every link violation the verifier would catch", async () => {
    const grant = await mintedGrantCapability({
      grantsCapability: "exec:pty",
    });
    const cases = [
      {
        capability: "pin:write" as const,
        scope: { kind: "folder", path: "/work/subdir" },
        expires: NOW_MS + HOUR_MS,
        reason: "authorisation_capability_mismatch",
      },
      {
        capability: "exec:pty" as const,
        scope: { kind: "folder", path: "/other" },
        expires: NOW_MS + HOUR_MS,
        reason: "authorisation_scope_does_not_narrow",
      },
      {
        capability: "exec:pty" as const,
        scope: { kind: "folder", path: "/work/subdir" },
        expires: NOW_MS + 2 * HOUR_MS + HOUR_MS,
        reason: "authorisation_exceeds_authoriser",
      },
    ];
    for (const testCase of cases) {
      const verdict = await mintCapabilityToken({
        identity: deputy,
        clock: fixedClock(NOW_MS),
        tokenId: nextTokenId(),
        bearer: thirdParty.deviceId,
        capability: testCase.capability,
        scope: testCase.scope,
        expires: testCase.expires,
        authorisedBy: grant,
      });
      expect(verdict).toEqual({ ok: false, reason: testCase.reason });
    }
  });

  it("refuses a mint the authoriser's subject-mode conditions bar, and one by a non-bearer of the authoriser", async () => {
    const grant = await mintedGrantCapability({
      conditions: [noSelfGrantBar("exec:pty", deputy.deviceId)],
    });
    const barred = await mintCapabilityToken({
      identity: deputy,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      expires: NOW_MS + HOUR_MS,
      authorisedBy: grant,
    });
    expect(barred).toEqual({
      ok: false,
      reason: "authorisation_conditions_not_satisfied",
    });

    const impostor = await generateEs256Identity();
    const notBearer = await mintCapabilityToken({
      identity: impostor,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      expires: NOW_MS + HOUR_MS,
      authorisedBy: grant,
    });
    expect(notBearer).toEqual({
      ok: false,
      reason: "authorisation_bearer_mismatch",
    });
  });

  it("refuses both link kinds at once, and a manage:grant minted through a parent", async () => {
    const grant = await mintedGrantCapability();
    const root = await signToken(owner, {
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      scope: WORK_SCOPE,
      expires: NOW_MS + 2 * HOUR_MS,
    });
    const both = await mintCapabilityToken({
      identity: deputy,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      expires: NOW_MS + HOUR_MS,
      parent: root,
      authorisedBy: grant,
    });
    expect(both).toEqual({ ok: false, reason: "links_exclusive" });

    const grantViaParent = await mintCapabilityToken({
      identity: deputy,
      clock: fixedClock(NOW_MS),
      tokenId: nextTokenId(),
      bearer: thirdParty.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      scope: WORK_SCOPE,
      expires: NOW_MS + HOUR_MS,
      parent: root,
    });
    expect(grantViaParent).toEqual({
      ok: false,
      reason: "authorisation_parent_forbidden",
    });
  });
});

describe("canGrantVia", () => {
  it("answers whether a holder could mint a candidate under a grant-capability, without minting", async () => {
    const owner = await generateEs256Identity();
    const deputy = await generateEs256Identity();
    const thirdParty = await generateEs256Identity();
    const grant = await signToken(owner, {
      tokenId: nextTokenId(),
      bearer: deputy.deviceId,
      capability: MANAGE_GRANT_CAPABILITY,
      grantsCapability: "exec:pty",
      scope: WORK_SCOPE,
      expires: NOW_MS + 2 * HOUR_MS,
      conditions: encodeBuf([noSelfGrantBar("exec:pty", deputy.deviceId)]),
    });
    const candidate = {
      capability: "exec:pty",
      scope: { kind: "folder", path: "/work/subdir" },
      bearer: thirdParty.deviceId,
      expires: NOW_MS + HOUR_MS,
    };

    expect(await canGrantVia(grant, deputy.deviceId, candidate, NOW_MS)).toBe(
      true,
    );
    expect(
      await canGrantVia(
        grant,
        deputy.deviceId,
        { ...candidate, bearer: deputy.deviceId },
        NOW_MS,
      ),
    ).toBe(false);
    expect(
      await canGrantVia(grant, thirdParty.deviceId, candidate, NOW_MS),
    ).toBe(false);
  });
});
