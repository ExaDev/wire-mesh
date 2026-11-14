/* Hello verdicts about the bytes of an identity key, which the spec (identity.cddl) fixes: a key is accepted only in its one canonical encoding and only when it is usable, and a refusal comes before any signature check. The device-id is the hash of the bytes a hello carries, so each hello names the device-id of the bytes it presents.

Everything is computed with node:crypto through secure-channel-crypto.ts, like the rest of secure-channel.v1.json. */

import {
  EDDSA,
  ES256,
  helloMessage,
  makeHello,
  presentedAs,
  type Handshake,
} from "./secure-channel-crypto.ts";
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

const ORDINARY_Y = 3;

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

/** An Ed25519 key of large order, in its canonical encoding: y = 3 is the y of a curve point. */
function ordinaryEncoding(): Buffer {
  const bytes = Buffer.alloc(ED25519_PUBLIC_KEY_BYTES);
  bytes[0] = ORDINARY_Y;

  return bytes;
}

/** Verdicts for hellos from the first side of `handshake`, delivered to `receiver`, whose identity key bytes are ones a verifier refuses. Every hello is signed so that its signature checks out if the key were accepted where one can: an Ed25519 signature with R the identity element and S zero verifies under the identity element for any message, so the refusal is the key's and not the signature's. */
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
    signature?: Buffer,
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
    const presented = signature === undefined ? made : { ...made, signature };
    verdicts.push({
      name,
      receiver,
      message: helloMessage(presented),
      signed: presented,
      expected,
    });
  };

  if (sideA.identity.alg === EDDSA) {
    const trivialSignature = Buffer.alloc(2 * ED25519_PUBLIC_KEY_BYTES);
    trivialSignature[0] = 1;
    for (const [name, hexEncoding] of SMALL_ORDER_ENCODINGS) {
      present(
        `identity_key_small_order_${name}`,
        Buffer.from(hexEncoding, "hex"),
        "invalid_identity_key",
        trivialSignature,
      );
    }
    // The same points and others written with y + p, and the identity element with a sign bit it cannot have: not canonical, so refused whether or not the point is of small order.
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
    // A key of large order in its canonical encoding is usable, so a signature made by another key is refused as a bad signature and not as a bad key.
    present(
      "identity_key_ordinary_point_wrong_signature",
      ordinaryEncoding(),
      "bad_signature",
    );
  }
  if (sideA.identity.alg === ES256) {
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
