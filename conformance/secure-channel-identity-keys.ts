/* Hello verdicts about the bytes of an identity key, which the spec (identity.cddl) fixes: a key is accepted only in its one canonical encoding and only when it is usable, and a refusal comes before any signature check. The device-id is the hash of the bytes a hello carries, so each hello names the device-id of the bytes it presents.

Everything is computed with node:crypto through secure-channel-crypto.ts and the group arithmetic in ed25519-arithmetic.ts, like the rest of secure-channel.v1.json. */

import {
  EDDSA,
  ES256,
  SCALAR_BYTE_LENGTH,
  identityNamed,
  helloMessage,
  makeHello,
  presentedAs,
  type Handshake,
} from "./secure-channel-crypto.ts";
import {
  BASE_POINT,
  GROUP_ORDER,
  IDENTITY_POINT,
  ORDER_EIGHT_POINT,
  add,
  encodePoint,
  multiply,
  readLittleEndian,
  secretScalar,
  signUnderTorsionKey,
  signWith,
  writeLittleEndian,
} from "./ed25519-arithmetic.ts";
import type { HelloVerdict } from "./secure-channel-vectors.ts";

const ED25519_PUBLIC_KEY_BYTES = 32;
const SEC1_UNCOMPRESSED_BYTES = 65;
const SEC1_UNCOMPRESSED_PREFIX = 0x04;
const SIGN_BIT = 0x80;
const TOP_BYTE = ED25519_PUBLIC_KEY_BYTES - 1;
// The field prime is 2^255 - 19, so a y coordinate of 19 or more cannot be written with 255 bits above it, and the encoding p + y fits for y below 19. Little-endian p is ed, thirty bytes of ff, then 7f.
const PRIME_LOW_BYTE = 0xed;
const ALL_BITS_BYTE = 0xff;
const PRIME_TOP_BYTE = 0x7f;

const COMPRESSED_EVEN_PREFIX = 0x02;
const COMPACT_PREFIX = 0x05;
const ORDINARY_Y = 3;
// A fixed nonce scalar for the Ed25519 signatures built here
const NONCE_SCALAR = BigInt(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef",
);
const NO_NONCE = BigInt(0);

/** The eight points of small order in their canonical encodings: the identity element, the point of order 2, the two of order 4 and the four of order 8. */
const SMALL_ORDER_ENCODINGS: readonly (readonly [string, string])[] = [
  [
    "identity_element",
    "0100000000000000000000000000000000000000000000000000000000000000",
  ],
  [
    "order_two",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  ],
  [
    "order_four_even",
    "0000000000000000000000000000000000000000000000000000000000000000",
  ],
  [
    "order_four_odd",
    "0000000000000000000000000000000000000000000000000000000000000080",
  ],
  [
    "order_eight_a_even",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  ],
  [
    "order_eight_a_odd",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  ],
  [
    "order_eight_b_even",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  ],
  [
    "order_eight_b_odd",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
  ],
];

/** The encoding of y + p, which names the same point as y but is not canonical, with the sign bit of x as given. */
function aboveThePrime(y: number, signBit: boolean): Buffer {
  const bytes = Buffer.alloc(ED25519_PUBLIC_KEY_BYTES, ALL_BITS_BYTE);
  bytes[0] = PRIME_LOW_BYTE + y;
  bytes[TOP_BYTE] = signBit ? ALL_BITS_BYTE : PRIME_TOP_BYTE;

  return bytes;
}

/** The identity element with the sign bit of x set: x is zero, so there is no such point, and it is a second spelling of the identity element. */
function identityElementWithSignBit(): Buffer {
  const bytes = Buffer.alloc(ED25519_PUBLIC_KEY_BYTES);
  bytes[0] = 1;
  bytes[TOP_BYTE] = SIGN_BIT;

  return bytes;
}

/** Verdicts for hellos from the first side of `handshake`, delivered to `receiver`, whose identity key bytes are ones a verifier refuses, or whose signature is one a lax verifier accepts. Every key refusal is shown with a signature that verifies where one can, so the refusal is the key's and not the signature's: an Ed25519 signature with R the identity element and S zero verifies under the identity element for any message. */
export function identityKeyVerdicts(
  handshake: Handshake,
  receiver: string,
): HelloVerdict[] {
  const [sideA] = handshake.sides;
  const hello = sideA.hello;
  const verdicts: HelloVerdict[] = [];
  const present = (
    name: string,
    key: Buffer,
    expected: HelloVerdict["expected"],
    sign?: (signingInput: Buffer) => Buffer,
  ): void => {
    const sender = presentedAs(sideA.identity, key);
    const made = makeHello({
      name: `verdict_${handshake.name}_${name}`,
      from: sender,
      to: hello.to,
      ephemeralPublic: hello.ephemeralPublic,
      nonce: hello.nonce,
      signer: sideA.identity,
    });
    const presented =
      sign === undefined
        ? made
        : { ...made, signature: sign(made.signingInput) };
    verdicts.push({
      name,
      receiver,
      message: helloMessage(presented),
      signed: presented,
      expected,
    });
  };

  if (sideA.identity.alg === EDDSA) {
    const trivialSignature = (): Buffer => {
      const signature = Buffer.alloc(2 * ED25519_PUBLIC_KEY_BYTES);
      signature[0] = 1;

      return signature;
    };
    for (const [name, hexEncoding] of SMALL_ORDER_ENCODINGS) {
      present(
        `identity_key_small_order_${name}`,
        Buffer.from(hexEncoding, "hex"),
        "invalid_identity_key",
        trivialSignature,
      );
    }
    // Written with y + p, and the identity element with a sign bit it cannot have: not canonical, so refused whether or not the point is of small order.
    present(
      "identity_key_non_canonical_identity_element",
      aboveThePrime(1, false),
      "invalid_identity_key",
      trivialSignature,
    );
    present(
      "identity_key_non_canonical_order_four",
      aboveThePrime(0, false),
      "invalid_identity_key",
      trivialSignature,
    );
    present(
      "identity_key_non_canonical_identity_element_sign_bit",
      identityElementWithSignBit(),
      "invalid_identity_key",
      trivialSignature,
    );
    present(
      "identity_key_non_canonical_ordinary_point",
      aboveThePrime(ORDINARY_Y, false),
      "invalid_identity_key",
    );
    present(
      "identity_key_non_canonical_ordinary_point_sign_bit",
      aboveThePrime(ORDINARY_Y, true),
      "invalid_identity_key",
    );
    // A usable key (another identity's) with the first side's signature: refused for the signature, not the key.
    present(
      "identity_key_other_key_wrong_signature",
      identityNamed("c").publicKey,
      "bad_signature",
    );

    // An honest key with one fault in the signature, each a signature a lax verifier accepts.
    const secret = secretScalar(Buffer.from(sideA.identity.secretHex, "hex"));
    const publicKey = sideA.identity.publicKey;
    const nonce = NONCE_SCALAR % GROUP_ORDER;
    const nonceEncoding = encodePoint(multiply(nonce, BASE_POINT));
    const mixedNonceEncoding = encodePoint(
      add(multiply(nonce, BASE_POINT), ORDER_EIGHT_POINT),
    );
    present("signature_s_not_reduced", publicKey, "bad_signature", (input) => {
      const honest = signWith(
        {
          secret,
          publicKeyEncoding: publicKey,
          rEncoding: nonceEncoding,
          nonceScalar: nonce,
        },
        input,
      );
      const s = readLittleEndian(honest.subarray(ED25519_PUBLIC_KEY_BYTES));

      return Buffer.concat([
        honest.subarray(0, ED25519_PUBLIC_KEY_BYTES),
        writeLittleEndian(s + GROUP_ORDER, ED25519_PUBLIC_KEY_BYTES),
      ]);
    });
    present("signature_r_small_order", publicKey, "bad_signature", (input) =>
      signWith(
        {
          secret,
          publicKeyEncoding: publicKey,
          rEncoding: encodePoint(IDENTITY_POINT),
          nonceScalar: NO_NONCE,
        },
        input,
      ),
    );
    present("signature_r_non_canonical", publicKey, "bad_signature", (input) =>
      signWith(
        {
          secret,
          publicKeyEncoding: publicKey,
          rEncoding: aboveThePrime(1, false),
          nonceScalar: NO_NONCE,
        },
        input,
      ),
    );
    present("signature_r_mixed_order", publicKey, "bad_signature", (input) =>
      signWith(
        {
          secret,
          publicKeyEncoding: publicKey,
          rEncoding: mixedNonceEncoding,
          nonceScalar: nonce,
        },
        input,
      ),
    );
    // A key with a torsion component and a signature that satisfies the cofactorless equation too (its challenge is a multiple of 8): refused for the key alone.
    const mixedKey = encodePoint(
      add(multiply(secret, BASE_POINT), ORDER_EIGHT_POINT),
    );
    present(
      "identity_key_mixed_order",
      mixedKey,
      "invalid_identity_key",
      (input) => signUnderTorsionKey(secret, mixedKey, nonce, input),
    );
  }
  if (sideA.identity.alg === ES256) {
    // The same key in two other encodings, each in a hello signed by the key's owner over a signing input that names the device-id of the bytes it carries: the encoding is the only fault.
    const uncompressed = sideA.identity.publicKey;
    const x = uncompressed.subarray(1, 1 + SCALAR_BYTE_LENGTH);
    const yIsOdd = (uncompressed.at(-1) ?? 0) % 2;
    present(
      "identity_key_compressed",
      Buffer.concat([Buffer.from([COMPRESSED_EVEN_PREFIX + yIsOdd]), x]),
      "invalid_identity_key",
    );
    present(
      "identity_key_compact",
      Buffer.concat([Buffer.from([COMPACT_PREFIX]), x]),
      "invalid_identity_key",
    );
    // The point at infinity is a single zero byte in SEC1, and the all-zero point under the uncompressed prefix is not on the curve: neither is a usable key.
    present(
      "identity_key_point_at_infinity",
      Buffer.alloc(1),
      "invalid_identity_key",
    );
    present(
      "identity_key_zero_point",
      Buffer.concat([
        Buffer.from([SEC1_UNCOMPRESSED_PREFIX]),
        Buffer.alloc(SEC1_UNCOMPRESSED_BYTES - 1),
      ]),
      "invalid_identity_key",
    );
  }

  return verdicts;
}
