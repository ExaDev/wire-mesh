/* Checks every vector in conformance/secure-channel.v1.json against the real secure channel: each hello is verified and each handshake established from its fixed ephemeral keys, every sealed frame of the transcripts is reproduced byte for byte and opened, and each negative sequence is opened in order. The key schedule's intermediate secrets are not observable through Web Crypto (its keys are non-extractable), so they are pinned through the ciphertexts they produce.

   This channel's `open` answers a frame or undefined, so replayed, unauthentic and undecodable are not told apart here: each is checked as "does not open", and what separates them is checked through the later steps of the same sequence (a replayed or consumed counter must stop a genuine frame that carries it, a forged one must not). The Rust implementation, whose errors are distinct, checks the class as well. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";
import { isDataFrame } from "../src/domain/hub-mailbox.js";
import {
  establishChannel,
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

const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);

const vectorSchema = z.object({ name: z.string(), wire_hex: hexString });

const sideSchema = z.object({
  identity: z.string(),
  peer: z.string(),
  ephemeral_secret_hex: hexString,
  ephemeral_public_hex: hexString,
  nonce_hex: hexString,
  signature_hex: hexString,
  hello_vector: z.string(),
});

const transcriptStepSchema = z.object({
  from: z.string(),
  counter: z.number().int().nonnegative(),
  inner_wire_hex: hexString,
  ciphertext_hex: hexString,
  sealed_vector: z.string(),
});

const handshakeSchema = z.object({
  name: z.string(),
  sides: z.tuple([sideSchema, sideSchema]),
  transcript: z.array(transcriptStepSchema),
});

const identitySchema = z.object({
  alg: z.number().int(),
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
    "bad_signature",
    "identity_mismatch",
  ]),
  peer_device_id_hex: hexString.optional(),
});

const establishVerdictSchema = z.object({
  name: z.string(),
  handshake: z.string(),
  side: z.string(),
  hello_vector: z.string(),
  expected: z.literal("unusable_ephemeral_key"),
});

const stepSchema = z.object({
  secure_data_wire_hex: hexString,
  expected: z.discriminatedUnion("result", [
    z.object({ result: z.literal("opened"), frame_wire_hex: hexString }),
    z.object({ result: z.literal("replayed") }),
    z.object({ result: z.literal("unauthentic") }),
    z.object({ result: z.literal("undecodable") }),
  ]),
});

const sequenceSchema = z.object({
  name: z.string(),
  handshake: z.string(),
  receiver: z.string(),
  steps: z.array(stepSchema),
  not_sealable_after_open: z.boolean(),
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

describe("secure-channel hello verdicts", () => {
  for (const verdict of channelVectors.hello_verdicts) {
    it(verdict.name, async () => {
      const result = await verifyHello(
        identityPort(verdict.receiver),
        helloVector(verdict.hello_vector),
      );

      if (verdict.expected === "ok") {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(hexOf(result.peer.deviceId)).toBe(verdict.peer_device_id_hex);
        }
      } else {
        expect(result).toEqual({ ok: false, reason: verdict.expected });
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
      const hello = helloVector(verdict.hello_vector);
      const identity = identityPort(verdict.side);
      const hellos = await verifyHello(identity, hello);
      // Validly signed, so verification passes and only the key exchange can refuse it.
      expect(hellos.ok).toBe(true);
      if (!hellos.ok) return;

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

describe("secure-channel open sequences", () => {
  for (const sequence of channelVectors.open_sequences) {
    it(sequence.name, async () => {
      const channel = await channelAt(
        handshakeNamed(sequence.handshake),
        sequence.receiver,
      );

      await inSequence(sequence.steps, async (step, index) => {
        const result = await channel.open(
          secureData(step.secure_data_wire_hex),
        );
        const label = `${sequence.name} step ${String(index)}`;
        if (step.expected.result === "opened") {
          expect(result, label).toEqual(
            frameFromHex(step.expected.frame_wire_hex),
          );
          if (sequence.not_sealable_after_open && result !== undefined) {
            // Spec obligation 5: a kind other than a manage-request, manage-response or data frame opens, and the session then drops it.
            expect(
              result.type !== "manage-request" &&
                result.type !== "manage-response" &&
                !isDataFrame(result),
              `${label} is a kind the session must drop`,
            ).toBe(true);
          }
        } else {
          expect(result, label).toBeUndefined();
        }
      });
    });
  }
});
