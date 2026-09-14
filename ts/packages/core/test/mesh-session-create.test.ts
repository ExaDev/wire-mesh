import { describe, expect, it, vi } from "vitest";
import type { GossipFrame, HandshakeFrame } from "../src/generated/protocol.js";
import type {
  Connection,
  Listener,
  Transport,
} from "../src/ports/transport.js";
import {
  HANDSHAKE_TIMEOUT_MS,
  createMeshSession,
} from "../src/domain/mesh-session.js";
import {
  EVENTS_THROUGH_FAILURE,
  EVENTS_THROUGH_PING_ROUND_TRIP,
  EVENTS_THROUGH_REMOTE_HANDSHAKE,
  EVENTS_THROUGH_THREE_GOSSIPS,
  EVENTS_THROUGH_TIMEOUT,
  FakeConnection,
  MS_PER_SECOND,
  SNAPSHOT_FIRST,
  SNAPSHOT_SECOND,
  SNAPSHOT_UPDATED,
  TEST_CLOCK_NOW_MS,
  TIMEOUT_MARKER,
  deviceA,
  deviceB,
  fakeTransport,
  gossipFor,
  nthEvent,
  testClock,
  testIdentity,
  testIdentityDeviceId,
  withinShortWait,
  yielded,
} from "./mesh-session-fixtures.js";

describe("createMeshSession", () => {
  it("connects, sends the local handshake, and negotiates against the node's answer", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    // Events: connecting, connected(handshake sent/pending), self-advert sent, connected/negotiated
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE);
    await session.connect("ws://node", ["core/management", "core/data"]);

    expect(connection.sent[0]).toEqual({
      type: "handshake",
      version: 1,
      domains: ["core/management", "core/data"],
    } satisfies HandshakeFrame);

    const answer: HandshakeFrame = {
      type: "handshake",
      version: 1,
      domains: ["core/data", "core/exec"],
    };
    connection.push(answer);
    const event = (await eventsDone) as {
      state: {
        status: string;
        handshake: { status: string; sharedDomains: string[] };
      };
    };
    expect(event.state.status).toBe("connected");
    expect(event.state.handshake.status).toBe("negotiated");
    expect(event.state.handshake.sharedDomains).toEqual(["core/data"]);
    await session.close();
  });

  it("sends a self-advertisement gossip frame right after the handshake", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    // Events: connecting, connected(handshake sent/pending), self-advert sent
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/data"]);
    await eventsDone;

    expect(connection.sent[0]?.type).toBe("handshake");
    const selfAdvert = connection.sent[1] as GossipFrame;
    expect(selfAdvert).toEqual({
      type: "gossip",
      peers: [
        {
          device: testIdentityDeviceId,
          addresses: [],
          "snapshot-seconds": Math.floor(TEST_CLOCK_NOW_MS / MS_PER_SECOND),
        },
      ],
    } satisfies GossipFrame);
    expect(selfAdvert.peers[0]?.device).toEqual(testIdentity.deviceId);
    await session.close();
  });

  it("advertises this node's own given addresses in its self-advert", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(
      transport,
      testIdentity,
      testClock,
      null,
      ["10.0.0.1:9000", "203.0.113.5:9000"],
    );
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/data"]);
    await eventsDone;

    const selfAdvert = connection.sent[1] as GossipFrame;
    expect(selfAdvert.peers[0]?.addresses).toEqual([
      "10.0.0.1:9000",
      "203.0.113.5:9000",
    ]);
    await session.close();
  });

  it("sendGossipUpdate re-sends a fresh self-advert with the given extensions merged in", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await session.sendGossipUpdate({ "presence/status": "idle" });

    const updated = connection.sent.at(-1) as GossipFrame;
    expect(updated).toEqual({
      type: "gossip",
      peers: [
        {
          device: testIdentityDeviceId,
          addresses: [],
          "snapshot-seconds": Math.floor(TEST_CLOCK_NOW_MS / MS_PER_SECOND),
          "presence/status": "idle",
        },
      ],
    } satisfies GossipFrame);
    await session.close();
  });

  it("sendGossipUpdate rejects an extension key that collides with a mandatory peer-advert field", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await expect(
      session.sendGossipUpdate({ device: "spoofed" }),
    ).rejects.toThrow(/collides with a mandatory peer-advert field/);
    await session.close();
  });

  it("sendGossipUpdate rejects a bare, non-domain-qualified extension key", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await expect(
      session.sendGossipUpdate({ presence: "idle" }),
    ).rejects.toThrow(/must be domain-qualified/);
    await session.close();
  });

  it("sendGossipUpdate rejects an extension key that collides with the mandatory addresses field", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await expect(session.sendGossipUpdate({ addresses: [] })).rejects.toThrow(
      /collides with a mandatory peer-advert field/,
    );
    await session.close();
  });

  it("sendGossipUpdate rejects an extension key that collides with the mandatory snapshot-seconds field", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await expect(
      session.sendGossipUpdate({ "snapshot-seconds": 0 }),
    ).rejects.toThrow(/collides with a mandatory peer-advert field/);
    await session.close();
  });

  it("sendGossipUpdate rejects an extension key with a domain-qualified prefix but trailing garbage after it", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await expect(
      session.sendGossipUpdate({ "presence/status!": "idle" }),
    ).rejects.toThrow(/must be domain-qualified/);
    await session.close();
  });

  it("sendGossipUpdate rejects an extension key that only matches a domain-qualified pattern partway through the string", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await expect(
      session.sendGossipUpdate({ "1presence/status": "idle" }),
    ).rejects.toThrow(/must be domain-qualified/);
    await session.close();
  });

  it("sendGossipUpdate with no extensions re-sends a plain self-advert", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);

    await session.sendGossipUpdate();

    const updated = connection.sent.at(-1) as GossipFrame;
    expect(updated).toEqual({
      type: "gossip",
      peers: [
        {
          device: testIdentityDeviceId,
          addresses: [],
          "snapshot-seconds": Math.floor(TEST_CLOCK_NOW_MS / MS_PER_SECOND),
        },
      ],
    } satisfies GossipFrame);
    await session.close();
  });

  it("emits a session event after sending a gossip update", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/data"]);
    await eventsDone;

    const eventsIterator = session.events[Symbol.asyncIterator]();
    await session.sendGossipUpdate();
    // Must already be available -- not merely eventually rescued by session.close()'s own trailing emit(), which would otherwise mask a missing emit() call in sendGossipUpdate.
    const result = await withinShortWait(eventsIterator.next());
    expect(result).not.toBe(TIMEOUT_MARKER);
    const event = yielded(
      result as IteratorResult<{
        frameLog: { direction: string; frame: { type: string } }[];
      }>,
    );
    expect(event.frameLog.at(-1)?.direction).toBe("sent");
    expect(event.frameLog.at(-1)?.frame.type).toBe("gossip");
    await session.close();
  });

  it("refuses sendGossipUpdate while not connected", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await expect(session.sendGossipUpdate()).rejects.toThrow("not connected");
  });

  it("refuses sendGossipUpdate once the connection has failed and closed, not just before the first connect", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    connection.fail(new Error("dropped"));
    await nthEvent(session, EVENTS_THROUGH_FAILURE);
    await expect(session.sendGossipUpdate()).rejects.toThrow("not connected");
  });

  it("excludes the retired core/federation domain even when both sides offer it", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    // Events: connecting, connected, connected/rejected
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE);
    await session.connect("ws://node", ["core/federation"]);
    connection.push({
      type: "handshake",
      version: 1,
      domains: ["core/federation"],
    });
    const event = (await eventsDone) as {
      state: { handshake: { status: string } };
    };
    expect(event.state.handshake.status).toBe("rejected");
    await session.close();
  });

  it("marks the handshake unanswered after the timeout instead of hanging", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/data"]);
      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
      // Events so far: connecting, connected -- then the timeout emits unanswered
      const event = (await nthEvent(session, EVENTS_THROUGH_TIMEOUT)) as {
        state: { handshake: { status: string } };
      };
      expect(event.state.handshake.status).toBe("unanswered");
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("assembles the peer directory from gossip, latest advert per device winning", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    connection.push(gossipFor(deviceA, SNAPSHOT_FIRST));
    connection.push(gossipFor(deviceB, SNAPSHOT_SECOND));
    connection.push(gossipFor(deviceA, SNAPSHOT_UPDATED));
    // Events: connecting, connected, then one per gossip push -- drain to the last
    const event = (await nthEvent(session, EVENTS_THROUGH_THREE_GOSSIPS)) as {
      directory: {
        device: Uint8Array;
        advert: { "snapshot-seconds": number };
      }[];
    };
    expect(event.directory.length).toBe(2);
    const entryA = event.directory.find(
      (entry) => entry.advert["snapshot-seconds"] === SNAPSHOT_UPDATED,
    );
    expect(entryA).toBeDefined();
    expect(event.directory[0]?.device).toEqual(deviceA);
    expect(event.directory[1]?.device).toEqual(deviceB);
    await session.close();
  });

  it("records sent and received frames in the frame log in order", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    await session.sendPing();
    connection.push({ type: "ping" });
    // Events: connecting, connected, ping sent, ping received
    const event = (await nthEvent(session, EVENTS_THROUGH_PING_ROUND_TRIP)) as {
      frameLog: { direction: string; frame: { type: string } }[];
    };
    expect(event.frameLog.map((entry) => entry.direction)).toEqual([
      "sent",
      "sent",
      "sent",
      "received",
    ]);
    await session.close();
  });

  it("closes with the node's reason when the receive iteration rejects", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    connection.fail(new Error("node closed abruptly"));
    // Events: connecting, connected, closed
    const event = (await nthEvent(session, EVENTS_THROUGH_FAILURE)) as {
      state: { status: string; reason: string };
    };
    expect(event.state.status).toBe("closed");
    expect(event.state.reason).toBe("node closed abruptly");
  });

  it("refuses a second connect on the same session", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    await expect(session.connect("ws://node", ["core/data"])).rejects.toThrow(
      "connects once",
    );
    await session.close();
  });

  it("refuses a ping while not connected", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await expect(session.sendPing()).rejects.toThrow("not connected");
  });

  it("refuses a ping once the connection has failed and the session is closed, not just before the first connect", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    connection.fail(new Error("dropped"));
    await nthEvent(session, EVENTS_THROUGH_FAILURE);
    await expect(session.sendPing()).rejects.toThrow("not connected");
  });

  it("close() while connected finalizes state as closed by you, and actually closes the underlying connection", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_FAILURE);
    await session.connect("ws://node", ["core/data"]);
    await session.close();
    const event = (await eventsDone) as {
      state: { status: string; reason?: string };
    };
    expect(event.state.status).toBe("closed");
    expect((event.state as { reason: string }).reason).toBe("closed by you");
    expect(connection.isClosed).toBe(true);
  });

  it("closes a dial that only completes after close() was already called, instead of wiring it up", async () => {
    // A plain `let` reassigned only inside the Promise executor below loses its non-null narrowing by the time it's called several `await`s later -- an object property isn't narrowed the same way a bare closed-over variable is, so this sidesteps that entirely.
    const dialResolver: {
      resolve: ((connection: Connection) => void) | null;
    } = { resolve: null };
    const transport: Transport = {
      connect: async (): Promise<Connection> =>
        new Promise<Connection>((resolve) => {
          dialResolver.resolve = resolve;
        }),
      listen: async (): Promise<Listener> =>
        Promise.reject(new Error("client-only transport")),
    };
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsIterator = session.events[Symbol.asyncIterator]();
    const connectPromise = session.connect("ws://node", ["core/data"]);
    await eventsIterator.next(); // connecting
    await session.close();
    const lateConnection = new FakeConnection();
    if (dialResolver.resolve === null)
      throw new Error("expected resolveDial to be set");
    dialResolver.resolve(lateConnection.connection);
    await connectPromise;
    expect(lateConnection.sent).toHaveLength(0);
    expect(lateConnection.isClosed).toBe(true);
    const closedEvent = yielded(await eventsIterator.next()) as {
      state: { status: string; reason?: string };
    };
    expect(closedEvent.state.status).toBe("closed");
    expect((closedEvent.state as { reason: string }).reason).toBe(
      "closed by you",
    );
  });

  it("treats a clean end of the receive stream as a disconnect when still connected", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_FAILURE);
    connection.endStream();
    const event = (await eventsDone) as {
      state: { status: string; reason: string };
    };
    expect(event.state.status).toBe("closed");
    expect(event.state.reason).toBe("node closed the connection");
  });

  it("ignores a frame that was already queued when close() is called, instead of applying it", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const iterator = session.events[Symbol.asyncIterator]();
    await session.connect("ws://node", ["core/data"]);
    connection.push(gossipFor(deviceA));
    await session.close();
    for (let i = 0; i < EVENTS_THROUGH_FAILURE; i++) {
      await iterator.next();
    }
    const result = await withinShortWait(iterator.next());
    expect(result).toBe(TIMEOUT_MARKER);
  });

  it("does not negotiate against a second handshake frame once the first has already settled the outcome", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE);
    await session.connect("ws://node", ["core/management", "core/data"]);
    connection.push({
      type: "handshake",
      version: 1,
      domains: ["core/data", "core/exec"],
    } satisfies HandshakeFrame);
    await eventsDone;

    const secondEventDone = nthEvent(session, 1);
    connection.push({
      type: "handshake",
      version: 1,
      domains: ["core/federation"],
    } satisfies HandshakeFrame);
    const event = (await secondEventDone) as {
      state: {
        status: string;
        handshake: { status: string; sharedDomains: string[] };
      };
    };
    expect(event.state.handshake.status).toBe("negotiated");
    expect(event.state.handshake.sharedDomains).toEqual(["core/data"]);
    await session.close();
  });

  it("keeps the handshake negotiated after HANDSHAKE_TIMEOUT_MS elapses, instead of flipping to unanswered", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connection } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE);
      await session.connect("ws://node", ["core/data"]);
      connection.push({
        type: "handshake",
        version: 1,
        domains: ["core/data"],
      } satisfies HandshakeFrame);
      await eventsDone;

      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS);
      await session.sendPing();
      const lastFrame = connection.sent.at(-1) as { type: string };
      expect(lastFrame.type).toBe("ping");
      // sendPing itself would have thrown if state had reverted away from "connected", and negotiate() already proved the handshake status. A direct re-check below confirms the handshake status specifically stayed "negotiated".
      const stillConnectedEvent = (await nthEvent(session, 1)) as {
        state: { handshake?: { status: string } };
      };
      expect(stillConnectedEvent.state.handshake?.status).toBe("negotiated");
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a specific reason when the handshake is rejected for sharing no domains or version", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE);
    await session.connect("ws://node", ["core/federation"]);
    connection.push({
      type: "handshake",
      version: 1,
      domains: ["core/federation"],
    });
    const event = (await eventsDone) as {
      state: { handshake: { status: string; reason?: string } };
    };
    expect(event.state.handshake.status).toBe("rejected");
    expect((event.state.handshake as { reason: string }).reason).toBe(
      "no shared domains or version",
    );
    await session.close();
  });

  it("events iterator resolves a live event, delivered after the wait began, with done: false", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const iterator = session.events[Symbol.asyncIterator]();
    // No event has been emitted yet, so this call registers a waiter rather than draining the backlog.
    const pending = iterator.next();
    await session.connect("ws://node", ["core/data"]);
    const result = await pending;
    expect(result.done).toBe(false);
    await session.close();
  });

  it("events iterator resolves a backlogged event, queued before anyone was iterating, with done: false", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    const iterator = session.events[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(false);
    await session.close();
  });
});
