/**
 * What an Ed25519 identity-key must be, and what an Ed25519 signature under one must look like, decided here and nowhere else, before the platform's crypto library is consulted.
 *
 * A key is usable when it is exactly 32 bytes, is the canonical encoding of a point on the curve (its y coordinate is below the field prime, and it decodes), is not a point of small order (the eight points of the torsion subgroup, the identity element among them), and lies in the prime-order subgroup (it has no torsion component). A signature is acceptable to verify when its S is below the group order and its R is a canonical encoding that is not a small-order point. The signature equation itself is the cofactorless one, `[S]B = R + [k]A` compared as encodings, which Web Crypto's Ed25519 verification does on the platforms the conformance vectors are run on: a platform that verifies differently fails the mixed-order vectors there. The Rust crates apply the same rules through ed25519-dalek's `is_weak`, `is_torsion_free` and `verify_strict`.
 */

import { bytesToHex } from "./device-id.js";

const BITS_PER_BYTE = 8;
const THREE = 3;
const FOUR = 4;
const EIGHT = 8;
// The field prime is 2^255 - 19, and the group order is 2^252 plus a 125-bit constant
const FIELD_BITS = 255;
const PRIME_OFFSET = 19;
const ORDER_BITS = 252;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const BYTE_BITS = BigInt(BITS_PER_BYTE);
const SIGN_BIT_BYTE = 31;
const SIGN_BIT_MASK = 0x7f;
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);

/** The field prime, 2^255 - 19. */
const FIELD_PRIME = (ONE << BigInt(FIELD_BITS)) - BigInt(PRIME_OFFSET);
/** The order of the prime-order subgroup. */
const GROUP_ORDER =
  (ONE << BigInt(ORDER_BITS)) +
  BigInt("27742317777372353535851937790883648493");
/** The curve constant d = -121665 / 121666, as a field element. */
const CURVE_D = BigInt(
  "37095705934669439343138083508754565189542113879843219016388785533085940283555",
);

/**
 * The y coordinates of the eight small-order points: 0 (two points of order 4), 1 (the identity element), -1 (order 2) and the two pairs of order 8. Both signs of x share each y, so a key is small-order exactly when its y is one of these, whatever its sign bit.
 */
const SMALL_ORDER_Y = new Set<bigint>(
  [
    "0",
    "1",
    "7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffec",
    "5fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826",
    "7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7",
  ].map((hex) => BigInt(`0x${hex}`)),
);

/** Why a key is refused, in the order the checks run. */
export type Ed25519KeyFault =
  | "wrong_size"
  | "non_canonical"
  | "not_a_point"
  | "small_order"
  | "mixed_order";

function littleEndian(bytes: Uint8Array): bigint {
  let value = ZERO;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << BYTE_BITS) | BigInt(bytes[index] ?? 0);
  }

  return value;
}

/** The y coordinate an encoding carries: the 255 low bits, with the sign bit of x cleared. */
function encodedY(encoding: Uint8Array): bigint {
  const bytes = Uint8Array.from(encoding);
  bytes[SIGN_BIT_BYTE] = (bytes[SIGN_BIT_BYTE] ?? 0) & SIGN_BIT_MASK;

  return littleEndian(bytes);
}

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

/** A point in extended homogeneous coordinates (x = X/Z, y = Y/Z, x y = T/Z). */
interface ExtendedPoint {
  x: bigint;
  y: bigint;
  z: bigint;
  t: bigint;
}

function mod(value: bigint): bigint {
  const reduced = value % FIELD_PRIME;

  return reduced >= ZERO ? reduced : reduced + FIELD_PRIME;
}

/** sqrt(-1) modulo the prime: 2^((p - 1) / 4). */
const SQRT_MINUS_ONE = modPow(TWO, (FIELD_PRIME - ONE) / BigInt(FOUR));

/** A point with the given y, with either sign of x (negating a point preserves its order, so the sign does not matter to a subgroup test), or `undefined` when no point has that y. */
function pointWithY(y: bigint): ExtendedPoint | undefined {
  const ySquared = mod(y * y);
  const numerator = mod(ySquared - ONE);
  const denominator = mod(CURVE_D * ySquared + ONE);
  const target = mod(numerator * modPow(denominator, FIELD_PRIME - TWO));
  // The square root of a value modulo a prime congruent to 5 modulo 8 (RFC 8032, section 5.1.3): a candidate, or the candidate times sqrt(-1).
  const candidate = modPow(target, (FIELD_PRIME + BigInt(THREE)) / BigInt(EIGHT));
  for (const x of [candidate, mod(candidate * SQRT_MINUS_ONE)]) {
    if (mod(x * x) === target) {
      return { x, y, z: ONE, t: mod(x * y) };
    }
  }

  return undefined;
}

/** The sum of two points: the unified, complete addition of Hisil, Wong, Carter and Dawson for a = -1, which doubles as the doubling. */
function addPoints(p: ExtendedPoint, q: ExtendedPoint): ExtendedPoint {
  const a = mod((p.y - p.x) * (q.y - q.x));
  const b = mod((p.y + p.x) * (q.y + q.x));
  const c = mod(p.t * TWO * CURVE_D * q.t);
  const d = mod(p.z * TWO * q.z);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;

  return { x: mod(e * f), y: mod(g * h), z: mod(f * g), t: mod(e * h) };
}

const IDENTITY_POINT: ExtendedPoint = { x: ZERO, y: ONE, z: ONE, t: ZERO };

/** Whether the point is in the prime-order subgroup: multiplying it by the group order gives the identity element. The point and the order are public, so the double-and-add loop leaks nothing. It costs one doubling per bit of the order below the top (252) and one addition per set bit below the top (72), each a handful of field multiplications, once per distinct key. */
function isTorsionFree(point: ExtendedPoint): boolean {
  let result = IDENTITY_POINT;
  for (let bit = ORDER_BITS; bit >= 0; bit -= 1) {
    result = addPoints(result, result);
    if (((GROUP_ORDER >> BigInt(bit)) & ONE) === ONE) {
      result = addPoints(result, point);
    }
  }

  // The identity element has x = 0 and y = z.
  return result.x === ZERO && result.y === result.z;
}

/** How many key verdicts are remembered, so a key that signs many messages is checked for torsion once and a flood of distinct keys cannot grow the memory without bound. */
const VERDICT_CAPACITY = 1024;
const verdicts = new Map<string, Ed25519KeyFault | undefined>();

function keyFaultUncached(publicKey: Uint8Array): Ed25519KeyFault | undefined {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    return "wrong_size";
  }
  const y = encodedY(publicKey);
  if (y >= FIELD_PRIME) {
    return "non_canonical";
  }
  const point = pointWithY(y);
  if (point === undefined) {
    return "not_a_point";
  }
  if (SMALL_ORDER_Y.has(y)) {
    return "small_order";
  }

  return isTorsionFree(point) ? undefined : "mixed_order";
}

/** The first reason an Ed25519 identity-key's bytes are refused, or `undefined` for a usable key. The checks are independent of the platform's crypto library, and the verdict for a key is remembered (the least recently used first goes once more than a fixed number are held), so verifying many signatures under one key tests it for torsion once. */
export function ed25519KeyFault(
  publicKey: Uint8Array,
): Ed25519KeyFault | undefined {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    return "wrong_size";
  }
  const id = bytesToHex(publicKey);
  if (verdicts.has(id)) {
    const held = verdicts.get(id);
    verdicts.delete(id);
    verdicts.set(id, held);

    return held;
  }
  const fault = keyFaultUncached(publicKey);
  verdicts.set(id, fault);
  for (const oldest of verdicts.keys()) {
    if (verdicts.size <= VERDICT_CAPACITY) {
      break;
    }
    verdicts.delete(oldest);
  }

  return fault;
}

/** Whether a 64-byte Ed25519 signature is acceptable to verify: S below the group order, and R a canonical encoding of a point that is not of small order. A signature that fails this does not verify, whatever the platform's library would say. */
export function ed25519SignatureIsStrict(signature: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_BYTES) {
    return false;
  }
  const r = signature.subarray(0, PUBLIC_KEY_BYTES);
  const s = signature.subarray(PUBLIC_KEY_BYTES);
  const rY = encodedY(r);

  return (
    littleEndian(s) < GROUP_ORDER && rY < FIELD_PRIME && !SMALL_ORDER_Y.has(rY)
  );
}
