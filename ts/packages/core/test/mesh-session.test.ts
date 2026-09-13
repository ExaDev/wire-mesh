import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityScope,
  CapabilityToken,
  Frame,
  GossipFrame,
  HandshakeFrame,
  ManageCommand,
  ManageRequestFrame,
  ManageResponseFrame,
  RelayDataFrame,
  RevocationAnnounceFrame,
  RevocationEntry,
} from "../src/generated/protocol.js";
import type { Clock } from "../src/ports/clock.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  Connection,
  Listener,
  Transport,
} from "../src/ports/transport.js";
import {
  HANDSHAKE_TIMEOUT_MS,
  acceptMeshSession,
  createMeshSession,
  type IncomingManageRequest,
  type ManageOutcome,
} from "../src/domain/mesh-session.js";
import {
  messageFromFrame,
  tryDecodeFrame,
} from "../src/adapters/frame-codec.js";
import { deviceIdFromFillHex } from "./hex.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");

const testIdentityDeviceId = deviceIdFromFillHex("ee");
const testIdentity: IdentityPort = {
  deviceId: testIdentityDeviceId,
  identityKey: { alg: -7, "public-key": new Uint8Array() },
  sign: async () => Promise.resolve(new Uint8Array()),
  verify: async () => Promise.resolve(true),
  deriveDeviceId: async () => Promise.resolve(testIdentityDeviceId),
};
const MS_PER_SECOND = 1000;
const TEST_CLOCK_NOW_MS = 1_700_000_000_000;
const testClock: Clock = { now: () => TEST_CLOCK_NOW_MS };

// Event-stream positions: connect() emits connecting + connected, then a self-advert-sent tick, then one event per pushed frame, timeout, or failure.
const EVENTS_THROUGH_REMOTE_HANDSHAKE = 4;
const EVENTS_THROUGH_TIMEOUT = 4;
const EVENTS_THROUGH_THREE_GOSSIPS = 6;
const EVENTS_THROUGH_PING_ROUND_TRIP = 5;
const EVENTS_THROUGH_FAILURE = 4;
const SNAPSHOT_FIRST = 100;
const SNAPSHOT_SECOND = 200;
const SNAPSHOT_UPDATED = 300;

// Reconnect-flow event-stream positions: each reconnect round emits connecting + connected(pending) + self-advert-sent, then either a further reconnecting (retrying) or closed (attempts exhausted) event.
const RECONNECT_DELAY_MS = 100;
const RECONNECT_MAX_ATTEMPTS = 2;
const EVENTS_THROUGH_FIRST_RECONNECT = 4;
const EVENTS_PER_RECONNECT_ROUND = 4;
const EVENTS_THROUGH_STALE_TIMER_REGRESSION = 8;

/** An in-memory Connection the test drives: pushes arrive on the receive iteration, sends are recorded. */
class FakeConnection {
  sent: Frame[] = [];
  private readonly inbound: Frame[] = [];
  private ended = false;
  private failure: Error | null = null;

  get connection(): Readonly<Connection> {
    return {
      send: async (frame: Frame): Promise<void> => {
        this.sent.push(frame);
        return Promise.resolve();
      },
      receive: () => this.stream(),
      close: async (): Promise<void> => {
        this.ended = true;
        this.wake();
        return Promise.resolve();
      },
    };
  }

  /** True once this connection's own close() has actually been invoked -- lets a test assert that a caller closed the link, distinct from the link merely ending its receive stream on its own (see endStream). */
  get isClosed(): boolean {
    return this.ended;
  }

  /** Ends the receive stream as if the remote hung up cleanly, without going through this side's own close() -- unlike close(), this leaves the session's own state untouched so a test can observe how the session itself reacts to a graceful remote end. */
  endStream(): void {
    this.ended = true;
    this.wake();
  }

  push(frame: Frame): void {
    this.inbound.push(frame);
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.wake();
  }

  private readonly wakeWaiters: (() => void)[] = [];

  private wake(): void {
    for (const wake of this.wakeWaiters.splice(0)) {
      wake();
    }
  }

  private stream(): AsyncIterable<Frame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Frame>> => this.nextFrame(),
      }),
    };
  }

  private async nextFrame(): Promise<IteratorResult<Frame>> {
    for (;;) {
      const next = this.inbound.shift();
      if (next !== undefined) {
        return { value: next, done: false };
      }
      if (this.failure !== null) {
        throw this.failure;
      }
      if (this.ended) {
        return { value: undefined, done: true };
      }
      await new Promise<void>((resolve) => {
        this.wakeWaiters.push(resolve);
      });
    }
  }
}

function fakeTransport(): { transport: Transport; connection: FakeConnection } {
  const connection = new FakeConnection();
  const transport: Transport = {
    connect: async (address: string): Promise<Connection> => {
      if (address !== "ws://node") {
        return Promise.reject(new Error(`connect to ${address} failed`));
      }
      return Promise.resolve(connection.connection);
    },
    listen: async (): Promise<Listener> =>
      Promise.reject(new Error("client-only transport")),
  };
  return { transport, connection };
}

/** A transport that hands out a fresh FakeConnection on every connect() call, so one attempt's failure doesn't leak into the next -- unlike fakeTransport()'s single shared connection, which stays broken forever once failed. */
function multiConnectionTransport(): {
  transport: Transport;
  connections: FakeConnection[];
} {
  const connections: FakeConnection[] = [];
  const transport: Transport = {
    connect: async (address: string): Promise<Connection> => {
      if (address !== "ws://node") {
        return Promise.reject(new Error(`connect to ${address} failed`));
      }
      const next = new FakeConnection();
      connections.push(next);
      return Promise.resolve(next.connection);
    },
    listen: async (): Promise<Listener> =>
      Promise.reject(new Error("client-only transport")),
  };
  return { transport, connections };
}

/** Narrows an IteratorResult to its yielded value, failing the test outright if the iterator has actually ended -- none of this file's own async iterators ever end, so a done:true result always indicates a broken assumption in the test itself, never legitimate data. */
function yielded<T>(result: IteratorResult<T>): T {
  if (result.done === true) {
    throw new Error("expected the iterator to yield a value, got done: true");
  }
  return result.value;
}

/** Resolves after the session has emitted at least `count` events, returning the latest. */
async function nthEvent(
  session: ReturnType<typeof createMeshSession>,
  count: number,
): Promise<unknown> {
  const iterator = session.events[Symbol.asyncIterator]();
  let last: unknown = null;
  for (let i = 0; i < count; i++) {
    const result = await iterator.next();
    last = result.value;
  }
  return last;
}

function gossipFor(
  device: Uint8Array<ArrayBuffer>,
  seconds = 1861833600,
): Frame {
  return {
    type: "gossip",
    peers: [
      { device, addresses: ["203.0.113.5:4433"], "snapshot-seconds": seconds },
    ],
  };
}

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
    const SHORT_WAIT_MS = 20;
    const TIMEOUT_MARKER = "timeout" as const;
    const result = await Promise.race([
      iterator.next(),
      new Promise<typeof TIMEOUT_MARKER>((resolve) => {
        setTimeout(() => {
          resolve(TIMEOUT_MARKER);
        }, SHORT_WAIT_MS);
      }),
    ]);
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

describe("reconnect policy", () => {
  it("never reconnects when no policy is given, matching today's default behavior", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/data"]);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_FAILURE);
    connection.fail(new Error("dropped"));
    const event = (await eventsDone) as {
      state: { status: string; reason: string };
    };
    expect(event.state.status).toBe("closed");
    expect(event.state.reason).toBe("dropped");
  });

  it("retries with backoff through correctly-numbered attempts, then gives up once max attempts are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connection } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock, {
        maxAttempts: RECONNECT_MAX_ATTEMPTS,
        delayMs: () => RECONNECT_DELAY_MS,
      });
      await session.connect("ws://node", ["core/data"]);
      connection.fail(new Error("dropped"));

      // Events: connecting, connected(pending), reconnecting(attempt 1).
      const firstReconnect = (await nthEvent(
        session,
        EVENTS_THROUGH_FIRST_RECONNECT,
      )) as { state: { status: string; attempt?: number } };
      expect(firstReconnect.state.status).toBe("reconnecting");
      expect(firstReconnect.state.attempt).toBe(1);

      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
      // Events: connecting, connected(pending) -- the still-broken connection fails again immediately, giving reconnecting(attempt 2).
      const secondReconnect = (await nthEvent(
        session,
        EVENTS_PER_RECONNECT_ROUND,
      )) as { state: { status: string; attempt?: number } };
      expect(secondReconnect.state.status).toBe("reconnecting");
      expect(secondReconnect.state.attempt).toBe(2);

      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
      // Events: connecting, connected(pending) -- the final attempt also fails, and with attempts exhausted this falls through to closed.
      const finalOutcome = (await nthEvent(
        session,
        EVENTS_PER_RECONNECT_ROUND,
      )) as { state: { status: string; reason: string } };
      expect(finalOutcome.state.status).toBe("closed");
      expect(finalOutcome.state.reason).toBe("dropped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the handshake timeout on reconnect, so a stale timer from the previous attempt cannot corrupt the new one", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connections } = multiConnectionTransport();
      const session = createMeshSession(transport, testIdentity, testClock, {
        maxAttempts: 1,
        delayMs: () => 0,
      });
      const eventsDone = nthEvent(
        session,
        EVENTS_THROUGH_STALE_TIMER_REGRESSION,
      );
      await session.connect("ws://node", ["core/data"]);
      await vi.advanceTimersByTimeAsync(HANDSHAKE_TIMEOUT_MS - 1);
      connections[0]?.fail(new Error("dropped"));
      // Reaches the ORIGINAL attempt's own handshake-timeout instant. The reconnect (0ms backoff) completes first against a fresh connection, resetting the handshake to pending for the new attempt; an uncleared stale timer would then fire at this very instant and clobber it.
      await vi.advanceTimersByTimeAsync(1);
      await session.sendPing();
      const event = (await eventsDone) as {
        state: { status: string; handshake?: { status: string } };
      };
      expect(event.state.status).toBe("connected");
      expect(event.state.handshake?.status).toBe("pending");
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the handshake timeout when close() is called before it fires", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/data"]);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await session.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending scheduled reconnect when close() is called before it fires", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connections } = multiConnectionTransport();
      const session = createMeshSession(transport, testIdentity, testClock, {
        maxAttempts: 1,
        delayMs: () => RECONNECT_DELAY_MS,
      });
      await session.connect("ws://node", ["core/data"]);
      connections[0]?.fail(new Error("dropped"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await session.close();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);
      expect(connections).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes as closed by you when close() is called while a reconnect is pending", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connections } = multiConnectionTransport();
      const session = createMeshSession(transport, testIdentity, testClock, {
        maxAttempts: 1,
        delayMs: () => RECONNECT_DELAY_MS,
      });
      await session.connect("ws://node", ["core/data"]);
      connections[0]?.fail(new Error("dropped"));
      const reconnecting = (await nthEvent(
        session,
        EVENTS_THROUGH_FIRST_RECONNECT,
      )) as { state: { status: string } };
      expect(reconnecting.state.status).toBe("reconnecting");
      const eventsDone = nthEvent(session, 1);
      await session.close();
      const event = (await eventsDone) as {
        state: { status: string; reason?: string };
      };
      expect(event.state.status).toBe("closed");
      expect((event.state as { reason: string }).reason).toBe("closed by you");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a failed retry dial itself as a disconnect, not a silently swallowed error", async () => {
    vi.useFakeTimers();
    try {
      const connections: FakeConnection[] = [];
      let calls = 0;
      const transport: Transport = {
        connect: async (address: string): Promise<Connection> => {
          calls += 1;
          if (address !== "ws://node") {
            return Promise.reject(new Error(`connect to ${address} failed`));
          }
          if (calls > 1) {
            return Promise.reject(new Error("dial failed on retry"));
          }
          const next = new FakeConnection();
          connections.push(next);
          return Promise.resolve(next.connection);
        },
        listen: async (): Promise<Listener> =>
          Promise.reject(new Error("client-only transport")),
      };
      const session = createMeshSession(transport, testIdentity, testClock, {
        maxAttempts: 1,
        delayMs: () => RECONNECT_DELAY_MS,
      });
      await session.connect("ws://node", ["core/data"]);
      connections[0]?.fail(new Error("dropped"));
      await nthEvent(session, EVENTS_THROUGH_FIRST_RECONNECT);
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY_MS);

      const iterator = session.events[Symbol.asyncIterator]();
      let event: { state: { status: string; reason?: string } } | null = null;
      const MAX_EVENTS_TO_SCAN = 10;
      for (let i = 0; i < MAX_EVENTS_TO_SCAN; i++) {
        const result = (await iterator.next()) as {
          value: { state: { status: string; reason?: string } };
        };
        event = result.value;
        if (event.state.status === "closed") {
          break;
        }
      }
      expect(event?.state.status).toBe("closed");
      expect(event?.state.reason).toBe("dial failed on retry");
    } finally {
      vi.useRealTimers();
    }
  });
});

const TEST_TOKEN_SIGNATURE_BYTE = 3;
const TEST_INCOMING_REQUEST_ID = 7;
const OVERRIDE_TOKEN_BYTE = 9;
const MANAGE_REQUEST_TIMEOUT_MS = 5000;

describe("capability tokens and manage-request plumbing", () => {
  const testCommand: ManageCommand = {
    verb: "exec:proc",
    params: { verb: "exec.list" },
  };
  const testScope: CapabilityScope = { kind: "folder" };
  const testToken: CapabilityToken = [
    new Uint8Array([1]),
    {},
    new Uint8Array([2]),
    new Uint8Array([TEST_TOKEN_SIGNATURE_BYTE]),
  ];

  it("attaches the current token to every manage-request it sends", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    session.setToken(testToken);
    const pending = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    expect(sentRequest.type).toBe("manage-request");
    expect(sentRequest.command).toEqual(testCommand);
    expect(sentRequest.scope).toEqual(testScope);
    expect(sentRequest.token).toEqual(testToken);
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("does not attach a token to a manage-request when none has been set", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    expect(sentRequest.token).toBeUndefined();
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("attaches a per-call token override even when no session-global token has been set", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(
      testCommand,
      testScope,
      undefined,
      testToken,
    );
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    expect(sentRequest.token).toEqual(testToken);
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("a per-call token override takes precedence over the session-global token for that one request only", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    session.setToken(testToken);
    const overrideToken: CapabilityToken = [
      new Uint8Array([OVERRIDE_TOKEN_BYTE]),
      {},
      new Uint8Array([OVERRIDE_TOKEN_BYTE]),
      new Uint8Array([OVERRIDE_TOKEN_BYTE]),
    ];

    const overridden = session.sendManageRequest(
      testCommand,
      testScope,
      undefined,
      overrideToken,
    );
    await Promise.resolve();
    expect((connection.sent.at(-1) as ManageRequestFrame).token).toEqual(
      overrideToken,
    );

    // The very next request, with no override of its own, must fall back to setToken's session-global value -- the override applies to the one call it was passed to, not for the rest of the session.
    const usingSessionDefault = session.sendManageRequest(
      testCommand,
      testScope,
    );
    await Promise.resolve();
    expect((connection.sent.at(-1) as ManageRequestFrame).token).toEqual(
      testToken,
    );

    await session.close();
    await expect(overridden).rejects.toThrow();
    await expect(usingSessionDefault).rejects.toThrow();
  });

  it("assigns sequentially increasing request-ids to successive sendManageRequest calls", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const first = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const firstId = (connection.sent.at(-1) as ManageRequestFrame)[
      "request-id"
    ];
    const second = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const secondId = (connection.sent.at(-1) as ManageRequestFrame)[
      "request-id"
    ];
    expect(secondId).toBe(firstId + 1);
    await session.close();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
  });

  it("refuses sendManageRequest while not connected", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await expect(
      session.sendManageRequest(testCommand, testScope),
    ).rejects.toThrow("not connected");
  });

  it("refuses sendManageRequest once the connection has failed and closed, not just before the first connect", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    connection.fail(new Error("dropped"));
    await nthEvent(session, EVENTS_THROUGH_FAILURE);
    await expect(
      session.sendManageRequest(testCommand, testScope),
    ).rejects.toThrow("not connected");
  });

  it("never times out a request when no timeoutMs is given", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connection } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/management"]);
      const pending = session.sendManageRequest(testCommand, testScope);
      await vi.advanceTimersByTimeAsync(1);
      const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
      connection.push({
        type: "manage-response",
        "request-id": sentRequest["request-id"],
        outcome: { result: "ok" },
      } satisfies ManageResponseFrame);
      await expect(pending).resolves.toEqual({ result: "ok" });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves sendManageRequest only with the outcome of the matching manage-response", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    const requestId = sentRequest["request-id"];

    // A response for a different request-id must not resolve this pending request.
    connection.push({
      type: "manage-response",
      "request-id": requestId + 1,
      outcome: { result: "error", code: "wrong-request" },
    } satisfies ManageResponseFrame);
    connection.push({
      type: "manage-response",
      "request-id": requestId,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);

    const outcome: ManageOutcome = await pending;
    expect(outcome).toEqual({ result: "ok" });
    await session.close();
  });

  it("rejects a pending sendManageRequest when the session is closed before a response arrives", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await session.close();
    await expect(pending).rejects.toThrow(
      "connection closed before a response arrived",
    );
  });

  it("rejects a pending sendManageRequest when the connection disconnects before a response arrives", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    connection.fail(new Error("dropped"));
    await expect(pending).rejects.toThrow(
      "disconnected before a response arrived",
    );
  });

  it("resolves with a timeout outcome, not a hang, when no response arrives within timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/management"]);
      const pending = session.sendManageRequest(
        testCommand,
        testScope,
        undefined,
        undefined,
        MANAGE_REQUEST_TIMEOUT_MS,
      );
      await vi.advanceTimersByTimeAsync(MANAGE_REQUEST_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({
        result: "error",
        code: "timeout",
      });
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a request whose response arrives before timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connection } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, testClock);
      await session.connect("ws://node", ["core/management"]);
      const pending = session.sendManageRequest(
        testCommand,
        testScope,
        undefined,
        undefined,
        MANAGE_REQUEST_TIMEOUT_MS,
      );
      await vi.advanceTimersByTimeAsync(0);
      const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
      connection.push({
        type: "manage-response",
        "request-id": sentRequest["request-id"],
        outcome: { result: "ok" },
      } satisfies ManageResponseFrame);
      await expect(pending).resolves.toEqual({ result: "ok" });
      await vi.advanceTimersByTimeAsync(MANAGE_REQUEST_TIMEOUT_MS);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces an incoming manage-request on incomingManageRequests, and sends the response frame from respond()", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/management"]);
    await eventsDone;

    const incomingDone = (async (): Promise<
      IteratorResult<IncomingManageRequest>
    > => {
      const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
      return iterator.next();
    })();

    connection.push({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
      token: testToken,
    } satisfies ManageRequestFrame);

    const incomingResult = await incomingDone;
    expect(incomingResult.done).toBe(false);
    const incoming = yielded(incomingResult);
    expect(incoming.requestId).toBe(TEST_INCOMING_REQUEST_ID);
    expect(incoming.command).toEqual(testCommand);
    expect(incoming.scope).toEqual(testScope);
    expect(incoming.token).toEqual(testToken);

    // Two events remain unconsumed: the received manage-request itself, then the sent response.
    const responseEventDone = nthEvent(session, 2);
    await incoming.respond({ result: "ok" });
    const sentResponse = connection.sent.at(-1) as ManageResponseFrame;
    expect(sentResponse).toEqual({
      type: "manage-response",
      "request-id": TEST_INCOMING_REQUEST_ID,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    const responseEvent = (await responseEventDone) as {
      frameLog: { direction: string; frame: { type: string } }[];
    };
    expect(responseEvent.frameLog.at(-1)).toEqual({
      direction: "sent",
      frame: sentResponse,
    });
    await session.close();
  });

  it("delivers a manage-request queued before anyone was iterating incomingManageRequests, from the backlog", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    await session.connect("ws://node", ["core/management"]);
    await eventsDone;

    const nextEventDone = nthEvent(session, 1);
    connection.push({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
    } satisfies ManageRequestFrame);
    await nextEventDone;

    const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(yielded(result).requestId).toBe(TEST_INCOMING_REQUEST_ID);
    await session.close();
  });
});

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

  it("flattens an incoming revocation-announce frame's entries onto revocationAnnouncements, one item per entry", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);

    const received: RevocationEntry[] = [];
    const receivedBoth = (async (): Promise<void> => {
      const iterator = session.revocationAnnouncements[Symbol.asyncIterator]();
      received.push((await iterator.next()).value as RevocationEntry);
      received.push((await iterator.next()).value as RevocationEntry);
    })();

    connection.push({
      type: "revocation-announce",
      entries: [testEntryA, testEntryB],
    } satisfies RevocationAnnounceFrame);

    await receivedBoth;
    expect(received).toEqual([testEntryA, testEntryB]);
    await session.close();
  });
});

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

describe("acceptMeshSession", () => {
  it("wires up handshake and self-advert immediately, with no dial step at all", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock, label: "peer-over-tcp" },
    );

    expect(fake.sent[0]).toEqual({
      type: "handshake",
      version: 1,
      domains: ["core/data"],
    } satisfies HandshakeFrame);
    const selfAdvert = fake.sent[1] as GossipFrame;
    expect(selfAdvert.peers[0]?.device).toEqual(testIdentity.deviceId);
    await session.close();
  });

  it("advertises this node's own given addresses in its self-advert", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock, addresses: ["192.168.1.10:9000"] },
    );

    const selfAdvert = fake.sent[1] as GossipFrame;
    expect(selfAdvert.peers[0]?.addresses).toEqual(["192.168.1.10:9000"]);
    await session.close();
  });

  it("advertises no addresses in its self-advert when none are given, rather than a stray default", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);

    const selfAdvert = fake.sent[1] as GossipFrame;
    expect(selfAdvert.peers[0]?.addresses).toEqual([]);
    await session.close();
  });

  it("labels its connection state 'accepted' when no label is given", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(
      fake.connection,
      testIdentity,
      ["core/data"],
      { clock: testClock },
    );
    const event = (await nthEvent(session, 1)) as {
      state: { address: string };
    };
    expect(event.state.address).toBe("accepted");
    await session.close();
  });

  it("negotiates against the remote's own handshake exactly like the dial side", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/management",
      "core/data",
    ]);
    const eventsDone = nthEvent(session, EVENTS_THROUGH_REMOTE_HANDSHAKE - 1);
    fake.push({
      type: "handshake",
      version: 1,
      domains: ["core/data", "core/exec"],
    });
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

  it("resolves peerDeviceId from the remote's own first self-advert", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    fake.push(gossipFor(deviceB));
    await expect(session.peerDeviceId).resolves.toEqual(deviceB);
    await session.close();
  });

  it("peerDeviceId resolves from the first advert and never changes on a later one", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    fake.push(gossipFor(deviceA));
    await expect(session.peerDeviceId).resolves.toEqual(deviceA);
    fake.push(gossipFor(deviceB));
    // Same promise, already settled -- a second, different advert cannot retroactively change what it resolved to.
    await expect(session.peerDeviceId).resolves.toEqual(deviceA);
    await session.close();
  });

  it("refuses connect(): the session is already connected by construction, with nothing to dial", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    await expect(session.connect("ws://node", ["core/data"])).rejects.toThrow(
      "connects once",
    );
    await session.close();
  });

  it("close() closes the underlying connection and rejects pending manage-requests, same as the dial side", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/data",
    ]);
    const pending = session.sendManageRequest(
      { verb: "exec:proc", params: { verb: "exec.list" } },
      { kind: "folder" },
    );
    await session.close();
    await expect(pending).rejects.toThrow();
  });
});
