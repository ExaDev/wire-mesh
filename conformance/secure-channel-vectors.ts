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
  SCALAR_BYTE_LENGTH,
  associatedData,
  buildHandshake,
  flipFirstByte,
  flipLastByte,
  gcmSeal,
  helloMessage,
  identities,
  identityNamed,
  innerWire,
  ivFor,
  makeHello,
  otherEnd,
  sealFrom,
  sealedFrame,
  sendKey,
  wireHex,
  type EphemeralInputs,
  type Handshake,
  type Hello,
  type Identity,
} from "./secure-channel-crypto.ts";

// An algorithm no verifier implements, for the identity_mismatch case
const UNKNOWN_ALG = -999;
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
  secureDataWireHex: string;
  expected: OpenVerdict | { opened: string };
}

function opened(frame: JsonWire): { opened: string } {
  return { opened: innerWire(frame).toString("hex") };
}

function dataStep(
  counter: number,
  ciphertext: Buffer,
  expected: OpenStep["expected"],
): OpenStep {
  return {
    secureDataWireHex: wireHex(sealedFrame(counter, ciphertext)),
    expected,
  };
}

function stepJson(step: OpenStep): JsonWire {
  return {
    secure_data_wire_hex: step.secureDataWireHex,
    expected:
      typeof step.expected === "string"
        ? { result: step.expected }
        : { result: "opened", frame_wire_hex: step.expected.opened },
  };
}

interface Sequence {
  name: string;
  handshake: string;
  sender: string;
  receiver: string;
  steps: readonly OpenStep[];
  /** A frame kind spec obligation 5 forbids inside a channel: it opens, the session then drops it, and a sealing implementation must refuse to produce it. */
  notSealable: boolean;
}

function sequencesFor(
  handshake: Handshake,
  sender: Identity,
  frame: JsonWire,
  wrongChannel: Handshake | undefined,
): Sequence[] {
  const receiver = otherEnd(handshake, sender);
  const suffix = `${handshake.name}_${sender.name}_to_${receiver.name}`;
  const seal = (counter: number, inner: JsonWire = frame): Buffer =>
    sealFrom(handshake, sender, counter, inner);
  const sequence = (
    name: string,
    steps: readonly OpenStep[],
    notSealable = false,
  ): Sequence => ({
    name: `${name}_${suffix}`,
    handshake: handshake.name,
    sender: sender.name,
    receiver: receiver.name,
    steps,
    notSealable,
  });
  const genuine = seal(0);
  const sequences: Sequence[] = [
    sequence("tampered_ciphertext_byte", [
      dataStep(0, flipFirstByte(genuine), "unauthentic"),
      dataStep(0, genuine, opened(frame)),
    ]),
    sequence("tampered_tag_byte", [
      dataStep(0, flipLastByte(genuine), "unauthentic"),
      dataStep(0, genuine, opened(frame)),
    ]),
    // The counter is in the IV and the associated data, so a ciphertext presented under another counter does not authenticate.
    sequence("tampered_counter", [
      dataStep(OTHER_COUNTER, genuine, "unauthentic"),
      dataStep(0, genuine, opened(frame)),
    ]),
    // Sealed under the right key and counter, but with associated data naming a different recipient.
    sequence("tampered_associated_data", [
      dataStep(
        0,
        gcmSeal(
          sendKey(handshake, sender),
          0,
          associatedData(sender.deviceId, identityNamed("c").deviceId, 0),
          innerWire(frame),
        ),
        "unauthentic",
      ),
      dataStep(0, genuine, opened(frame)),
    ]),
    // The receiver's own frame reflected back at it is sealed under the other direction's key.
    sequence("wrong_key_reflected", [
      dataStep(0, sealFrom(handshake, receiver, 0, frame), "unauthentic"),
      dataStep(0, genuine, opened(frame)),
    ]),
    sequence("replayed_counter", [
      dataStep(0, genuine, opened(frame)),
      dataStep(0, genuine, "replayed"),
    ]),
    // A gap is accepted and going back is not.
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
      dataStep(0, genuine, opened(frame)),
    ]),
    // Authenticates but is not a frame: the counter is consumed all the same.
    sequence("undecodable_plaintext_consumes_counter", [
      dataStep(
        0,
        gcmSeal(
          sendKey(handshake, sender),
          0,
          associatedData(sender.deviceId, receiver.deviceId, 0),
          Buffer.from(
            encode(toWire({ type: "no-such-frame" }), cdeEncodeOptions),
          ),
        ),
        "undecodable",
      ),
      dataStep(0, genuine, "replayed"),
      dataStep(1, seal(1), opened(frame)),
    ]),
    sequence(
      "not_sealable_kind",
      [dataStep(0, seal(0, { type: "ping" }), opened({ type: "ping" }))],
      true,
    ),
  ];
  if (wrongChannel !== undefined) {
    // The same two devices on a second channel, with different ephemeral keys and nonces, so different keys.
    sequences.push(
      sequence("wrong_channel", [
        dataStep(0, sealFrom(wrongChannel, sender, 0, frame), "unauthentic"),
        dataStep(0, genuine, opened(frame)),
      ]),
    );
  }

  return sequences;
}

interface HelloVerdict {
  name: string;
  receiver: string;
  message: JsonWire;
  expected: "ok" | "wrong_recipient" | "bad_signature" | "identity_mismatch";
  peer?: Identity;
  /** Set when the hello was freshly signed for this case, so its signature is recorded and, for ES256, kept on regeneration. */
  signed?: Hello;
}

/** Hellos from the first side of `handshake`, delivered to its second side. */
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

  return [
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
    // An algorithm no verifier implements: verification throws, which is reported as a mismatch, not a bad signature.
    {
      name: "unknown_identity_alg",
      receiver,
      message: helloMessage(hello, {
        identityKey: {
          alg: UNKNOWN_ALG,
          "public-key": hex(sideA.identity.publicKey.toString("hex")),
        },
      }),
      expected: "identity_mismatch",
    },
    // A public key of the wrong size for its algorithm cannot import.
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
      expected: "identity_mismatch",
    },
  ];
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

  // An ephemeral key with the right length and prefix that is not on the curve, validly signed: only the key exchange can refuse it.
  const origin = ed25519.sides[0];
  const offCurve = Buffer.concat([
    Buffer.from([SEC1_UNCOMPRESSED_PREFIX]),
    Buffer.alloc(SCALAR_BYTE_LENGTH, OFF_CURVE_X_FILL),
    Buffer.alloc(SCALAR_BYTE_LENGTH, OFF_CURVE_Y_FILL),
  ]);
  const offCurveHello = makeHello({
    name: "establish_ephemeral_key_not_on_curve",
    from: origin.identity,
    to: origin.peer.deviceId,
    ephemeralPublic: offCurve,
    nonce: origin.hello.nonce,
  });
  const offCurveMessage = helloMessage(offCurveHello);
  vectors.push({
    name: offCurveHello.name,
    message: offCurveMessage,
    wire_hex: wireHex(offCurveMessage),
  });
  const establishVerdicts: JsonWire[] = [
    {
      name: "ephemeral_key_not_on_curve",
      handshake: ed25519.name,
      side: origin.peer.name,
      hello_vector: offCurveHello.name,
      expected: "unusable_ephemeral_key",
    },
  ];

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
          not_sealable_after_open: s.notSealable,
        })),
      },
    },
  };
}
