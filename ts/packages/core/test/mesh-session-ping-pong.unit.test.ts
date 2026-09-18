import { describe, expect, it, vi } from "vitest";
import type { Clock } from "../src/ports/clock.js";
import { createMeshSession } from "../src/domain/mesh-session.js";
import {
  fakeTransport,
  testIdentity,
  withinShortWait,
  TIMEOUT_MARKER,
} from "./mesh-session-fixtures.js";

const PING_ROUND_TRIP_TIMEOUT_MS = 5000;
const CLOCK_START_MS = 1_000;
const FIRST_LEG_MS = 10;
const SECOND_LEG_MS = 20;
const PONG_ARRIVAL_DELAY_MS = 42;
const FIRST_CALL_RTT_MS = FIRST_LEG_MS + SECOND_LEG_MS;
const ARBITRARY_FIXED_NOW_MS = 5;

/** A clock whose now() can be advanced between calls, unlike the fixtures' own fixed testClock -- needed here specifically to prove sendPingMeasureRtt reports a real elapsed duration rather than always reporting 0. */
function mutableClock(startMs: number): {
  clock: Clock;
  advanceMs: (ms: number) => void;
} {
  let now = startMs;
  return {
    clock: { now: () => now },
    advanceMs: (ms: number): void => {
      now += ms;
    },
  };
}

describe("sendPingMeasureRtt", () => {
  it("resolves with the elapsed milliseconds once the correlated pong arrives", async () => {
    const { transport, connection } = fakeTransport();
    const { clock, advanceMs } = mutableClock(CLOCK_START_MS);
    const session = createMeshSession(transport, testIdentity, clock);
    await session.connect("ws://node", ["core/management"]);

    const pending = session.sendPingMeasureRtt();
    advanceMs(PONG_ARRIVAL_DELAY_MS);
    connection.push({ type: "pong" });

    await expect(pending).resolves.toBe(PONG_ARRIVAL_DELAY_MS);
    await session.close();
  });

  it("pairs concurrent calls FIFO against pongs in arrival order, not by any other correlation", async () => {
    const { transport, connection } = fakeTransport();
    const { clock, advanceMs } = mutableClock(CLOCK_START_MS);
    const session = createMeshSession(transport, testIdentity, clock);
    await session.connect("ws://node", ["core/management"]);

    const first = session.sendPingMeasureRtt();
    advanceMs(FIRST_LEG_MS);
    const second = session.sendPingMeasureRtt();
    advanceMs(SECOND_LEG_MS);

    // Two pongs arrive back to back -- the first pong must resolve the first call (sent earlier, so its own elapsed time is larger), the second pong the second call.
    connection.push({ type: "pong" });
    connection.push({ type: "pong" });

    await expect(first).resolves.toBe(FIRST_CALL_RTT_MS);
    await expect(second).resolves.toBe(SECOND_LEG_MS);
    await session.close();
  });

  it("refuses to send a ping while not connected", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, {
      now: () => 0,
    });
    await expect(session.sendPingMeasureRtt()).rejects.toThrow("not connected");
  });

  it("rejects a still-pending call when the connection disconnects before a pong arrives", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, {
      now: () => 0,
    });
    await session.connect("ws://node", ["core/management"]);
    const pending = session.sendPingMeasureRtt();
    connection.fail(new Error("dropped"));
    await expect(pending).rejects.toThrow("disconnected before a pong arrived");
  });

  it("times out rather than hanging forever when no pong ever arrives", async () => {
    vi.useFakeTimers();
    try {
      const { transport } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, {
        now: () => 0,
      });
      await session.connect("ws://node", ["core/management"]);
      const pending = session
        .sendPingMeasureRtt(PING_ROUND_TRIP_TIMEOUT_MS)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(PING_ROUND_TRIP_TIMEOUT_MS);
      const outcome = await pending;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("timed out waiting for pong");
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not time out a call whose pong arrives before timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const { transport, connection } = fakeTransport();
      const session = createMeshSession(transport, testIdentity, {
        now: () => ARBITRARY_FIXED_NOW_MS,
      });
      await session.connect("ws://node", ["core/management"]);
      const pending = session.sendPingMeasureRtt(PING_ROUND_TRIP_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(0);
      connection.push({ type: "pong" });
      await expect(pending).resolves.toBe(0);
      await vi.advanceTimersByTimeAsync(PING_ROUND_TRIP_TIMEOUT_MS);
      await session.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a plain fire-and-forget sendPing entirely unaffected -- it still never waits for a pong", async () => {
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, {
      now: () => 0,
    });
    await session.connect("ws://node", ["core/management"]);
    const settled = await withinShortWait(session.sendPing());
    expect(settled).not.toBe(TIMEOUT_MARKER);
    expect(connection.sent.at(-1)).toEqual({ type: "ping" });
    await session.close();
  });
});
