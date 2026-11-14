/* Peer-advert vectors for signatures and identity keys that a verifier must refuse although a lax implementation would accept them. Every one has the verdict `verifies: false` (beside one control that is true), so adverts.v1.json pins them for each implementation that reads it, the Rust binary included.

   Each case is built so that the thing it names is the only reason to refuse: the signatures below satisfy the signing equation under the rule a lax verifier uses (reduced or not, cofactored, R compared as a point), and are built with the group arithmetic in ed25519-arithmetic.ts since node:crypto signs only honestly. ES256 signatures are RFC 6979 deterministic (p256-arithmetic.ts), so everything regenerates byte for byte. */

import { createHash, sign as nodeSign } from "node:crypto";
import {
  hex,
  type AdvertVector,
  type JsonWire,
} from "@exadev/wire-mesh-conformance";
import {
  ED25519_SEED_BYTE_LENGTH,
  EDDSA,
  SNAPSHOT_SECONDS,
  advertSigningInput,
  advertiser,
  wireHex,
} from "./adverts.ts";
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
import { p256PublicKey, p256Sign } from "./p256-arithmetic.ts";

const ES256 = -7;
const ADVERTISER_SEED_FILL = 0x7c;
const ES256_SECRET = BigInt(
  "0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
);
const FIXED_NONCE = BigInt(
  "0x0123456789abcdef0123456789abcdef0123456789abcdef",
);
const NO_NONCE = BigInt(0);
const SIGNATURE_HALF_BYTES = 32;
const SEC1_X_START = 1;
const SEC1_X_END = 33;
const COMPRESSED_EVEN_TAG = 2;
const COMPACT_TAG = 5;
// the identity element with y written as p + 1: ee, thirty bytes of ff, then 7f
const NON_CANONICAL_IDENTITY = Buffer.from(
  `ee${"ff".repeat(SIGNATURE_HALF_BYTES - 2)}7f`,
  "hex",
);

const seed = Buffer.alloc(ED25519_SEED_BYTE_LENGTH, ADVERTISER_SEED_FILL);
const secret = secretScalar(seed);
const publicKey = advertiser.publicKeyBytes;
if (!encodePoint(multiply(secret, BASE_POINT)).equals(publicKey)) {
  throw new Error("the advertiser seed does not give the advertiser key");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** An advert for `key` under `alg`, signed by `sign` over its own signing input, with the verdict a verifier must reach. */
function advertFor(
  name: string,
  identityKey: Readonly<{ alg: number; key: Buffer }>,
  sign: (signingInput: Buffer) => Buffer,
  verifies: boolean,
): AdvertVector {
  const { alg, key } = identityKey;
  const content: Record<string, JsonWire> = {
    device: hex(sha256(key)),
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": SNAPSHOT_SECONDS,
    "identity-key": { alg, "public-key": hex(key.toString("hex")) },
  };
  const signingInput = advertSigningInput(content);
  const message: Record<string, JsonWire> = {
    ...content,
    signature: hex(sign(signingInput).toString("hex")),
  };

  return {
    name,
    message,
    wire_hex: wireHex(message),
    signing_input_hex: signingInput.toString("hex"),
    verifies,
  };
}

/** The honest Ed25519 signature of the advertiser. */
function honest(signingInput: Buffer): Buffer {
  return nodeSign(null, signingInput, advertiser.privateKey);
}

const nonceScalar = FIXED_NONCE % GROUP_ORDER;
const mixedNonceEncoding = encodePoint(
  add(multiply(nonceScalar, BASE_POINT), ORDER_EIGHT_POINT),
);
const mixedKey = encodePoint(
  add(multiply(secret, BASE_POINT), ORDER_EIGHT_POINT),
);

const es256Public = p256PublicKey(ES256_SECRET);
const es256X = es256Public.subarray(SEC1_X_START, SEC1_X_END);
const es256YIsOdd = (es256Public.at(-1) ?? 0) % 2;

export const advertIdentityKeyVectors: AdvertVector[] = [
  // S is not below the group order: S + L satisfies the same equation, so a verifier that reduces S accepts what a strict one must not.
  advertFor(
    "peer_advert_v1_signature_s_not_reduced",
    { alg: EDDSA, key: publicKey },
    (input) => {
      const signature = honest(input);
      const s = readLittleEndian(signature.subarray(SIGNATURE_HALF_BYTES));

      return Buffer.concat([
        signature.subarray(0, SIGNATURE_HALF_BYTES),
        writeLittleEndian(s + GROUP_ORDER, SIGNATURE_HALF_BYTES),
      ]);
    },
    false,
  ),
  // R is the identity element, a point of small order: with S = k a the equation holds, and a verifier that does not refuse a small-order R accepts it.
  advertFor(
    "peer_advert_v1_signature_r_small_order",
    { alg: EDDSA, key: publicKey },
    (input) =>
      signWith(
        {
          secret,
          publicKeyEncoding: publicKey,
          rEncoding: encodePoint(IDENTITY_POINT),
          nonceScalar: NO_NONCE,
        },
        input,
      ),
    false,
  ),
  // R is the identity element written with y = p + 1: the same point, not its canonical encoding, so a verifier that decodes R and compares points accepts it.
  advertFor(
    "peer_advert_v1_signature_r_non_canonical",
    { alg: EDDSA, key: publicKey },
    (input) =>
      signWith(
        {
          secret,
          publicKeyEncoding: publicKey,
          rEncoding: NON_CANONICAL_IDENTITY,
          nonceScalar: NO_NONCE,
        },
        input,
      ),
    false,
  ),
  // R has a torsion component: S = r + k a satisfies the cofactored equation (multiply everything by 8) and not the cofactorless one, so only a verifier that checks the equation exactly refuses it.
  advertFor(
    "peer_advert_v1_signature_r_mixed_order",
    { alg: EDDSA, key: publicKey },
    (input) =>
      signWith(
        {
          secret,
          publicKeyEncoding: publicKey,
          rEncoding: mixedNonceEncoding,
          nonceScalar,
        },
        input,
      ),
    false,
  ),
  // The key has a torsion component. The signature satisfies the cofactorless equation too (its challenge is a multiple of 8), so only the key is wrong.
  advertFor(
    "peer_advert_v1_identity_key_mixed_order",
    { alg: EDDSA, key: mixedKey },
    (input) => signUnderTorsionKey(secret, mixedKey, nonceScalar, input),
    false,
  ),
  // The identity element as the key, with R the identity element and S zero, which verifies under it for any message: refused for the key.
  advertFor(
    "peer_advert_v1_identity_key_small_order",
    { alg: EDDSA, key: encodePoint(IDENTITY_POINT) },
    () => Buffer.alloc(2 * SIGNATURE_HALF_BYTES, 0).fill(1, 0, 1),
    false,
  ),
  // The same point written with y = p + 1.
  advertFor(
    "peer_advert_v1_identity_key_non_canonical",
    { alg: EDDSA, key: NON_CANONICAL_IDENTITY },
    () => Buffer.alloc(2 * SIGNATURE_HALF_BYTES, 0).fill(1, 0, 1),
    false,
  ),
  // ES256: the uncompressed key verifies; the same key as a compressed point or a compact point is a different byte string and so a different device-id, and is refused although the signature is the key owner's.
  advertFor(
    "peer_advert_v1_es256_valid",
    { alg: ES256, key: es256Public },
    (input) => p256Sign(ES256_SECRET, input),
    true,
  ),
  advertFor(
    "peer_advert_v1_es256_identity_key_compressed",
    {
      alg: ES256,
      key: Buffer.concat([
        Buffer.from([COMPRESSED_EVEN_TAG + es256YIsOdd]),
        es256X,
      ]),
    },
    (input) => p256Sign(ES256_SECRET, input),
    false,
  ),
  advertFor(
    "peer_advert_v1_es256_identity_key_compact",
    { alg: ES256, key: Buffer.concat([Buffer.from([COMPACT_TAG]), es256X]) },
    (input) => p256Sign(ES256_SECRET, input),
    false,
  ),
];
