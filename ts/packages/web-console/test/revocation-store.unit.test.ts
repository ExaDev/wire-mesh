import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { mintRevocationEntry } from "wire-mesh-core/domain/tokens";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { createRevocationStore } from "../src/revocation-store.js";

const TOKEN_ID_BYTES = 16;
const TOKEN_ID_FILL = 7;
const NOW = 1000;

let own: IdentityPort;
let other: IdentityPort;
const clock = { now: () => NOW };
const tokenId = (): Uint8Array<ArrayBuffer> =>
  new Uint8Array(TOKEN_ID_BYTES).fill(TOKEN_ID_FILL);

beforeAll(async () => {
  own = await createWebCryptoIdentity();
  other = await createWebCryptoIdentity();
});

describe("revocation store", () => {
  it("records a revocation it mints, so the view reports it", async () => {
    const store = await createRevocationStore({
      storage: createMemoryStorage(),
      identity: own,
      clock,
    });

    await store.revoke(tokenId());

    const entries = await store.view.entriesFor(tokenId());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.["revoked-at"]).toBe(NOW);
  });

  it("keeps a revocation across store instances over the same storage", async () => {
    const storage = createMemoryStorage();
    await (
      await createRevocationStore({ storage, identity: own, clock })
    ).revoke(tokenId());

    const reloaded = await createRevocationStore({
      storage,
      identity: own,
      clock,
    });

    expect(await reloaded.view.entriesFor(tokenId())).toHaveLength(1);
  });

  it("records a verified revocation heard from another issuer", async () => {
    const store = await createRevocationStore({
      storage: createMemoryStorage(),
      identity: own,
      clock,
    });

    const verdict = await store.ingest(
      await mintRevocationEntry({
        identity: other,
        tokenId: tokenId(),
        revokedAt: NOW,
      }),
    );

    expect(verdict.ok).toBe(true);
    expect(await store.view.entriesFor(tokenId())).toHaveLength(1);
  });

  it("drops an entry that does not verify, storing and announcing nothing", async () => {
    const storage = createMemoryStorage();
    const store = await createRevocationStore({
      storage,
      identity: own,
      clock,
    });
    const listener = vi.fn<() => void>();
    store.subscribe(listener);
    const genuine = await mintRevocationEntry({
      identity: other,
      tokenId: tokenId(),
      revokedAt: NOW,
    });
    const forged: typeof genuine = [
      genuine[0],
      genuine[1],
      genuine[2],
      new Uint8Array(genuine[3].length),
    ];

    const verdict = await store.ingest(forged);

    expect(verdict).toEqual({ ok: false, reason: "bad_signature" });
    expect(await store.view.entriesFor(tokenId())).toEqual([]);
    expect(await storage.keys("revocation/")).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("tells listeners about each newly recorded revocation", async () => {
    const store = await createRevocationStore({
      storage: createMemoryStorage(),
      identity: own,
      clock,
    });
    const listener = vi.fn<() => void>();
    store.subscribe(listener);

    await store.revoke(tokenId());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe("a stored revocation that cannot be loaded", () => {
    const MALFORMED_KEY = "revocation/x/y";
    const NOT_CBOR_KEY = "revocation/x/z";
    const BREAK_CODE = 0xff;
    const CBOR_ZERO = 0;

    it("starts anyway, loading what is readable and listing what is not with the reason", async () => {
      const storage = createMemoryStorage();
      await (
        await createRevocationStore({ storage, identity: own, clock })
      ).revoke(tokenId());
      await storage.set(MALFORMED_KEY, new Uint8Array([CBOR_ZERO]));
      await storage.set(NOT_CBOR_KEY, new Uint8Array([BREAK_CODE]));

      const store = await createRevocationStore({
        storage,
        identity: own,
        clock,
      });

      expect(await store.view.entriesFor(tokenId())).toHaveLength(1);
      expect(store.unreadable()).toEqual([
        { key: MALFORMED_KEY, reason: "it is not a revocation entry" },
        { key: NOT_CBOR_KEY, reason: "it is not valid CBOR" },
      ]);
    });

    it("lists nothing when every stored revocation loads", async () => {
      const storage = createMemoryStorage();
      await (
        await createRevocationStore({ storage, identity: own, clock })
      ).revoke(tokenId());

      const store = await createRevocationStore({
        storage,
        identity: own,
        clock,
      });

      expect(store.unreadable()).toEqual([]);
    });

    it("deletes a discarded entry from storage and the list, and tells listeners", async () => {
      const storage = createMemoryStorage();
      await storage.set(MALFORMED_KEY, new Uint8Array([CBOR_ZERO]));
      const store = await createRevocationStore({
        storage,
        identity: own,
        clock,
      });
      const listener = vi.fn<() => void>();
      store.subscribe(listener);
      const before = store.unreadable();

      await store.discardUnreadable(MALFORMED_KEY);

      expect(store.unreadable()).toEqual([]);
      expect(store.unreadable()).not.toBe(before);
      expect(await storage.get(MALFORMED_KEY)).toBeUndefined();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("returns the same list until something is discarded, so it can back a subscription", async () => {
      const storage = createMemoryStorage();
      await storage.set(MALFORMED_KEY, new Uint8Array([CBOR_ZERO]));
      const store = await createRevocationStore({
        storage,
        identity: own,
        clock,
      });

      expect(store.unreadable()).toBe(store.unreadable());
    });
  });
});
