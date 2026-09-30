import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import type { CapabilityToken } from "wire-mesh-core/generated/protocol";
import { mintCapabilityToken } from "wire-mesh-core/domain/tokens";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createGrantStore } from "../src/grant-store.js";

const TOKEN_ID_BYTES = 16;
const NOW = 1000;
const LATER = 2000;
const LIFETIME = 5000;
const FIRST_ID = 1;
const SECOND_ID = 2;

let issuer: IdentityPort;
let bearer: IdentityPort;
const clock = { now: () => NOW };

beforeAll(async () => {
  issuer = await createWebCryptoIdentity();
  bearer = await createWebCryptoIdentity();
});

async function grant(id: number): Promise<CapabilityToken> {
  const verdict = await mintCapabilityToken({
    identity: issuer,
    clock,
    tokenId: new Uint8Array(TOKEN_ID_BYTES).fill(id),
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: "a-room" },
    expires: NOW + LIFETIME,
  });
  if (!verdict.ok) throw new Error("expected the grant to mint");
  return verdict.token;
}

describe("grant store", () => {
  it("lists what was recorded with its direction, claims and time, most recent first", async () => {
    const store = createGrantStore(createMemoryStorage());
    await store.record("held", await grant(FIRST_ID), NOW);
    await store.record("issued", await grant(SECOND_ID), LATER);

    const records = await store.list();

    expect(
      records.map((record) => [record.direction, record.recordedAt]),
    ).toEqual([
      ["issued", LATER],
      ["held", NOW],
    ]);
    expect(records[0]?.claims.capability).toBe("room:member");
    expect(records[0]?.tokenId).toBe("02".repeat(TOKEN_ID_BYTES));
  });

  it("records a token once per direction, keeping the first time", async () => {
    const store = createGrantStore(createMemoryStorage());
    const token = await grant(FIRST_ID);
    await store.record("held", token, NOW);
    await store.record("held", token, LATER);
    await store.record("issued", token, LATER);

    const records = await store.list();

    expect(
      records.map((record) => [record.direction, record.recordedAt]),
    ).toEqual([
      ["issued", LATER],
      ["held", NOW],
    ]);
  });

  it("keeps grants across store instances over the same storage", async () => {
    const storage = createMemoryStorage();
    await createGrantStore(storage).record("held", await grant(FIRST_ID), NOW);

    expect(await createGrantStore(storage).list()).toHaveLength(1);
  });

  it("tells listeners about a newly recorded grant and not a repeat", async () => {
    const store = createGrantStore(createMemoryStorage());
    const listener = vi.fn<() => void>();
    const stop = store.subscribe(listener);
    const token = await grant(FIRST_ID);

    await store.record("held", token, NOW);
    await store.record("held", token, NOW);
    stop();
    await store.record("issued", token, NOW);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("refuses a token whose claims cannot be read", async () => {
    const store = createGrantStore(createMemoryStorage());

    await expect(
      store.record("held", [new Uint8Array(), {}, null, new Uint8Array()], NOW),
    ).rejects.toThrow("readable token claims");
  });

  it("fails loudly on a stored record that is malformed", async () => {
    const storage = createMemoryStorage();
    await storage.set("grant/held/deadbeef", new Uint8Array([0]));

    await expect(createGrantStore(storage).list()).rejects.toThrow("malformed");
  });
});
