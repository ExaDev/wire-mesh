import { describe, expect, it } from "vitest";
import {
  formatAgo,
  formatRemaining,
  formatUntil,
} from "../src/format-duration.js";

const SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MINUTE = SECONDS_PER_MINUTE * SECOND;
const HOUR = MINUTES_PER_HOUR * MINUTE;
const DAY = HOURS_PER_DAY * HOUR;

const JUST_UNDER_A_SECOND = SECOND - 1;
const FEW = 3;
const JUST_UNDER_A_MINUTE = SECONDS_PER_MINUTE - 1;
const TWO = 2;
const CLOCK_AHEAD = -FEW * SECOND;
const ONE_AND_A_HALF_SECONDS = 1500;
const OVERDUE = -200;

describe("formatAgo", () => {
  it("reads under a second, and a peer clock ahead of ours, as just now", () => {
    expect(formatAgo(JUST_UNDER_A_SECOND)).toBe("just now");
    expect(formatAgo(CLOCK_AHEAD)).toBe("just now");
  });

  it("picks the coarsest whole unit", () => {
    expect(formatAgo(FEW * SECOND)).toBe("3 s ago");
    expect(formatAgo(JUST_UNDER_A_MINUTE * SECOND)).toBe("59 s ago");
    expect(formatAgo(MINUTE)).toBe("1 min ago");
    expect(formatAgo(TWO * HOUR)).toBe("2 h ago");
    expect(formatAgo(FEW * DAY)).toBe("3 d ago");
  });
});

describe("formatRemaining", () => {
  it("rounds up so a countdown never reads zero with time left", () => {
    expect(formatRemaining(1)).toBe("1 s");
    expect(formatRemaining(ONE_AND_A_HALF_SECONDS)).toBe("2 s");
    expect(formatRemaining(0)).toBe("0 s");
    expect(formatRemaining(OVERDUE)).toBe("0 s");
  });
});

describe("formatUntil", () => {
  it("reads a time still to come in the coarsest whole unit", () => {
    expect(formatUntil(FEW * SECOND)).toBe("in 3 s");
    expect(formatUntil(TWO * HOUR)).toBe("in 2 h");
  });

  it("reads under a second as such rather than as just now", () => {
    expect(formatUntil(JUST_UNDER_A_SECOND)).toBe("in under a second");
  });
});
