import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { createRevocationView } from "wire-mesh-core/domain/revocation-view";
import {
  mintCapabilityToken,
  mintRevocationEntry,
  type RevocationCheck,
} from "wire-mesh-core/domain/tokens";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import {
  createPersistentRoomKeyStore,
  createPersistentRoomTokenStore,
} from "../src/persistent-room-state.js";

const NOW_MS = 1_000_000;
const LIFETIME_MS = 60_000;
const TOKEN_ID = Uint8Array.from([1]);
const ROOM = "owner/room";

/** A revocation view that has recorded nothing, so every otherwise valid token passes. */
const NOTHING_REVOKED: RevocationCheck = {
  entriesFor: async () => Promise.resolve([]),
};
const SECOND_EPOCH = 2;
const TENTH_EPOCH = 10;

function clockAt(now: number): Clock {
  return { now: () => now };
}

async function roomToken(
  issuer: IdentityPort,
  bearer: IdentityPort,
): ReturnType<typeof mintCapabilityToken> {
  return mintCapabilityToken({
    identity: issuer,
    clock: clockAt(NOW_MS),
    tokenId: TOKEN_ID,
    bearer: bearer.deviceId,
    capability: "room:member",
    scope: { kind: "room", path: ROOM },
    expires: NOW_MS + LIFETIME_MS,
    delegationsRemaining: 0,
  });
}

describe("createPersistentRoomKeyStore", () => {
  it("returns a key and the highest epoch from a store built over the same storage later", async () => {
    const storage = createMemoryStorage();
    const first = createPersistentRoomKeyStore(storage);
    await first.set(ROOM, SECOND_EPOCH, Uint8Array.from([2]));
    await first.set(ROOM, TENTH_EPOCH, Uint8Array.from([TENTH_EPOCH]));

    const reloaded = createPersistentRoomKeyStore(storage);

    expect(await reloaded.get(ROOM, SECOND_EPOCH)).toEqual(
      Uint8Array.from([2]),
    );
    expect(await reloaded.currentEpoch(ROOM)).toBe(TENTH_EPOCH);
  });

  it("has no epoch for a room it holds nothing for", async () => {
    const store = createPersistentRoomKeyStore(createMemoryStorage());
    expect(await store.currentEpoch(ROOM)).toBeUndefined();
  });
});

describe("createPersistentRoomTokenStore", () => {
  it("restores a token that is still valid for the same device", async () => {
    const owner = await createWebCryptoIdentity();
    const member = await createWebCryptoIdentity();
    const minted = await roomToken(owner, member);
    if (!minted.ok) throw new Error(minted.reason);
    const storage = createMemoryStorage();
    await createPersistentRoomTokenStore(
      storage,
      member,
      clockAt(NOW_MS),
      NOTHING_REVOKED,
    ).set(ROOM, minted.token);

    const restored = await createPersistentRoomTokenStore(
      storage,
      member,
      clockAt(NOW_MS),
      NOTHING_REVOKED,
    ).get(ROOM);

    expect(restored).toEqual(minted.token);
  });

  it("drops a stored token once it has expired", async () => {
    const owner = await createWebCryptoIdentity();
    const member = await createWebCryptoIdentity();
    const minted = await roomToken(owner, member);
    if (!minted.ok) throw new Error(minted.reason);
    const storage = createMemoryStorage();
    const later = clockAt(NOW_MS + LIFETIME_MS + 1);
    const store = createPersistentRoomTokenStore(
      storage,
      member,
      later,
      NOTHING_REVOKED,
    );
    await store.set(ROOM, minted.token);

    expect(await store.get(ROOM)).toBeUndefined();
    expect(await storage.keys("room-token/")).toEqual([]);
  });

  it("drops a stored token issued to a different device", async () => {
    const owner = await createWebCryptoIdentity();
    const member = await createWebCryptoIdentity();
    const other = await createWebCryptoIdentity();
    const minted = await roomToken(owner, member);
    if (!minted.ok) throw new Error(minted.reason);
    const storage = createMemoryStorage();
    const store = createPersistentRoomTokenStore(
      storage,
      other,
      clockAt(NOW_MS),
      NOTHING_REVOKED,
    );
    await store.set(ROOM, minted.token);

    expect(await store.get(ROOM)).toBeUndefined();
  });

  it("drops a stored token its issuer has since revoked", async () => {
    const owner = await createWebCryptoIdentity();
    const member = await createWebCryptoIdentity();
    const minted = await roomToken(owner, member);
    if (!minted.ok) throw new Error(minted.reason);
    const storage = createMemoryStorage();
    const revocations = createRevocationView();
    const store = createPersistentRoomTokenStore(
      storage,
      member,
      clockAt(NOW_MS),
      revocations,
    );
    await store.set(ROOM, minted.token);
    expect(await store.get(ROOM)).toEqual(minted.token);

    const recorded = await revocations.record(
      await mintRevocationEntry({
        identity: owner,
        tokenId: TOKEN_ID,
        revokedAt: NOW_MS,
      }),
      { identity: member },
    );
    expect(recorded.ok).toBe(true);

    expect(await store.get(ROOM)).toBeUndefined();
    expect(await storage.keys("room-token/")).toEqual([]);
  });
});
