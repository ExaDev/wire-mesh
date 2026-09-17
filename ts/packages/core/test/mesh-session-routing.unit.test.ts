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
import {
  TEST_INCOMING_REQUEST_ID,
  deviceA,
  deviceB,
  fakeTransport,
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

  /** Decodes a relay-data frame's opaque payload back into the Frame it wraps, failing the test outright if it isn't one -- every relay-data frame this suite sends is expected to wrap a real nested frame. */
  function unwrapRelayData(frame: Frame): Frame {
    expect(frame.type).toBe("relay-data");
    const inner = tryDecodeFrame((frame as RelayDataFrame).payload);
    if (inner === null) {
      throw new Error(
        "expected the relay-data payload to decode as a nested Frame",
      );
    }
    return inner;
  }

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
  const SECOND_TO_LAST_SENT = -2;

  // Events since session start: connecting, connected, self-advert sent -- then, for a manage-request addressed to a device this session isn't already paired with, a relay-connect-sent event and a relay-data-sent event.
  const EVENTS_THROUGH_FIRST_RELAY_REQUEST = 5;
  // Incremental events a further sendManageRequest call emits on top of EVENTS_THROUGH_FIRST_RELAY_REQUEST: just the relay-data-sent event when the target is already paired, or a relay-connect-sent event plus a relay-data-sent event when it re-pairs to a new target.
  const EVENTS_PER_RELAY_REQUEST_SAME_TARGET = 1;
  const EVENTS_PER_RELAY_REQUEST_NEW_TARGET = 2;

  it("establishes a relay-connect pairing before sending a manage-request with a targetDevice, wrapped in relay-data", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_FIRST_RELAY_REQUEST);
    const pending = session.sendManageRequest(testCommand, testScope, deviceA);
    await eventsDone;

    const relayConnect = frameAt(connection.sent, SECOND_TO_LAST_SENT);
    expect(relayConnect).toEqual({
      type: "relay-connect",
      "target-device": deviceA,
    });

    const relayData = frameAt(connection.sent, LAST_SENT);
    const inner = unwrapRelayData(relayData) as ManageRequestFrame;
    expect(inner.type).toBe("manage-request");
    expect(inner.command).toEqual(testCommand);
    expect(inner.scope).toEqual(testScope);

    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("reuses an established pairing rather than sending a second relay-connect for the same target", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const firstDone = nthEvent(session, EVENTS_THROUGH_FIRST_RELAY_REQUEST);
    const first = session.sendManageRequest(testCommand, testScope, deviceA);
    await firstDone;
    const secondDone = nthEvent(session, EVENTS_PER_RELAY_REQUEST_SAME_TARGET);
    const second = session.sendManageRequest(testCommand, testScope, deviceA);
    await secondDone;

    const relayConnects = connection.sent.filter(
      (frame) => frame.type === "relay-connect",
    );
    expect(relayConnects).toHaveLength(1);
    const relayDataFrames = connection.sent.filter(
      (frame) => frame.type === "relay-data",
    );
    expect(relayDataFrames).toHaveLength(2);
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

  it("dispatches a relay-data frame wrapping a manage-request into incomingManageRequests, with fromDevice set from the establishing relay-inbound", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);

    const incomingDone = (async (): Promise<IncomingManageRequest> => {
      const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
      const result = await iterator.next();
      return result.value as IncomingManageRequest;
    })();

    connection.push({ type: "relay-inbound", "source-device": deviceA });
    const wrapped: ManageRequestFrame = {
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
    };
    connection.push({
      type: "relay-data",
      payload: messageFromFrame(wrapped),
    } satisfies RelayDataFrame);

    const incoming = await incomingDone;
    expect(incoming.requestId).toBe(TEST_INCOMING_REQUEST_ID);
    expect(incoming.command).toEqual(testCommand);
    expect(incoming.scope).toEqual(testScope);
    expect(incoming.fromDevice).toEqual(deviceA);

    await incoming.respond({ result: "ok" });
    const sentResponse = frameAt(connection.sent, LAST_SENT);
    const innerResponse = unwrapRelayData(sentResponse);
    expect(innerResponse).toEqual({
      type: "manage-response",
      "request-id": TEST_INCOMING_REQUEST_ID,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await session.close();
  });

  it("resolves a pending sendManageRequest from a relay-data frame wrapping the matching manage-response", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_FIRST_RELAY_REQUEST);
    const pending = session.sendManageRequest(testCommand, testScope, deviceA);
    await eventsDone;
    const sentRelayData = frameAt(connection.sent, LAST_SENT);
    const sentRequest = unwrapRelayData(sentRelayData) as ManageRequestFrame;
    const requestId = sentRequest["request-id"];

    connection.push({
      type: "relay-data",
      payload: messageFromFrame({
        type: "manage-response",
        "request-id": requestId,
        outcome: { result: "ok" },
      } satisfies ManageResponseFrame),
    } satisfies RelayDataFrame);

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
