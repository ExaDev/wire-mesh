// How a fault is told to its owner: the owner's callback is its own code, so a throw or a rejected promise from it is reported once locally and swallowed, and the reports a source can cause are rate-limited so a peer cannot drive one report per failing message without bound. A fault suppressed inside a source's interval is counted, and the count is delivered when the interval ends, so a burst followed by silence is still told.

/** The shortest time between two reports for one source. */
export const FAULT_REPORT_INTERVAL_MS = 1_000;

/** The most sources whose report windows are kept at once; past it the oldest window goes, its pending count delivered first if the budget allows. */
export const MAX_TRACKED_FAULT_SOURCES = 1_024;

/** The most reports delivered across all sources in one interval. A source beyond it is counted like one inside its own interval, so the total is bounded however many distinct sources a peer presents. */
export const MAX_FAULT_REPORTS_PER_INTERVAL = 64;

/** Delivers one report, given how many faults from the same source were suppressed since its previous report. */
export type FaultDelivery = (suppressed: number) => void | Promise<void>;

export type FaultReporter = (source: string, deliver: FaultDelivery) => void;

interface ReportWindow {
  since: number;
  suppressed: number;
  /** The most recent suppressed fault's delivery, which carries the count when the interval ends. */
  latest: FaultDelivery | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
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

/** A clock that never steps backwards, which the interval arithmetic relies on. */
function monotonicNow(): number {
  return performance.now();
}

/**
 * Builds a reporter that delivers a source's first fault at once and then at most one more per FAULT_REPORT_INTERVAL_MS, each carrying the number of that source's faults suppressed since the one before, with at most MAX_FAULT_REPORTS_PER_INTERVAL reports across all sources. A count still pending when its source falls quiet is delivered when its interval ends. `now` is the clock the intervals are read from; it must not step backwards.
 */
export function createFaultReporter(
  now: () => number = monotonicNow,
): FaultReporter {
  const windows = new Map<string, ReportWindow>();
  const budget = { since: Number.NEGATIVE_INFINITY, used: 0 };

  /** Takes one report from the interval's budget, if it has one left. */
  function admit(at: number): boolean {
    if (at - budget.since >= FAULT_REPORT_INTERVAL_MS) {
      budget.since = at;
      budget.used = 0;
    }
    if (budget.used >= MAX_FAULT_REPORTS_PER_INTERVAL) {
      return false;
    }
    budget.used += 1;

    return true;
  }

  function arm(source: string): void {
    const window = windows.get(source);
    if (window === undefined || window.timer !== undefined) {
      return;
    }
    const delay = Math.max(0, window.since + FAULT_REPORT_INTERVAL_MS - now());
    const timer = setTimeout(() => {
      flush(source);
    }, delay);
    timer.unref();
    window.timer = timer;
  }

  /** Delivers a window's pending count at the end of its interval, or waits for the next interval when the budget is spent. */
  function flush(source: string): void {
    const window = windows.get(source);
    if (window === undefined) {
      return;
    }
    window.timer = undefined;
    const { latest } = window;
    if (window.suppressed === 0 || latest === undefined) {
      return;
    }
    const at = now();
    window.since = at;
    if (!admit(at)) {
      arm(source);

      return;
    }
    const count = window.suppressed;
    window.suppressed = 0;
    window.latest = undefined;
    deliverContained(latest, count);
  }

  function evictOldest(): void {
    const oldest = windows.entries().next();
    if (oldest.done === true) {
      return;
    }
    const [source, window] = oldest.value;
    clearTimeout(window.timer);
    windows.delete(source);
    if (window.suppressed > 0 && window.latest !== undefined && admit(now())) {
      deliverContained(window.latest, window.suppressed);
    }
  }

  return (source, deliver) => {
    const at = now();
    const window = windows.get(source);
    if (window !== undefined && at - window.since < FAULT_REPORT_INTERVAL_MS) {
      window.suppressed += 1;
      window.latest = deliver;
      arm(source);

      return;
    }
    const carried = window?.suppressed ?? 0;
    clearTimeout(window?.timer);
    windows.delete(source);
    const next: ReportWindow = {
      since: at,
      suppressed: carried,
      latest: window?.latest,
      timer: undefined,
    };
    windows.set(source, next);
    if (windows.size > MAX_TRACKED_FAULT_SOURCES) {
      evictOldest();
    }
    if (!admit(at)) {
      next.suppressed += 1;
      next.latest = deliver;
      arm(source);

      return;
    }
    next.suppressed = 0;
    next.latest = undefined;
    deliverContained(deliver, carried);
  };
}
