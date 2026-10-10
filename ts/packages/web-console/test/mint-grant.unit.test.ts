import { beforeAll, describe, expect, it } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import type {
  CapabilityToken,
  TokenClaims,
} from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { decodeGrantClaims, grantStatus } from "../src/grants.js";
import { mintGrant } from "../src/mint-grant.js";
import type { MintGrantInput } from "../src/mint-grant.js";

const NOW = 1000;
const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;
const TWO_HOURS = 2;
const NO_DELEGATIONS = 0;
const ONE_DELEGATION = 1;

let own: IdentityPort;
let peer: IdentityPort;
const clock = { now: () => NOW };

beforeAll(async () => {
  own = await createWebCryptoIdentity();
  peer = await createWebCryptoIdentity();
});

function input(overrides: Partial<MintGrantInput> = {}): MintGrantInput {
  return {
    bearerHex: deviceIdToHex(peer.deviceId),
    capability: "room:member",
    scopeKind: "room",
    scopePath: "a-room",
    lifetimeHours: DAY_HOURS,
    delegationsRemaining: undefined,
    parent: undefined,
    ...overrides,
  };
}

/** The decoded claims of a token a test just minted, failing loudly rather than narrowing around an absence that would mean the mint itself was wrong. */
function claimsOf(token: CapabilityToken): TokenClaims {
  const claims = decodeGrantClaims(token);
  if (claims === undefined) throw new Error("the minted token has no claims");

  return claims;
}

/** The reason a mint was refused, or an empty string for one that succeeded. */
function errorOf(result: Awaited<ReturnType<typeof mintGrant>>): string {
  return result.ok ? "" : result.error;
}

describe("mintGrant", () => {
  it("mints a root grant that verifies, for the named bearer, with the requested limits", async () => {
    const result = await mintGrant(
      input({ delegationsRemaining: ONE_DELEGATION }),
      {
        identity: own,
        clock,
      },
    );

    if (!result.ok) throw new Error(result.error);
    const claims = decodeGrantClaims(result.token);
    expect(claims?.capability).toBe("room:member");
    expect(claims?.scope).toEqual({ kind: "room", path: "a-room" });
    expect(claims?.expires).toBe(NOW + DAY_HOURS * HOUR_MS);
    expect(claims?.["delegations-remaining"]).toBe(ONE_DELEGATION);
    expect(
      await grantStatus(result.token, {
        identity: peer,
        clock,
        revocation: createRevocationView(),
        expectedBearer: peer.deviceId,
      }),
    ).toEqual({ kind: "valid" });
  });

  it("omits the path when the scope has none", async () => {
    const result = await mintGrant(input({ scopePath: "  " }), {
      identity: own,
      clock,
    });

    if (!result.ok) throw new Error(result.error);
    expect(decodeGrantClaims(result.token)?.scope).toEqual({ kind: "room" });
  });

  it("refuses a bearer that is not a device-id", async () => {
    expect(
      await mintGrant(input({ bearerHex: "abc" }), { identity: own, clock }),
    ).toEqual({
      ok: false,
      error: "the bearer must be a 64-character hex device-id",
    });
  });

  it("refuses a capability that is not subsystem:action, a missing scope kind and a lifetime of nothing", async () => {
    const context = { identity: own, clock };

    expect(
      errorOf(await mintGrant(input({ capability: "nonsense" }), context)),
    ).toContain("subsystem:action");
    expect(
      errorOf(await mintGrant(input({ scopeKind: " " }), context)),
    ).toContain("scope needs a kind");
    expect(
      errorOf(await mintGrant(input({ lifetimeHours: 0 }), context)),
    ).toContain("more than zero hours");
  });

  it("mints a whole number of milliseconds for a fractional number of hours, so the token still decodes", async () => {
    const FRACTIONAL_HOURS = 0.123456;
    const result = await mintGrant(input({ lifetimeHours: FRACTIONAL_HOURS }), {
      identity: own,
      clock,
    });

    if (!result.ok) throw new Error(result.error);
    const expires = decodeGrantClaims(result.token)?.expires;
    expect(expires).toBe(Math.round(NOW + FRACTIONAL_HOURS * HOUR_MS));
    expect(Number.isInteger(expires)).toBe(true);
  });

  it("refuses a delegation count that is fractional or negative, which no token can carry", async () => {
    const context = { identity: own, clock };
    const FRACTIONAL_DELEGATIONS = 1.5;
    const NEGATIVE_DELEGATIONS = -1;

    expect(
      errorOf(
        await mintGrant(
          input({ delegationsRemaining: FRACTIONAL_DELEGATIONS }),
          context,
        ),
      ),
    ).toContain("whole number");
    expect(
      errorOf(
        await mintGrant(
          input({ delegationsRemaining: NEGATIVE_DELEGATIONS }),
          context,
        ),
      ),
    ).toContain("whole number");
  });

  describe("delegating", () => {
    async function parentGrant(
      overrides: Partial<MintGrantInput> = {},
    ): Promise<NonNullable<MintGrantInput["parent"]>> {
      const minted = await mintGrant(
        input({
          bearerHex: deviceIdToHex(own.deviceId),
          delegationsRemaining: ONE_DELEGATION,
          ...overrides,
        }),
        { identity: peer, clock },
      );
      if (!minted.ok) throw new Error(minted.error);

      return minted.token;
    }

    it("mints a grant that narrows the one it delegates from", async () => {
      const parent = await parentGrant();

      const result = await mintGrant(
        input({
          lifetimeHours: TWO_HOURS,
          delegationsRemaining: NO_DELEGATIONS,
          parent,
        }),
        { identity: own, clock },
      );

      expect(result.ok).toBe(true);
    });

    it("refuses one that would outlast the grant it delegates from", async () => {
      const parent = await parentGrant({ lifetimeHours: TWO_HOURS });

      expect(
        await mintGrant(
          input({
            lifetimeHours: DAY_HOURS,
            delegationsRemaining: NO_DELEGATIONS,
            parent,
          }),
          { identity: own, clock },
        ),
      ).toEqual({
        ok: false,
        error: "refused: it would outlast the grant it delegates from",
      });
    });

    it("refuses one with a wider scope", async () => {
      const parent = await parentGrant();

      const result = await mintGrant(
        input({ scopePath: "", delegationsRemaining: NO_DELEGATIONS, parent }),
        { identity: own, clock },
      );

      expect(result).toEqual({
        ok: false,
        error: "refused: its scope is wider than the grant it delegates from",
      });
    });
  });

  describe("the grant and request permissions", () => {
    const FOLDER_SCOPE = { scopeKind: "folder", scopePath: "/work" } as const;

    it("mints a manage:grant that names its verb and bars its holder from granting that verb to itself", async () => {
      const minted = await mintGrant(
        input({
          capability: "manage:grant",
          ...FOLDER_SCOPE,
          targetVerb: "exec:pty",
          selfGrantBars: ["exec:pty"],
        }),
        { identity: own, clock },
      );
      if (!minted.ok) throw new Error(minted.error);
      expect(claimsOf(minted.token)["grants-capability"]).toBe("exec:pty");

      /* The bar does its job end to end: the holder (peer) minting exec:pty under this grant
         naming itself is refused, and naming anyone else is accepted. */
      const toSelf = await mintCapabilityToken({
        identity: peer,
        clock,
        tokenId: Uint8Array.from([1]),
        bearer: peer.deviceId,
        capability: "exec:pty",
        scope: { kind: "folder", path: "/work/sub" },
        expires: NOW + HOUR_MS,
        authorisedBy: minted.token,
      });
      expect(toSelf).toEqual({
        ok: false,
        reason: "authorisation_conditions_not_satisfied",
      });
      const toOther = await mintCapabilityToken({
        identity: peer,
        clock,
        tokenId: Uint8Array.from([2]),
        bearer: own.deviceId,
        capability: "exec:pty",
        scope: { kind: "folder", path: "/work/sub" },
        expires: NOW + HOUR_MS,
        authorisedBy: minted.token,
      });
      expect(toOther.ok).toBe(true);
    });

    it("mints a manage:request that names the verb it may ask for", async () => {
      const minted = await mintGrant(
        input({
          capability: "manage:request",
          scopeKind: "room",
          scopePath: "",
          targetVerb: "room:member",
        }),
        { identity: own, clock },
      );
      if (!minted.ok) throw new Error(minted.error);

      expect(claimsOf(minted.token)["requests-capability"]).toBe("room:member");
    });

    it("mints a grant authorised by a held manage:grant, citing it", async () => {
      const authoriser = await mintGrant(
        input({
          capability: "manage:grant",
          bearerHex: deviceIdToHex(own.deviceId),
          ...FOLDER_SCOPE,
        }),
        { identity: peer, clock },
      );
      if (!authoriser.ok) throw new Error(authoriser.error);

      const minted = await mintGrant(
        input({
          capability: "exec:pty",
          bearerHex: deviceIdToHex(peer.deviceId),
          scopeKind: "folder",
          scopePath: "/work/sub",
          authorisedBy: authoriser.token,
        }),
        { identity: own, clock },
      );

      expect(minted.ok).toBe(true);
      if (minted.ok) {
        expect(claimsOf(minted.token)["authorised-by"]).toBeDefined();
      }
    });

    it("reports a refused authorised mint in the person's terms", async () => {
      const authoriser = await mintGrant(
        input({
          capability: "manage:grant",
          bearerHex: deviceIdToHex(own.deviceId),
          targetVerb: "exec:pty",
          ...FOLDER_SCOPE,
        }),
        { identity: peer, clock },
      );
      if (!authoriser.ok) throw new Error(authoriser.error);

      const result = await mintGrant(
        input({
          capability: "pin:write",
          scopeKind: "folder",
          scopePath: "/work/sub",
          authorisedBy: authoriser.token,
        }),
        { identity: own, clock },
      );

      expect(result).toEqual({
        ok: false,
        error: "refused: the grant authorising it names a different capability",
      });
    });

    it("refuses a covered verb on a capability that names none, and bars on anything but a manage:grant", async () => {
      expect(
        errorOf(
          await mintGrant(input({ targetVerb: "room:member" }), {
            identity: own,
            clock,
          }),
        ),
      ).toContain("only manage:grant and manage:request name a verb");
      expect(
        errorOf(
          await mintGrant(input({ selfGrantBars: ["exec:pty"] }), {
            identity: own,
            clock,
          }),
        ),
      ).toContain("only a manage:grant can bar its holder");
    });

    it("refuses a malformed covered or barred verb", async () => {
      expect(
        errorOf(
          await mintGrant(
            input({
              capability: "manage:grant",
              ...FOLDER_SCOPE,
              targetVerb: "nope",
            }),
            { identity: own, clock },
          ),
        ),
      ).toContain("the covered verb must look like subsystem:action");
      expect(
        errorOf(
          await mintGrant(
            input({
              capability: "manage:grant",
              ...FOLDER_SCOPE,
              selfGrantBars: ["nope"],
            }),
            { identity: own, clock },
          ),
        ),
      ).toContain('the barred verb "nope" must look like subsystem:action');
    });
  });
});
