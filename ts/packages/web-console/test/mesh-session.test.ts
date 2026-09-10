import { describe, expect, it, vi } from "vitest";
import type {
  Frame,
  HandshakeFrame,
} from "@exadev/wire-mesh-core/generated/protocol";
import type {
  Connection,
  Listener,
  Transport,
} from "@exadev/wire-mesh-core/ports/transport";
import {
  HANDSHAKE_TIMEOUT_MS,
  createMeshSession,
} from "../src/mesh-session.js";
import { deviceIdFromFillHex } from "./hex.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");

// Event-stream positions: connect() emits connecting + connected, then one event per pushed frame, timeout, or failure.
const EVENTS_THROUGH_REMOTE_HANDSHAKE = 3;
const EVENTS_THROUGH_TIMEOUT = 3;
const EVENTS_THROUGH_THREE_GOSSIPS = 5;
const EVENTS_THROUGH_PING_ROUND_TRIP = 4;
const EVENTS_THROUGH_FAILURE = 3;
const SNAPSHOT_FIRST = 100;
const SNAPSHOT_SECOND = 200;
const SNAPSHOT_UPDATED = 300;

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
    const session = createMeshSession(transport);
    // Events: connecting, connected(handshake sent/pending), connected/negotiated
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

  it("excludes the retired core/federation domain even when both sides offer it", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport);
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
      const session = createMeshSession(transport);
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
    const session = createMeshSession(transport);
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
    const session = createMeshSession(transport);
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
      "received",
    ]);
    await session.close();
  });

  it("closes with the node's reason when the receive iteration rejects", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport);
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
    const session = createMeshSession(transport);
    await session.connect("ws://node", ["core/data"]);
    await expect(session.connect("ws://node", ["core/data"])).rejects.toThrow(
      "connects once",
    );
    await session.close();
  });

  it("refuses a ping while not connected", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport);
    await expect(session.sendPing()).rejects.toThrow("not connected");
  });
});
