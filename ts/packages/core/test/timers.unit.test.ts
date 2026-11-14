import { describe, expect, it, vi } from "vitest";
import { unrefIfSupported } from "../src/domain/timers.js";

const NUMERIC_HANDLE = 7;

describe("unrefIfSupported", () => {
  it("unrefs a handle that has unref()", () => {
    const unref = vi.fn();

    unrefIfSupported({ unref });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("leaves a numeric handle alone, as a browser's or a Worker's setTimeout returns", () => {
    expect(() => {
      unrefIfSupported(NUMERIC_HANDLE);
    }).not.toThrow();
  });

  it("leaves a handle with no unref alone", () => {
    expect(() => {
      unrefIfSupported({});
      unrefIfSupported(null);
      unrefIfSupported(undefined);
    }).not.toThrow();
  });
});
