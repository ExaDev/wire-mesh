// The memo's own policy, independent of what the verdicts are about: which entries it keeps under a byte budget, and what it does with an outcome that must not be kept.

import { describe, expect, it } from "vitest";
import { bytesKey, createVerdictCache } from "../src/domain/verdict-cache.js";

/** Characters in every key these tests build, so a budget can be stated in whole entries. */
const KEY_LENGTH = 8;
/** The cache charges this much per entry on top of its key's length. Restated here, not imported, so a change to it shows up as a failing test of the budget arithmetic. */
const ENTRY_OVERHEAD = 16;
const ENTRY_COST = KEY_LENGTH + ENTRY_OVERHEAD;
const ROOM_FOR_TWO_ENTRIES = 2 * ENTRY_COST;
const BYTES_PER_KIBIBYTE = 1024;
const GENEROUS_BUDGET = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
/** Longer than one String.fromCharCode call can take as arguments, so the chunked path is exercised. */
const LARGER_THAN_ONE_CHUNK = 100_000;
const FILL_BYTE = 7;
const OTHER_BYTE = 8;
const OVERSIZED_KEY_LENGTH = 1000;

const FIRST = 1;
const SECOND = 2;
const THIRD = 3;
const keyOf = (n: number): string => String(n).padStart(KEY_LENGTH, "0");

/** A compute function that records how many times it ran. */
function counted(verdict: boolean | undefined): {
  compute: () => Promise<boolean | undefined>;
  runs: () => number;
} {
  let runs = 0;

  return {
    compute: async () => {
      runs += 1;

      return Promise.resolve(verdict);
    },
    runs: () => runs,
  };
}

describe("bytesKey", () => {
  it("is equal for equal bytes and different for different bytes", () => {
    expect(bytesKey(Uint8Array.of(FIRST, SECOND, THIRD))).toBe(
      bytesKey(Uint8Array.of(FIRST, SECOND, THIRD)),
    );
    expect(bytesKey(Uint8Array.of(FIRST, SECOND, THIRD))).not.toBe(
      bytesKey(Uint8Array.of(FIRST, SECOND, FILL_BYTE)),
    );
  });

  it("cannot be made to collide by shifting bytes between parts", () => {
    expect(
      bytesKey(Uint8Array.of(FIRST, SECOND), Uint8Array.of(THIRD)),
    ).not.toBe(bytesKey(Uint8Array.of(FIRST), Uint8Array.of(SECOND, THIRD)));
  });

  it("keys inputs larger than one fromCharCode call can take", () => {
    const large = new Uint8Array(LARGER_THAN_ONE_CHUNK).fill(FILL_BYTE);
    const other = Uint8Array.from(large);
    other[LARGER_THAN_ONE_CHUNK - 1] = OTHER_BYTE;

    expect(bytesKey(large)).toBe(bytesKey(Uint8Array.from(large)));
    expect(bytesKey(large)).not.toBe(bytesKey(other));
  });
});

describe("createVerdictCache", () => {
  it("computes a key once and answers repeats from memory", async () => {
    const cache = createVerdictCache(GENEROUS_BUDGET);
    const a = counted(true);

    expect(await cache.verdict("k", a.compute)).toBe(true);
    expect(await cache.verdict("k", a.compute)).toBe(true);

    expect(a.runs()).toBe(1);
  });

  it("evicts the least recently used entry first when the budget is exceeded", async () => {
    const cache = createVerdictCache(ROOM_FOR_TWO_ENTRIES);
    const first = counted(true);
    const second = counted(true);
    const third = counted(true);

    await cache.verdict(keyOf(FIRST), first.compute);
    await cache.verdict(keyOf(SECOND), second.compute);
    // Touching the first makes the second the least recently used.
    await cache.verdict(keyOf(FIRST), first.compute);
    await cache.verdict(keyOf(THIRD), third.compute);
    await cache.verdict(keyOf(FIRST), first.compute);
    await cache.verdict(keyOf(SECOND), second.compute);

    expect(first.runs(), "the recently used entry survived").toBe(1);
    expect(second.runs(), "the least recently used entry was evicted").toBe(2);
  });

  it("answers a key larger than the whole budget without keeping it or flushing others", async () => {
    const cache = createVerdictCache(ENTRY_COST);
    const small = counted(true);
    const oversized = counted(false);
    const hostile = "x".repeat(OVERSIZED_KEY_LENGTH);

    await cache.verdict(keyOf(FIRST), small.compute);
    expect(await cache.verdict(hostile, oversized.compute)).toBe(false);
    expect(await cache.verdict(hostile, oversized.compute)).toBe(false);
    await cache.verdict(keyOf(FIRST), small.compute);

    expect(oversized.runs(), "an oversized key is never kept").toBe(2);
    expect(small.runs(), "and it did not push out a normal entry").toBe(1);
  });

  it("reports an unsettled outcome as false to its callers but does not keep it", async () => {
    const cache = createVerdictCache(GENEROUS_BUDGET);
    const failing = counted(undefined);

    expect(await cache.verdict("k", failing.compute)).toBe(false);
    expect(await cache.verdict("k", failing.compute)).toBe(false);

    expect(failing.runs()).toBe(2);
  });
});
