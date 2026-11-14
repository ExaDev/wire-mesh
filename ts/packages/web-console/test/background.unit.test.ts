import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FAULT_TEXT_CHARS } from "wire-mesh-core/domain/fault-report";
import { startInBackground } from "../src/background.js";

/** What a report line adds around the bounded text: its label and the quotes. */
const LINE_OVERHEAD_CHARS = 64;
const unhandled: unknown[] = [];
function record(reason: unknown): void {
  unhandled.push(reason);
}

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", record);
});

afterEach(() => {
  process.off("unhandledRejection", record);
});

async function letRejectionsSurface(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("startInBackground", () => {
  it("tells a failure to the given callback and raises nothing unhandled", async () => {
    const told: unknown[] = [];
    const failure = new Error("the work failed");

    startInBackground(Promise.reject(failure), (error) => {
      told.push(error);
    });
    await letRejectionsSurface();

    expect(told).toEqual([failure]);
    expect(unhandled).toEqual([]);
  });

  it("writes a failure to the console as one bounded, quoted line when no callback is given, with nothing unhandled", async () => {
    const reported = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      startInBackground(
        Promise.reject(
          new Error(`a\nb${"x".repeat(MAX_FAULT_TEXT_CHARS * 2)}`),
        ),
      );
      await letRejectionsSurface();

      expect(unhandled).toEqual([]);
      expect(reported).toHaveBeenCalledTimes(1);
      const line = String(reported.mock.calls[0]?.[0]);
      expect(line).toContain("background work failed");
      expect(line).not.toContain("\n");
      expect(line.length).toBeLessThan(
        MAX_FAULT_TEXT_CHARS + LINE_OVERHEAD_CHARS,
      );
    } finally {
      reported.mockRestore();
    }
  });
});
