/* Checks every vector in conformance/secure-channel.v1.json against the real secure channel, field by field:

   - every recorded intermediate (identity device-ids, hello signing inputs, shared secrets, salts, HKDF infos, both direction keys, IVs and associated data) is derived again here from the vector's own scalars, seeds and fields with test-only Web Crypto calls and compared;
   - each hello is verified and its verdict compared with the reason verifyHello reports;
   - each handshake is established from its fixed ephemeral keys, every sealed transcript frame is reproduced byte for byte and opened;
   - each establish verdict, and each open sequence step with its refusal reason, is checked against the real implementation.

   The only vector fields not compared are the ones that name data the others already pin (such as names and the `synthetic` marker). A step marked `full_width_only` needs a counter wider than this implementation holds exactly: it is checked to be refused at decoding (never truncated) when its counter is above the bound, and skipped otherwise. */

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

const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);

const vectorSchema = z.object({ name: z.string(), wire_hex: hexString });

const sideSchema = z.object({
  identity: z.string(),
  peer: z.string(),
  ephemeral_secret_hex: hexString,
  ephemeral_public_hex: hexString,
  nonce_hex: hexString,
  signing_input_hex: hexString,
  signature_hex: hexString,
  hello_vector: z.string(),
});

const transcriptStepSchema = z.object({
  from: z.string(),
  counter: z.number().int().nonnegative(),
  inner_wire_hex: hexString,
  iv_hex: hexString,
  aad_hex: hexString,
  ciphertext_hex: hexString,
  sealed_vector: z.string(),
});

const keyScheduleSchema = z.object({
  low: z.string(),
  high: z.string(),
  shared_secret_hex: hexString,
  salt_hex: hexString,
  info_low_to_high_hex: hexString,
  info_high_to_low_hex: hexString,
  key_low_to_high_hex: hexString,
  key_high_to_low_hex: hexString,
});

const handshakeSchema = z.object({
  name: z.string(),
  sides: z.tuple([sideSchema, sideSchema]),
  key_schedule: keyScheduleSchema,
  transcript: z.array(transcriptStepSchema),
});

const identitySchema = z.object({
  alg: z.number().int(),
  synthetic: z.literal(true),
  public_key_hex: hexString,
  device_id_hex: hexString,
});

const helloVerdictSchema = z.object({
  name: z.string(),
  handshake: z.string(),
  receiver: z.string(),
  hello_vector: z.string(),
  expected: z.enum([
    "ok",
    "wrong_recipient",
    "unsupported_identity_alg",
    "invalid_identity_key",
    "bad_signature",
  ]),
  peer_device_id_hex: hexString.optional(),
  signing_input_hex: hexString.optional(),
  signature_hex: hexString.optional(),
});

const establishVerdictSchema = z.object({
  name: z.string(),
  handshake: z.string(),
  side: z.string(),
  hello_vector: z.string(),
  hello_verdict: z.literal("ok"),
  expected: z.enum(["unusable_ephemeral_key", "refused"]),
  refused_at: z.enum(["establishment", "decoding_or_establishment"]),
  stage_advisory: z.boolean(),
});

const stepSchema = z.object({
  counter: z.string().regex(/^[0-9]+$/),
  secure_data_wire_hex: hexString,
  expected: z.discriminatedUnion("result", [
    z.object({ result: z.literal("opened"), frame_wire_hex: hexString }),
    z.object({ result: z.literal("replayed") }),
    z.object({ result: z.literal("unauthentic") }),
    z.object({ result: z.literal("undecodable") }),
  ]),
  full_width_only: z.literal(true).optional(),
});

const sequenceSchema = z.object({
  name: z.string(),
  handshake: z.string(),
  sender: z.string(),
  receiver: z.string(),
  steps: z.array(stepSchema),
  receiver_drops_after_open: z.boolean(),
});

const fileSchema = z.object({
  vectors: z.array(vectorSchema),
  secure_channel: z.object({
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

describe("secure-channel recorded intermediates are derived again", () => {
  it("gives each identity the device-id its public key hashes to", async () => {
    await Promise.all(
      Object.entries(channelVectors.identities).map(
        async ([name, identity]) => {
          expect(
            hexOf(await deriveDeviceId(bytesFromHex(identity.public_key_hex))),
            name,
          ).toBe(identity.device_id_hex);
        },
      ),
    );
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
        expect(result).toEqual({ ok: false, reason: verdict.expected });
      }
      if (verdict.signing_input_hex !== undefined) {
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
        expect(sealed.counter, `${step.sealed_vector} counter`).toBe(
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

describe("secure-channel establishment refuses an unusable ephemeral key", () => {
  for (const verdict of channelVectors.establish_verdicts) {
    it(verdict.name, async () => {
      const handshake = handshakeNamed(verdict.handshake);
      const own = lookup(handshake.sides, (s) => s.identity === verdict.side);
      const wire = lookup(
        file.vectors,
        (v) => v.name === verdict.hello_vector,
      ).wire_hex;
      const decoded = tryDecodeFrame(bytesFromHex(wire));
      if (decoded?.type !== "secure-hello") {
        // Refused while decoding: allowed only where the vector says the stage is advisory.
        expect(
          verdict.stage_advisory,
          `${verdict.name} refused at decoding`,
        ).toBe(true);

        return;
      }
      if (!verdict.stage_advisory) {
        expect(verdict.refused_at).toBe("establishment");
      }
      const identity = identityPort(verdict.side);
      const hellos = await verifyHello(identity, decoded);
      // The hello is validly signed, so only the key exchange can refuse its ephemeral key.
      expect(hellos.ok, `${verdict.name} hello verdict`).toBe(true);
      if (!hellos.ok) return;

      expect(
        await establishChannel(
          identity,
          await pendingFor(own),
          decoded,
          hellos.peer,
        ),
      ).toBeUndefined();
    });
  }
});

describe("secure-channel open sequences", () => {
  for (const sequence of channelVectors.open_sequences) {
    it(sequence.name, async () => {
      const channel = await channelAt(
        handshakeNamed(sequence.handshake),
        sequence.receiver,
      );

      await inSequence(sequence.steps, async (step, index) => {
        const label = `${sequence.name} step ${String(index)}`;
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
