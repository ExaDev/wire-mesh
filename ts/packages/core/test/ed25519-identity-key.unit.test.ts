import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ed25519KeyFault,
  ed25519SignatureIsStrict,
} from "../src/domain/ed25519-identity-key.js";
import { verifyWithPublicKey } from "../src/adapters/node-identity.js";
import { IdentityKeyError } from "../src/ports/identity.js";

const EDDSA = -8;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / HEX_DIGITS_PER_BYTE);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      hex.slice(index * HEX_DIGITS_PER_BYTE, (index + 1) * HEX_DIGITS_PER_BYTE),
      HEX_RADIX,
    );
  }

  return bytes;
}

/** The eight points of small order, canonical encodings. */
const SMALL_ORDER = [
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0000000000000000000000000000000000000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
];

/** An encoding of 32 bytes: the given lowest byte, thirty bytes of ff, and the given top byte, as hex. */
function paddedHex(low: string, top: string): string {
  return `${low}${"ff".repeat(KEY_BYTES - HEX_DIGITS_PER_BYTE)}${top}`;
}

async function generatedKey(): Promise<{
  publicKey: Uint8Array<ArrayBuffer>;
  privateKey: webcrypto.CryptoKey;
}> {
  // The same overload steer as tokens-fixtures.ts: a bare { name: "Ed25519" } mis-resolves to the CryptoKey-only overload in @types/node.
  const pair = await webcrypto.subtle.generateKey(
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign", "verify"],
  );

  return {
    publicKey: new Uint8Array(
      await webcrypto.subtle.exportKey("raw", pair.publicKey),
    ),
    privateKey: pair.privateKey,
  };
}

describe("ed25519KeyFault", () => {
  it.each(SMALL_ORDER)("refuses the small-order point %s", (hex) => {
    expect(ed25519KeyFault(fromHex(hex))).toBe("small_order");
  });

  it("refuses an encoding with y at or above the prime, whichever point it names", () => {
    // y = p + 1 (the identity element), y = p (an order-four point), y = p + 3 (an ordinary point), each with and without the sign bit.
    for (const [low, top] of [
      ["ee", "7f"],
      ["ed", "7f"],
      ["f0", "7f"],
      ["f0", "ff"],
      ["ee", "ff"],
    ] as const) {
      expect(ed25519KeyFault(fromHex(paddedHex(low, top)))).toBe(
        "non_canonical",
      );
    }
  });

  it("refuses the identity element written with a sign bit", () => {
    expect(ed25519KeyFault(fromHex(`01${"00".repeat(KEY_BYTES - 2)}80`))).toBe(
      "small_order",
    );
  });

  it("refuses a y that is the y of no point, and the wrong sizes", () => {
    expect(ed25519KeyFault(fromHex(`02${"00".repeat(KEY_BYTES - 1)}`))).toBe(
      "not_a_point",
    );
    expect(ed25519KeyFault(new Uint8Array(KEY_BYTES - 1))).toBe("wrong_size");
    expect(ed25519KeyFault(new Uint8Array(KEY_BYTES + 1))).toBe("wrong_size");
    expect(ed25519KeyFault(new Uint8Array())).toBe("wrong_size");
  });

  it("refuses a key with a torsion component, whether or not it is small order", () => {
    // y = 3 is a curve point of mixed order, and so is [a]B plus a point of order 8.
    expect(ed25519KeyFault(fromHex(`03${"00".repeat(KEY_BYTES - 1)}`))).toBe(
      "mixed_order",
    );
    expect(
      ed25519KeyFault(
        fromHex(
          "3deb8ca9e3d031548d729bed3aa7f3840e256888362f1ea239c189f03b281f24",
        ),
      ),
    ).toBe("mixed_order");
  });

  it("accepts an ordinary point and a generated key", async () => {
    // The base point: y = 4/5.
    expect(
      ed25519KeyFault(
        fromHex(
          "5866666666666666666666666666666666666666666666666666666666666666",
        ),
      ),
    ).toBeUndefined();
    expect(ed25519KeyFault((await generatedKey()).publicKey)).toBeUndefined();
  });
});

describe("ed25519SignatureIsStrict", () => {
  it("refuses a signature whose R is of small order, whose S is not reduced, or that is the wrong size", () => {
    const signature = new Uint8Array(SIGNATURE_BYTES);
    signature.fill(1, KEY_BYTES);
    signature.set(fromHex(SMALL_ORDER[0] ?? ""), 0);
    expect(ed25519SignatureIsStrict(signature)).toBe(false);
    // R is an ordinary point, and S is all ones, far above the group order.
    expect(
      ed25519SignatureIsStrict(
        fromHex(`03${"00".repeat(KEY_BYTES - 1)}${"ff".repeat(KEY_BYTES)}`),
      ),
    ).toBe(false);
    expect(ed25519SignatureIsStrict(new Uint8Array(SIGNATURE_BYTES - 1))).toBe(
      false,
    );
  });
});

describe("verifyWithPublicKey for Ed25519", () => {
  it("throws an invalid_key fault for a weak key, whatever signature accompanies it", async () => {
    const identityElement = fromHex(SMALL_ORDER[0] ?? "");
    const trivialSignature = new Uint8Array(SIGNATURE_BYTES);
    trivialSignature[0] = 1;
    await expect(
      verifyWithPublicKey(
        { alg: EDDSA, "public-key": identityElement },
        fromHex("010203"),
        trivialSignature,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IdentityKeyError && error.fault === "invalid_key",
    );
  });

  it("verifies a genuine signature and refuses one with R replaced by a small-order point", async () => {
    const { publicKey, privateKey } = await generatedKey();
    const message = fromHex("090807");
    const signature = new Uint8Array(
      await webcrypto.subtle.sign({ name: "Ed25519" }, privateKey, message),
    );
    const key = { alg: EDDSA, "public-key": publicKey };
    expect(await verifyWithPublicKey(key, message, signature)).toBe(true);
    signature.set(fromHex(SMALL_ORDER[0] ?? ""), 0);
    expect(await verifyWithPublicKey(key, message, signature)).toBe(false);
  });
});
