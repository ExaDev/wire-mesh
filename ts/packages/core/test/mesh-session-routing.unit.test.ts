import { describe, expect, it } from "vitest";
import type {
  CapabilityScope,
  Frame,
  ManageCommand,
  ManageRequestFrame,
  ManageResponseFrame,
  RelayDataFrame,
} from "../src/generated/protocol.js";
import {
  createMeshSession,
  type IncomingManageRequest,
  type ManageOutcome,
} from "../src/domain/mesh-session.js";
import {
  messageFromFrame,
  tryDecodeFrame,
} from "../src/adapters/frame-codec.js";
import { RelayPeer } from "./relay-peer.js";
import {
  TEST_INCOMING_REQUEST_ID,
  deviceA,
  deviceB,
  deviceC,
  fakeTransport,
  identityA,
  identityB,
  identityC,
  nthEvent,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

describe("relay routing", () => {
  const testCommand: ManageCommand = {
    verb: "exec:proc",
    params: { verb: "exec.list" },
  };
  const testScope: CapabilityScope = { kind: "folder" };

  /** The frame at `index` (negative counts from the end, matching Array.prototype.at), failing the test outright if there isn't one there -- avoids both a non-null assertion and an `as` cast that would silently paper over an empty/short array. */
  function frameAt(frames: readonly Frame[], index: number): Frame {
    const frame = frames.at(index);
    if (frame === undefined) {
      throw new Error(
        `expected a frame at index ${String(index)}, got ${String(frames.length)} frames`,
      );
    }

    return frame;
  }

  const LAST_SENT = -1;

  // Events since session start: connecting, connected, self-advert sent -- then, for a manage-request addressed to a device this session isn't already paired with, a relay-connect-sent event and a relay-data-sent event.
  const EVENTS_THROUGH_FIRST_RELAY_REQUEST = 5;
  // Incremental events a further sendManageRequest call emits on top of EVENTS_THROUGH_FIRST_RELAY_REQUEST: just the relay-data-sent event when the target is already paired, or a relay-connect-sent event plus a relay-data-sent event when it re-pairs to a new target.
  const EVENTS_PER_RELAY_REQUEST_SAME_TARGET = 1;
  const EVENTS_PER_RELAY_REQUEST_NEW_TARGET = 2;

  it("establishes a relay-connect pairing, then a secure channel, before sending a manage-request with a targetDevice, and sends nothing a relay could read", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const peer = new RelayPeer(identityA, testIdentity, connection);
    const pending = session.sendManageRequest(testCommand, testScope, deviceA);
    await peer.answerHello();

    const [request] = await peer.received();

    expect(request).toMatchObject({
      type: "manage-request",
      command: testCommand,
      scope: testScope,
    });
    const relayConnectIndex = connection.sent.findIndex(
      (frame) => frame.type === "relay-connect",
    );
    const firstRelayDataIndex = connection.sent.findIndex(
      (frame) => frame.type === "relay-data",
    );
    expect(connection.sent[relayConnectIndex]).toEqual({
      type: "relay-connect",
      "target-device": deviceA,
    });
    expect(relayConnectIndex).toBeLessThan(firstRelayDataIndex);
    const relayed = connection.sent
      .filter((frame): frame is RelayDataFrame => frame.type === "relay-data")
      .map((frame) => tryDecodeFrame(frame.payload)?.type);
    expect(relayed).toEqual(["secure-hello", "secure-data"]);
    expect(relayed).not.toContain("manage-request");

    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("reuses an established pairing and channel rather than sending a second relay-connect or hello for the same target", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const peer = new RelayPeer(identityA, testIdentity, connection);
    const first = session.sendManageRequest(testCommand, testScope, deviceA);
    await peer.answerHello();
    await peer.received();
    const second = session.sendManageRequest(testCommand, testScope, deviceA);
    await peer.received();

    const relayConnects = connection.sent.filter(
      (frame) => frame.type === "relay-connect",
    );
    expect(relayConnects).toHaveLength(1);
    const relayed = connection.sent
      .filter((frame): frame is RelayDataFrame => frame.type === "relay-data")
      .map((frame) => tryDecodeFrame(frame.payload)?.type);
    expect(relayed).toEqual(["secure-hello", "secure-data", "secure-data"]);
    await session.close();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
  });

  it("sends a fresh relay-connect when a later request targets a different device", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const firstDone = nthEvent(session, EVENTS_THROUGH_FIRST_RELAY_REQUEST);
    const first = session.sendManageRequest(testCommand, testScope, deviceA);
    await firstDone;
    const secondDone = nthEvent(session, EVENTS_PER_RELAY_REQUEST_NEW_TARGET);
    const second = session.sendManageRequest(testCommand, testScope, deviceB);
    await secondDone;

    const relayConnects = connection.sent.filter(
      (frame) => frame.type === "relay-connect",
    );
    expect(relayConnects).toEqual([
      { type: "relay-connect", "target-device": deviceA },
      { type: "relay-connect", "target-device": deviceB },
    ]);
    await session.close();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
  });

  it("dispatches a sealed manage-request into incomingManageRequests, with fromDevice the identity its channel authenticated", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const peer = new RelayPeer(identityA, testIdentity, connection);
    const incomingDone = (async (): Promise<IncomingManageRequest> => {
      const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
      const result = await iterator.next();

      return result.value as IncomingManageRequest;
    })();

    await peer.openTowardSession();
    await peer.deliver({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
    } satisfies ManageRequestFrame);

    const incoming = await incomingDone;
    expect(incoming.requestId).toBe(TEST_INCOMING_REQUEST_ID);
    expect(incoming.command).toEqual(testCommand);
    expect(incoming.scope).toEqual(testScope);
    expect(incoming.fromDevice).toEqual(deviceA);

    await incoming.respond({ result: "ok" });
    const [response] = await peer.received();
    expect(response).toEqual({
      type: "manage-response",
      "request-id": TEST_INCOMING_REQUEST_ID,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    const sentResponse = frameAt(connection.sent, LAST_SENT);
    expect((sentResponse as RelayDataFrame)["to-device"]).toEqual(deviceA);
    await session.close();
  });

  it("attributes fromDevice to the peer whose channel the frame opened under, not to whichever relay pairing was most recently established", async () => {
    // Regression test for wire-mesh#170: a single-value "most recent pairing" tracker collapses concurrent relay pairings, mis-attributing every inbound request to whichever peer paired last regardless of who actually sent it.
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const peerA = new RelayPeer(identityA, testIdentity, connection);
    const peerB = new RelayPeer(identityB, testIdentity, connection);
    const incomingDone = (async (): Promise<IncomingManageRequest> => {
      const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
      const result = await iterator.next();

      return result.value as IncomingManageRequest;
    })();

    await peerA.openTowardSession();
    await peerB.openTowardSession();
    await peerA.deliver({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
    } satisfies ManageRequestFrame);

    const incoming = await incomingDone;
    expect(incoming.fromDevice).toEqual(deviceA);
    await session.close();
  });

  it("exposes toDevice from the relay-data frame's own to-device field, for a caller fronting more than one local device to route on", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const peer = new RelayPeer(identityA, testIdentity, connection);
    const incomingDone = (async (): Promise<IncomingManageRequest> => {
      const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
      const result = await iterator.next();

      return result.value as IncomingManageRequest;
    })();

    await peer.openTowardSession();
    await peer.deliver(
      {
        type: "manage-request",
        "request-id": TEST_INCOMING_REQUEST_ID,
        command: testCommand,
        scope: testScope,
      } satisfies ManageRequestFrame,
      { toDevice: deviceB },
    );

    const incoming = await incomingDone;
    expect(incoming.toDevice).toEqual(deviceB);
    await session.close();
  });

  it("does not resend relay-connect for a previously-paired target after pairing with a different target in between", async () => {
    // Regression test for wire-mesh#170: the old single-value pairing tracker treated pairing with a new target as replacing the old one, so returning to an already-paired device sent a redundant relay-connect. relay-hub.ts has tracked a real multiplexed adjacency map (multiple simultaneous pairings per connection) since #30; the session side must hold onto every pairing it has established, not just the latest.
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const firstDone = nthEvent(session, EVENTS_THROUGH_FIRST_RELAY_REQUEST);
    const first = session.sendManageRequest(testCommand, testScope, deviceA);
    await firstDone;
    const secondDone = nthEvent(session, EVENTS_PER_RELAY_REQUEST_NEW_TARGET);
    const second = session.sendManageRequest(testCommand, testScope, deviceB);
    await secondDone;
    const thirdDone = nthEvent(session, EVENTS_PER_RELAY_REQUEST_SAME_TARGET);
    const third = session.sendManageRequest(testCommand, testScope, deviceA);
    await thirdDone;

    const relayConnects = connection.sent.filter(
      (frame) => frame.type === "relay-connect",
    );
    expect(relayConnects).toEqual([
      { type: "relay-connect", "target-device": deviceA },
      { type: "relay-connect", "target-device": deviceB },
    ]);
    await session.close();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    await expect(third).rejects.toThrow();
  });

  it("addresses a response back to the request's own source device, even after a different relay pairing was established in between", async () => {
    // Regression test for wire-mesh#170: two concurrent inbound requests from two different peers relayed through the same hub connection must each get their response addressed back to the actual sender, not to whichever pairing was established last.
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const peerA = new RelayPeer(identityA, testIdentity, connection);
    const peerC = new RelayPeer(identityC, testIdentity, connection);

    const incoming: IncomingManageRequest[] = [];
    const collectIncoming = (async (): Promise<void> => {
      for await (const request of session.incomingManageRequests) {
        incoming.push(request);
        if (incoming.length === 2) {
          return;
        }
      }
    })();

    await peerA.openTowardSession();
    await peerA.deliver({
      type: "manage-request",
      "request-id": 1,
      command: testCommand,
      scope: testScope,
    } satisfies ManageRequestFrame);
    await peerC.openTowardSession();
    await peerC.deliver({
      type: "manage-request",
      "request-id": 2,
      command: testCommand,
      scope: testScope,
    } satisfies ManageRequestFrame);

    await collectIncoming;
    const [fromA, fromC] = incoming;
    if (fromA === undefined || fromC === undefined) {
      throw new Error("expected two incoming manage-requests");
    }

    await fromA.respond({ result: "ok" });
    expect(frameAt(connection.sent, LAST_SENT)).toMatchObject({
      type: "relay-data",
      "to-device": deviceA,
    });
    expect(await peerA.received()).toEqual([
      {
        type: "manage-response",
        "request-id": 1,
        outcome: { result: "ok" },
      },
    ]);

    await fromC.respond({ result: "ok" });
    expect(frameAt(connection.sent, LAST_SENT)).toMatchObject({
      type: "relay-data",
      "to-device": deviceC,
    });
    expect(await peerC.received()).toEqual([
      {
        type: "manage-response",
        "request-id": 2,
        outcome: { result: "ok" },
      },
    ]);

    await session.close();
  });

  it("resolves a pending sendManageRequest from a sealed manage-response from the device it was sent to", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const peer = new RelayPeer(identityA, testIdentity, connection);
    const pending = session.sendManageRequest(testCommand, testScope, deviceA);
    await peer.answerHello();
    const [request] = await peer.received();
    if (request?.type !== "manage-request") {
      throw new Error("expected the peer to receive a manage-request");
    }

    await peer.deliver({
      type: "manage-response",
      "request-id": request["request-id"],
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);

    const outcome: ManageOutcome = await pending;
    expect(outcome).toEqual({ result: "ok" });
    await session.close();
  });

  it("leaves a relay-data frame whose payload does not decode as a recognized frame as ordinary opaque data", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    // A CBOR break byte on its own -- undecodable as a complete value, the same convention webrtc-transport.test.ts uses for an invalid payload.
    const CBOR_BREAK_BYTE = 0xff;
    const undecodable: RelayDataFrame = {
      type: "relay-data",
      payload: new Uint8Array([CBOR_BREAK_BYTE]),
    };
    // Events: connecting, connected, self-advert sent, opaque relay-data received.
    const EVENTS_THROUGH_OPAQUE_RELAY_DATA = 4;
    const eventsDone = nthEvent(session, EVENTS_THROUGH_OPAQUE_RELAY_DATA);
    connection.push(undecodable);
    const event = (await eventsDone) as {
      frameLog: { direction: string; frame: Frame }[];
    };
    expect(event.frameLog.at(-1)).toEqual({
      direction: "received",
      frame: undecodable,
    });
    await session.close();
  });

  it("leaves a relay-data frame whose payload decodes as a recognized but non-manage frame as ordinary opaque data", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const wrapped: RelayDataFrame = {
      type: "relay-data",
      payload: messageFromFrame({ type: "ping" }),
    };
    const EVENTS_THROUGH_OPAQUE_RELAY_DATA = 4;
    const eventsDone = nthEvent(session, EVENTS_THROUGH_OPAQUE_RELAY_DATA);
    connection.push(wrapped);
    const event = (await eventsDone) as {
      frameLog: { direction: string; frame: Frame }[];
    };
    expect(event.frameLog.at(-1)).toEqual({
      direction: "received",
      frame: wrapped,
    });
    await session.close();
  });
});
