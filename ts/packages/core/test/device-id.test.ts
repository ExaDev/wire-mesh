import { describe, expect, it } from "vitest";
import { deviceIdFromHex, deviceIdToHex } from "../src/domain/device-id.js";
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
