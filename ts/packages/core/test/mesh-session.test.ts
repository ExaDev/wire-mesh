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
});

const TEST_TOKEN_SIGNATURE_BYTE = 3;
const TEST_INCOMING_REQUEST_ID = 7;
const OVERRIDE_TOKEN_BYTE = 9;

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

  it("surfaces an incoming manage-request on incomingManageRequests, and sends the response frame from respond()", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
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
    await expect(session.connect("ws://node", ["core/data"])).rejects.toThrow();
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
