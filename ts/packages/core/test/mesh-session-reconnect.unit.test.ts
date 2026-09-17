import { describe, expect, it, vi } from "vitest";
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
  EVENTS_PER_RECONNECT_ROUND,
  EVENTS_THROUGH_FAILURE,
  EVENTS_THROUGH_FIRST_RECONNECT,
  EVENTS_THROUGH_STALE_TIMER_REGRESSION,
  FakeConnection,
  RECONNECT_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  fakeTransport,
  multiConnectionTransport,
  nthEvent,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

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
