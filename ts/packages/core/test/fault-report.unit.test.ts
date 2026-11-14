// The reporter that tells an owner of a fault: one report per source per interval, a pending count delivered when its interval ends, a bounded number of sources and of reports remembered, and nothing the owner's callback does reaching the caller.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAULT_REPORT_INTERVAL_MS,
  MAX_FAULT_REPORTS_PER_INTERVAL,
  MAX_TRACKED_FAULT_SOURCES,
  MAX_FAULT_TEXT_CHARS,
  createFaultReporter,
  deliverContained,
  describeFault,
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

    // The last fault of the burst is the one the second report carries; the others in between are what it counts.
    expect(told).toEqual([0, BURST - 2]);
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

  it("adds the pending count of a source it stopped tracking to the next report it delivers", () => {
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
    // Each source arrives in an interval of its own, so the budget never refuses one; once there are more than it tracks, the oldest, "first", is forgotten with one fault still pending.
    for (let source = 0; source <= MAX_TRACKED_FAULT_SOURCES; source += 1) {
      clock += FAULT_REPORT_INTERVAL_MS;
      report(`other-${String(source)}`, deliverFor(`other-${String(source)}`));
    }

    const counted = told
      .filter(([name]) => name.startsWith("other-"))
      .map(([, suppressed]) => suppressed)
      .filter((suppressed) => suppressed > 0);
    expect(counted).toEqual([1]);
  });

  it("does not throw where a timer handle is a number, as in a browser or a Worker", () => {
    let nextHandle = 0;
    vi.stubGlobal("setTimeout", () => {
      nextHandle += 1;

      return nextHandle;
    });
    try {
      const report = createFaultReporter(() => 0);
      const told: number[] = [];
      const deliver = (suppressed: number): void => {
        told.push(suppressed);
      };

      report("peer", deliver);
      expect(() => {
        report("peer", deliver);
        report("peer", deliver);
      }).not.toThrow();

      expect(told).toEqual([0]);
      expect(nextHandle).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("counts the faults between two reports, not the one a report carries", async () => {
    vi.useFakeTimers();
    const report = createFaultReporter(() => performance.now());
    const told: number[] = [];
    const deliver = (suppressed: number): void => {
      told.push(suppressed);
    };

    report("peer", deliver);
    report("peer", deliver);
    report("peer", deliver);
    report("peer", deliver);
    await vi.advanceTimersByTimeAsync(FAULT_REPORT_INTERVAL_MS);

    // One fault reported at once, three after it inside the interval: the report that ends it carries the last and counts the two before.
    expect(told).toEqual([0, 2]);
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

describe("describeFault", () => {
  it("quotes control characters and cuts the text to the bound", () => {
    const text = describeFault(
      new Error(`a\nb${"x".repeat(MAX_FAULT_TEXT_CHARS * 2)}`),
    );

    expect(text).not.toContain("\n");
    expect(text.length).toBeLessThanOrEqual(MAX_FAULT_TEXT_CHARS + 2 + 2);
  });
});
