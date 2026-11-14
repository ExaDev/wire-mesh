// A wait for one device's part of a ceremony settles on delivery, on failure and after its own bound, and removes its registration whichever it is.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PerDeviceCollector } from "../src/domain/per-device-collector.js";

const BOUND_MS = 1_000;
const VALUE = 7;

afterEach(() => {
  vi.useRealTimers();
});

describe("PerDeviceCollector", () => {
  it("resolves a wait with the value delivered afterwards, and a value delivered before", async () => {
    const collector = new PerDeviceCollector<number>();
    const waiting = collector.awaitFrom("a");
    collector.deliver("a", VALUE);
    collector.deliver("b", VALUE);

    await expect(waiting).resolves.toBe(VALUE);
    await expect(collector.awaitFrom("b")).resolves.toBe(VALUE);
  });

  it("rejects a wait after its bound and leaves no registration, so a later delivery is buffered for the next wait", async () => {
    vi.useFakeTimers();
    const collector = new PerDeviceCollector<number>();
    const waiting = collector.awaitFrom("a", BOUND_MS);
    const outcome = expect(waiting).rejects.toThrow(/timed out/u);
    await vi.advanceTimersByTimeAsync(BOUND_MS);
    await outcome;

    collector.deliver("a", VALUE);

    await expect(collector.awaitFrom("a", BOUND_MS)).resolves.toBe(VALUE);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the bound's timer when the value arrives first", async () => {
    vi.useFakeTimers();
    const collector = new PerDeviceCollector<number>();
    const waiting = collector.awaitFrom("a", BOUND_MS);
    collector.deliver("a", VALUE);
    await waiting;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects every wait when failed, clears their timers, and refuses later waits", async () => {
    vi.useFakeTimers();
    const collector = new PerDeviceCollector<number>();
    const first = collector.awaitFrom("a", BOUND_MS);
    const second = collector.awaitFrom("b", BOUND_MS);
    const outcomes = Promise.all([
      expect(first).rejects.toThrow("ceremony failed"),
      expect(second).rejects.toThrow("ceremony failed"),
    ]);
    collector.fail(new Error("ceremony failed"));
    await outcomes;

    expect(vi.getTimerCount()).toBe(0);
    await expect(collector.awaitFrom("c")).rejects.toThrow("ceremony failed");
  });

  it("refuses a second wait for a device whose first is still registered, leaving the first intact", async () => {
    const collector = new PerDeviceCollector<number>();
    const first = collector.awaitFrom("a");
    await expect(collector.awaitFrom("a")).rejects.toThrow(
      /already registered/u,
    );
    collector.deliver("a", VALUE);

    await expect(first).resolves.toBe(VALUE);
  });
});
