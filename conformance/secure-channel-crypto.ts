/* The cryptography behind secure-channel.v1.json: identities, hellos, the handshake's key schedule and AES-GCM sealing, as spec/secure-channel.cddl defines them. secure-channel-vectors.ts builds the vector file from it; the two are split only to keep each under this repo's max-lines cap.

   Every value is computed here with node:crypto alone, written from the spec text and deliberately not imported from either implementation: the generator, the TypeScript core and the Rust crate are three independent implementations checked against one file, and a vector produced by the thing it checks would prove nothing.

   All key material is made up for these vectors and is test material only: Ed25519 identities from fixed repeated-byte seeds, an ES256 identity from a fixed scalar, ephemeral P-256 keys from fixed scalars and nonces from fixed fills. AES-GCM and Ed25519 are deterministic, so everything regenerates byte for byte. ECDSA is not: an ES256 hello's signature is emitted once and kept on regeneration for as long as the signing input is unchanged, in which case the generator only checks that it still verifies. Such a hello is verify-only. */

import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign as nodeSign,
  verify as nodeVerify,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { cdeEncodeOptions, encode } from "cbor2";
import { hex, toWire, type JsonWire } from "@exadev/wire-mesh-conformance";

const NONCE_BYTE_LENGTH = 16;
export const SCALAR_BYTE_LENGTH = 32;
const AES_KEY_BYTE_LENGTH = 32;
const GCM_IV_BYTE_LENGTH = 12;
const GCM_TAG_BYTE_LENGTH = 16;
/** The counter fills the last eight bytes of the IV, as a big-endian uint64. */
const COUNTER_BYTE_LENGTH = 8;
const IV_COUNTER_OFFSET = GCM_IV_BYTE_LENGTH - COUNTER_BYTE_LENGTH;
const ED25519_SEED_BYTE_LENGTH = 32;
// COSE algorithm identifiers (RFC 9053)
export const EDDSA = -8;
export const ES256 = -7;
const LOW_BYTE_MASK = 0xff;
const FILE_NAME = "secure-channel.v1.json";

const encoder = new TextEncoder();
const HELLO_CONTEXT = Buffer.from(
  encoder.encode("wire-mesh/secure-hello/v1\0"),
);
const CHANNEL_CONTEXT = Buffer.from(
  encoder.encode("wire-mesh/secure-channel/v1\0"),
);
const DATA_CONTEXT = Buffer.from(encoder.encode("wire-mesh/secure-data/v1\0"));
const LABEL_LOW_TO_HIGH = Buffer.from(encoder.encode("lo-to-hi"));
const LABEL_HIGH_TO_LOW = Buffer.from(encoder.encode("hi-to-lo"));

/** RFC 8410 section 7's PKCS#8 prefix for an Ed25519 private key, ahead of the 32 raw seed bytes. */
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);

export function wireHex(message: JsonWire): string {
  return Buffer.from(encode(toWire(message), cdeEncodeOptions)).toString("hex");
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** A channel counter: a bigint where it may exceed what a JavaScript number holds exactly. */
export type Counter = bigint | number;

function counterBytes(counter: Counter): Buffer {
  const bytes = Buffer.alloc(COUNTER_BYTE_LENGTH);
  bytes.writeBigUInt64BE(BigInt(counter));

  return bytes;
}

function flipByteAt(bytes: Buffer, index: number): Buffer {
  const copy = Buffer.from(bytes);
  const byte = copy.at(index);
  if (byte === undefined) {
    throw new Error("cannot corrupt a byte past the end");
  }
  copy[index < 0 ? copy.length + index : index] = byte ^ LOW_BYTE_MASK;

  return copy;
}

export function flipLastByte(bytes: Buffer): Buffer {
  return flipByteAt(bytes, -1);
}

export function flipFirstByte(bytes: Buffer): Buffer {
  return flipByteAt(bytes, 0);
}

// Identities

export interface Identity {
  name: string;
  alg: number;
  /** The Ed25519 seed or the ES256 private scalar: made-up test material. */
  secretHex: string;
  publicKey: Buffer;
  deviceId: Buffer;
  privateKey: KeyObject;
}

function ed25519Identity(name: string, seedFillHex: string): Identity {
  const secretHex = seedFillHex.repeat(ED25519_SEED_BYTE_LENGTH);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(secretHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new Error("Ed25519 public JWK is missing its raw x coordinate");
  }
  const publicKey = Buffer.from(jwk.x, "base64url");

  return {
    name,
    alg: EDDSA,
    secretHex,
    publicKey,
    deviceId: sha256(publicKey),
    privateKey,
  };
}

function es256Identity(name: string, scalarFillHex: string): Identity {
  const secretHex = scalarFillHex.repeat(SCALAR_BYTE_LENGTH);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(secretHex, "hex"));
  const publicKey = ecdh.getPublicKey();
  const privateKey = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(secretHex, "hex").toString("base64url"),
      x: publicKey.subarray(1, 1 + SCALAR_BYTE_LENGTH).toString("base64url"),
      y: publicKey.subarray(1 + SCALAR_BYTE_LENGTH).toString("base64url"),
    },
    format: "jwk",
  });

  return {
    name,
    alg: ES256,
    secretHex,
    publicKey,
    deviceId: sha256(publicKey),
    privateKey,
  };
}

const HEX_RADIX = 16;
const HALF_DIVISOR = 2n;
const DER_SEQUENCE_TAG = 0x30;
const DER_INTEGER_TAG = 0x02;
const DER_SIGN_BIT = 0x80;

/** The order of the P-256 group: an ECDSA signature (r, s) and (r, n - s) verify for the same input. */
const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);
const P256_SCALAR_HEX_LENGTH = SCALAR_BYTE_LENGTH * 2;

/** The form of an ECDSA signature whose s is above half the group order: the signature itself when it already is, and otherwise its twin with s replaced by n - s. Both verify for the same input, so a verifier that requires the low-s form refuses this one. */
export function highSForm(rawSignature: Buffer): Buffer {
  const r = rawSignature.subarray(0, SCALAR_BYTE_LENGTH);
  const s = BigInt(
    "0x" + rawSignature.subarray(SCALAR_BYTE_LENGTH).toString("hex"),
  );
  if (s > P256_ORDER / HALF_DIVISOR) {
    return rawSignature;
  }

  return Buffer.concat([
    r,
    Buffer.from(
      (P256_ORDER - s)
        .toString(HEX_RADIX)
        .padStart(P256_SCALAR_HEX_LENGTH, "0"),
      "hex",
    ),
  ]);
}

/** A raw r||s ECDSA signature re-encoded as the ASN.1 DER SEQUENCE of two INTEGERs, the form the spec does not use. */
export function derSignature(rawSignature: Buffer): Buffer {
  const integer = (bytes: Buffer): Buffer => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    let body = bytes.subarray(start);
    if ((body[0] ?? 0) >= DER_SIGN_BIT)
      body = Buffer.concat([Buffer.from([0]), body]);

    return Buffer.concat([Buffer.from([DER_INTEGER_TAG, body.length]), body]);
  };
  const content = Buffer.concat([
    integer(rawSignature.subarray(0, SCALAR_BYTE_LENGTH)),
    integer(rawSignature.subarray(SCALAR_BYTE_LENGTH)),
  ]);

  return Buffer.concat([
    Buffer.from([DER_SEQUENCE_TAG, content.length]),
    content,
  ]);
}

/** Ed25519 signs deterministically (RFC 8032); ES256 yields raw r||s (IEEE P1363) with a fresh nonce on every call. */
function signWith(identity: Identity, input: Buffer): Buffer {
  return identity.alg === EDDSA
    ? nodeSign(null, input, identity.privateKey)
    : nodeSign("sha256", input, {
        key: identity.privateKey,
        dsaEncoding: "ieee-p1363",
      });
}

function verifyWith(
  identity: Identity,
  input: Buffer,
  signature: Buffer,
): boolean {
  return identity.alg === EDDSA
    ? nodeVerify(null, input, identity.privateKey, signature)
    : nodeVerify(
        "sha256",
        input,
        { key: identity.privateKey, dsaEncoding: "ieee-p1363" },
        signature,
      );
}

export const identities: Readonly<Record<string, Identity>> = {
  a: ed25519Identity("a", "a1"),
  b: ed25519Identity("b", "b2"),
  // Only ever an outsider: addressed in the wrong-recipient case and signing the re-signed hello.
  c: ed25519Identity("c", "c3"),
  // agent-comms uses ES256, so a hello signed that way must verify across implementations.
  e: es256Identity("e", "e5"),
};

export function identityNamed(name: string): Identity {
  const found = identities[name];
  if (found === undefined) {
    throw new Error(`no identity named ${name}`);
  }

  return found;
}

// ES256 signature reuse

/** The signing input and signature of each hello in the committed file, by hello name. */
type CommittedSignatures = ReadonlyMap<
  string,
  { signingInputHex: string; signatureHex: string }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The elements of `value` when it is an array, and none otherwise: JSON read back from disk is unknown until checked. */
function elementsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? Array.from<unknown>(value) : [];
}

function readCommittedSignatures(): CommittedSignatures {
  const found = new Map<
    string,
    { signingInputHex: string; signatureHex: string }
  >();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(new URL(FILE_NAME, import.meta.url), "utf8"),
    );
  } catch {
    // No committed file yet: every signature is produced fresh.
    return found;
  }
  const section = isRecord(parsed) ? parsed.secure_channel : undefined;
  if (!isRecord(section)) {
    return found;
  }
  // Each handshake side and each hello verdict that carries its own signature records the signing input it covers.
  const sideRecords = elementsOf(section.handshakes).flatMap((handshake) =>
    isRecord(handshake) ? elementsOf(handshake.sides) : [],
  );
  const verdictRecords = elementsOf(section.hello_verdicts);
  for (const record of [...sideRecords, ...verdictRecords]) {
    if (
      isRecord(record) &&
      typeof record.hello_vector === "string" &&
      typeof record.signing_input_hex === "string" &&
      typeof record.signature_hex === "string"
    ) {
      found.set(record.hello_vector, {
        signingInputHex: record.signing_input_hex,
        signatureHex: record.signature_hex,
      });
    }
  }

  return found;
}

const committedSignatures = readCommittedSignatures();

/** The signature for `input`: Ed25519 is recomputed; an ES256 one is the committed signature when it still covers this input and verifies, and a fresh one otherwise. */
function helloSignature(
  helloName: string,
  signer: Identity,
  input: Buffer,
): Buffer {
  if (signer.alg === EDDSA) {
    return signWith(signer, input);
  }
  const committed = committedSignatures.get(helloName);
  if (committed?.signingInputHex === input.toString("hex")) {
    const signature = Buffer.from(committed.signatureHex, "hex");
    if (verifyWith(signer, input, signature)) {
      return signature;
    }
  }

  return signWith(signer, input);
}

// Hellos

export interface EphemeralInputs {
  secretHex: string;
  nonceFillHex: string;
}

export interface Hello {
  name: string;
  from: Identity;
  to: Buffer;
  ephemeralPublic: Buffer;
  nonce: Buffer;
  signingInput: Buffer;
  signature: Buffer;
}

function ephemeralPublicKey(secretHex: string): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(secretHex, "hex"));

  return ecdh.getPublicKey();
}

/** What a hello's signature covers: spec/secure-channel.cddl. */
function helloSigningInput(
  ephemeralKey: Buffer,
  nonce: Buffer,
  sender: Buffer,
  recipient: Buffer,
): Buffer {
  return Buffer.concat([HELLO_CONTEXT, ephemeralKey, nonce, sender, recipient]);
}

export function makeHello({
  name,
  from,
  to,
  ephemeralPublic,
  nonce,
  signer = from,
}: Readonly<{
  name: string;
  from: Identity;
  to: Buffer;
  ephemeralPublic: Buffer;
  nonce: Buffer;
  /** Who signs: the sender unless a case needs a signature by someone else. */
  signer?: Identity;
}>): Hello {
  const signingInput = helloSigningInput(
    ephemeralPublic,
    nonce,
    from.deviceId,
    to,
  );

  return {
    name,
    from,
    to,
    ephemeralPublic,
    nonce,
    signingInput,
    signature: helloSignature(name, signer, signingInput),
  };
}

export function helloMessage(
  hello: Hello,
  overrides: Readonly<{
    ephemeralPublic?: Buffer;
    signature?: Buffer;
    identityKey?: JsonWire;
  }> = {},
): JsonWire {
  return {
    type: "secure-hello",
    "ephemeral-key": hex(
      (overrides.ephemeralPublic ?? hello.ephemeralPublic).toString("hex"),
    ),
    nonce: hex(hello.nonce.toString("hex")),
    "identity-key": overrides.identityKey ?? {
      alg: hello.from.alg,
      "public-key": hex(hello.from.publicKey.toString("hex")),
    },
    "to-device": hex(hello.to.toString("hex")),
    signature: hex((overrides.signature ?? hello.signature).toString("hex")),
  };
}

// Handshakes and the key schedule

export interface Side {
  identity: Identity;
  peer: Identity;
  ephemeralSecretHex: string;
  hello: Hello;
}

export interface Handshake {
  name: string;
  sides: [Side, Side];
  low: Identity;
  high: Identity;
  sharedSecret: Buffer;
  salt: Buffer;
  infoLowToHigh: Buffer;
  infoHighToLow: Buffer;
  keyLowToHigh: Buffer;
  keyHighToLow: Buffer;
}

function buildSide(
  handshake: string,
  identity: Identity,
  peer: Identity,
  inputs: Readonly<EphemeralInputs>,
): Side {
  const helloName = `hello_${handshake}_${identity.name}_to_${peer.name}`;

  return {
    identity,
    peer,
    ephemeralSecretHex: inputs.secretHex,
    hello: makeHello({
      name: helloName,
      from: identity,
      to: peer.deviceId,
      ephemeralPublic: ephemeralPublicKey(inputs.secretHex),
      nonce: Buffer.from(inputs.nonceFillHex.repeat(NONCE_BYTE_LENGTH), "hex"),
    }),
  };
}

function hkdf(secret: Buffer, salt: Buffer, info: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", secret, salt, info, AES_KEY_BYTE_LENGTH),
  );
}

function ecdhSecret(own: Side, remote: Side): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(own.ephemeralSecretHex, "hex"));

  return ecdh.computeSecret(remote.hello.ephemeralPublic);
}

export function buildHandshake(
  name: string,
  first: Readonly<{ identity: Identity; ephemeral: EphemeralInputs }>,
  second: Readonly<{ identity: Identity; ephemeral: EphemeralInputs }>,
): Handshake {
  const sideFirst = buildSide(
    name,
    first.identity,
    second.identity,
    first.ephemeral,
  );
  const sideSecond = buildSide(
    name,
    second.identity,
    first.identity,
    second.ephemeral,
  );
  const sharedSecret = ecdhSecret(sideFirst, sideSecond);
  if (!sharedSecret.equals(ecdhSecret(sideSecond, sideFirst))) {
    throw new Error("the two ECDH results disagree");
  }

  const firstIsLow =
    Buffer.compare(first.identity.deviceId, second.identity.deviceId) < 0;
  const [low, high] = firstIsLow
    ? [sideFirst, sideSecond]
    : [sideSecond, sideFirst];
  const salt = Buffer.concat([low.hello.nonce, high.hello.nonce]);
  const infoFor = (label: Buffer): Buffer =>
    Buffer.concat([
      CHANNEL_CONTEXT,
      low.identity.deviceId,
      high.identity.deviceId,
      label,
    ]);
  const infoLowToHigh = infoFor(LABEL_LOW_TO_HIGH);
  const infoHighToLow = infoFor(LABEL_HIGH_TO_LOW);

  return {
    name,
    sides: [sideFirst, sideSecond],
    low: low.identity,
    high: high.identity,
    sharedSecret,
    salt,
    infoLowToHigh,
    infoHighToLow,
    keyLowToHigh: hkdf(sharedSecret, salt, infoLowToHigh),
    keyHighToLow: hkdf(sharedSecret, salt, infoHighToLow),
  };
}

export function otherEnd(handshake: Handshake, identity: Identity): Identity {
  const [first, second] = handshake.sides;

  return first.identity === identity ? second.identity : first.identity;
}

/** The key the sender seals with: low-to-high when it is the lower device-id. */
export function sendKey(handshake: Handshake, sender: Identity): Buffer {
  return sender === handshake.low
    ? handshake.keyLowToHigh
    : handshake.keyHighToLow;
}

export function ivFor(counter: Counter): Buffer {
  const iv = Buffer.alloc(GCM_IV_BYTE_LENGTH);
  counterBytes(counter).copy(iv, IV_COUNTER_OFFSET);

  return iv;
}

export function associatedData(
  sender: Buffer,
  recipient: Buffer,
  counter: Counter,
): Buffer {
  return Buffer.concat([
    DATA_CONTEXT,
    sender,
    recipient,
    counterBytes(counter),
  ]);
}

/** AES-256-GCM output: ciphertext followed by the 16-byte tag. */
export function gcmSeal(
  key: Buffer,
  counter: Counter,
  aad: Buffer,
  plaintext: Buffer,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, ivFor(counter), {
    authTagLength: GCM_TAG_BYTE_LENGTH,
  });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([body, cipher.getAuthTag()]);
}

export function innerWire(frame: JsonWire): Buffer {
  return Buffer.from(wireHex(frame), "hex");
}

export function sealedFrame(counter: number, ciphertext: Buffer): JsonWire {
  return {
    type: "secure-data",
    counter,
    ciphertext: hex(ciphertext.toString("hex")),
  };
}

/** The canonical wire bytes, as hex, of a secure-data frame whose counter may be any unsigned 64-bit value. */
export function secureDataWireHex(
  counter: Counter,
  ciphertext: Buffer,
): string {
  return Buffer.from(
    encode(
      {
        type: "secure-data",
        counter: Number.isSafeInteger(counter) ? counter : BigInt(counter),
        ciphertext: Uint8Array.from(ciphertext),
      },
      cdeEncodeOptions,
    ),
  ).toString("hex");
}

/** Seals `frame` as `sender` would, to the other end of the handshake, under the given counter. */
export function sealFrom(
  handshake: Handshake,
  sender: Identity,
  counter: Counter,
  frame: JsonWire,
): Buffer {
  const recipient = otherEnd(handshake, sender);

  return gcmSeal(
    sendKey(handshake, sender),
    counter,
    associatedData(sender.deviceId, recipient.deviceId, counter),
    innerWire(frame),
  );
}
