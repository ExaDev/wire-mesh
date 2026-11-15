/* The `handshake_scenarios` section of secure-channel.v1.json: scripted two-party scenarios for the per-peer state machine that opens secure channels through a relay (domain/relay-channels.ts, `domain::relay_channels`), which secure-channel.v1.json's own sections do not reach (they pin one handshake and one transcript, not what a side does when hellos arrive in the order a relay delivers them).

   A scenario names its parties (the identities of this file's `secure_channel` section), the handshakes each party will begin in the order it begins them (a fixed ephemeral scalar and nonce each, so every hello is the same bytes in every implementation), the hellos a peer outside the scenario's parties could send (built here and signed or broken on purpose), and the steps. A step is one operation, run to quiescence before the next: a seal started and left pending, a hello or a sealed frame delivered (any number of times, in any order, with the sender the relay stamped or another), time moved on, a peer forgotten, a side reset, a send or a signature made to fail. After each step the file records exactly what it changed: the hellos sent (by the name of the handshake they belong to), the seals that completed (with the counter of every sealed frame) or failed, the frame an open produced, and the faults reported. Every expectation is written by hand from the rules in relay-channels.ts and never produced by an implementation; the hellos and keys are the only computed values. A step that changes nothing records empty lists. */

import { createECDH } from "node:crypto";
import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import {
  flipLastByte,
  helloMessage,
  identityNamed,
  makeHello,
  wireHex,
  type Hello,
} from "./secure-channel-crypto.ts";

export const RELAY_SCENARIO_LAYOUT_VERSION = 1;

const SCALAR_BYTES = 32;
const NONCE_BYTES = 16;
const POINT_FILL_X = 0x01;
const POINT_FILL_Y = 0x02;
const UNCOMPRESSED_TAG = 0x04;
/** The first fill of an ephemeral scalar: every handshake of every scenario takes the next one, so no two share a key. */
const FIRST_FILL = 0x11;
const LAST_FILL = 0x7f;
const HANDSHAKE_WINDOW_MS = 3_000;
const FAULT_INTERVAL_MS = 1_000;

type Party = "a" | "b";

/** Where a hello is stamped as coming from when it is delivered: its sender, nobody, or another party. */
type Claim = "sender" | "none" | "c";

interface Expect {
  /** Names of the handshakes whose hello was sent during the step. */
  hellos: string[];
  /** Seals that completed during the step, with the counter of every frame sealed for each. */
  sealed: { seal: string; counters: string[] }[];
  /** Seals that failed during the step, with why. */
  failed: { seal: string; kind: "abandoned" | "handshake_failed" }[];
  /** The frame an open produced, or null when it produced none (or the step opens nothing). */
  opened: { from: Party; frame: string } | null;
  /** The faults reported during the step: the peer and how many were withheld before. */
  faults: { peer: Party; suppressed: number }[];
}

type Op =
  | {
      op: "seal";
      seal: string;
      party: Party;
      to: Party;
      purpose: "request" | "reply";
      frame: string;
    }
  | { op: "hello"; handshake: string; claimed: Claim }
  | { op: "extra_hello"; hello: string; to: Party; claimed: Claim | Party }
  | { op: "data"; seal: string; index: number; to: Party }
  | { op: "advance"; ms: number }
  | { op: "forget"; party: Party; peer: Party }
  | { op: "reset"; party: Party }
  | { op: "fail"; party: Party; what: "send" | "sign"; enabled: boolean };

type Step = Op & { expect: Expect };

interface ExtraHello {
  name: string;
  from: Party;
  to: Party | "c";
  /** What is wrong with the hello, if anything. */
  defect?: "bad_signature" | "unusable_ephemeral_key";
}

interface Scenario {
  name: string;
  handshakes: readonly string[];
  extra?: readonly ExtraHello[];
  steps: readonly Step[];
}

const NOTHING: Expect = {
  hellos: [],
  sealed: [],
  failed: [],
  opened: null,
  faults: [],
};

function expecting(partial: Partial<Expect>): Expect {
  return { ...NOTHING, ...partial };
}

function sealed(
  seal: string,
  ...counters: readonly number[]
): Expect["sealed"][number] {
  return { seal, counters: counters.map(String) };
}

function sealStep(
  start: Readonly<{
    seal: string;
    party: Party;
    to: Party;
    purpose: "request" | "reply";
    frame: string;
  }>,
  expect: Partial<Expect>,
): Step {
  return { op: "seal", ...start, expect: expecting(expect) };
}

function deliverHello(
  handshake: string,
  expect: Partial<Expect>,
  claimed: Claim = "sender",
): Step {
  return { op: "hello", handshake, claimed, expect: expecting(expect) };
}

function extraHello(
  name: string,
  to: Party,
  claimed: Claim | Party,
  expect: Partial<Expect>,
): Step {
  return {
    op: "extra_hello",
    hello: name,
    to,
    claimed,
    expect: expecting(expect),
  };
}

function data(
  id: string,
  index: number,
  to: Party,
  opened: Expect["opened"],
): Step {
  return { op: "data", seal: id, index, to, expect: expecting({ opened }) };
}

function advance(ms: number): Step {
  return { op: "advance", ms, expect: NOTHING };
}

/** The first six steps of a request that opens a channel between a (which asks) and b (which answers), through its first reply. Needs the handshakes `a>b#0` and `b>a#0`. */
function openedChannel(): readonly Step[] {
  return [
    sealStep(
      { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
      { hellos: ["a>b#0"] },
    ),
    deliverHello("a>b#0", { hellos: ["b>a#0"] }),
    deliverHello("b>a#0", { sealed: [sealed("s1", 0)] }),
    data("s1", 0, "b", { from: "a", frame: "f1" }),
    sealStep(
      { seal: "s2", party: "b", to: "a", purpose: "reply", frame: "f2" },
      { sealed: [sealed("s2", 0)] },
    ),
    data("s2", 0, "a", { from: "b", frame: "f2" }),
  ];
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "a_request_opens_a_channel_in_both_directions",
    handshakes: ["a>b#0", "b>a#0"],
    steps: openedChannel(),
  },
  {
    name: "two_sides_that_initiate_at_once_reach_one_channel_without_answering_each_other_a_first",
    handshakes: ["a>b#0", "b>a#0"],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      sealStep(
        { seal: "s2", party: "b", to: "a", purpose: "request", frame: "f2" },
        { hellos: ["b>a#0"] },
      ),
      deliverHello("a>b#0", { sealed: [sealed("s2", 0)] }),
      deliverHello("b>a#0", { sealed: [sealed("s1", 0)] }),
      data("s1", 0, "b", { from: "a", frame: "f1" }),
      data("s2", 0, "a", { from: "b", frame: "f2" }),
    ],
  },
  {
    name: "two_sides_that_initiate_at_once_reach_one_channel_without_answering_each_other_b_first",
    handshakes: ["a>b#0", "b>a#0"],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      sealStep(
        { seal: "s2", party: "b", to: "a", purpose: "request", frame: "f2" },
        { hellos: ["b>a#0"] },
      ),
      deliverHello("b>a#0", { sealed: [sealed("s1", 0)] }),
      deliverHello("a>b#0", { sealed: [sealed("s2", 0)] }),
      data("s2", 0, "a", { from: "b", frame: "f2" }),
      data("s1", 0, "b", { from: "a", frame: "f1" }),
    ],
  },
  {
    name: "a_hello_from_a_peer_never_chosen_is_answered_and_a_reply_seals_under_its_candidate",
    handshakes: ["b>a#0", "a>b#0"],
    steps: [
      sealStep(
        { seal: "s1", party: "b", to: "a", purpose: "request", frame: "f1" },
        { hellos: ["b>a#0"] },
      ),
      deliverHello("b>a#0", { hellos: ["a>b#0"] }),
      sealStep(
        { seal: "s2", party: "a", to: "b", purpose: "reply", frame: "f2" },
        { sealed: [sealed("s2", 0)] },
      ),
      deliverHello("a>b#0", { sealed: [sealed("s1", 0)] }),
      data("s2", 0, "b", { from: "a", frame: "f2" }),
      data("s1", 0, "a", { from: "b", frame: "f1" }),
    ],
  },
  {
    name: "a_hello_beside_a_confirmed_channel_only_makes_a_candidate_and_a_frame_under_it_replaces_the_channel",
    handshakes: ["a>b#0", "b>a#0", "b>a#1", "a>b#1"],
    steps: [
      ...openedChannel(),
      sealStep(
        { seal: "s3", party: "b", to: "a", purpose: "reply", frame: "f3" },
        { sealed: [sealed("s3", 1)] },
      ),
      sealStep(
        { seal: "s4", party: "b", to: "a", purpose: "reply", frame: "f4" },
        { sealed: [sealed("s4", 2)] },
      ),
      { op: "forget", party: "b", peer: "a", expect: NOTHING },
      sealStep(
        { seal: "s5", party: "b", to: "a", purpose: "request", frame: "f5" },
        { hellos: ["b>a#1"] },
      ),
      deliverHello("b>a#1", { hellos: ["a>b#1"] }),
      sealStep(
        { seal: "s6", party: "a", to: "b", purpose: "reply", frame: "f6" },
        { sealed: [sealed("s6", 1)] },
      ),
      deliverHello("a>b#1", { sealed: [sealed("s5", 0)] }),
      data("s5", 0, "a", { from: "b", frame: "f5" }),
      data("s3", 0, "a", { from: "b", frame: "f3" }),
      advance(HANDSHAKE_WINDOW_MS),
      data("s4", 0, "a", null),
      sealStep(
        { seal: "s7", party: "a", to: "b", purpose: "reply", frame: "f7" },
        { sealed: [sealed("s7", 0)] },
      ),
    ],
  },
  {
    name: "a_hello_that_repeats_a_key_already_held_is_dropped_and_answered_by_nothing",
    handshakes: ["a>b#0", "b>a#0"],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      deliverHello("a>b#0", { hellos: ["b>a#0"] }),
      deliverHello("a>b#0", {}),
      deliverHello("b>a#0", { sealed: [sealed("s1", 0)] }),
      deliverHello("b>a#0", {}),
      data("s1", 0, "b", { from: "a", frame: "f1" }),
      deliverHello("a>b#0", {}),
    ],
  },
  {
    name: "a_hello_that_cannot_be_used_is_dropped_before_any_key_of_this_sides_own_is_generated",
    handshakes: ["b>a#0"],
    extra: [
      { name: "valid", from: "a", to: "b" },
      { name: "bad_signature", from: "a", to: "b", defect: "bad_signature" },
      {
        name: "unusable_key",
        from: "a",
        to: "b",
        defect: "unusable_ephemeral_key",
      },
      { name: "wrong_recipient", from: "a", to: "c" },
    ],
    steps: [
      extraHello("valid", "b", "c", {}),
      extraHello("valid", "b", "none", {}),
      extraHello("bad_signature", "b", "sender", {}),
      extraHello("unusable_key", "b", "sender", {}),
      extraHello("wrong_recipient", "b", "sender", {}),
      extraHello("valid", "b", "sender", { hellos: ["b>a#0"] }),
    ],
  },
  {
    name: "a_third_hello_beyond_the_candidates_a_handshake_may_build_is_dropped",
    handshakes: ["a>b#0"],
    extra: [
      { name: "first", from: "b", to: "a" },
      { name: "second", from: "b", to: "a" },
      { name: "third", from: "b", to: "a" },
    ],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      extraHello("first", "a", "sender", { sealed: [sealed("s1", 0)] }),
      extraHello("second", "a", "sender", {}),
      extraHello("third", "a", "sender", {}),
      sealStep(
        { seal: "s2", party: "a", to: "b", purpose: "request", frame: "f2" },
        { sealed: [sealed("s2", 1, 0)] },
      ),
    ],
  },
  {
    name: "an_older_hello_replayed_to_a_side_with_a_channel_is_answered_once_per_handshake_window",
    handshakes: ["a>b#0", "b>a#0", "a>b#1", "a>b#2"],
    extra: [{ name: "older", from: "b", to: "a" }],
    steps: [
      ...openedChannel(),
      extraHello("older", "a", "sender", { hellos: ["a>b#1"] }),
      extraHello("older", "a", "sender", {}),
      advance(HANDSHAKE_WINDOW_MS - 1),
      extraHello("older", "a", "sender", {}),
      advance(1),
      extraHello("older", "a", "sender", { hellos: ["a>b#2"] }),
    ],
  },
  {
    name: "a_frame_that_arrives_before_its_hello_is_dropped_and_the_resent_one_opens",
    handshakes: ["a>b#0", "b>a#0"],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      deliverHello("a>b#0", { hellos: ["b>a#0"] }),
      sealStep(
        { seal: "s2", party: "b", to: "a", purpose: "reply", frame: "f2" },
        { sealed: [sealed("s2", 0)] },
      ),
      data("s2", 0, "a", null),
      deliverHello("b>a#0", { sealed: [sealed("s1", 0)] }),
      data("s2", 0, "a", { from: "b", frame: "f2" }),
    ],
  },
  {
    name: "forgetting_a_peer_drops_a_handshake_with_no_candidate_and_keeps_one_that_has_a_candidate",
    handshakes: ["a>b#0", "a>b#1"],
    extra: [{ name: "answer", from: "b", to: "a" }],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      {
        op: "forget",
        party: "a",
        peer: "b",
        expect: expecting({ failed: [{ seal: "s1", kind: "abandoned" }] }),
      },
      sealStep(
        { seal: "s2", party: "a", to: "b", purpose: "request", frame: "f2" },
        { hellos: ["a>b#1"] },
      ),
      extraHello("answer", "a", "sender", { sealed: [sealed("s2", 0)] }),
      { op: "forget", party: "a", peer: "b", expect: NOTHING },
      sealStep(
        { seal: "s3", party: "a", to: "b", purpose: "request", frame: "f3" },
        { sealed: [sealed("s3", 1)] },
      ),
    ],
  },
  {
    name: "a_reset_abandons_every_seal_still_waiting_and_the_next_send_starts_afresh",
    handshakes: ["a>b#0", "a>b#1"],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      {
        op: "reset",
        party: "a",
        expect: expecting({ failed: [{ seal: "s1", kind: "abandoned" }] }),
      },
      sealStep(
        { seal: "s2", party: "a", to: "b", purpose: "request", frame: "f2" },
        { hellos: ["a>b#1"] },
      ),
    ],
  },
  {
    name: "a_hello_whose_answer_cannot_be_sent_is_reported_once_per_interval_and_the_next_report_counts_the_rest",
    handshakes: ["a>b#0", "a>b#1", "a>b#2", "a>b#3"],
    extra: [{ name: "request", from: "b", to: "a" }],
    steps: [
      {
        op: "fail",
        party: "a",
        what: "send",
        enabled: true,
        expect: NOTHING,
      },
      extraHello("request", "a", "sender", {
        faults: [{ peer: "b", suppressed: 0 }],
      }),
      extraHello("request", "a", "sender", {}),
      advance(FAULT_INTERVAL_MS),
      extraHello("request", "a", "sender", {
        faults: [{ peer: "b", suppressed: 1 }],
      }),
      {
        op: "fail",
        party: "a",
        what: "send",
        enabled: false,
        expect: NOTHING,
      },
      extraHello("request", "a", "sender", { hellos: ["a>b#3"] }),
    ],
  },
  {
    name: "a_hello_whose_answer_cannot_be_signed_is_reported_and_leaves_no_handshake",
    handshakes: ["a>b#0"],
    extra: [{ name: "request", from: "b", to: "a" }],
    steps: [
      {
        op: "fail",
        party: "a",
        what: "sign",
        enabled: true,
        expect: NOTHING,
      },
      extraHello("request", "a", "sender", {
        faults: [{ peer: "b", suppressed: 0 }],
      }),
      {
        op: "fail",
        party: "a",
        what: "sign",
        enabled: false,
        expect: NOTHING,
      },
      extraHello("request", "a", "sender", { hellos: ["a>b#0"] }),
    ],
  },
  {
    name: "a_hello_whose_answer_cannot_be_sent_beside_a_confirmed_channel_leaves_the_channel_in_place",
    handshakes: ["a>b#0", "b>a#0", "a>b#1"],
    extra: [{ name: "older", from: "b", to: "a" }],
    steps: [
      ...openedChannel(),
      {
        op: "fail",
        party: "a",
        what: "send",
        enabled: true,
        expect: NOTHING,
      },
      extraHello("older", "a", "sender", {
        faults: [{ peer: "b", suppressed: 0 }],
      }),
      sealStep(
        { seal: "s3", party: "a", to: "b", purpose: "reply", frame: "f3" },
        { sealed: [sealed("s3", 1)] },
      ),
    ],
  },
  {
    name: "a_handshake_nobody_answers_ends_with_its_window_and_a_later_hello_is_answered_afresh",
    handshakes: ["a>b#0", "a>b#1"],
    extra: [{ name: "answer", from: "b", to: "a" }],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      advance(HANDSHAKE_WINDOW_MS),
      extraHello("answer", "a", "sender", {
        hellos: ["a>b#1"],
        sealed: [sealed("s1", 0)],
      }),
    ],
  },
  {
    name: "one_candidate_nothing_confirms_becomes_the_current_channel_when_the_window_passes",
    handshakes: ["a>b#0", "b>a#0", "a>b#1"],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      deliverHello("a>b#0", { hellos: ["b>a#0"] }),
      deliverHello("b>a#0", { sealed: [sealed("s1", 0)] }),
      advance(HANDSHAKE_WINDOW_MS),
      sealStep(
        { seal: "s2", party: "a", to: "b", purpose: "request", frame: "f2" },
        { sealed: [sealed("s2", 1)] },
      ),
      // The candidate is the current channel now and has no candidate beside it, so a lost pairing forgets it and the next request starts afresh.
      { op: "forget", party: "a", peer: "b", expect: NOTHING },
      sealStep(
        { seal: "s3", party: "a", to: "b", purpose: "request", frame: "f3" },
        { hellos: ["a>b#1"] },
      ),
    ],
  },
  {
    name: "two_candidates_nothing_confirms_serve_as_the_channel_together_until_a_frame_opens_under_one",
    handshakes: ["a>b#0", "b>a#0", "b>a#1"],
    steps: [
      sealStep(
        { seal: "s1", party: "a", to: "b", purpose: "request", frame: "f1" },
        { hellos: ["a>b#0"] },
      ),
      sealStep(
        { seal: "s2", party: "b", to: "a", purpose: "request", frame: "f2" },
        { hellos: ["b>a#0"] },
      ),
      {
        op: "forget",
        party: "b",
        peer: "a",
        expect: expecting({ failed: [{ seal: "s2", kind: "abandoned" }] }),
      },
      sealStep(
        { seal: "s3", party: "b", to: "a", purpose: "request", frame: "f3" },
        { hellos: ["b>a#1"] },
      ),
      deliverHello("b>a#0", { sealed: [sealed("s1", 0)] }),
      deliverHello("b>a#1", {}),
      deliverHello("a>b#0", { sealed: [sealed("s3", 0)] }),
      advance(HANDSHAKE_WINDOW_MS),
      // Two candidates and no channel: a frame is sealed under each, in the order the candidates were built.
      sealStep(
        { seal: "s4", party: "a", to: "b", purpose: "request", frame: "f4" },
        { sealed: [sealed("s4", 1, 0)] },
      ),
      // A lost pairing keeps candidates the peer may still confirm, so the frame below still opens.
      { op: "forget", party: "a", peer: "b", expect: NOTHING },
      data("s3", 0, "a", { from: "b", frame: "f3" }),
      // The one that opened is the channel now and the other is gone.
      sealStep(
        { seal: "s5", party: "a", to: "b", purpose: "request", frame: "f5" },
        { sealed: [sealed("s5", 1)] },
      ),
      data("s4", 0, "b", null),
      data("s4", 1, "b", { from: "a", frame: "f4" }),
    ],
  },
];

const FRAME_NAMES = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"] as const;

function isParty(name: string | undefined): name is Party {
  return name === "a" || name === "b";
}

/** The sender and the recipient a handshake name `a>b#0` spells. */
function parseHandshake(name: string): { party: Party; target: Party } {
  const match = /^(?<from>[ab])>(?<to>[ab])#\d+$/u.exec(name);
  const from = match?.groups?.from;
  const to = match?.groups?.to;
  if (!isParty(from) || !isParty(to)) {
    throw new Error(`${name} is not a handshake name`);
  }

  return { party: from, target: to };
}

function ephemeralPublic(secret: Buffer): Buffer {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(secret);

  return ecdh.getPublicKey();
}

function offCurvePoint(): Buffer {
  return Buffer.concat([
    Buffer.from([UNCOMPRESSED_TAG]),
    Buffer.alloc(SCALAR_BYTES, POINT_FILL_X),
    Buffer.alloc(SCALAR_BYTES, POINT_FILL_Y),
  ]);
}

function device(name: Party | "c"): Buffer {
  return identityNamed(name).deviceId;
}

function expectJson(expect: Readonly<Expect>): JsonWire {
  return {
    hellos: [...expect.hellos],
    sealed: expect.sealed.map((entry) => ({
      seal: entry.seal,
      counters: [...entry.counters],
    })),
    failed: expect.failed.map((entry) => ({ ...entry })),
    opened: expect.opened === null ? null : { ...expect.opened },
    faults: expect.faults.map((entry) => ({ ...entry })),
  };
}

/** The hellos of one scenario as vectors, and the JSON that describes the scenario. */
function scenarioJson(
  scenario: Scenario,
  take: () => number,
  collect: (vector: Vector) => void,
): JsonWire {
  const built = (
    name: string,
    made: Hello,
    defect?: ExtraHello["defect"],
  ): string => {
    const vector = `relay:${scenario.name}:${name}`;
    const message = helloMessage(made, {
      ...(defect === "bad_signature"
        ? { signature: flipLastByte(made.signature) }
        : {}),
    });
    collect({ name: vector, message, wire_hex: wireHex(message) });

    return vector;
  };
  const handshakes = scenario.handshakes.map((name): JsonWire => {
    const { party, target } = parseHandshake(name);
    const fill = take();
    const secret = Buffer.alloc(SCALAR_BYTES, fill);
    const nonce = Buffer.alloc(NONCE_BYTES, fill);
    const made = makeHello({
      name,
      from: identityNamed(party),
      to: device(target),
      ephemeralPublic: ephemeralPublic(secret),
      nonce,
    });

    return {
      name,
      party,
      to: target,
      ephemeral_secret_hex: secret.toString("hex"),
      ephemeral_public_hex: made.ephemeralPublic.toString("hex"),
      nonce_hex: nonce.toString("hex"),
      hello_vector: built(name, made),
    };
  });
  const extra = (scenario.extra ?? []).map((entry): JsonWire => {
    const fill = take();
    const secret = Buffer.alloc(SCALAR_BYTES, fill);
    const nonce = Buffer.alloc(NONCE_BYTES, fill);
    const key =
      entry.defect === "unusable_ephemeral_key"
        ? offCurvePoint()
        : ephemeralPublic(secret);
    const made = makeHello({
      name: entry.name,
      from: identityNamed(entry.from),
      to: device(entry.to),
      ephemeralPublic: key,
      nonce,
    });

    return {
      name: entry.name,
      from: entry.from,
      to: entry.to,
      hello_vector: built(entry.name, made, entry.defect),
    };
  });

  return {
    name: scenario.name,
    handshakes,
    extra_hellos: extra,
    steps: scenario.steps.map((step): JsonWire => ({
      ...step,
      expect: expectJson(step.expect),
    })),
  };
}

/** The `handshake_scenarios` section, and the hello vectors its scenarios deliver. */
export function relayScenarios(): { vectors: Vector[]; section: JsonWire } {
  const vectors: Vector[] = [];
  let nextFill = FIRST_FILL;
  const take = (): number => {
    const fill = nextFill;
    nextFill += 1;
    if (fill > LAST_FILL) {
      throw new Error("more ephemeral keys than distinct fills");
    }

    return fill;
  };
  const frames: Record<string, JsonWire> = {};
  const peer = hex(device("c").toString("hex"));
  for (const [index, name] of FRAME_NAMES.entries()) {
    frames[name] = wireHex({
      type: "data-have",
      peer,
      "head-seq": index + 1,
    });
  }
  const scenarios = SCENARIOS.map((scenario) =>
    scenarioJson(scenario, take, (vector) => {
      vectors.push(vector);
    }),
  );
  const identities = ["a", "b", "c"].map((name): JsonWire => {
    const identity = identityNamed(name);

    return {
      name,
      alg: identity.alg,
      secret_hex: identity.secretHex,
      public_key_hex: identity.publicKey.toString("hex"),
      device_id_hex: identity.deviceId.toString("hex"),
    };
  });

  return {
    vectors,
    section: {
      layout_version: RELAY_SCENARIO_LAYOUT_VERSION,
      identities,
      frames,
      scenarios,
      counts: { scenarios: SCENARIOS.length },
    },
  };
}
