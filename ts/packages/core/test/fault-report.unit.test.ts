// The reporter that tells an owner of a fault: one report per source per interval, a pending count delivered when its interval ends, a bounded number of sources and of reports remembered, and nothing the owner's callback does reaching the caller.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAULT_REPORT_INTERVAL_MS,
  MAX_FAULT_REPORTS_PER_INTERVAL,
  MAX_TRACKED_FAULT_SOURCES,
  createFaultReporter,
  deliverContained,
} from "../src/domain/fault-report.js";

const BURST = 1_000;
const CLOCK_START_MS = 10_000;
const CLOCK_STEP_BACK_MS = 5_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("createFaultReporter", () => {
  it("delivers a source's first fault at once and counts the ones inside the interval", () => {
    let clock = 0;
    const report = createFaultReporter(() => clock);
    const told: number[] = [];
    const deliver = (suppressed: number): void => {
      told.push(suppressed);
    };

    report("peer", deliver);
    report("peer", deliver);
    report("peer", deliver);
    clock += FAULT_REPORT_INTERVAL_MS;
    report("peer", deliver);

    expect(told).toEqual([0, 2]);
  });

  it("tells a burst followed by silence, once its interval ends, how many faults were not reported", async () => {
    vi.useFakeTimers();
    const report = createFaultReporter(() => performance.now());
    const told: number[] = [];
    const deliver = (suppressed: number): void => {
      told.push(suppressed);
    };

    for (let fault = 0; fault < BURST; fault += 1) {
      report("peer", deliver);
    }
    expect(told).toEqual([0]);
    await vi.advanceTimersByTimeAsync(FAULT_REPORT_INTERVAL_MS);

    expect(told).toEqual([0, BURST - 1]);
  });

  it("keeps one source's faults from hiding another's", () => {
    const report = createFaultReporter(() => 0);
    const told: string[] = [];

    report("a", () => {
      told.push("a");
    });
    report("b", () => {
      told.push("b");
    });

    expect(told).toEqual(["a", "b"]);
  });

  it("bounds the reports across all sources in one interval, however many sources there are", () => {
    const report = createFaultReporter(() => 0);
    let told = 0;
    for (
      let source = 0;
      source < MAX_FAULT_REPORTS_PER_INTERVAL * 2;
      source += 1
    ) {
      report(String(source), () => {
        told += 1;
      });
    }

    expect(told).toBe(MAX_FAULT_REPORTS_PER_INTERVAL);
  });

  it("does not let a clock that steps backwards silence every later fault", () => {
    let clock = CLOCK_START_MS;
    const report = createFaultReporter(() => clock);
    const told: number[] = [];
    const deliver = (suppressed: number): void => {
      told.push(suppressed);
    };

    report("peer", deliver);
    clock -= CLOCK_STEP_BACK_MS;
    report("peer", deliver);
    clock += CLOCK_STEP_BACK_MS + FAULT_REPORT_INTERVAL_MS;
    report("peer", deliver);

    expect(told.length).toBeGreaterThanOrEqual(2);
  });

  it("delivers a source's pending count when its window is evicted for a newer source", () => {
    let clock = 0;
    const report = createFaultReporter(() => clock);
    const told: [string, number][] = [];
    const deliverFor =
      (source: string) =>
      (suppressed: number): void => {
        told.push([source, suppressed]);
      };
    report("first", deliverFor("first"));
    report("first", deliverFor("first"));
    for (let source = 0; source < MAX_TRACKED_FAULT_SOURCES; source += 1) {
      clock += 1;
      report(`other-${String(source)}`, deliverFor("other"));
    }

    expect(told.filter(([name]) => name === "first")).toEqual([
      ["first", 0],
      ["first", 1],
    ]);
  });
});

describe("deliverContained", () => {
  it("reports once to the console, and no further, a callback that throws", () => {
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      deliverContained(() => {
        throw new Error("the callback throws");
      }, 0);

      expect(reported).toHaveBeenCalledTimes(1);
    } finally {
      reported.mockRestore();
    }
  });
});
