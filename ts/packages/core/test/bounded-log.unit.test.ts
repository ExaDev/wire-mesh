import { describe, expect, it } from "vitest";
import { createBoundedLog } from "../src/domain/bounded-log.js";

const WINDOW = 3;

describe("createBoundedLog", () => {
  it("keeps the most recent entries in order and drops the oldest past the window", () => {
    const log = createBoundedLog<number>(WINDOW);
    for (let entry = 1; entry <= WINDOW + 2; entry += 1) {
      log.record(entry);
    }

    expect(log.entries()).toEqual([
      WINDOW,
      WINDOW + 1,
      WINDOW + 2,
    ]);
  });

  it("hands out a copy, so a caller cannot change the log", () => {
    const log = createBoundedLog<number>(WINDOW);
    log.record(1);
    log.entries().push(2);

    expect(log.entries()).toEqual([1]);
  });
});
