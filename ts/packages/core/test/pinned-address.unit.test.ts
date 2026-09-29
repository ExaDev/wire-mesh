import { describe, expect, it } from "vitest";
import {
  formatPinnedAddress,
  isPinnedAddress,
  parsePinnedAddress,
} from "../src/domain/pinned-address.js";

const HASH_BYTES = 32;
const HASH_BYTE = 0xab; // the value of each byte of HASH_HEX
const HASH_HEX = "ab".repeat(HASH_BYTES);

describe("pinned addresses", () => {
  it("round-trips a host, port and hash", () => {
    const parsed = parsePinnedAddress(
      formatPinnedAddress("192.0.2.5:4433", [HASH_HEX]),
    );
    expect(parsed.url).toBe("https://192.0.2.5:4433/");
    expect(parsed.sha256.map((hash) => Array.from(hash))).toEqual([
      Array(HASH_BYTES).fill(HASH_BYTE),
    ]);
  });

  it("round-trips several hashes in order", () => {
    const otherByte = 0xcd;
    const other = "cd".repeat(HASH_BYTES);
    const parsed = parsePinnedAddress(
      formatPinnedAddress("192.0.2.5:4433", [HASH_HEX, other]),
    );
    expect(parsed.sha256.map((hash) => Array.from(hash))).toEqual([
      Array(HASH_BYTES).fill(HASH_BYTE),
      Array(HASH_BYTES).fill(otherByte),
    ]);
  });

  it("recognises an address that carries a pin", () => {
    expect(
      isPinnedAddress(formatPinnedAddress("192.0.2.5:4433", [HASH_HEX])),
    ).toBe(true);
    expect(isPinnedAddress("https://node.example:8790")).toBe(false);
    expect(isPinnedAddress("wss://node.example:8790")).toBe(false);
  });

  it.each([
    "https://192.0.2.5:4433",
    "wss://192.0.2.5:4433#sha256=" + HASH_HEX,
    "https://192.0.2.5:4433#sha256=abc",
    `https://192.0.2.5:4433#sha256=${HASH_HEX},`,
    `https://192.0.2.5:4433#sha256=${HASH_HEX},abc`,
    "https://192.0.2.5:4433#sha256=" + HASH_HEX.toUpperCase(),
  ])("refuses %s", (address) => {
    expect(() => parsePinnedAddress(address)).toThrow("expected");
  });
});
