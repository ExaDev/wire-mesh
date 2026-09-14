import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Clock } from "../src/ports/clock.js";
import type {
  CapabilityScope,
  CapabilityToken,
  DeviceId,
  ManageCommand,
} from "../src/generated/protocol.js";
import type {
  IncomingManageRequest,
  ManageOutcome,
  MeshSession,
} from "../src/domain/mesh-session.js";
import {
  buildCapabilityRequestCommand,
  createCapabilityRequestHandler,
  requestCapability,
  type CapabilityGrantDecision,
  type CapabilityGrantRequestEvent,
} from "../src/domain/capability-request.js";

const ES256 = -7;
const HOUR_MS = 3_600_000;
const NOW_MS = 1_893_456_000_000;
const TEST_CAPABILITY = "room:member";
const TEST_SCOPE: CapabilityScope = { kind: "room", path: "some-room" };

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

function fixedClock(atMs: number): Clock {
  return { now: () => atMs };
}

/** Same minimal fake MeshSession shape room-client.test.ts uses -- sendManageRequest is a mock the test configures per case; incomingManageRequests is unused here since createCapabilityRequestHandler is exercised directly against a fake IncomingManageRequest, not through a session's own drain loop. */
function fakeSession(): MeshSession {
  return {
    sendManageRequest: vi.fn(),
  } as unknown as MeshSession;
}

function fakeIncoming(
  command: ManageCommand,
  scope: CapabilityScope = TEST_SCOPE,
): { incoming: IncomingManageRequest; respond: ReturnType<typeof vi.fn> } {
  const respond = vi.fn(async (): Promise<void> => Promise.resolve());
  const incoming: IncomingManageRequest = {
    requestId: 0,
    command,
    scope,
    respond,
  };
  return { incoming, respond };
}

describe("buildCapabilityRequestCommand", () => {
  it("carries the capability string as both the outer verb and params.capability", () => {
    expect(buildCapabilityRequestCommand(TEST_CAPABILITY)).toEqual({
      verb: TEST_CAPABILITY,
      params: { verb: "capability.request", capability: TEST_CAPABILITY },
    } satisfies ManageCommand);
  });

  it("includes valid-until only when given", () => {
    expect(buildCapabilityRequestCommand(TEST_CAPABILITY, NOW_MS)).toEqual({
      verb: TEST_CAPABILITY,
      params: {
        verb: "capability.request",
        capability: TEST_CAPABILITY,
        "valid-until": NOW_MS,
      },
    } satisfies ManageCommand);
  });
});

describe("requestCapability", () => {
  it("sends an ungated request -- no token argument reaches sendManageRequest", async () => {
    const session = fakeSession();
    const grantedToken: CapabilityToken = [
      new Uint8Array(0),
      {},
      null,
      new Uint8Array(0),
    ];
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "ok",
      "granted-token": grantedToken,
    });

    const result = await requestCapability(session, TEST_CAPABILITY, TEST_SCOPE);

    expect(result["granted-token"]).toEqual(grantedToken);
    expect(session.sendManageRequest).toHaveBeenCalledTimes(1);
    const [command, scope, targetDevice, token, timeoutMs] = vi.mocked(
      session.sendManageRequest,
    ).mock.calls[0] as [
      ManageCommand,
      CapabilityScope,
      DeviceId | undefined,
      CapabilityToken | undefined,
      number | undefined,
    ];
    expect(command).toEqual(buildCapabilityRequestCommand(TEST_CAPABILITY));
    expect(scope).toEqual(TEST_SCOPE);
    expect(targetDevice).toBeUndefined();
    expect(token).toBeUndefined();
    expect(timeoutMs).toBeUndefined();
  });

  it("forwards timeoutMs to sendManageRequest", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "ok",
      "granted-token": [new Uint8Array(0), {}, null, new Uint8Array(0)],
    });

    await requestCapability(session, TEST_CAPABILITY, TEST_SCOPE, undefined, 5_000);

    const [, , , , timeoutMs] = vi.mocked(session.sendManageRequest).mock
      .calls[0] as [unknown, unknown, unknown, unknown, number | undefined];
    expect(timeoutMs).toBe(5_000);
  });

  it("throws with the refusal code when the request is refused", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "error",
      code: "denied",
    } satisfies ManageOutcome);

    await expect(
      requestCapability(session, TEST_CAPABILITY, TEST_SCOPE),
    ).rejects.toThrow(/denied/);
  });

  it("throws when the grant response is malformed", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "ok",
    } as unknown as ManageOutcome);

    await expect(
      requestCapability(session, TEST_CAPABILITY, TEST_SCOPE),
    ).rejects.toThrow(/malformed/);
  });
});

describe("createCapabilityRequestHandler", () => {
  async function makeHandler(overrides?: {
    onRequest?: (event: Readonly<CapabilityGrantRequestEvent>) => void;
    timeoutMs?: number;
    capability?: string;
  }): Promise<{
    handle: (incoming: Readonly<IncomingManageRequest>) => Promise<void>;
    identity: IdentityPort;
    bearer: IdentityPort;
    onRequest: ReturnType<typeof vi.fn>;
  }> {
    const identity = await generateEs256Identity();
    const bearer = await generateEs256Identity();
    const onRequest =
      overrides?.onRequest !== undefined
        ? vi.fn(overrides.onRequest)
        : vi.fn<(event: Readonly<CapabilityGrantRequestEvent>) => void>();
    const handle = createCapabilityRequestHandler({
      capability: overrides?.capability ?? TEST_CAPABILITY,
      identity,
      clock: fixedClock(NOW_MS),
      bearerDevice: bearer.deviceId,
      timeoutMs: overrides?.timeoutMs ?? HOUR_MS,
      onRequest,
    });
    return { handle, identity, bearer, onRequest };
  }

  it("refuses a request whose capability does not match this handler's own", async () => {
    const { handle, onRequest } = await makeHandler({ capability: "exec:pty" });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityRequestCommand(TEST_CAPABILITY),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({ result: "error", code: "malformed" });
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("refuses an already-expired request without ever invoking onRequest", async () => {
    const { handle, onRequest } = await makeHandler();
    const { incoming, respond } = fakeIncoming(
      buildCapabilityRequestCommand(TEST_CAPABILITY, NOW_MS - 1),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({ result: "error", code: "expired" });
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("accepts a request whose valid-until has not yet passed", async () => {
    const { handle, onRequest } = await makeHandler({
      onRequest: (event) => {
        void event.decide({
          kind: "accept",
          capability: TEST_CAPABILITY,
          expires: NOW_MS + HOUR_MS,
        });
      },
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityRequestCommand(TEST_CAPABILITY, NOW_MS + 1),
    );

    await handle(incoming);

    expect(onRequest).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ result: "ok" }),
      );
    });
  });

  it("auto-rejects with a real manage-error, not a hang, when no decision arrives within timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const TIMEOUT_MS = 1_000;
      const { handle, onRequest } = await makeHandler({
        timeoutMs: TIMEOUT_MS,
        onRequest: () => {
          // Deliberately never calls decide() -- simulates a human who never answers.
        },
      });
      const { incoming, respond } = fakeIncoming(
        buildCapabilityRequestCommand(TEST_CAPABILITY),
      );

      await handle(incoming);
      expect(onRequest).toHaveBeenCalledTimes(1);
      expect(respond).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ result: "error", code: "timeout" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("never answers twice -- a late decide() after the timeout already fired is a no-op", async () => {
    vi.useFakeTimers();
    try {
      const TIMEOUT_MS = 1_000;
      let lateDecide: CapabilityGrantRequestEvent["decide"] | undefined;
      const { handle } = await makeHandler({
        timeoutMs: TIMEOUT_MS,
        onRequest: (event) => {
          lateDecide = event.decide;
        },
      });
      const { incoming, respond } = fakeIncoming(
        buildCapabilityRequestCommand(TEST_CAPABILITY),
      );

      await handle(incoming);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      expect(respond).toHaveBeenCalledTimes(1);

      if (lateDecide === undefined) throw new Error("onRequest never fired");
      await lateDecide({
        kind: "accept",
        capability: TEST_CAPABILITY,
        expires: NOW_MS + HOUR_MS,
      });

      expect(respond).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mints and returns a fresh token on accept, merging any domain-supplied extension fields", async () => {
    const { handle, onRequest, bearer } = await makeHandler({
      onRequest: (event) => {
        void event.decide({
          kind: "accept",
          capability: TEST_CAPABILITY,
          expires: NOW_MS + HOUR_MS,
          extensions: { members: [{ device: bearerPlaceholder() }] },
        });
      },
    });
    function bearerPlaceholder(): DeviceId {
      return bearer.deviceId;
    }
    const { incoming, respond } = fakeIncoming(
      buildCapabilityRequestCommand(TEST_CAPABILITY),
    );

    await handle(incoming);

    expect(onRequest).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1);
    });
    const outcome = respond.mock.calls[0]?.[0] as {
      result: string;
      "granted-token": CapabilityToken;
      members: { device: DeviceId }[];
    };
    expect(outcome.result).toBe("ok");
    expect(outcome["granted-token"]).toBeDefined();
    expect(outcome.members).toEqual([{ device: bearer.deviceId }]);
  });

  it("responds with an ordinary manage-error on reject, carrying the given reason", async () => {
    const { handle } = await makeHandler({
      onRequest: (event) => {
        void event.decide({ kind: "reject", reason: "not now" });
      },
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityRequestCommand(TEST_CAPABILITY),
    );

    await handle(incoming);

    expect(respond).toHaveBeenCalledWith({
      result: "error",
      code: "denied",
      message: "not now",
    });
  });

  it("passes the requester's device-id and the request's own scope through to onRequest", async () => {
    let seen: CapabilityGrantRequestEvent | undefined;
    const { handle, bearer } = await makeHandler({
      onRequest: (event) => {
        seen = event;
      },
    });
    const { incoming } = fakeIncoming(
      buildCapabilityRequestCommand(TEST_CAPABILITY),
      TEST_SCOPE,
    );

    await handle(incoming);

    expect(seen).toBeDefined();
    expect(deviceIdToHex(seen?.requesterDevice as DeviceId)).toBe(
      deviceIdToHex(bearer.deviceId),
    );
    expect(seen?.scope).toEqual(TEST_SCOPE);
  });
});

describe("round trip: requestCapability against createCapabilityRequestHandler", () => {
  it("grants a real, verifiable token end to end on accept", async () => {
    const owner = await generateEs256Identity();
    const requester = await generateEs256Identity();
    const handle = createCapabilityRequestHandler({
      capability: TEST_CAPABILITY,
      identity: owner,
      clock: fixedClock(NOW_MS),
      bearerDevice: requester.deviceId,
      timeoutMs: HOUR_MS,
      onRequest: (event) => {
        void event.decide({
          kind: "accept",
          capability: TEST_CAPABILITY,
          expires: NOW_MS + HOUR_MS,
        });
      },
    });
    const { incoming, respond } = fakeIncoming(
      buildCapabilityRequestCommand(TEST_CAPABILITY),
      TEST_SCOPE,
    );

    await handle(incoming);

    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1);
    });
    const outcome = respond.mock.calls[0]?.[0] as ManageOutcome;
    expect(outcome.result).toBe("ok");
  });

  it("refuses on reject with an ordinary manage-error the requester side surfaces as a thrown error", async () => {
    const session = fakeSession();
    vi.mocked(session.sendManageRequest).mockResolvedValue({
      result: "error",
      code: "denied",
      message: "not now",
    });

    await expect(
      requestCapability(session, TEST_CAPABILITY, TEST_SCOPE),
    ).rejects.toThrow(/denied/);
  });
});

const _decisionShapeCheck: CapabilityGrantDecision = {
  kind: "reject",
  reason: "type-only sanity check",
};
void _decisionShapeCheck;
