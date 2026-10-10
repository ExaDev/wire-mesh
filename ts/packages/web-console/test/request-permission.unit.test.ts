import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import {
  CapabilityRequestRefusedError,
  MANAGE_REQUEST_CAPABILITY,
} from "wire-mesh-core/domain/capability-request";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createGrantStore } from "../src/grant-store.js";
import type { GrantDirection } from "../src/grant-store.js";
import {
  describeRequestRefusal,
  heldRequestToken,
} from "../src/request-permission.js";
import { inSequence } from "./sequence.js";

const NOW = 1000;
const HOUR_MS = 3_600_000;
const ROOM = { kind: "room", path: "a-room" } as const;

let grantor: IdentityPort;
let own: IdentityPort;

beforeAll(async () => {
  grantor = await createWebCryptoIdentity();
  own = await createWebCryptoIdentity();
});

function verification(
  now: number = NOW,
): Parameters<typeof heldRequestToken>[1] {
  return {
    identity: own,
    clock: { now: () => now },
    revocation: createRevocationView(),
    expectedBearer: own.deviceId,
  };
}

let mintedCount = 0;

async function permission(
  overrides: Partial<{
    capability: string;
    requestsCapability: string;
    scope: { kind: string; path?: string };
    lifetimeMs: number;
  }> = {},
): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: grantor,
    clock: { now: () => NOW },
    tokenId: Uint8Array.from([++mintedCount]),
    bearer: own.deviceId,
    capability: overrides.capability ?? MANAGE_REQUEST_CAPABILITY,
    scope: overrides.scope ?? { kind: "room" },
    expires: NOW + (overrides.lifetimeMs ?? HOUR_MS),
    ...(overrides.requestsCapability === undefined
      ? {}
      : { requestsCapability: overrides.requestsCapability }),
  });
  if (!verdict.ok) throw new Error(verdict.reason);

  return verdict.token;
}

async function storeWith(
  recorded: readonly { token: CapabilityToken; direction?: GrantDirection }[],
): Promise<ReturnType<typeof createGrantStore>> {
  const store = createGrantStore(createMemoryStorage());
  await inSequence(recorded, async ({ token, direction }) => {
    await store.record(direction ?? "held", token, NOW);
  });

  return store;
}

describe("heldRequestToken", () => {
  it("returns a held manage:request that is valid and covers the ask", async () => {
    const token = await permission({ requestsCapability: "room:member" });
    const store = await storeWith([{ token }]);

    expect(
      await heldRequestToken(store, verification(), "room:member", ROOM),
    ).toEqual(token);
  });

  it("returns a permission that names no verb for any verb within its scope", async () => {
    const token = await permission();
    const store = await storeWith([{ token }]);

    expect(
      await heldRequestToken(store, verification(), "room:member", ROOM),
    ).toEqual(token);
  });

  it("skips a permission naming another verb, one over another scope kind, an issued one and a different capability", async () => {
    const store = await storeWith([
      { token: await permission({ requestsCapability: "exec:pty" }) },
      { token: await permission({ scope: { kind: "folder" } }) },
      { token: await permission(), direction: "issued" },
      { token: await permission({ capability: "room:member" }) },
    ]);

    expect(
      await heldRequestToken(store, verification(), "room:member", ROOM),
    ).toBeUndefined();
  });

  it("skips a permission that has expired by the time of the ask", async () => {
    const store = await storeWith([{ token: await permission() }]);

    expect(
      await heldRequestToken(
        store,
        verification(NOW + 2 * HOUR_MS),
        "room:member",
        ROOM,
      ),
    ).toBeUndefined();
  });

  it("returns nothing when no grant is held", async () => {
    expect(
      await heldRequestToken(
        await storeWith([]),
        verification(),
        "room:member",
        ROOM,
      ),
    ).toBeUndefined();
  });

  it("falls through an unusable permission to a usable one later in the store", async () => {
    const usable = await permission();
    const store = await storeWith([
      { token: await permission({ requestsCapability: "exec:pty" }) },
      { token: usable },
    ]);

    expect(
      await heldRequestToken(store, verification(), "room:member", ROOM),
    ).toEqual(usable);
  });
});

describe("describeRequestRefusal", () => {
  const refusal = (code: string): CapabilityRequestRefusedError =>
    new CapabilityRequestRefusedError("room:member", code);

  it("tells a person's no from a gate that wanted a request permission", () => {
    expect(describeRequestRefusal(refusal("denied"))).toBe(
      "the other side denied the request",
    );
    expect(describeRequestRefusal(refusal("token_required"))).toContain(
      "only accepts requests that present a request permission",
    );
  });

  it("names a presented permission that did not cover the ask", () => {
    expect(describeRequestRefusal(refusal("capability_mismatch"))).toContain(
      "does not cover this capability",
    );
    expect(describeRequestRefusal(refusal("scope_mismatch"))).toContain(
      "does not cover this conversation",
    );
    expect(describeRequestRefusal(refusal("expired"))).toBe(
      "the request permission presented was refused (expired)",
    );
  });

  it("leaves any other error to be reported as it is", () => {
    expect(describeRequestRefusal(new Error("boom"))).toBeUndefined();
  });
});
