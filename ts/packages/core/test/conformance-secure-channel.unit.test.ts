/* Checks every vector in conformance/secure-channel.v1.json against the real secure channel, field by field. The schemas below are strict, so a key the test does not know fails it. In summary:

   - every recorded intermediate (each identity's public key and device-id from its seed or scalar, hello signing inputs, Ed25519 signatures, shared secrets, salts, HKDF infos, both direction keys, IVs and associated data) is derived again here from the vector's own scalars, seeds and fields and compared;
   - each hello is verified and the reason verifyHello reports is compared with the one the vector expects (or one it lists as also acceptable);
   - each handshake is established from its fixed ephemeral keys, every sealed transcript frame is reproduced byte for byte and opened;
   - each establish verdict, and each open sequence step with its refusal reason, is checked against the real implementation.

   Not compared, because they only name or label: every `name`, `inner_frame`, `sealed_vector` and `hello_vector` (used to look entries up), `synthetic` and the layout version (checked to be the one this test reads). An ES256 signature is only verified, never reproduced, as the vector file says. A step marked `full_width_only` needs a counter wider than this implementation holds exactly: its counter is compared with the one in its wire bytes, and when it is above the bound its frame is checked to be refused at decoding (never truncated); its expected class is not compared, and the steps after it are skipped. */

import {
  createECDH,
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";
import { tryDecodeFrame } from "../src/adapters/frame-codec.js";
import { isDataFrame } from "../src/domain/hub-mailbox.js";
import {
  establishChannel,
  MAX_COUNTER,
  verifyHello,
  type PendingHandshake,
  type SecureChannel,
} from "../src/domain/secure-channel.js";
import {
  frameSchema,
  type Frame,
  type SecureDataFrame,
  type SecureHelloFrame,
} from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { bytesFromHex } from "./hex.js";
import { inSequence } from "./sequence.js";

const COORDINATE_BYTE_LENGTH = 32;
const GCM_IV_BYTE_LENGTH = 12;
const IV_COUNTER_OFFSET = 4;
const COUNTER_BYTE_LENGTH = 8;
const KEY_BIT_LENGTH = 256;
const EDDSA = -8;
const LAYOUT_VERSION = 1;
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const counterString = z.string().regex(/^[0-9]+$/);

const vectorSchema = z.object({ name: z.string(), wire_hex: hexString });

const sideSchema = z.strictObject({
  identity: z.string(),
  peer: z.string(),
  ephemeral_secret_hex: hexString,
  ephemeral_public_hex: hexString,
  nonce_hex: hexString,
  signing_input_hex: hexString,
  signature_hex: hexString,
  signature_verify_only: z.boolean(),
  hello_vector: z.string(),
});

const transcriptStepSchema = z.strictObject({
  from: z.string(),
  counter: counterString,
  inner_frame: z.string(),
  inner_wire_hex: hexString,
  iv_hex: hexString,
  aad_hex: hexString,
  ciphertext_hex: hexString,
  sealed_vector: z.string(),
});

const keyScheduleSchema = z.strictObject({
  low: z.string(),
  high: z.string(),
  shared_secret_hex: hexString,
  salt_hex: hexString,
  info_low_to_high_hex: hexString,
  info_high_to_low_hex: hexString,
  key_low_to_high_hex: hexString,
  key_high_to_low_hex: hexString,
});

const handshakeSchema = z.strictObject({
  name: z.string(),
  sides: z.tuple([sideSchema, sideSchema]),
  key_schedule: keyScheduleSchema,
  transcript: z.array(transcriptStepSchema),
});

const identitySchema = z.strictObject({
  alg: z.number().int(),
  synthetic: z.literal(true),
  secret_hex: hexString,
  public_key_hex: hexString,
  device_id_hex: hexString,
});

const helloReason = z.enum([
  "ok",
  "wrong_recipient",
  "unsupported_identity_alg",
  "invalid_identity_key",
  "bad_signature",
]);

const helloVerdictSchema = z.strictObject({
  name: z.string(),
  handshake: z.string(),
  receiver: z.string(),
  hello_vector: z.string(),
  expected: helloReason,
  also_acceptable: z.array(helloReason),
  peer_device_id_hex: hexString.nullable(),
  signing_input_hex: hexString.nullable(),
  signature_hex: hexString.nullable(),
});

const establishVerdictSchema = z.strictObject({
  name: z.string(),
  handshake: z.string(),
  side: z.string(),
  hello_vector: z.string(),
  hello_verdict: z.literal("ok"),
  expected: z.enum(["unusable_ephemeral_key", "refused"]),
  refused_at: z.enum(["establishment", "decoding_or_establishment"]),
  stage_advisory: z.boolean(),
});

const stepSchema = z.strictObject({
  counter: counterString,
  secure_data_wire_hex: hexString,
  expected: z.discriminatedUnion("result", [
    z.strictObject({
      result: z.literal("opened"),
      frame_wire_hex: hexString,
    }),
    z.strictObject({ result: z.literal("replayed") }),
    z.strictObject({ result: z.literal("unauthentic") }),
    z.strictObject({ result: z.literal("undecodable") }),
  ]),
  full_width_only: z.boolean(),
});

const sequenceSchema = z.strictObject({
  name: z.string(),
  handshake: z.string(),
  sender: z.string(),
  receiver: z.string(),
  steps: z.array(stepSchema),
  receiver_drops_after_open: z.boolean(),
});

const fileSchema = z.object({
  vectors: z.array(vectorSchema),
  secure_channel: z.strictObject({
    layout_version: z.literal(LAYOUT_VERSION),
    identities: z.record(z.string(), identitySchema),
    handshakes: z.array(handshakeSchema),
    hello_verdicts: z.array(helloVerdictSchema),
    establish_verdicts: z.array(establishVerdictSchema),
    open_sequences: z.array(sequenceSchema),
  }),
});

const file = fileSchema.parse(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../../conformance/secure-channel.v1.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ),
);
const channelVectors = file.secure_channel;

function frameFromHex(wireHex: string): Frame {
  return frameSchema.parse(decode(bytesFromHex(wireHex), cdeDecodeOptions));
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function lookup<T>(items: readonly T[], find: (item: T) => boolean): T {
  const found = items.find(find);
  if (found === undefined) {
    throw new Error("vector file lacks an entry another entry names");
  }

  return found;
}

function helloVector(name: string): SecureHelloFrame {
  const vector = lookup(file.vectors, (v) => v.name === name);
  const frame = frameFromHex(vector.wire_hex);
  if (frame.type !== "secure-hello") {
    throw new Error(`${name} is not a secure-hello`);
  }

  return frame;
}

function secureData(wireHex: string): SecureDataFrame {
  const frame = frameFromHex(wireHex);
  if (frame.type !== "secure-data") {
    throw new Error("expected a secure-data frame");
  }

  return frame;
}

/** The verifying half of an identity, which is all a channel end needs besides its device-id: the generator holds the only signing keys, and every hello here was signed by it. */
function identityPort(name: string): IdentityPort {
  const identity = channelVectors.identities[name];
  if (identity === undefined) {
    throw new Error(`vector file has no identity ${name}`);
  }

  return {
    deviceId: bytesFromHex(identity.device_id_hex),
    identityKey: {
      alg: identity.alg,
      "public-key": bytesFromHex(identity.public_key_hex),
    },
    sign: async () =>
      Promise.reject(new Error("vector identities only verify")),
    verify: verifyWithPublicKey,
    deriveDeviceId,
  };
}

/** The ephemeral private key a side announced, rebuilt from its fixed scalar. */
async function pendingFor(
  side: z.infer<typeof sideSchema>,
): Promise<PendingHandshake> {
  const publicKey = bytesFromHex(side.ephemeral_public_hex);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: Buffer.from(side.ephemeral_secret_hex, "hex").toString("base64url"),
      x: Buffer.from(
        publicKey.subarray(1, 1 + COORDINATE_BYTE_LENGTH),
      ).toString("base64url"),
      y: Buffer.from(publicKey.subarray(1 + COORDINATE_BYTE_LENGTH)).toString(
        "base64url",
      ),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const hello = helloVector(side.hello_vector);
  expect(hexOf(hello["ephemeral-key"])).toBe(side.ephemeral_public_hex);
  expect(hexOf(hello.nonce)).toBe(side.nonce_hex);
  expect(hexOf(hello.signature)).toBe(side.signature_hex);

  return { peer: identityPort(side.peer).deviceId, hello, privateKey };
}

/** One end of a handshake, established from the other end's hello as vectors fix it. */
async function channelAt(
  handshake: z.infer<typeof handshakeSchema>,
  identityName: string,
): Promise<SecureChannel> {
  const own = lookup(handshake.sides, (s) => s.identity === identityName);
  const remote = lookup(handshake.sides, (s) => s.identity !== identityName);
  const identity = identityPort(identityName);
  const verdict = await verifyHello(identity, helloVector(remote.hello_vector));
  if (!verdict.ok) {
    throw new Error(`${handshake.name}: hello refused: ${verdict.reason}`);
  }
  const channel = await establishChannel(
    identity,
    await pendingFor(own),
    helloVector(remote.hello_vector),
    verdict.peer,
  );
  if (channel === undefined) {
    throw new Error(`${handshake.name}: no channel at ${identityName}`);
  }

  return channel;
}

function handshakeNamed(name: string): z.infer<typeof handshakeSchema> {
  return lookup(channelVectors.handshakes, (h) => h.name === name);
}

const encoder = new TextEncoder();
const HELLO_CONTEXT = encoder.encode("wire-mesh/secure-hello/v1\0");
const DATA_CONTEXT = encoder.encode("wire-mesh/secure-data/v1\0");

function concat(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

function counterBytes(counter: bigint): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(COUNTER_BYTE_LENGTH);
  new DataView(bytes.buffer).setBigUint64(0, counter, false);

  return bytes;
}

function identityDeviceId(name: string): Uint8Array<ArrayBuffer> {
  return identityPort(name).deviceId;
}

async function hkdfKeyHex(
  secret: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );

  return hexOf(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: Uint8Array.from(salt),
          info: Uint8Array.from(info),
        },
        material,
        KEY_BIT_LENGTH,
      ),
    ),
  );
}

async function sharedSecretHex(
  own: z.infer<typeof sideSchema>,
  remote: z.infer<typeof sideSchema>,
): Promise<string> {
  const { privateKey } = await pendingFor(own);
  const remotePublic = await crypto.subtle.importKey(
    "raw",
    bytesFromHex(remote.ephemeral_public_hex),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  return hexOf(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: remotePublic },
        privateKey,
        KEY_BIT_LENGTH,
      ),
    ),
  );
}

/** The public key a vector identity's seed (Ed25519) or scalar (ES256) derives, with test-only node:crypto calls. */
function publicKeyFromSecretHex(
  identity: z.infer<typeof identitySchema>,
): string {
  if (identity.alg === EDDSA) {
    const jwk = createPublicKey(
      createPrivateKey({
        key: Buffer.from(PKCS8_ED25519_PREFIX + identity.secret_hex, "hex"),
        format: "der",
        type: "pkcs8",
      }),
    ).export({ format: "jwk" });

    return Buffer.from(jwk.x ?? "", "base64url").toString("hex");
  }
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(identity.secret_hex, "hex"));

  return ecdh.getPublicKey().toString("hex");
}

describe("secure-channel recorded intermediates are derived again", () => {
  it("gives each identity the public key its seed or scalar derives and the device-id that key hashes to", async () => {
    await Promise.all(
      Object.entries(channelVectors.identities).map(async ([name, identity]) => {
        expect(publicKeyFromSecretHex(identity), `${name} public key`).toBe(
          identity.public_key_hex,
        );
        expect(
          hexOf(await deriveDeviceId(bytesFromHex(identity.public_key_hex))),
          name,
        ).toBe(identity.device_id_hex);
      }),
    );
  });

  it("reproduces every Ed25519 hello signature and marks exactly the ES256 ones verify-only", () => {
    for (const handshake of channelVectors.handshakes) {
      for (const side of handshake.sides) {
        const identity = channelVectors.identities[side.identity];
        if (identity === undefined) throw new Error("unknown identity");
        expect(side.signature_verify_only, side.hello_vector).toBe(
          identity.alg !== EDDSA,
        );
        if (identity.alg === EDDSA) {
          const key = createPrivateKey({
            key: Buffer.from(
              PKCS8_ED25519_PREFIX + identity.secret_hex,
              "hex",
            ),
            format: "der",
            type: "pkcs8",
          });
          expect(
            nodeSign(null, bytesFromHex(side.signing_input_hex), key).toString(
              "hex",
            ),
            `${side.hello_vector} signature`,
          ).toBe(side.signature_hex);
        }
      }
    }
  });

  for (const handshake of channelVectors.handshakes) {
    it(`${handshake.name}: signing inputs, shared secret, salt, infos and keys`, async () => {
      const [first, second] = handshake.sides;
      const schedule = handshake.key_schedule;

      for (const side of handshake.sides) {
        expect(
          side.signing_input_hex,
          `${side.hello_vector} signing input`,
        ).toBe(
          hexOf(
            concat(
              HELLO_CONTEXT,
              bytesFromHex(side.ephemeral_public_hex),
              bytesFromHex(side.nonce_hex),
              identityDeviceId(side.identity),
              identityDeviceId(side.peer),
            ),
          ),
        );
      }

      const secret = await sharedSecretHex(first, second);
      expect(secret).toBe(schedule.shared_secret_hex);
      expect(await sharedSecretHex(second, first)).toBe(secret);

      const lowSide = lookup(
        handshake.sides,
        (s) => s.identity === schedule.low,
      );
      const highSide = lookup(
        handshake.sides,
        (s) => s.identity === schedule.high,
      );
      const lowId = identityDeviceId(schedule.low);
      const highId = identityDeviceId(schedule.high);
      expect(
        Buffer.compare(lowId, highId),
        "low sorts before high",
      ).toBeLessThan(0);
      const salt = concat(
        bytesFromHex(lowSide.nonce_hex),
        bytesFromHex(highSide.nonce_hex),
      );
      expect(schedule.salt_hex).toBe(hexOf(salt));

      const channelContext = encoder.encode("wire-mesh/secure-channel/v1\0");
      const infoLowToHigh = concat(
        channelContext,
        lowId,
        highId,
        encoder.encode("lo-to-hi"),
      );
      const infoHighToLow = concat(
        channelContext,
        lowId,
        highId,
        encoder.encode("hi-to-lo"),
      );
      expect(schedule.info_low_to_high_hex).toBe(hexOf(infoLowToHigh));
      expect(schedule.info_high_to_low_hex).toBe(hexOf(infoHighToLow));
      const secretBytes = bytesFromHex(secret);
      expect(await hkdfKeyHex(secretBytes, salt, infoLowToHigh)).toBe(
        schedule.key_low_to_high_hex,
      );
      expect(await hkdfKeyHex(secretBytes, salt, infoHighToLow)).toBe(
        schedule.key_high_to_low_hex,
      );

      for (const step of handshake.transcript) {
        const recipient = lookup(
          handshake.sides,
          (s) => s.identity !== step.from,
        ).identity;
        const counter = BigInt(step.counter);
        expect(step.iv_hex, `${step.sealed_vector} iv`).toBe(
          hexOf(
            concat(new Uint8Array(IV_COUNTER_OFFSET), counterBytes(counter)),
          ),
        );
        expect(step.iv_hex.length / 2).toBe(GCM_IV_BYTE_LENGTH);
        expect(step.aad_hex, `${step.sealed_vector} aad`).toBe(
          hexOf(
            concat(
              DATA_CONTEXT,
              identityDeviceId(step.from),
              identityDeviceId(recipient),
              counterBytes(counter),
            ),
          ),
        );
      }
    });
  }
});

describe("secure-channel hello verdicts", () => {
  for (const verdict of channelVectors.hello_verdicts) {
    it(verdict.name, async () => {
      const hello = helloVector(verdict.hello_vector);
      const result = await verifyHello(identityPort(verdict.receiver), hello);

      if (verdict.expected === "ok") {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(hexOf(result.peer.deviceId)).toBe(verdict.peer_device_id_hex);
        }
      } else {
        // The reason is the expected one or one the vector lists as also acceptable.
        const acceptable = [verdict.expected, ...verdict.also_acceptable];
        expect(
          result.ok ? "ok" : result.reason,
          `${verdict.name} reason`,
        ).toBeOneOf(acceptable);
      }
      if (verdict.signing_input_hex !== null) {
        const sender = await deriveDeviceId(
          hello["identity-key"]["public-key"],
        );
        expect(verdict.signing_input_hex).toBe(
          hexOf(
            concat(
              HELLO_CONTEXT,
              hello["ephemeral-key"],
              hello.nonce,
              sender,
              hello["to-device"],
            ),
          ),
        );
        expect(verdict.signature_hex).toBe(hexOf(hello.signature));
      }
    });
  }
});

describe("secure-channel handshakes reproduce every sealed transcript frame", () => {
  for (const handshake of channelVectors.handshakes) {
    it(handshake.name, async () => {
      const channels = new Map<string, SecureChannel>();
      await inSequence(handshake.sides, async (side) => {
        channels.set(side.identity, await channelAt(handshake, side.identity));
      });

      await inSequence(handshake.transcript, async (step) => {
        const sender = channels.get(step.from);
        const recipientName = lookup(
          handshake.sides,
          (s) => s.identity !== step.from,
        ).identity;
        const recipient = channels.get(recipientName);
        if (sender === undefined || recipient === undefined) {
          throw new Error("a channel end is missing");
        }
        const frame = frameFromHex(step.inner_wire_hex);

        const sealed = await sender.seal(frame);
        expect(String(sealed.counter), `${step.sealed_vector} counter`).toBe(
          step.counter,
        );
        expect(
          hexOf(sealed.ciphertext),
          `${step.sealed_vector} ciphertext`,
        ).toBe(step.ciphertext_hex);
        const vector = lookup(
          file.vectors,
          (v) => v.name === step.sealed_vector,
        );
        expect(hexOf(encode(sealed, cdeEncodeOptions))).toBe(vector.wire_hex);

        expect(
          await recipient.open(secureData(vector.wire_hex)),
          `${step.sealed_vector} did not open`,
        ).toEqual(frame);
      });
    });
  }
});

/** A secure-hello read from its wire bytes without the size rules of the frame schema, so a hello whose ephemeral key is malformed can still be given to verifyHello. */
function unsizedHello(wireHex: string): SecureHelloFrame {
  const decoded: unknown = decode(bytesFromHex(wireHex), cdeDecodeOptions);
  const parsed = z
    .object({
      type: z.literal("secure-hello"),
      "ephemeral-key": z.instanceof(Uint8Array),
      nonce: z.instanceof(Uint8Array),
      "identity-key": z.object({
        alg: z.number().int(),
        "public-key": z.instanceof(Uint8Array),
      }),
      "to-device": z.instanceof(Uint8Array),
      signature: z.instanceof(Uint8Array),
    })
    .parse(decoded);

  return parsed;
}

describe("secure-channel establishment refuses an unusable ephemeral key", () => {
  for (const verdict of channelVectors.establish_verdicts) {
    it(verdict.name, async () => {
      const handshake = handshakeNamed(verdict.handshake);
      const own = lookup(handshake.sides, (s) => s.identity === verdict.side);
      const wire = lookup(
        file.vectors,
        (v) => v.name === verdict.hello_vector,
      ).wire_hex;
      const hello = unsizedHello(wire);
      expect(verdict.expected).toBe(
        verdict.stage_advisory ? "refused" : "unusable_ephemeral_key",
      );
      expect(verdict.refused_at).toBe(
        verdict.stage_advisory ? "decoding_or_establishment" : "establishment",
      );
      const identity = identityPort(verdict.side);
      // The hello verifies as a hello wherever the frame is decoded, since its signature covers whatever key bytes it carries.
      const hellos = await verifyHello(identity, hello);
      expect(hellos.ok, `${verdict.name} hello verdict`).toBe(true);
      if (!hellos.ok) return;

      // This implementation's frame schema has a size rule for the key, so a key that is not 65 bytes is refused while decoding. The stage may be either (the vector says so when it is advisory), and a hello refused only at establishment must decode.
      const decodes = tryDecodeFrame(bytesFromHex(wire)) !== null;
      if (!verdict.stage_advisory) {
        expect(decodes, `${verdict.name} decodes`).toBe(true);
      }
      // A hello refused at decoding never reaches establishment here. (Web Crypto's key import would take some of these, a compressed point for one, which is why the frame's size rule matters and why the stage is advisory.)
      if (!decodes) return;


      expect(
        await establishChannel(
          identity,
          await pendingFor(own),
          hello,
          hellos.peer,
        ),
      ).toBeUndefined();
    });
  }
});

/** The counter in a secure-data frame's wire bytes, read as an unsigned integer of any width. */
function wireCounter(wireHex: string): bigint {
  const decoded: unknown = decode(bytesFromHex(wireHex), cdeDecodeOptions);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("counter" in decoded) ||
    (typeof decoded.counter !== "number" && typeof decoded.counter !== "bigint")
  ) {
    throw new Error("a secure-data frame without a counter");
  }

  return BigInt(decoded.counter);
}

describe("secure-channel open sequences", () => {
  for (const sequence of channelVectors.open_sequences) {
    it(sequence.name, async () => {
      const channel = await channelAt(
        handshakeNamed(sequence.handshake),
        sequence.receiver,
      );

      const receiverIsFirst =
        handshakeNamed(sequence.handshake).sides[0].identity ===
        sequence.receiver;
      expect(sequence.sender).toBe(
        handshakeNamed(sequence.handshake).sides[receiverIsFirst ? 1 : 0]
          .identity,
      );

      await inSequence(sequence.steps, async (step, index) => {
        const label = `${sequence.name} step ${String(index)}`;
        // The step's counter and the one in its wire bytes are generated from one value; they must agree.
        expect(String(wireCounter(step.secure_data_wire_hex)), label).toBe(
          step.counter,
        );
        if (step.full_width_only === true) {
          // Past what this implementation holds exactly, the frame is refused at decoding rather than truncated; below it, the step depends on state a refused step would have left, so it is skipped.
          if (BigInt(step.counter) > BigInt(MAX_COUNTER)) {
            expect(
              tryDecodeFrame(bytesFromHex(step.secure_data_wire_hex)),
              label,
            ).toBeNull();
          }

          return;
        }
        const outcome = await channel.openOutcome(
          secureData(step.secure_data_wire_hex),
        );
        if (step.expected.result === "opened") {
          expect(outcome, label).toEqual({
            ok: true,
            frame: frameFromHex(step.expected.frame_wire_hex),
          });
          if (sequence.receiver_drops_after_open && outcome.ok) {
            // Spec obligation 5: a kind other than a manage-request, manage-response or data frame opens at the channel and the session drops it (mesh-session-secure-relay.unit.test.ts checks the drop).
            expect(
              outcome.frame.type !== "manage-request" &&
                outcome.frame.type !== "manage-response" &&
                !isDataFrame(outcome.frame),
              `${label} is a kind the session must drop`,
            ).toBe(true);
          }
        } else {
          expect(outcome, label).toEqual({
            ok: false,
            reason: step.expected.result,
          });
        }
      });
    });
  }
});
