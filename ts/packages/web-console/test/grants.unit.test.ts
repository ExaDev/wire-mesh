import { beforeAll, describe, expect, it } from "vitest";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { mintRevocationEntry } from "wire-mesh-core/domain/tokens";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import {
  GRANT_CODE_PREFIX,
  decodeGrantClaims,
  decodeGrantCode,
  describeGrantStatus,
  encodeGrantCode,
  grantStatus,
} from "../src/grants.js";

const TOKEN_ID_BYTES = 16;
const NOW = 1000;
const LIFETIME = 5000;

let issuer: IdentityPort;
let bearer: IdentityPort;
const clock = { now: () => NOW };

beforeAll(async () => {
  issuer = await createWebCryptoIdentity();
  bearer = await createWebCryptoIdentity();
});

async function grant(expires = NOW + LIFETIME): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock,
    tokenId: new Uint8Array(TOKEN_ID_BYTES).fill(1),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: "a-room" },
    expires,
  });
  if (!verdict.ok) throw new Error("expected the grant to mint");
  return verdict.token;
}

describe("grant codes", () => {
  it("round-trips a token through its code", async () => {
    const token = await grant();

    const decoded = decodeGrantCode(encodeGrantCode(token));

    expect(decodeGrantClaims(decoded)).toEqual(decodeGrantClaims(token));
    expect(encodeGrantCode(token).startsWith(GRANT_CODE_PREFIX)).toBe(true);
  });

  it("ignores surrounding whitespace, as a pasted code often has", async () => {
    const code = encodeGrantCode(await grant());

    expect(() => decodeGrantCode(`  ${code}\n`)).not.toThrow();
  });

  it("refuses text that is not a grant code, a damaged one, and one that carries no token", () => {
    expect(() => decodeGrantCode("hello")).toThrow(/starts with/);
    expect(() => decodeGrantCode(`${GRANT_CODE_PREFIX}!!!`)).toThrow(/damaged/);
    expect(() => decodeGrantCode(`${GRANT_CODE_PREFIX}gA`)).toThrow(
      /does not carry a capability token/,
    );
  });
});

describe("grantStatus", () => {
  it("is valid for a live, unrevoked grant", async () => {
    const status = await grantStatus(await grant(), {
      identity: bearer,
      clock,
      revocation: createRevocationView(),
    });

    expect(status).toEqual({ kind: "valid" });
    expect(describeGrantStatus(status)).toBe("valid");
  });

  it("says a grant is expired once its time has passed", async () => {
    const token = await grant(NOW + 1);

    const status = await grantStatus(token, {
      identity: bearer,
      clock: { now: () => NOW + LIFETIME },
      revocation: createRevocationView(),
    });

    expect(status).toEqual({ kind: "invalid", reason: "expired" });
    expect(describeGrantStatus(status)).toBe("expired");
  });

  it("says a grant is revoked once its issuer's revocation is recorded", async () => {
    const token = await grant();
    const revocation = createRevocationView();
    await revocation.record(
      await mintRevocationEntry({
        identity: issuer,
        tokenId: new Uint8Array(TOKEN_ID_BYTES).fill(1),
        revokedAt: NOW,
      }),
      { identity: bearer },
    );

    const status = await grantStatus(token, {
      identity: bearer,
      clock,
      revocation,
    });

    expect(describeGrantStatus(status)).toBe("revoked");
  });
});
