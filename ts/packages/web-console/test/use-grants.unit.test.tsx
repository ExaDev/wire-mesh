// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import type { GrantRecord, GrantStore } from "../src/grant-store.js";
import { decodeGrantClaims } from "../src/grants.js";
import { useGrants } from "../src/hooks/use-grants.js";
import { mintGrant } from "../src/mint-grant.js";
import { testCapabilities } from "./capability-services.js";

const NOW = 1000;
const HOURS = 24;
const clock = { now: () => NOW };
const STORAGE_FAILURE = "the origin's storage quota is exhausted";

let own: IdentityPort;
let other: IdentityPort;

beforeAll(async () => {
  own = await createWebCryptoIdentity();
  other = await createWebCryptoIdentity();
});

afterEach(() => {
  cleanup();
});

async function issuedRecord(): Promise<GrantRecord> {
  const minted = await mintGrant(
    {
      bearerHex: deviceIdToHex(other.deviceId),
      capability: "room:member",
      scopeKind: "room",
      scopePath: "a-room",
      lifetimeHours: HOURS,
      delegationsRemaining: undefined,
      parent: undefined,
    },
    { identity: own, clock },
  );
  if (!minted.ok) throw new Error(minted.error);
  const claims = decodeGrantClaims(minted.token);
  if (claims === undefined) throw new Error("minted token has no claims");
  return {
    tokenId: "issued-1",
    direction: "issued",
    token: minted.token,
    claims,
    recordedAt: NOW,
  };
}

/** A grant store whose `list` answers are handed out by the test, in the order they are asked for, and whose change notification the test can fire. */
function scriptedStore(): {
  store: GrantStore;
  answers: PromiseWithResolvers<GrantRecord[]>[];
  notify: () => void;
} {
  const answers: PromiseWithResolvers<GrantRecord[]>[] = [];
  const listeners = new Set<() => void>();
  const store: GrantStore = {
    record: async () => Promise.resolve(),
    list: async () => {
      const answer = Promise.withResolvers<GrantRecord[]>();
      answers.push(answer);
      return answer.promise;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    store,
    answers,
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
}

describe("useGrants", () => {
  it("keeps the rows of the most recently started load when an older one settles later", async () => {
    const record = await issuedRecord();
    const { revocations } = await testCapabilities(own, clock);
    const scripted = scriptedStore();
    const { result } = renderHook(() =>
      useGrants({
        identity: own,
        clock,
        grants: scripted.store,
        revocations,
        announce: async () => Promise.resolve({ attempted: 0, reached: 0 }),
      }),
    );
    await waitFor(() => {
      expect(scripted.answers).toHaveLength(1);
    });

    act(() => {
      scripted.notify();
    });
    await waitFor(() => {
      expect(scripted.answers).toHaveLength(2);
    });
    await act(async () => {
      scripted.answers[1]?.resolve([]);
      await Promise.resolve();
    });
    // The older load settles last, and its judging of the record is what would overwrite the newer rows.
    const judged = vi.spyOn(own, "verify");
    await act(async () => {
      scripted.answers[0]?.resolve([record]);
      await vi.waitFor(() => {
        expect(judged).toHaveBeenCalled();
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    expect(result.current.rows).toEqual([]);
    judged.mockRestore();
  });

  it("reports why the grants could not be read, and clears it once a load succeeds", async () => {
    const record = await issuedRecord();
    const { revocations } = await testCapabilities(own, clock);
    const scripted = scriptedStore();
    const failing: GrantStore = {
      ...scripted.store,
      list: vi
        .fn<GrantStore["list"]>()
        .mockRejectedValueOnce(new Error(STORAGE_FAILURE))
        .mockResolvedValue([record]),
    };
    const { result } = renderHook(() =>
      useGrants({
        identity: own,
        clock,
        grants: failing,
        revocations,
        announce: async () => Promise.resolve({ attempted: 0, reached: 0 }),
      }),
    );

    await waitFor(() => {
      expect(result.current.loadError).toBe(STORAGE_FAILURE);
    });

    act(() => {
      scripted.notify();
    });

    await waitFor(() => {
      expect(result.current.loadError).toBeUndefined();
    });
    expect(result.current.rows).toHaveLength(1);
  });
});
