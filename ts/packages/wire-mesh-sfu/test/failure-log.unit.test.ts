import { describe, expect, it } from "vitest";
import { MAX_FAULT_TEXT_CHARS } from "wire-mesh-core/domain/fault-report";
import {
  createParticipantFailureLog,
  failureLine,
} from "../src/domain/failure-log.js";

/** What a log line adds around the bounded text: its label and the quotes. */
const LINE_OVERHEAD_CHARS = 64;
const NOT_LOGGED = 3;

describe("failureLine", () => {
  it("quotes the text so a control character in it cannot start another line", () => {
    const line = failureLine("request", new Error("first\nsecond"), 0);

    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(line).toContain("\\n");
  });

  it("cuts the text to the bound", () => {
    const line = failureLine(
      "request",
      new Error("x".repeat(MAX_FAULT_TEXT_CHARS * 2)),
      0,
    );

    expect(line.length).toBeLessThan(
      MAX_FAULT_TEXT_CHARS + LINE_OVERHEAD_CHARS,
    );
  });

  it("says how many failures were not logged before it", () => {
    expect(failureLine("request", new Error("boom"), NOT_LOGGED)).toContain(
      `(${String(NOT_LOGGED)} more not logged)`,
    );
    expect(failureLine("request", new Error("boom"), 0)).not.toContain("more");
  });
});

describe("createParticipantFailureLog", () => {
  it("logs the first failure at once and limits the lines that follow in the same interval", () => {
    const lines: string[] = [];
    const log = createParticipantFailureLog((line) => {
      lines.push(line);
    });

    log(new Error("one"));
    log(new Error("two"));
    log(new Error("three"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("participant failed");
  });
});
