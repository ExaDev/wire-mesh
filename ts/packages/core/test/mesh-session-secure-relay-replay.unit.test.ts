// Through a real session: a relayed request and its reply still round-trip, and an older hello replayed by the relay costs this side one hello and leaves the channel it holds working (spec/secure-channel.cddl, obligations 7 to 9).

import { describe, expect, it, vi } from "vitest";
import { tryDecodeFrame } from "../src/adapters/frame-codec.js";
import { HANDSHAKE_WINDOW_MS } from "../src/domain/relay-channels.js";
import {
  createMeshSession,
  type IncomingManageRequest,
} from "../src/domain/mesh-session.js";
import type {
  CapabilityScope,
  Frame,
  ManageCommand,
} from "../src/generated/protocol.js";
import {
  fakeTransport,
  identityA,
  testIdentity,
} from "./mesh-session-fixtures.js";
import { RelayPeer } from "./relay-peer.js";

const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const scope: CapabilityScope = { kind: "folder" };
const FIRST_REQUEST_ID = 51;
const SECOND_REQUEST_ID = 52;
const THIRD_REQUEST_ID = 53;
const REQUESTS_ANSWERED = 3;
const SETTLE_MS = 30;

async function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, SETTLE_MS);
  });
}

function helloPayloads(frames: readonly Frame[]): Frame[] {
  return frames.filter(
    (frame) =>
      frame.type === "relay-data" &&
      tryDecodeFrame(frame.payload)?.type === "secure-hello",
  );
}

describe("a session reached through a relay", () => {
  it("round-trips a request and its reply, and answers a replayed older hello once, leaving its channel working", async () => {
    let now = 0;
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, {
      now: () => now,
    });
    await session.connect("ws://node", ["core/management"]);
    const incoming: IncomingManageRequest[] = [];
    void (async (): Promise<void> => {
      for await (const request of session.incomingManageRequests) {
        incoming.push(request);
      }
    })();
    const pushed: Frame[] = [];
    const push = connection.push.bind(connection);
    connection.push = (frame): void => {
      pushed.push(frame);
      push(frame);
    };

    const first = new RelayPeer(identityA, testIdentity, connection);
    await first.openTowardSession();
    await first.deliver({
      type: "manage-request",
      "request-id": FIRST_REQUEST_ID,
      command,
      scope,
    });
    await vi.waitFor(() => {
      expect(incoming).toHaveLength(1);
    });
    await incoming[0]?.respond({ result: "ok" });
    expect(await first.received()).toEqual([
      expect.objectContaining({ type: "manage-response" }),
    ]);

    // The same device reconnects with a new channel, which its first request confirms.
    const second = new RelayPeer(identityA, testIdentity, connection);
    await second.openTowardSession();
    await second.deliver({
      type: "manage-request",
      "request-id": SECOND_REQUEST_ID,
      command,
      scope,
    });
    await vi.waitFor(() => {
      expect(incoming).toHaveLength(2);
    });
    now += HANDSHAKE_WINDOW_MS + 1;

    const [older] = helloPayloads(pushed);
    const hellosBefore = helloPayloads(connection.sent).length;
    if (older === undefined) {
      throw new Error("no hello was relayed");
    }
    connection.push(older);
    await vi.waitFor(() => {
      expect(helloPayloads(connection.sent)).toHaveLength(hellosBefore + 1);
    });
    // Nothing further follows: the session answers once.
    await settle();
    expect(helloPayloads(connection.sent)).toHaveLength(hellosBefore + 1);

    // The channel the second peer confirmed is unchanged.
    await second.deliver({
      type: "manage-request",
      "request-id": THIRD_REQUEST_ID,
      command,
      scope,
    });
    await vi.waitFor(() => {
      expect(incoming).toHaveLength(REQUESTS_ANSWERED);
    });
    await session.close();
  });
});
