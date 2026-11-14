/* Edwards25519 arithmetic with bigint, written from RFC 8032, for building signatures that no honest signer produces: a signature whose R is of small order or not canonical, or a key or R with a torsion component. node:crypto signs only honestly, so these need the group operations themselves. Every input is public test material, so nothing here is constant time. */

import { createHash } from "node:crypto";

const BITS_PER_BYTE = 8;
const ENCODED_BYTES = 32;
const SIGN_SHIFT = 255;
const ORDER_BITS = 252;
const PRIME_OFFSET = 19;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const THREE = BigInt("3");
const FOUR = BigInt("4");
const EIGHT = BigInt("8");
const BYTE_MASK = BigInt("0xff");
const D_NUMERATOR = BigInt("-121665");
const D_DENOMINATOR = BigInt("121666");
const FIVE = BigInt("5");
const FIELD_PRIME = (ONE << BigInt(SIGN_SHIFT)) - BigInt(PRIME_OFFSET);
export const GROUP_ORDER =
  (ONE << BigInt(ORDER_BITS)) +
  BigInt("27742317777372353535851937790883648493");
const CLAMP_LOW = 0xf8;
const CLAMP_HIGH_MASK = 0x7f;
const CLAMP_HIGH_BIT = 0x40;
const LAST = ENCODED_BYTES - 1;

export type Point = readonly [bigint, bigint];

function modPow(base: bigint, exponent: bigint): bigint {
  let result = ONE;
  let factor = base % FIELD_PRIME;
  let remaining = exponent;
  while (remaining > ZERO) {
    if ((remaining & ONE) === ONE) {
      result = (result * factor) % FIELD_PRIME;
    }
    factor = (factor * factor) % FIELD_PRIME;
    remaining >>= ONE;
  }

  return result;
}

function mod(value: bigint): bigint {
  const reduced = value % FIELD_PRIME;

  return reduced >= ZERO ? reduced : reduced + FIELD_PRIME;
}

function inverse(value: bigint): bigint {
  return modPow(mod(value), FIELD_PRIME - TWO);
}

const CURVE_D = mod(D_NUMERATOR * inverse(D_DENOMINATOR));
const SQRT_MINUS_ONE = modPow(TWO, (FIELD_PRIME - ONE) / FOUR);

export function readLittleEndian(bytes: Uint8Array): bigint {
  let value = ZERO;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << BigInt(BITS_PER_BYTE)) | BigInt(bytes[index] ?? 0);
  }

  return value;
}

export function writeLittleEndian(value: bigint, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number(remaining & BYTE_MASK);
    remaining >>= BigInt(BITS_PER_BYTE);
  }

  return bytes;
}

/** The complete affine addition law of the twisted Edwards curve with a = -1. */
export function add(p: Point, q: Point): Point {
  const [x1, y1] = p;
  const [x2, y2] = q;
  const product = mod(CURVE_D * x1 * x2 * y1 * y2);

  return [
    mod((x1 * y2 + x2 * y1) * inverse(ONE + product)),
    mod((y1 * y2 + x1 * x2) * inverse(ONE - product)),
  ];
}

export function multiply(scalar: bigint, point: Point): Point {
  let result: Point = [ZERO, ONE];
  let addend = point;
  let remaining = scalar;
  while (remaining > ZERO) {
    if ((remaining & ONE) === ONE) {
      result = add(result, addend);
    }
    addend = add(addend, addend);
    remaining >>= ONE;
  }

  return result;
}

/** The point with this y and an x of the given parity. */
export function pointFromY(y: bigint, xIsOdd: boolean): Point {
  const numerator = mod(y * y - ONE);
  const denominator = mod(CURVE_D * y * y + ONE);
  let x = modPow(
    mod(numerator * inverse(denominator)),
    (FIELD_PRIME + THREE) / EIGHT,
  );
  if (mod(denominator * x * x - numerator) !== ZERO) {
    x = mod(x * SQRT_MINUS_ONE);
  }
  if (mod(denominator * x * x - numerator) !== ZERO) {
    throw new Error("no point has this y");
  }
  if (((x & ONE) === ONE) !== xIsOdd) {
    x = mod(-x);
  }

  return [x, y];
}

/** The canonical encoding of a point: y little-endian with the parity of x in the top bit. */
export function encodePoint(point: Point): Buffer {
  const [x, y] = point;

  return writeLittleEndian(
    y | ((x & ONE) << BigInt(SIGN_SHIFT)),
    ENCODED_BYTES,
  );
}

export function decodePoint(encoding: Uint8Array): Point {
  const value = readLittleEndian(encoding);
  const y = value & ((ONE << BigInt(SIGN_SHIFT)) - ONE);

  return pointFromY(y, value >> BigInt(SIGN_SHIFT) === ONE);
}

const BASE_Y = mod(FOUR * inverse(FIVE));
export const BASE_POINT: Point = pointFromY(BASE_Y, false);
/** A point of order 8: its multiples by 4 are the point of order 2. */
export const ORDER_EIGHT_POINT: Point = decodePoint(
  Buffer.from(
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "hex",
  ),
);
export const IDENTITY_POINT: Point = [ZERO, ONE];

function sha512(...parts: readonly Uint8Array[]): Buffer {
  const hash = createHash("sha512");
  for (const part of parts) {
    hash.update(part);
  }

  return hash.digest();
}

/** The secret scalar of an Ed25519 seed (RFC 8032 section 5.1.5): the clamped low half of its SHA-512. */
export function secretScalar(seed: Uint8Array): bigint {
  const digest = sha512(seed);
  const low = digest.subarray(0, ENCODED_BYTES);
  low[0] = (low[0] ?? 0) & CLAMP_LOW;
  low[LAST] = ((low[LAST] ?? 0) & CLAMP_HIGH_MASK) | CLAMP_HIGH_BIT;

  return readLittleEndian(low);
}

/** The challenge k = SHA-512(R || A || message) mod L. */
export function challenge(
  rEncoding: Uint8Array,
  aEncoding: Uint8Array,
  message: Uint8Array,
): bigint {
  return readLittleEndian(sha512(rEncoding, aEncoding, message)) % GROUP_ORDER;
}

/** What `signWith` signs with: the secret scalar and public key of the signer, and the nonce, given as the bytes of R and the scalar r behind it (R need not be [r]B, which is how a signature with a torsion or small-order R is built). */
export interface SigningInputs {
  secret: bigint;
  publicKeyEncoding: Uint8Array;
  rEncoding: Uint8Array;
  nonceScalar: bigint;
}

/** A signature `R || S` that satisfies the cofactorless equation for the given nonce scalar, whatever the point R is made of: S = r + k a mod L, where k hashes the bytes of R given (not a re-encoding of it). */
export function signWith(inputs: SigningInputs, message: Uint8Array): Buffer {
  const k = challenge(inputs.rEncoding, inputs.publicKeyEncoding, message);
  const s = (inputs.nonceScalar + k * inputs.secret) % GROUP_ORDER;

  return Buffer.concat([inputs.rEncoding, writeLittleEndian(s, ENCODED_BYTES)]);
}

/** A signature under `keyEncoding` with an honest R = [r]B whose challenge is a multiple of 8, found by trying nonces from `startNonce` upwards. For a key A = [a]B + T with T of order 8 the cofactorless equation then holds (k T is the identity), so the only thing wrong with the signature is the key's torsion component, and a verifier that checks the key refuses it for that reason alone. */
export function signUnderTorsionKey(
  secret: bigint,
  keyEncoding: Uint8Array,
  startNonce: bigint,
  message: Uint8Array,
): Buffer {
  for (let nonce = startNonce; ; nonce += ONE) {
    const rEncoding = encodePoint(multiply(nonce, BASE_POINT));
    if (challenge(rEncoding, keyEncoding, message) % EIGHT === ZERO) {
      return signWith(
        {
          secret,
          publicKeyEncoding: keyEncoding,
          rEncoding,
          nonceScalar: nonce,
        },
        message,
      );
    }
  }
}
