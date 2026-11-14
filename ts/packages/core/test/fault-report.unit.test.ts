// The reporter that tells an owner of a fault: one report per source per interval, a bounded number of sources remembered, and nothing the owner's callback does reaching the caller.

import { describe, expect, it, vi } from "vitest";
import {
  FAULT_REPORT_INTERVAL_MS,
  MAX_TRACKED_FAULT_SOURCES,
  createFaultReporter,
  deliverContained,
} from "../src/domain/fault-report.js";

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

  it("forgets the oldest source's window once more sources than the bound have been seen", () => {
    const report = createFaultReporter(() => 0);
    const told: string[] = [];
    for (let source = 0; source <= MAX_TRACKED_FAULT_SOURCES; source += 1) {
      report(String(source), () => undefined);
    }

    report("0", () => {
      told.push("0 again");
    });

    expect(told).toEqual(["0 again"]);
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
