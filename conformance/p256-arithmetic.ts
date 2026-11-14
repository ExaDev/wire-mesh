/* Deterministic ECDSA over P-256 with SHA-256 (RFC 6979), with bigint arithmetic, so a vector file can carry an ES256 signature that regenerates byte for byte: node:crypto signs with a fresh nonce each time. Every input is public test material, so nothing here is constant time. */

import { createHash, createHmac } from "node:crypto";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const THREE = BigInt("3");
const BYTE_MASK = BigInt("0xff");
const FIELD = BigInt(
  "0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
);
const ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);
const GENERATOR: AffinePoint = [
  BigInt("0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296"),
  BigInt("0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5"),
];
const SCALAR_BYTES = 32;
const CURVE_A = FIELD - THREE;
const BITS_PER_BYTE = BigInt("8");
const BYTES_V_INIT = 1;
const UNCOMPRESSED_TAG = 4;
const SEPARATOR_LOW = 0;
const SEPARATOR_HIGH = 1;

type AffinePoint = readonly [bigint, bigint];
type MaybePoint = AffinePoint | undefined;

function mod(value: bigint, modulus: bigint): bigint {
  const reduced = value % modulus;

  return reduced >= ZERO ? reduced : reduced + modulus;
}

function invert(value: bigint, modulus: bigint): bigint {
  let [low, high] = [mod(value, modulus), modulus];
  let [lowCoefficient, highCoefficient] = [ONE, ZERO];
  while (low > ONE) {
    const quotient = high / low;
    [low, high] = [high - quotient * low, low];
    [lowCoefficient, highCoefficient] = [
      highCoefficient - quotient * lowCoefficient,
      lowCoefficient,
    ];
  }

  return mod(lowCoefficient, modulus);
}

/** The sum of two points, where `undefined` is the point at infinity. */
function addPoints(p: MaybePoint, q: MaybePoint): MaybePoint {
  if (p === undefined) {
    return q;
  }
  if (q === undefined) {
    return p;
  }
  const [x1, y1] = p;
  const [x2, y2] = q;
  if (x1 === x2 && mod(y1 + y2, FIELD) === ZERO) {
    return undefined;
  }
  const slope =
    x1 === x2
      ? mod((THREE * x1 * x1 + CURVE_A) * invert(TWO * y1, FIELD), FIELD)
      : mod((y2 - y1) * invert(x2 - x1, FIELD), FIELD);
  const x3 = mod(slope * slope - x1 - x2, FIELD);

  return [x3, mod(slope * (x1 - x3) - y1, FIELD)];
}

function multiply(scalar: bigint, point: AffinePoint): MaybePoint {
  let result: MaybePoint;
  let addend: MaybePoint = point;
  let remaining = scalar;
  while (remaining > ZERO) {
    if ((remaining & ONE) === ONE) {
      result = addPoints(result, addend);
    }
    addend = addPoints(addend, addend);
    remaining >>= ONE;
  }

  return result;
}

function toBytes(value: bigint, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & BYTE_MASK);
    remaining >>= BITS_PER_BYTE;
  }

  return bytes;
}

function toInteger(bytes: Uint8Array): bigint {
  let value = ZERO;
  for (const byte of bytes) {
    value = (value << BITS_PER_BYTE) | BigInt(byte);
  }

  return value;
}

function hmac(key: Buffer, ...parts: readonly Uint8Array[]): Buffer {
  const mac = createHmac("sha256", key);
  for (const part of parts) {
    mac.update(part);
  }

  return mac.digest();
}

/** The RFC 6979 nonce for a private scalar and a message digest. */
function nonce(secret: bigint, digest: Buffer): bigint {
  const x = toBytes(secret, SCALAR_BYTES);
  const h = toBytes(mod(toInteger(digest), ORDER), SCALAR_BYTES);
  let v: Buffer = Buffer.alloc(SCALAR_BYTES, BYTES_V_INIT);
  let k: Buffer = Buffer.alloc(SCALAR_BYTES, SEPARATOR_LOW);
  k = hmac(k, v, Buffer.from([SEPARATOR_LOW]), x, h);
  v = hmac(k, v);
  k = hmac(k, v, Buffer.from([SEPARATOR_HIGH]), x, h);
  v = hmac(k, v);
  for (;;) {
    v = hmac(k, v);
    const candidate = toInteger(v);
    if (candidate >= ONE && candidate < ORDER) {
      return candidate;
    }
    k = hmac(k, v, Buffer.from([SEPARATOR_LOW]));
    v = hmac(k, v);
  }
}

/** The SEC1 uncompressed public key (0x04 || X || Y) of a private scalar. */
export function p256PublicKey(secret: bigint): Buffer {
  const point = multiply(secret, GENERATOR);
  if (point === undefined) {
    throw new Error("the private scalar is zero");
  }

  return Buffer.concat([
    Buffer.from([UNCOMPRESSED_TAG]),
    toBytes(point[0], SCALAR_BYTES),
    toBytes(point[1], SCALAR_BYTES),
  ]);
}

/** The ES256 signature of `message`: the raw 64-byte r || s of the RFC 6979 deterministic ECDSA over its SHA-256. */
export function p256Sign(secret: bigint, message: Uint8Array): Buffer {
  const digest = createHash("sha256").update(message).digest();
  const k = nonce(secret, digest);
  const point = multiply(k, GENERATOR);
  if (point === undefined) {
    throw new Error("the nonce is a multiple of the order");
  }
  const r = mod(point[0], ORDER);
  const s = mod(invert(k, ORDER) * (toInteger(digest) + r * secret), ORDER);

  return Buffer.concat([toBytes(r, SCALAR_BYTES), toBytes(s, SCALAR_BYTES)]);
}
