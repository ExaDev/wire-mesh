import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityScope,
  ManageCommand,
} from "../src/generated/protocol.js";
import { createMeshSession } from "../src/domain/mesh-session.js";
import { RelayPeer } from "./relay-peer.js";
import {
  deviceA,
  identityA,
  multiConnectionTransport,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1;
const command: ManageCommand = {
  verb: "exec:proc",
  params: { verb: "exec.list" },
};
const scope: CapabilityScope = { kind: "folder" };

describe("relay pairings across a reconnect", () => {
  it("sends a fresh relay-connect on the new connection, since the hub's pairing belonged to the old one", async () => {
    {
      const { transport, connections } = multiConnectionTransport();
      const session = createMeshSession(transport, testIdentity, testClock, {
        maxAttempts: RECONNECT_ATTEMPTS,
        delayMs: () => RECONNECT_DELAY_MS,
      });
      await session.connect("ws://node", ["core/management"]);
      const first = connections[0];
      if (first === undefined) {
        throw new Error("the session opened no connection");
      }
      const peer = new RelayPeer(identityA, testIdentity, first);
      const pending = session.sendManageRequest(command, scope, deviceA);
      // The disconnect below rejects it, so the assertion is attached now, before that happens.
      const pendingRejected = expect(pending).rejects.toThrow();
      await peer.answerHello();
      await peer.received();
      expect(
        first.sent.filter((frame) => frame.type === "relay-connect"),
      ).toHaveLength(1);

      first.fail(new Error("dropped"));
      await vi.waitFor(() => {
        expect(connections).toHaveLength(2);
      });
      const second = connections[1];
      if (second === undefined) {
        throw new Error("the session did not reconnect");
      }
      const secondPeer = new RelayPeer(identityA, testIdentity, second);
      const again = session.sendManageRequest(command, scope, deviceA);
      await secondPeer.answerHello();
      await secondPeer.received();

      expect(
        second.sent.filter((frame) => frame.type === "relay-connect"),
      ).toEqual([{ type: "relay-connect", "target-device": deviceA }]);
      await session.close();
      await pendingRejected;
      await expect(again).rejects.toThrow();
    }
  });
});
