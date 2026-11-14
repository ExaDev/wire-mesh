// How a fault is told to its owner: the owner's callback is its own code, so a throw or a rejected promise from it is reported once locally and swallowed, and the reports a single source can cause are rate-limited so a peer cannot drive one report per failing message without bound.

/** The shortest time between two reports for one source. A source that faults again inside it is counted, and the count goes with its next report. */
export const FAULT_REPORT_INTERVAL_MS = 1_000;

/** The most sources whose report windows are kept at once; past it the oldest window goes, with the count it held. */
export const MAX_TRACKED_FAULT_SOURCES = 1_024;

/** Delivers one report, given how many faults from the same source were suppressed since its previous report. */
export type FaultDelivery = (suppressed: number) => void | Promise<void>;

export type FaultReporter = (source: string, deliver: FaultDelivery) => void;

interface ReportWindow {
  since: number;
  suppressed: number;
}

/** Runs `deliver` so that nothing it does reaches the caller: a throw, or a returned promise that rejects, is reported once to the console and dropped. */
export function deliverContained(
  deliver: FaultDelivery,
  suppressed: number,
): void {
  const report = (error: unknown): void => {
    console.error("the fault callback failed", error);
  };
  try {
    const result: unknown = deliver(suppressed);
    if (
      typeof result === "object" &&
      result !== null &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      void Promise.resolve(result).catch(report);
    }
  } catch (error) {
    report(error);
  }
}

/**
 * Builds a reporter that delivers a source's first fault at once and then at most one more per FAULT_REPORT_INTERVAL_MS, each carrying the number of that source's faults suppressed since the one before. `now` is the clock the intervals are read from.
 */
export function createFaultReporter(
  now: () => number = Date.now,
): FaultReporter {
  const windows = new Map<string, ReportWindow>();

  return (source, deliver) => {
    const at = now();
    const window = windows.get(source);
    if (window !== undefined && at - window.since < FAULT_REPORT_INTERVAL_MS) {
      window.suppressed += 1;

      return;
    }
    windows.delete(source);
    windows.set(source, { since: at, suppressed: 0 });
    if (windows.size > MAX_TRACKED_FAULT_SOURCES) {
      const oldest = windows.keys().next();
      if (oldest.done !== true) {
        windows.delete(oldest.value);
      }
    }
    deliverContained(deliver, window?.suppressed ?? 0);
  };
}
