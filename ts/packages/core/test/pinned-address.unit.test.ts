import { describe, expect, it } from "vitest";
import {
  MAX_ANNOUNCED_HASHES,
  decodeCertificateHashes,
  encodeCertificateHashes,
  formatPinnedAddress,
  isPinnedAddress,
  mergeHashes,
  parsePinnedAddress,
  withPinnedHashes,
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

/** CBOR for `{}`, a map with no `sha256` key. */
const CBOR_EMPTY_MAP_BYTE = 0xa0;
const EMPTY_CBOR_MAP = Uint8Array.of(CBOR_EMPTY_MAP_BYTE);
/** A CBOR break code with nothing to break out of: not a value at all. */
const CBOR_BREAK_BYTE = 0xff;
const CBOR_BREAK_ALONE = Uint8Array.of(CBOR_BREAK_BYTE);

describe("certificate hash announcements", () => {
  const first = "ab".repeat(HASH_BYTES);
  const second = "cd".repeat(HASH_BYTES);

  it("round-trips a list of hashes in order", () => {
    const decoded = decodeCertificateHashes(
      encodeCertificateHashes([first, second]),
    );
    expect(decoded.map((hash) => Array.from(hash))).toEqual([
      Array(HASH_BYTES).fill(HASH_BYTE),
      Array(HASH_BYTES).fill(parseInt("cd", 16)),
    ]);
  });

  it("refuses a message that is not a list of one to the most hashes of 32 bytes", () => {
    const tooMany = Array(MAX_ANNOUNCED_HASHES + 1).fill(first) as string[];
    expect(() =>
      decodeCertificateHashes(encodeCertificateHashes([])),
    ).toThrow();
    expect(() =>
      decodeCertificateHashes(encodeCertificateHashes(tooMany)),
    ).toThrow();
    expect(() => decodeCertificateHashes(EMPTY_CBOR_MAP)).toThrow("sha256");
    expect(() => decodeCertificateHashes(CBOR_BREAK_ALONE)).toThrow();
  });

  it("merges without repeating a hash, keeping the earlier list first", () => {
    const [a, b] = decodeCertificateHashes(
      encodeCertificateHashes([first, second]),
    );
    const [only] = decodeCertificateHashes(encodeCertificateHashes([second]));
    if (a === undefined || b === undefined || only === undefined) {
      throw new Error("decoded fewer hashes than encoded");
    }
    expect(mergeHashes([a], [only, b]).map((hash) => Array.from(hash))).toEqual(
      [Array.from(a), Array.from(only)],
    );
  });

  it("puts a new hash list on an address, keeping its host and port", () => {
    const hashes = decodeCertificateHashes(encodeCertificateHashes([second]));
    expect(
      withPinnedHashes(formatPinnedAddress("192.0.2.5:4433", [first]), hashes),
    ).toBe(formatPinnedAddress("192.0.2.5:4433", [second]));
  });
});
