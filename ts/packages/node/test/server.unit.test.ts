import { describe, expect, it } from "vitest";
import { bindAddressFromArgs } from "../src/server.js";

describe("bindAddressFromArgs", () => {
  it("falls back to 0.0.0.0:8787 when no --bind flag is given", () => {
    expect(bindAddressFromArgs([])).toBe("0.0.0.0:8787");
  });

  it("uses the value following --bind when given", () => {
    expect(bindAddressFromArgs(["--bind", "127.0.0.1:9000"])).toBe(
      "127.0.0.1:9000",
    );
  });

  it("falls back to the default when --bind is the last argument with no value", () => {
    expect(bindAddressFromArgs(["--bind"])).toBe("0.0.0.0:8787");
  });
});
