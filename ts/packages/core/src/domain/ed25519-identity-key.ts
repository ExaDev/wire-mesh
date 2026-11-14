/**
 * What an Ed25519 identity-key must be, and what an Ed25519 signature under one must look like, decided here and nowhere else so that every platform and every implementation gives the same verdict for the same bytes. Web Crypto's Ed25519 import and verification differ between crypto libraries on exactly these inputs, so the adapters call this before they import a key or verify a signature and do not rely on the library.
 *
 * A key is usable when it is exactly 32 bytes, is the canonical encoding of a point on the curve (its y coordinate is below the field prime, and it decodes), and is not a point of small order (the eight points of the torsion subgroup, which include the identity element). A signature is acceptable when its S is below the group order and its R is a canonical encoding that is not a small-order point. The Rust crates apply the same rules through ed25519-dalek's `is_weak` and `verify_strict`.
 */

const BITS_PER_BYTE = 8;
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
  "wrong_size" | "non_canonical" | "not_a_point" | "small_order";

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

/** Whether some x satisfies the curve equation for this y: x^2 = (y^2 - 1) / (d y^2 + 1) has a square root (Euler's criterion; zero counts). */
function yIsOnCurve(y: bigint): boolean {
  const ySquared = (y * y) % FIELD_PRIME;
  const numerator = (ySquared - ONE + FIELD_PRIME) % FIELD_PRIME;
  const denominator = (CURVE_D * ySquared + ONE) % FIELD_PRIME;
  const xSquared =
    (numerator * modPow(denominator, FIELD_PRIME - TWO)) % FIELD_PRIME;

  return (
    xSquared === ZERO || modPow(xSquared, (FIELD_PRIME - ONE) / TWO) === ONE
  );
}

/** The first reason an Ed25519 identity-key's bytes are refused, or `undefined` for a usable key. The checks are independent of the platform's crypto library. */
export function ed25519KeyFault(
  publicKey: Uint8Array,
): Ed25519KeyFault | undefined {
  if (publicKey.length !== PUBLIC_KEY_BYTES) {
    return "wrong_size";
  }
  const y = encodedY(publicKey);
  if (y >= FIELD_PRIME) {
    return "non_canonical";
  }
  if (!yIsOnCurve(y)) {
    return "not_a_point";
  }
  if (SMALL_ORDER_Y.has(y)) {
    return "small_order";
  }

  return undefined;
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
