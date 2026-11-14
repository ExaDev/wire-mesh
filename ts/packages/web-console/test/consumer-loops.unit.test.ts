// The console's consumers of a session's incoming requests, over a real MeshSession: a request whose handling fails (its answer cannot be sent because the link refuses writes) is contained to it, reported once, and the next request is still served, with no unhandled rejection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestDemux } from "../src/request-demux.js";
import { createRoomRouter, buildRoomSendCommand } from "../src/room-client.js";
import { createWebrtcNegotiator } from "../src/webrtc-negotiation.js";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { buildIceCandidateCommand } from "wire-mesh-core/domain/webrtc-signaling";
import type { IncomingManageRequest } from "wire-mesh-core/domain/mesh-session";
import type {
  CapabilityScope,
  Frame,
  ManageCommand,
} from "wire-mesh-core/generated/protocol";
import { answerTo, liveSession, type LiveSession } from "./live-session.js";

const FIRST_REQUEST = 21;
const SECOND_REQUEST = 22;
const NEGOTIATION_ID = 5;
const MESSAGE_ID_BYTES = 16;
const MESSAGE_ID = new Uint8Array(MESSAGE_ID_BYTES);
const SENT_AT = 1_000;
const NEVER_REVOKED = { entriesFor: async () => Promise.resolve([]) };

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

function request(
  requestId: number,
  command: ManageCommand,
  scope: Readonly<CapabilityScope>,
): Frame {
  return { type: "manage-request", "request-id": requestId, command, scope };
}

/** Sends `frame` while the link refuses writes, until the session has tried and failed to answer it, then lets writes through again. */
async function sendWhileLinkIsDown(
  live: LiveSession,
  frame: Frame,
): Promise<void> {
  const before = live.rejectedSends();
  live.rejectSends();
  live.push(frame);
  await vi.waitFor(() => {
    if (live.rejectedSends() <= before) {
      throw new Error("the session has not tried to answer yet");
    }
  });
  live.acceptSends();
}

describe("the WebRTC negotiator's loop", () => {
  it("serves the request after one whose answer could not be sent, and reports the failure once", async () => {
    const identity = await createWebCryptoIdentity();
    const live = await liveSession(identity, ["core/webrtc"]);
    const faults: unknown[] = [];
    createWebrtcNegotiator(
      {
        sendManageRequest: async (...args) =>
          live.session.sendManageRequest(...args),
        incomingManageRequests: live.session.incomingManageRequests,
      },
      {
        identity,
        clock: { now: () => 0 },
        revocation: NEVER_REVOKED,
        iceServers: [],
        onIncomingConnection: () => undefined,
        onFault: (error) => {
          faults.push(error);
        },
      },
    );
    const iceCandidate = (requestId: number): Frame =>
      request(requestId, buildIceCandidateCommand(NEGOTIATION_ID), {
        kind: "node",
      });

    await sendWhileLinkIsDown(live, iceCandidate(FIRST_REQUEST));
    live.push(iceCandidate(SECOND_REQUEST));

    await vi.waitFor(() => {
      expect(answerTo(live.sent, SECOND_REQUEST)).toMatchObject({
        outcome: { result: "ok" },
      });
    });
    expect(faults).toHaveLength(1);
    expect(unhandled).toEqual([]);
    await live.session.close();
  });
});

describe("the room router's loop", () => {
  it("serves the request after one whose answer could not be sent, and reports the failure once", async () => {
    const identity = await createWebCryptoIdentity();
    const live = await liveSession(identity, ["core/room"]);
    const faults: unknown[] = [];
    createRoomRouter(
      { incomingManageRequests: live.session.incomingManageRequests },
      {
        identity,
        clock: { now: () => 0 },
        revocation: NEVER_REVOKED,
        peerDevice: identity.deviceId,
        onFault: (error) => {
          faults.push(error);
        },
      },
      {},
    );
    // A room.send with no token is refused, which is an answer the session has to send.
    const send = (requestId: number): Frame =>
      request(requestId, buildRoomSendCommand("hello", MESSAGE_ID, SENT_AT), {
        kind: "room",
      });

    await sendWhileLinkIsDown(live, send(FIRST_REQUEST));
    live.push(send(SECOND_REQUEST));

    await vi.waitFor(() => {
      expect(answerTo(live.sent, SECOND_REQUEST)).toMatchObject({
        outcome: { result: "error", code: "unauthorized" },
      });
    });
    expect(faults).toHaveLength(1);
    expect(unhandled).toEqual([]);
    await live.session.close();
  });
});

describe("the request demux", () => {
  it("delivers what came before its source failed, and reports the failure once", async () => {
    const faults: unknown[] = [];
    const delivered: IncomingManageRequest[] = [];
    async function* source(): AsyncGenerator<IncomingManageRequest> {
      yield await Promise.resolve({
        requestId: FIRST_REQUEST,
        command: { verb: "exec:proc", params: { verb: "exec.list" } },
        scope: { kind: "folder" },
        respond: async () => Promise.resolve(),
      });
      throw new Error("the session went away");
    }
    const demux = createRequestDemux(source(), ["exec:proc"], {
      onFault: (error) => {
        faults.push(error);
      },
    });
    for await (const item of demux.stream("exec:proc")) {
      delivered.push(item);
      break;
    }

    await vi.waitFor(() => {
      expect(faults).toHaveLength(1);
    });
    expect(delivered.map((item) => item.requestId)).toEqual([FIRST_REQUEST]);
    expect(unhandled).toEqual([]);
  });
});
