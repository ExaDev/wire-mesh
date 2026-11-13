/* secure-channel.v1.json's own vectors: the handshake transcripts, key schedule and sealed frames of spec/secure-channel.cddl, plus the negative cases a receiver must refuse.

   Every value is computed here with node:crypto alone, written from the spec text and deliberately not imported from either implementation: the generator, the TypeScript core and the Rust crate are three independent implementations checked against one file, and a vector produced by the thing it checks would prove nothing.

   All key material (see secure-channel-crypto.ts) is made up for these vectors and is test material only: Ed25519 identities from fixed repeated-byte seeds, an ES256 identity from a fixed scalar, ephemeral P-256 keys from fixed scalars and nonces from fixed fills. AES-GCM and Ed25519 are deterministic, so everything regenerates byte for byte. ECDSA is not: an ES256 hello's signature is emitted once and kept on regeneration for as long as the signing input is unchanged, in which case the generator only checks that it still verifies. Such a hello is verify-only. */

import { cdeEncodeOptions, encode } from "cbor2";
import {
  hex,
  toWire,
  type JsonWire,
  type Vector,
} from "@exadev/wire-mesh-conformance";
import {
  EDDSA,
  ES256,
  SCALAR_BYTE_LENGTH,
  associatedData,
  buildHandshake,
  derSignature,
  flipFirstByte,
  flipLastByte,
  gcmSeal,
  helloMessage,
  highSForm,
  identities,
  identityNamed,
  innerWire,
  ivFor,
  makeHello,
  otherEnd,
  sealFrom,
  sealedFrame,
  secureDataWireHex,
  sendKey,
  wireHex,
  type Counter,
  type EphemeralInputs,
  type Handshake,
  type Hello,
  type Identity,
} from "./secure-channel-crypto.ts";

// An algorithm no verifier implements
const UNKNOWN_ALG = -999;
// A frame's ciphertext cut to fewer bytes than a GCM tag holds
const SHORT_CIPHERTEXT_BYTE_LENGTH = 8;
const COMPRESSED_PREFIX = 0x02;
// What a verifier does with the high-s twin of a valid ES256 signature: ECDSA verification accepts it
const HIGH_S_TWIN_VERDICT = "ok";
// A counter far above anything a test channel has seen, for the forged-counter case
const FORGED_HIGH_COUNTER = 1000;
const FORGED_CIPHERTEXT_BYTE_LENGTH = 40;
const FORGED_FILL = 0x5a;
// A counter the genuine frame was not sealed under, for the tampered-counter case
const OTHER_COUNTER = 5;
// Out-of-order case: counter 2 opens first (a gap is allowed), 1 is then behind it, and 3 is ahead again
const SKIPPED_OVER = 1;
const SKIPPED_AHEAD = 2;
const AFTER_GAP = 3;
const SEC1_UNCOMPRESSED_PREFIX = 0x04;
const OFF_CURVE_X_FILL = 0x01;
const OFF_CURVE_Y_FILL = 0x02;

// Inner frames

function innerFrames(tokenRequest: JsonWire): Record<string, JsonWire> {
  const deviceHex = identityNamed("a").deviceId.toString("hex");

  return {
    manage_request_with_token: tokenRequest,
    manage_request_without_token: {
      type: "manage-request",
      "request-id": 7,
      command: {
        verb: "exec:pty",
        params: {
          verb: "pty.spawn",
          shell: "/bin/sh",
          argv: [],
          cwd: "/work",
          env: {},
          cols: 80,
          rows: 24,
        },
      },
      scope: { kind: "folder", path: "/work" },
    },
    manage_response_ok: {
      type: "manage-response",
      "request-id": 7,
      outcome: { result: "ok" },
    },
    manage_response_error: {
      type: "manage-response",
      "request-id": 8,
      outcome: {
        result: "error",
        code: "scope-denied",
        message: "token does not authorise this path",
      },
    },
    data_have: { type: "data-have", peer: hex(deviceHex), "head-seq": 128 },
    data_request: {
      type: "data-request",
      peer: hex(deviceHex),
      "from-seq": 100,
    },
    data_entries: {
      type: "data-entries",
      peer: hex(deviceHex),
      "from-seq": 100,
      entries: [hex("aabbcc"), hex("ddeeff00")],
    },
  };
}

// Positive transcripts

type JsonRecord = Record<string, JsonWire>;

type TranscriptPlan = readonly (readonly [string, string])[];

function transcriptSteps(
  handshake: Handshake,
  frames: Readonly<Record<string, JsonWire>>,
  plan: TranscriptPlan,
): { steps: JsonRecord[]; vectors: Vector[] } {
  const counters = new Map<string, number>();

  const sealed = plan.map(([senderName, frameName]) => {
    const sender = identityNamed(senderName);
    const recipient = otherEnd(handshake, sender);
    const frame = frames[frameName];
    if (frame === undefined) {
      throw new Error(`no inner frame named ${frameName}`);
    }
    const counter = counters.get(senderName) ?? 0;
    counters.set(senderName, counter + 1);
    const ciphertext = sealFrom(handshake, sender, counter, frame);
    const vectorName = `secure_data_${handshake.name}_${senderName}_${String(counter)}`;
    const message = sealedFrame(counter, ciphertext);
    const vector: Vector = {
      name: vectorName,
      message,
      wire_hex: wireHex(message),
    };

    return {
      vector,
      step: {
        from: senderName,
        counter,
        inner_frame: frameName,
        inner_wire_hex: innerWire(frame).toString("hex"),
        iv_hex: ivFor(counter).toString("hex"),
        aad_hex: associatedData(
          sender.deviceId,
          recipient.deviceId,
          counter,
        ).toString("hex"),
        ciphertext_hex: ciphertext.toString("hex"),
        sealed_vector: vectorName,
      },
    };
  });

  return {
    steps: sealed.map((item) => item.step),
    vectors: sealed.map((item) => item.vector),
  };
}

function handshakeJson(
  handshake: Handshake,
  frames: Readonly<Record<string, JsonWire>>,
  plan: TranscriptPlan,
): { json: JsonRecord; vectors: Vector[] } {
  const sides = handshake.sides.map((side) => {
    const message = helloMessage(side.hello);
    const vector: Vector = {
      name: side.hello.name,
      message,
      wire_hex: wireHex(message),
    };

    return {
      vector,
      side: {
        identity: side.identity.name,
        peer: side.peer.name,
        ephemeral_secret_hex: side.ephemeralSecretHex,
        ephemeral_public_hex: side.hello.ephemeralPublic.toString("hex"),
        nonce_hex: side.hello.nonce.toString("hex"),
        signing_input_hex: side.hello.signingInput.toString("hex"),
        signature_hex: side.hello.signature.toString("hex"),
        // ES256 signatures carry a fresh nonce on every signing, so such a hello is checked, never reproduced.
        signature_verify_only: side.identity.alg !== EDDSA,
        hello_vector: side.hello.name,
      },
    };
  });
  const transcript = transcriptSteps(handshake, frames, plan);

  return {
    vectors: [...sides.map((item) => item.vector), ...transcript.vectors],
    json: {
      name: handshake.name,
      sides: sides.map((item): JsonWire => item.side),
      key_schedule: {
        low: handshake.low.name,
        high: handshake.high.name,
        shared_secret_hex: handshake.sharedSecret.toString("hex"),
        salt_hex: handshake.salt.toString("hex"),
        info_low_to_high_hex: handshake.infoLowToHigh.toString("hex"),
        info_high_to_low_hex: handshake.infoHighToLow.toString("hex"),
        key_low_to_high_hex: handshake.keyLowToHigh.toString("hex"),
        key_high_to_low_hex: handshake.keyHighToLow.toString("hex"),
      },
      transcript: transcript.steps,
    },
  };
}

// Negative cases

type OpenVerdict = "replayed" | "unauthentic" | "undecodable";

interface OpenStep {
  counter: Counter;
  secureDataWireHex: string;
  expected: OpenVerdict | { opened: string };
  /** Set when the step needs a counter wider than the exact range of a JavaScript number, or state a refused earlier step would have left. An implementation whose counter is narrower refuses the frame (it must not truncate it) and skips the steps after it. */
  fullWidthOnly?: boolean;
}

function opened(frame: JsonWire): { opened: string } {
  return { opened: innerWire(frame).toString("hex") };
}

function dataStep(
  counter: Counter,
  ciphertext: Buffer,
  expected: OpenStep["expected"],
  fullWidthOnly = false,
): OpenStep {
  return {
    counter,
    secureDataWireHex: secureDataWireHex(counter, ciphertext),
    expected,
    ...(fullWidthOnly ? { fullWidthOnly } : {}),
  };
}

function stepJson(step: OpenStep): JsonWire {
  return {
    counter: String(step.counter),
    secure_data_wire_hex: step.secureDataWireHex,
    expected:
      typeof step.expected === "string"
        ? { result: step.expected }
        : { result: "opened", frame_wire_hex: step.expected.opened },
    ...(step.fullWidthOnly === true ? { full_width_only: true } : {}),
  };
}

interface Sequence {
  name: string;
  handshake: string;
  sender: string;
  receiver: string;
  steps: readonly OpenStep[];
  /** A frame kind spec obligation 5 says the receiver drops after opening it: it opens at the channel, and the session does not act on it. */
  receiverDropsAfterOpen: boolean;
}

/* The counter's byte positions: every one of the eight is non-zero in WIDE_COUNTER (0x0102030405 fills the low five)
   and in MAX_COUNTER_U64 (all eight). */
const WIDE_COUNTER = 0x0102030405n;
const MAX_EXACT_COUNTER = BigInt(Number.MAX_SAFE_INTEGER);
const COUNTER_STEP = 1n;
const FIRST_INEXACT_COUNTER = MAX_EXACT_COUNTER + COUNTER_STEP;

/** The counter one below `counter`. */
function below(counter: bigint): bigint {
  return counter - COUNTER_STEP;
}
const MAX_COUNTER_U64 = 0xffffffffffffffffn;
// A wide counter with a distinct value in each of the eight bytes
const DISTINCT_BYTES_COUNTER = 0x0102030405060708n;

/** The plaintexts that authenticate but are not one frame, each a different way of being wrong. */
function undecodablePlaintexts(): readonly (readonly [string, Buffer])[] {
  const ping = Buffer.from(encode(toWire({ type: "ping" }), cdeEncodeOptions));

  return [
    [
      "unknown_frame_type",
      Buffer.from(encode(toWire({ type: "no-such-frame" }), cdeEncodeOptions)),
    ],
    // A known kind with a required field missing
    [
      "known_kind_missing_fields",
      Buffer.from(encode(toWire({ type: "data-have" }), cdeEncodeOptions)),
    ],
    // map(1) with its length in the one-byte form instead of the shortest
    ["non_canonical_length", Buffer.from("b80164747970656470696e67", "hex")],
    // The indefinite-length map form
    ["indefinite_length_map", Buffer.from("bf64747970656470696e67ff", "hex")],
    ["trailing_bytes", Buffer.concat([ping, Buffer.from([0])])],
    ["empty_plaintext", Buffer.alloc(0)],
  ];
}

function sequencesFor(
  handshake: Handshake,
  sender: Identity,
  frame: JsonWire,
  wrongChannel: Handshake | undefined,
): Sequence[] {
  const receiver = otherEnd(handshake, sender);
  const suffix = `${handshake.name}_${sender.name}_to_${receiver.name}`;
  const seal = (counter: Counter, inner: JsonWire = frame): Buffer =>
    sealFrom(handshake, sender, counter, inner);
  const sealPlaintext = (
    counter: Counter,
    plaintext: Buffer,
    options: Readonly<{ key?: Buffer; recipient?: Identity }> = {},
  ): Buffer =>
    gcmSeal(
      options.key ?? sendKey(handshake, sender),
      counter,
      associatedData(
        sender.deviceId,
        (options.recipient ?? receiver).deviceId,
        counter,
      ),
      plaintext,
    );
  const sequence = (
    name: string,
    steps: readonly OpenStep[],
    receiverDropsAfterOpen = false,
  ): Sequence => ({
    name: `${name}_${suffix}`,
    handshake: handshake.name,
    sender: sender.name,
    receiver: receiver.name,
    steps,
    receiverDropsAfterOpen,
  });
  const genuine = seal(0);
  const genuineOpens = dataStep(0, genuine, opened(frame));
  const sequences: Sequence[] = [
    sequence("tampered_ciphertext_byte", [
      dataStep(0, flipFirstByte(genuine), "unauthentic"),
      genuineOpens,
    ]),
    sequence("tampered_tag_byte", [
      dataStep(0, flipLastByte(genuine), "unauthentic"),
      genuineOpens,
    ]),
    // The tag is the last 16 bytes: dropping one byte, keeping fewer bytes than a tag, and no bytes at all.
    sequence("truncated_tag", [
      dataStep(0, genuine.subarray(0, genuine.length - 1), "unauthentic"),
      genuineOpens,
    ]),
    sequence("ciphertext_shorter_than_a_tag", [
      dataStep(
        0,
        genuine.subarray(0, SHORT_CIPHERTEXT_BYTE_LENGTH),
        "unauthentic",
      ),
      genuineOpens,
    ]),
    sequence("empty_ciphertext", [
      dataStep(0, Buffer.alloc(0), "unauthentic"),
      genuineOpens,
    ]),
    // The counter is in the IV and the associated data, so a ciphertext presented under another counter does not authenticate.
    sequence("tampered_counter", [
      dataStep(OTHER_COUNTER, genuine, "unauthentic"),
      genuineOpens,
    ]),
    // Sealed under the right key and counter, but with associated data naming a different recipient.
    sequence("tampered_associated_data", [
      dataStep(
        0,
        sealPlaintext(0, innerWire(frame), {
          recipient: identityNamed("c"),
        }),
        "unauthentic",
      ),
      genuineOpens,
    ]),
    // Only the key differs from a genuine frame: sealed under the key of the other direction, with this direction's counter, IV and associated data.
    sequence("wrong_direction_key", [
      dataStep(
        0,
        sealPlaintext(0, innerWire(frame), {
          key: sendKey(handshake, receiver),
        }),
        "unauthentic",
      ),
      genuineOpens,
    ]),
    // The receiver's own frame sent back at it: the other direction's key, and associated data naming the receiver as sender.
    sequence("reflected_frame", [
      dataStep(0, sealFrom(handshake, receiver, 0, frame), "unauthentic"),
      genuineOpens,
    ]),
    sequence("replayed_counter", [
      genuineOpens,
      dataStep(0, genuine, "replayed"),
    ]),
    // Replay is checked before the frame is authenticated, so an altered frame at a counter already accepted is replayed, not unauthentic.
    sequence("unauthentic_at_a_passed_counter", [
      genuineOpens,
      dataStep(0, flipFirstByte(genuine), "replayed"),
    ]),
    // A gap is accepted and going back is not; there is no window.
    sequence("out_of_order_counter", [
      dataStep(SKIPPED_AHEAD, seal(SKIPPED_AHEAD), opened(frame)),
      dataStep(SKIPPED_OVER, seal(SKIPPED_OVER), "replayed"),
      dataStep(AFTER_GAP, seal(AFTER_GAP), opened(frame)),
    ]),
    // A forged high counter must not advance the accepted counter, or it would lock out every real frame.
    sequence("forged_high_counter", [
      dataStep(
        FORGED_HIGH_COUNTER,
        Buffer.alloc(FORGED_CIPHERTEXT_BYTE_LENGTH, FORGED_FILL),
        "unauthentic",
      ),
      genuineOpens,
    ]),
    // Counters that fill the IV and associated data's counter bytes beyond the low byte, in both a counter a JavaScript number holds and one it does not.
    sequence("counter_in_every_low_byte", [
      dataStep(WIDE_COUNTER, seal(WIDE_COUNTER), opened(frame)),
      dataStep(below(WIDE_COUNTER), seal(below(WIDE_COUNTER)), "replayed"),
    ]),
    sequence("largest_exact_counter", [
      dataStep(MAX_EXACT_COUNTER, seal(MAX_EXACT_COUNTER), opened(frame)),
      dataStep(
        below(MAX_EXACT_COUNTER),
        seal(below(MAX_EXACT_COUNTER)),
        "replayed",
      ),
    ]),
    sequence("counter_beyond_exact_range", [
      dataStep(
        FIRST_INEXACT_COUNTER,
        seal(FIRST_INEXACT_COUNTER),
        opened(frame),
        true,
      ),
      dataStep(MAX_EXACT_COUNTER, seal(MAX_EXACT_COUNTER), "replayed", true),
    ]),
    sequence("counter_with_a_distinct_byte_in_all_eight_positions", [
      dataStep(
        DISTINCT_BYTES_COUNTER,
        seal(DISTINCT_BYTES_COUNTER),
        opened(frame),
        true,
      ),
      dataStep(
        below(DISTINCT_BYTES_COUNTER),
        seal(below(DISTINCT_BYTES_COUNTER)),
        "replayed",
        true,
      ),
    ]),
    sequence("largest_counter", [
      dataStep(MAX_COUNTER_U64, seal(MAX_COUNTER_U64), opened(frame), true),
      dataStep(
        below(MAX_COUNTER_U64),
        seal(below(MAX_COUNTER_U64)),
        "replayed",
        true,
      ),
    ]),
    // Authenticates but is not a frame, in six ways: the counter is consumed each time, so the genuine frame at that counter is then replayed.
    ...undecodablePlaintexts().map(([name, plaintext]) =>
      sequence(`undecodable_${name}`, [
        dataStep(0, sealPlaintext(0, plaintext), "undecodable"),
        dataStep(0, genuine, "replayed"),
        dataStep(1, seal(1), opened(frame)),
      ]),
    ),
    // A kind the receiver does not act on (spec obligation 5): it opens at the channel, and the session drops it.
    sequence(
      "kind_outside_obligation_5",
      [dataStep(0, seal(0, { type: "ping" }), opened({ type: "ping" }))],
      true,
    ),
  ];
  if (wrongChannel !== undefined) {
    // The same two devices on a second channel, with different ephemeral keys and nonces, so different keys.
    sequences.push(
      sequence("wrong_channel", [
        dataStep(0, sealFrom(wrongChannel, sender, 0, frame), "unauthentic"),
        genuineOpens,
      ]),
    );
  }

  return sequences;
}

type HelloExpectation =
  | "ok"
  | "wrong_recipient"
  | "unsupported_identity_alg"
  | "invalid_identity_key"
  | "bad_signature";

interface HelloVerdict {
  name: string;
  receiver: string;
  message: JsonWire;
  expected: HelloExpectation;
  peer?: Identity;
  /** Set when the hello was freshly signed for this case, so its signature is recorded and, for ES256, kept on regeneration. */
  signed?: Hello;
}

/** Hellos from the first side of `handshake`, delivered to its second side unless a case says otherwise. */
function helloVerdicts(handshake: Handshake): HelloVerdict[] {
  const [sideA, sideB] = handshake.sides;
  const hello = sideA.hello;
  const outsider = identityNamed("c");
  const receiver = sideB.identity.name;
  const addressedToOutsider = makeHello({
    name: `verdict_${handshake.name}_addressed_to_outsider`,
    from: sideA.identity,
    to: outsider.deviceId,
    ephemeralPublic: hello.ephemeralPublic,
    nonce: hello.nonce,
  });
  const signedByOutsider = makeHello({
    name: `verdict_${handshake.name}_signed_by_outsider`,
    from: sideA.identity,
    to: hello.to,
    ephemeralPublic: hello.ephemeralPublic,
    nonce: hello.nonce,
    signer: outsider,
  });
  const unknownAlgKey: JsonWire = {
    alg: UNKNOWN_ALG,
    "public-key": hex(sideA.identity.publicKey.toString("hex")),
  };
  const verdicts: HelloVerdict[] = [
    {
      name: "valid",
      receiver,
      message: helloMessage(hello),
      expected: "ok",
      peer: sideA.identity,
    },
    // Signed correctly, but for the outsider: the receiver is not the addressee, which is checked before the signature.
    {
      name: "addressed_to_outsider",
      receiver,
      message: helloMessage(addressedToOutsider),
      signed: addressedToOutsider,
      expected: "wrong_recipient",
    },
    // The first side's own hello delivered back to it: addressed to the other side, so not to the receiver.
    {
      name: "reflected_to_its_sender",
      receiver: sideA.identity.name,
      message: helloMessage(hello),
      expected: "wrong_recipient",
    },
    // A relay substituting its own ephemeral key invalidates the signature.
    {
      name: "ephemeral_key_swapped",
      receiver,
      message: helloMessage(hello, {
        ephemeralPublic: sideB.hello.ephemeralPublic,
      }),
      expected: "bad_signature",
    },
    // Carries the first side's identity-key, but was signed by the outsider.
    {
      name: "signed_by_outsider",
      receiver,
      message: helloMessage(signedByOutsider),
      signed: signedByOutsider,
      expected: "bad_signature",
    },
    {
      name: "signature_byte_flipped",
      receiver,
      message: helloMessage(hello, {
        signature: flipLastByte(hello.signature),
      }),
      expected: "bad_signature",
    },
    // An algorithm no verifier implements.
    {
      name: "unsupported_identity_alg",
      receiver,
      message: helloMessage(hello, { identityKey: unknownAlgKey }),
      expected: "unsupported_identity_alg",
    },
    // A public key of the wrong size for its algorithm cannot be used.
    {
      name: "identity_key_wrong_size",
      receiver,
      message: helloMessage(hello, {
        identityKey: {
          alg: sideA.identity.alg,
          "public-key": hex(
            sideA.identity.publicKey.subarray(1).toString("hex"),
          ),
        },
      }),
      expected: "invalid_identity_key",
    },
    // The right size for ES256, but not a point on the curve.
    {
      name: "identity_key_not_on_curve",
      receiver,
      message: helloMessage(hello, {
        identityKey: {
          alg: ES256,
          "public-key": hex(offCurvePoint().toString("hex")),
        },
      }),
      expected: "invalid_identity_key",
    },
    // Wrong in two ways at once: addressed to someone else and with an unsupported algorithm. The recipient is checked first.
    {
      name: "wrong_recipient_and_unsupported_alg",
      receiver,
      message: helloMessage(addressedToOutsider, {
        identityKey: unknownAlgKey,
      }),
      expected: "wrong_recipient",
    },
  ];
  if (sideA.identity.alg === ES256) {
    // The spec's ES256 signature is the fixed-length raw r||s, and a verifier does not require the low-s form.
    verdicts.push(
      {
        name: "der_encoded_signature",
        receiver,
        message: helloMessage(hello, {
          signature: derSignature(hello.signature),
        }),
        expected: "bad_signature",
      },
      {
        name: "high_s_signature",
        receiver,
        message: helloMessage(hello, { signature: highSForm(hello.signature) }),
        expected: HIGH_S_TWIN_VERDICT,
        peer: sideA.identity,
      },
    );
  }

  return verdicts;
}

/** A 65-byte SEC1-looking value that is not on the P-256 curve. */
function offCurvePoint(): Buffer {
  return Buffer.concat([
    Buffer.from([SEC1_UNCOMPRESSED_PREFIX]),
    Buffer.alloc(SCALAR_BYTE_LENGTH, OFF_CURVE_X_FILL),
    Buffer.alloc(SCALAR_BYTE_LENGTH, OFF_CURVE_Y_FILL),
  ]);
}

/** Fixed scalar and nonce fills: made up, one distinct pair per channel end. */
function ephemeral(
  secretFillHex: string,
  nonceFillHex: string,
): EphemeralInputs {
  return {
    secretHex: secretFillHex.repeat(SCALAR_BYTE_LENGTH),
    nonceFillHex,
  };
}

const TRANSCRIPT_PLAN = (first: string, other: string): [string, string][] => [
  [first, "manage_request_with_token"],
  [other, "manage_response_ok"],
  [first, "data_have"],
  [other, "data_request"],
  [first, "manage_request_without_token"],
  [other, "data_entries"],
  [other, "manage_response_error"],
  [first, "data_request"],
  [other, "data_have"],
];

/** The whole of secure-channel.v1.json apart from its description: the top-level round-trip vectors and the `secure_channel` section. `frameVectors` supplies the one inner frame that carries a token, so no second token is minted here. */
export function secureChannelFile(frameVectors: readonly Vector[]): {
  vectors: Vector[];
  extra: JsonRecord;
} {
  const tokenRequest = frameVectors.find(
    (vector) => vector.name === "manage_request_v1_webrtc_offer",
  );
  if (tokenRequest === undefined) {
    throw new Error("frames lack the token-carrying manage-request vector");
  }
  const frames = innerFrames(tokenRequest.message);
  const plainRequest = frames.manage_request_without_token;
  if (plainRequest === undefined) {
    throw new Error("no plain manage-request frame");
  }
  const vectors: Vector[] = [];

  const ed25519 = buildHandshake(
    "ed25519",
    { identity: identityNamed("a"), ephemeral: ephemeral("11", "a0") },
    { identity: identityNamed("b"), ephemeral: ephemeral("22", "b0") },
  );
  const es256 = buildHandshake(
    "es256",
    { identity: identityNamed("e"), ephemeral: ephemeral("33", "c0") },
    { identity: identityNamed("a"), ephemeral: ephemeral("44", "d0") },
  );
  // The same two devices again with other ephemeral keys and nonces, for the wrong-channel case.
  const second = buildHandshake(
    "second_channel",
    { identity: identityNamed("a"), ephemeral: ephemeral("55", "e0") },
    { identity: identityNamed("b"), ephemeral: ephemeral("66", "f0") },
  );

  const built = [
    handshakeJson(ed25519, frames, TRANSCRIPT_PLAN("a", "b")),
    handshakeJson(es256, frames, TRANSCRIPT_PLAN("e", "a")),
    handshakeJson(second, frames, TRANSCRIPT_PLAN("a", "b")),
  ];
  const handshakes = built.map((item) => item.json);
  vectors.push(...built.flatMap((item) => item.vectors));

  const helloVerdictJson: JsonWire[] = [];
  for (const handshake of [ed25519, es256]) {
    for (const verdict of helloVerdicts(handshake)) {
      const name = `verdict_${handshake.name}_${verdict.name}`;
      vectors.push({
        name,
        message: verdict.message,
        wire_hex: wireHex(verdict.message),
      });
      helloVerdictJson.push({
        name,
        handshake: handshake.name,
        receiver: verdict.receiver,
        hello_vector: name,
        expected: verdict.expected,
        ...(verdict.peer === undefined
          ? {}
          : { peer_device_id_hex: verdict.peer.deviceId.toString("hex") }),
        ...(verdict.signed === undefined
          ? {}
          : {
              signing_input_hex: verdict.signed.signingInput.toString("hex"),
              signature_hex: verdict.signed.signature.toString("hex"),
            }),
      });
    }
  }

  // Hellos that are validly signed but carry an ephemeral key that cannot be used. Every one of them verifies as a hello, so only establishing the channel can refuse the key.
  const origin = ed25519.sides[0];
  const realPoint = origin.hello.ephemeralPublic;
  const establishCases: readonly (readonly [string, Buffer, boolean])[] = [
    // 65 bytes with the uncompressed prefix, the right length, not on the curve: a conformant implementation reaches establishment and refuses there.
    ["not_on_curve", offCurvePoint(), true],
    // Wrong encodings of a valid point or of nothing: the CDDL's size rule may refuse them while decoding, or establishment may, so the stage is advisory.
    ["identity_encoding", Buffer.from([0]), false],
    [
      "compressed_point",
      Buffer.concat([
        Buffer.from([COMPRESSED_PREFIX]),
        realPoint.subarray(1, 1 + SCALAR_BYTE_LENGTH),
      ]),
      false,
    ],
    ["missing_prefix", realPoint.subarray(1), false],
    [
      "uncompressed_prefix_one_byte_short",
      realPoint.subarray(0, realPoint.length - 1),
      false,
    ],
  ];
  const establishVerdicts: JsonWire[] = establishCases.map(
    ([name, key, exactSize]) => {
      const helloName = `establish_ephemeral_key_${name}`;
      const bad = makeHello({
        name: helloName,
        from: origin.identity,
        to: origin.peer.deviceId,
        ephemeralPublic: key,
        nonce: origin.hello.nonce,
      });
      const message = helloMessage(bad);
      vectors.push({ name: helloName, message, wire_hex: wireHex(message) });

      return {
        name: `ephemeral_key_${name}`,
        handshake: ed25519.name,
        side: origin.peer.name,
        hello_vector: helloName,
        // The hello itself verifies as ok wherever it is decoded; the refusal is the key exchange's.
        hello_verdict: "ok",
        expected: exactSize ? "unusable_ephemeral_key" : "refused",
        refused_at: exactSize ? "establishment" : "decoding_or_establishment",
        stage_advisory: !exactSize,
      };
    },
  );

  const sequences: Sequence[] = [];
  for (const handshake of [ed25519, es256]) {
    const wrongChannel = handshake === ed25519 ? second : undefined;
    for (const side of handshake.sides) {
      sequences.push(
        ...sequencesFor(handshake, side.identity, plainRequest, wrongChannel),
      );
    }
  }

  const identityJson: JsonRecord = {};
  for (const identity of Object.values(identities)) {
    identityJson[identity.name] = {
      alg: identity.alg,
      // Made-up test material: an Ed25519 seed or an ES256 private scalar. Never a real key.
      synthetic: true,
      secret_hex: identity.secretHex,
      public_key_hex: identity.publicKey.toString("hex"),
      device_id_hex: identity.deviceId.toString("hex"),
    };
  }

  return {
    vectors,
    extra: {
      secure_channel: {
        identities: identityJson,
        handshakes,
        hello_verdicts: helloVerdictJson,
        establish_verdicts: establishVerdicts,
        open_sequences: sequences.map((s): JsonWire => ({
          name: s.name,
          handshake: s.handshake,
          sender: s.sender,
          receiver: s.receiver,
          steps: s.steps.map(stepJson),
          receiver_drops_after_open: s.receiverDropsAfterOpen,
        })),
      },
    },
  };
}
