// wire-mesh#181: core/management's path:trace -- the ungated "is my path to a peer direct or relayed, and via which hub, and what's the real RTT" diagnostic.

import { describe, expect, it } from "vitest";
import type {
  IncomingManageRequest,
  ManageOutcome,
} from "../src/domain/mesh-session.js";
import {
  PATH_TRACE_SCOPE,
  PATH_TRACE_VERB,
  buildPathTraceCommand,
  buildPathTraceResponse,
  isPathTrace,
  tracePath,
} from "../src/domain/path-trace.js";
import { deviceIdFromFillHex } from "./hex.js";

const deviceA = deviceIdFromFillHex("11");
const ARBITRARY_RTT_MS = 17;

function incomingRequestFor(
  fromDevice?: Uint8Array<ArrayBuffer>,
): IncomingManageRequest {
  return {
    requestId: 1,
    command: buildPathTraceCommand(),
    scope: PATH_TRACE_SCOPE,
    ...(fromDevice !== undefined ? { fromDevice } : {}),
    respond: async (): Promise<void> => Promise.resolve(),
  };
}

describe("isPathTrace", () => {
  it("matches path.trace's own params shape", () => {
    expect(isPathTrace({ verb: "path.trace" })).toBe(true);
  });

  it("does not match an unrelated params shape", () => {
    expect(isPathTrace({ verb: "room.leave" })).toBe(false);
  });
});

describe("buildPathTraceCommand", () => {
  it("names path:trace as the outer verb and path.trace as the inner one", () => {
    expect(buildPathTraceCommand()).toEqual({
      verb: PATH_TRACE_VERB,
      params: { verb: "path.trace" },
    });
  });
});

describe("buildPathTraceResponse", () => {
  it("reports relayed: false, with no hub-address, for a request that arrived directly (no fromDevice)", () => {
    const response = buildPathTraceResponse(
      incomingRequestFor(undefined),
      "ws://hub",
    );
    expect(response).toEqual({ result: "ok", relayed: false });
  });

  it("reports relayed: true and the given hub-address for a request that arrived relay-wrapped", () => {
    const response = buildPathTraceResponse(
      incomingRequestFor(deviceA),
      "ws://hub",
    );
    expect(response).toEqual({
      result: "ok",
      relayed: true,
      "hub-address": "ws://hub",
    });
  });

  it("omits hub-address when relayed but no address was given", () => {
    const response = buildPathTraceResponse(incomingRequestFor(deviceA));
    expect(response).toEqual({ result: "ok", relayed: true });
  });

  it("never reports a hub-address for a direct request, even if one is passed", () => {
    const response = buildPathTraceResponse(
      incomingRequestFor(undefined),
      "ws://hub",
    );
    expect(response).not.toHaveProperty("hub-address");
  });
});

describe("tracePath", () => {
  function fakeSession(outcome: ManageOutcome): {
    sendManageRequest: () => Promise<ManageOutcome>;
    calls: number;
  } {
    let calls = 0;
    return {
      sendManageRequest: async (): Promise<ManageOutcome> => {
        calls += 1;
        return Promise.resolve(outcome);
      },
      get calls(): number {
        return calls;
      },
    };
  }

  it("reports real end-to-end RTT and the remote's own relayed/hub-address for a direct trace", async () => {
    const session = fakeSession({
      result: "ok",
      relayed: true,
      "hub-address": "ws://remote-hub",
    });
    let now = 1_000;
    const clock = { now: () => now };
    const pending = tracePath({ session, clock });
    now += ARBITRARY_RTT_MS;
    const result = await pending;

    expect(result.rttMs).toBe(ARBITRARY_RTT_MS);
    expect(result.local).toEqual({ relayed: false });
    expect(result.remote).toEqual({
      relayed: true,
      hubAddress: "ws://remote-hub",
    });
    expect(result.outcome).toEqual({
      result: "ok",
      relayed: true,
      "hub-address": "ws://remote-hub",
    });
  });

  it("reports local.relayed and local.hubAddress from purely local knowledge when targetDevice is given, with no wire round trip needed for that half", async () => {
    const session = fakeSession({ result: "ok", relayed: false });
    const clock = { now: () => 0 };
    const result = await tracePath({
      session,
      clock,
      targetDevice: deviceA,
      localHubAddress: "ws://my-hub",
    });

    expect(result.local).toEqual({
      relayed: true,
      hubAddress: "ws://my-hub",
    });
  });

  it("omits remote and preserves the raw outcome when the receiver answers with a manage-error", async () => {
    const session = fakeSession({
      result: "error",
      code: "unknown-verb",
    });
    const clock = { now: () => 0 };
    const result = await tracePath({ session, clock });

    expect(result.remote).toBeUndefined();
    expect(result.outcome).toEqual({ result: "error", code: "unknown-verb" });
  });

  it("throws when an ok outcome does not actually match path-trace-ok's own shape", async () => {
    const session = fakeSession({
      result: "ok",
      // Missing the mandatory `relayed` field entirely -- a receiver that answers path.trace at all must answer it correctly.
    } as unknown as ManageOutcome);
    const clock = { now: () => 0 };
    await expect(tracePath({ session, clock })).rejects.toThrow(
      "path-trace-ok",
    );
  });
});
