import { describe, expect, it } from "vitest";
import type {
  RevocationAnnounceFrame,
  RevocationEntry,
} from "../src/generated/protocol.js";
import { createMeshSession } from "../src/domain/mesh-session.js";
import {
  EVENTS_THROUGH_FAILURE,
  EVENTS_THROUGH_REMOTE_HANDSHAKE,
  TEST_TOKEN_SIGNATURE_BYTE,
  TIMEOUT_MARKER,
  fakeTransport,
  nthEvent,
  testClock,
  testIdentity,
  withinShortWait,
  yielded,
} from "./mesh-session-fixtures.js";

describe("revocation-announce plumbing", () => {
  const ENTRY_B_PROTECTED_HEADER_BYTE = 11;
  const ENTRY_B_PAYLOAD_BYTE = 12;
  const testEntryA: RevocationEntry = [
    new Uint8Array([1]),
    {},
    new Uint8Array([2]),
    new Uint8Array([TEST_TOKEN_SIGNATURE_BYTE]),
  ];
  const testEntryB: RevocationEntry = [
    new Uint8Array([ENTRY_B_PROTECTED_HEADER_BYTE]),
    {},
    new Uint8Array([ENTRY_B_PAYLOAD_BYTE]),
    new Uint8Array([TEST_TOKEN_SIGNATURE_BYTE + 1]),
  ];

  it("sends a revocation-announce frame carrying the given entries", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);

    await session.sendRevocationAnnounce([testEntryA, testEntryB]);

    const sentFrame = connection.sent.at(-1) as RevocationAnnounceFrame;
    expect(sentFrame).toEqual({
      type: "revocation-announce",
      entries: [testEntryA, testEntryB],
    } satisfies RevocationAnnounceFrame);
    await session.close();
  });

  it("emits a session event after sending a revocation-announce", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/management"]);
    await eventsDone;

    const eventsIterator = session.events[Symbol.asyncIterator]();
    await session.sendRevocationAnnounce([testEntryA]);
    // Must already be available -- not merely eventually rescued by session.close()'s own trailing emit(), which would otherwise mask a missing emit() call in sendRevocationAnnounce.
    const result = await withinShortWait(eventsIterator.next());
    expect(result).not.toBe(TIMEOUT_MARKER);
    const event = yielded(
      result as IteratorResult<{
        frameLog: { direction: string; frame: { type: string } }[];
      }>,
    );
    expect(event.frameLog.at(-1)).toEqual({
      direction: "sent",
      frame: {
        type: "revocation-announce",
        entries: [testEntryA],
      },
    });
    await session.close();
  });

  it("refuses sendRevocationAnnounce while not connected", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await expect(session.sendRevocationAnnounce([testEntryA])).rejects.toThrow(
      "not connected",
    );
  });

  it("refuses sendRevocationAnnounce once the connection has failed and closed, not just before the first connect", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    connection.fail(new Error("dropped"));
    await nthEvent(session, EVENTS_THROUGH_FAILURE);
    await expect(session.sendRevocationAnnounce([testEntryA])).rejects.toThrow(
      "not connected",
    );
  });

  it("flattens an incoming revocation-announce frame's entries onto revocationAnnouncements, one item per entry", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);

    const received: RevocationEntry[] = [];
    const receivedBoth = (async (): Promise<void> => {
      const iterator = session.revocationAnnouncements[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      received.push(yielded(first));
      const second = await iterator.next();
      expect(second.done).toBe(false);
      received.push(yielded(second));
    })();

    connection.push({
      type: "revocation-announce",
      entries: [testEntryA, testEntryB],
    } satisfies RevocationAnnounceFrame);

    await receivedBoth;
    expect(received).toEqual([testEntryA, testEntryB]);
    await session.close();
  });

  it("delivers a revocation entry queued before anyone was iterating revocationAnnouncements, from the backlog", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/management"]);
    await eventsDone;

    const nextEventDone = nthEvent(session, 1);
    connection.push({
      type: "revocation-announce",
      entries: [testEntryA],
    } satisfies RevocationAnnounceFrame);
    await nextEventDone;

    const iterator = session.revocationAnnouncements[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(yielded(result)).toEqual(testEntryA);
    await session.close();
  });
});
