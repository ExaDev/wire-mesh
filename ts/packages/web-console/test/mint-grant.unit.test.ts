import { beforeAll, describe, expect, it } from "vitest";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
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
});
