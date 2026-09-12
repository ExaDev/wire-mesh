import { describe, expect, it } from "vitest";
import {
  bytesFromHex,
  bytesToHex,
  deviceIdFromHex,
  deviceIdToHex,
} from "../src/domain/device-id.js";
import { deviceIdFromFillHex } from "./hex.js";

const SHA256_BYTE_LENGTH = 32; // device-id = SHA-256(identity-key.public-key)

describe("deviceIdToHex", () => {
  it("encodes a fill-byte device-id as its repeated hex pair", () => {
    expect(deviceIdToHex(deviceIdFromFillHex("11"))).toBe(
      "11".repeat(SHA256_BYTE_LENGTH),
    );
  });

  it("pads a byte below 0x10 to two hex digits", () => {
    const device = deviceIdFromFillHex("11");
    device[0] = 0x0a;
    expect(deviceIdToHex(device).slice(0, 2)).toBe("0a");
  });
});

describe("deviceIdFromHex", () => {
  it("round-trips through deviceIdToHex", () => {
    const original = deviceIdFromFillHex("2a");
    expect(deviceIdFromHex(deviceIdToHex(original))).toStrictEqual(original);
  });

  it("rejects a string that isn't exactly 64 lowercase hex characters", () => {
    expect(() =>
      deviceIdFromHex("11".repeat(SHA256_BYTE_LENGTH - 1)),
    ).toThrow(); // too short
    expect(() =>
      deviceIdFromHex(`${"11".repeat(SHA256_BYTE_LENGTH)}gg`),
    ).toThrow(); // non-hex characters
    expect(() => deviceIdFromHex("AA".repeat(SHA256_BYTE_LENGTH))).toThrow(); // uppercase, not the canonical lowercase form
  });
});

const ARBITRARY_BYTE_SEQUENCE_HEX = "002aff100a";

describe("bytesFromHex", () => {
  it("round-trips an arbitrary-length byte string through bytesToHex", () => {
    const original = bytesFromHex(ARBITRARY_BYTE_SEQUENCE_HEX);
    expect(bytesFromHex(bytesToHex(original))).toStrictEqual(original);
  });

  it("decodes an odd-looking but valid hex pair-by-pair", () => {
    expect(bytesFromHex("002aff")).toStrictEqual(
      Uint8Array.from(
        Array.from({ length: 3 }, (_unused, index) =>
          Number.parseInt("002aff".slice(index * 2, index * 2 + 2), 16),
        ),
      ),
    );
  });

  it("rejects an odd-length string", () => {
    expect(() => bytesFromHex("abc")).toThrow();
  });

  it("rejects non-hex characters", () => {
    expect(() => bytesFromHex("zz")).toThrow();
  });

  it("rejects uppercase, not the canonical lowercase form", () => {
    expect(() => bytesFromHex("AA")).toThrow();
  });

  it("accepts an empty string as zero bytes", () => {
    expect(bytesFromHex("")).toStrictEqual(new Uint8Array(0));
  });
});
