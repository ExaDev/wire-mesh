// The threshold consumers over a real MeshSession: a request whose handling fails (here, its answer cannot be sent because the link refuses writes) is contained to it, reported once, and the next request is still served, with no unhandled rejection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryNonceStore } from "../src/adapters/memory-nonce-store.js";
import { runFreshThresholdDkg } from "../src/adapters/threshold-dkg.js";
import { startThresholdParticipant } from "../src/adapters/threshold-participant.js";
import { createMeshSession } from "../src/domain/mesh-session.js";
import {
  buildCommitCommand,
  buildKeygenRound2Command,
  THRESHOLD_GROUP_SCOPE,
} from "../src/domain/threshold-network.js";
import type { ManageOutcome } from "../src/domain/mesh-session.js";
import type { Frame } from "../src/generated/protocol.js";
import {
  fakeTransport,
  identityA,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";
import { RelayPeer } from "./relay-peer.js";
import { fixedClock, neverRevoked } from "./tokens-fixtures.js";

const FIRST_REQUEST = 11;
const SECOND_REQUEST = 12;
const SESSION_ID = 1n;
const NOW_MS = 1_000_000;
const SOON_MS = 1_000;
const THRESHOLD = 2;
const SHARE_BYTES = 8;
const CEREMONY_TIMEOUT_MS = 200;
const GROUP_DEVICE_BYTE = 9;
const DEVICE_ID_LENGTH = 32;

const unhandled: unknown[] = [];
function recordUnhandled(reason: unknown): void {
  unhandled.push(reason);
}

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", recordUnhandled);
});

afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
});

async function liveSession(): Promise<{
  session: ReturnType<typeof createMeshSession>;
  connection: ReturnType<typeof fakeTransport>["connection"];
  peer: RelayPeer;
}> {
  const { transport, connection } = fakeTransport();
  const session = createMeshSession(transport, testIdentity, testClock);
  await session.connect("ws://node", ["core/management"]);
  const peer = new RelayPeer(identityA, testIdentity, connection);
  await peer.openTowardSession();

  return { session, connection, peer };
}

/** Delivers `frame` with the link refusing writes until the session has tried and failed to answer it, then lets writes through again. */
async function deliverWhileLinkIsDown(
  harness: Awaited<ReturnType<typeof liveSession>>,
  frame: Frame,
): Promise<void> {
  const before = harness.connection.rejectedSendCount;
  harness.connection.rejectSends(
    new Error("the link stopped accepting writes"),
  );
  await harness.peer.deliver(frame);
  await vi.waitFor(() => {
    if (harness.connection.rejectedSendCount <= before) {
      throw new Error("the session has not tried to answer yet");
    }
  });
  harness.connection.acceptSends();
}

function answerTo(frames: readonly Frame[], requestId: number): ManageOutcome {
  const response = frames.find(
    (frame) =>
      frame.type === "manage-response" && frame["request-id"] === requestId,
  );
  if (response?.type !== "manage-response") {
    throw new Error(`no answer to request ${String(requestId)}`);
  }

  return response.outcome;
}

describe("the threshold participant's loop", () => {
  it("serves the request after one whose answer could not be sent, and reports the failure once", async () => {
    const harness = await liveSession();
    const faults: unknown[] = [];
    startThresholdParticipant({
      session: harness.session,
      personalIdentity: testIdentity,
      keyPackagesByGroup: new Map(),
      nonceStore: createMemoryNonceStore(),
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
      onFault: (error) => {
        faults.push(error);
      },
    });
    const groupDevice = new Uint8Array(DEVICE_ID_LENGTH);
    groupDevice[DEVICE_ID_LENGTH - 1] = GROUP_DEVICE_BYTE;
    const command = buildCommitCommand(
      SESSION_ID,
      groupDevice,
      {
        kind: "capability-token",
        protected: new Uint8Array([1]),
        payload: new Uint8Array([2]),
      },
      NOW_MS + SOON_MS,
    );
    const request = (requestId: number): Frame => ({
      type: "manage-request",
      "request-id": requestId,
      command,
      scope: THRESHOLD_GROUP_SCOPE,
    });

    await deliverWhileLinkIsDown(harness, request(FIRST_REQUEST));
    await harness.peer.deliver(request(SECOND_REQUEST));

    expect(answerTo(await harness.peer.received(), SECOND_REQUEST)).toEqual({
      result: "error",
      code: "unauthorized",
    });
    expect(faults).toHaveLength(1);
    expect(unhandled).toEqual([]);
    await harness.session.close();
  });
});

describe("the DKG consumer's loop", () => {
  it("serves the request after one whose answer could not be sent, and reports the failure once", async () => {
    const harness = await liveSession();
    const faults: unknown[] = [];
    const ceremony = runFreshThresholdDkg({
      session: harness.session,
      ownDeviceId: testIdentity.deviceId,
      otherParticipants: [harness.peer.deviceId],
      threshold: THRESHOLD,
      sessionId: SESSION_ID,
      timeoutMs: CEREMONY_TIMEOUT_MS,
      onFault: (error) => {
        faults.push(error);
      },
    }).catch(() => undefined);
    // The ceremony's own first message has gone out; what follows is the peer's.
    await harness.peer.received();
    const round2 = (requestId: number): Frame => ({
      type: "manage-request",
      "request-id": requestId,
      command: buildKeygenRound2Command(
        SESSION_ID,
        new Uint8Array(SHARE_BYTES),
        false,
      ),
      scope: THRESHOLD_GROUP_SCOPE,
    });

    await deliverWhileLinkIsDown(harness, round2(FIRST_REQUEST));
    await harness.peer.deliver(round2(SECOND_REQUEST));

    expect(answerTo(await harness.peer.received(), SECOND_REQUEST)).toEqual({
      result: "ok",
    });
    expect(faults).toHaveLength(1);
    expect(unhandled).toEqual([]);
    // The ceremony itself is still waiting for the peer's first round; it is not what this test is about.
    void ceremony;
    await harness.session.close();
  });
});
