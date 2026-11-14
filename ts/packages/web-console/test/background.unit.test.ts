import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInBackground } from "../src/background.js";

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

  it("drops a failure on purpose when no callback is given, with nothing unhandled", async () => {
    startInBackground(Promise.reject(new Error("the work failed")));
    await letRejectionsSurface();

    expect(unhandled).toEqual([]);
  });
});
