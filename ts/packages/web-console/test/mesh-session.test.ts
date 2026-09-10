import { describe, expect, it, vi } from "vitest";
import type {
  CapabilityScope,
  CapabilityToken,
  Frame,
  HandshakeFrame,
  ManageCommand,
  ManageRequestFrame,
  ManageResponseFrame,
} from "@exadev/wire-mesh-core/generated/protocol";
import type {
  Connection,
  Listener,
  Transport,
} from "@exadev/wire-mesh-core/ports/transport";
import {
  HANDSHAKE_TIMEOUT_MS,
  createMeshSession,
  type IncomingManageRequest,
  type ManageOutcome,
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

// Reconnect-flow event-stream positions: each reconnect round emits connecting + connected(pending), then either a further reconnecting (retrying) or closed (attempts exhausted) event.
const RECONNECT_DELAY_MS = 100;
const RECONNECT_MAX_ATTEMPTS = 2;
const EVENTS_THROUGH_FIRST_RECONNECT = 3;
const EVENTS_PER_RECONNECT_ROUND = 3;
const EVENTS_THROUGH_STALE_TIMER_REGRESSION = 6;

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

describe("reconnect policy", () => {
  it("never reconnects when no policy is given, matching today's default behavior", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport);
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
      const session = createMeshSession(transport, {
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
      const session = createMeshSession(transport, {
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
});

const TEST_TOKEN_SIGNATURE_BYTE = 3;
const TEST_INCOMING_REQUEST_ID = 7;

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
    const session = createMeshSession(transport);
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
    const session = createMeshSession(transport);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await Promise.resolve();
    const sentRequest = connection.sent.at(-1) as ManageRequestFrame;
    expect(sentRequest.token).toBeUndefined();
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("resolves sendManageRequest only with the outcome of the matching manage-response", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport);
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
    const session = createMeshSession(transport);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    await session.close();
    await expect(pending).rejects.toThrow(
      "connection closed before a response arrived",
    );
  });

  it("rejects a pending sendManageRequest when the connection disconnects before a response arrives", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport);
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendManageRequest(testCommand, testScope);
    connection.fail(new Error("dropped"));
    await expect(pending).rejects.toThrow(
      "disconnected before a response arrived",
    );
  });

  it("surfaces an incoming manage-request on incomingManageRequests, and sends the response frame from respond()", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport);
    await session.connect("ws://node", ["core/management"]);

    const incomingDone = (async (): Promise<IncomingManageRequest> => {
      const iterator = session.incomingManageRequests[Symbol.asyncIterator]();
      const result = await iterator.next();
      return result.value as IncomingManageRequest;
    })();

    connection.push({
      type: "manage-request",
      "request-id": TEST_INCOMING_REQUEST_ID,
      command: testCommand,
      scope: testScope,
      token: testToken,
    } satisfies ManageRequestFrame);

    const incoming = await incomingDone;
    expect(incoming.requestId).toBe(TEST_INCOMING_REQUEST_ID);
    expect(incoming.command).toEqual(testCommand);
    expect(incoming.scope).toEqual(testScope);
    expect(incoming.token).toEqual(testToken);

    await incoming.respond({ result: "ok" });
    const sentResponse = connection.sent.at(-1) as ManageResponseFrame;
    expect(sentResponse).toEqual({
      type: "manage-response",
      "request-id": TEST_INCOMING_REQUEST_ID,
      outcome: { result: "ok" },
    } satisfies ManageResponseFrame);
    await session.close();
  });
});
