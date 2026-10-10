// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { PingTimeoutError } from "wire-mesh-core/domain/ping-round-trips";
import {
  MAX_SAMPLES,
  useConnectionHealth,
} from "../src/hooks/use-connection-health.js";
import type { ProbeTiming } from "../src/hooks/use-connection-health.js";

type Ping = (timeoutMs?: number) => Promise<number>;

const RTT_MS = 42;
const FIRST_RTT_MS = 10;
const RECOVERED_RTT_MS = 7;
const EXTRA_PROBES = 5;
const SCRIPTED_SAMPLES = 3;

/** Fake-timer timing that honours ProbeTiming's invariant: a probe is given up on well before the next one is due. */
const TIMING: ProbeTiming = { pongTimeoutMs: 50, intervalMs: 100 };

/** The session a hook is given must be the same object across renders, as a real session is, or every render would look like a new session and probe again. */
function renderHealth(
  ping: Ping,
  connected: boolean,
): ReturnType<
  typeof renderHook<ReturnType<typeof useConnectionHealth>, unknown>
> {
  const session = { sendPingMeasureRtt: ping };

  return renderHook(() => useConnectionHealth(session, connected, TIMING));
}

/** Moves the fake clock forward and lets every promise and state update it caused settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** A ping that answers with each outcome in turn, then with `fallback`. */
function scripted(
  outcomes: readonly (() => Promise<number>)[],
  fallback: number,
): ReturnType<typeof vi.fn<Ping>> {
  const remaining = [...outcomes];

  return vi.fn<Ping>(async () => {
    const outcome = remaining.shift();

    return outcome === undefined ? fallback : outcome();
  });
}

describe("useConnectionHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("probes as soon as the connection is up and records the round trip, with the configured timeout", async () => {
    const ping = vi.fn<Ping>(async () => Promise.resolve(RTT_MS));
    const { result } = renderHealth(ping, true);

    await advance(0);

    expect(result.current.samples).toEqual([RTT_MS]);
    expect(ping.mock.calls[0]).toEqual([TIMING.pongTimeoutMs]);
  });

  it("does not probe while the connection is down", async () => {
    const ping = vi.fn<Ping>(async () => Promise.resolve(RTT_MS));
    renderHealth(ping, false);

    await advance(TIMING.intervalMs * EXTRA_PROBES);

    expect(ping).not.toHaveBeenCalled();
  });

  it("probes again every interval and keeps only the most recent samples", async () => {
    let next = 0;
    const ping = vi.fn<Ping>(async () => Promise.resolve(next++));
    const { result } = renderHealth(ping, true);

    await advance(TIMING.intervalMs * (MAX_SAMPLES + EXTRA_PROBES));

    expect(ping).toHaveBeenCalledTimes(MAX_SAMPLES + EXTRA_PROBES + 1);
    expect(result.current.samples).toHaveLength(MAX_SAMPLES);
    expect(result.current.samples.at(-1)).toBe(MAX_SAMPLES + EXTRA_PROBES);
  });

  it("records a lost probe after a pong has been heard, and keeps probing", async () => {
    const ping = scripted(
      [
        async () => Promise.resolve(FIRST_RTT_MS),
        async () => Promise.reject(new PingTimeoutError()),
      ],
      RECOVERED_RTT_MS,
    );
    const { result } = renderHealth(ping, true);

    await advance(TIMING.intervalMs * (SCRIPTED_SAMPLES - 1));

    expect(result.current.samples.slice(0, SCRIPTED_SAMPLES)).toEqual([
      FIRST_RTT_MS,
      undefined,
      RECOVERED_RTT_MS,
    ]);
    expect(result.current.unresponsive).toBe(false);
  });

  it("stops probing a node whose first probe gets no pong, until a manual probe is answered", async () => {
    const node = { answering: false };
    const ping = vi.fn<Ping>(async () =>
      node.answering
        ? Promise.resolve(RECOVERED_RTT_MS)
        : Promise.reject(new PingTimeoutError()),
    );
    const { result } = renderHealth(ping, true);

    await advance(0);
    expect(result.current.unresponsive).toBe(true);
    const probesWhenStopped = ping.mock.calls.length;
    await advance(TIMING.intervalMs * EXTRA_PROBES);
    expect(ping).toHaveBeenCalledTimes(probesWhenStopped);

    node.answering = true;
    act(() => {
      result.current.probe();
    });
    await advance(0);

    expect(result.current.unresponsive).toBe(false);
    expect(result.current.samples.at(-1)).toBe(RECOVERED_RTT_MS);
    expect(result.current.samples[0]).toBeUndefined();
  });

  it("records nothing for a probe rejected because the connection dropped, even before the dropped state reaches the hook", async () => {
    // The session rejects every pending ping before it announces the state change, so the hook still believes the link is up when the rejection arrives.
    const dropped = Promise.reject<number>(
      new Error("disconnected before a pong arrived"),
    );
    const ping = scripted([async () => dropped], RECOVERED_RTT_MS);
    const { result } = renderHealth(ping, true);

    await advance(0);

    expect(result.current.samples).toEqual([]);
    expect(result.current.unresponsive).toBe(false);

    await advance(TIMING.intervalMs);

    expect(result.current.samples).toEqual([RECOVERED_RTT_MS]);
  });
});
