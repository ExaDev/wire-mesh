/* coordinator-election.v1.json: the claims of the gossiped coordinator election (`coordinator-frame` in spec/transport.cddl) and the outcome of each step of a sequence of them.

   The frames round-trip like any other vector. The `coordinator_election` section holds scenarios: each starts a side that has made and heard no claim, and every step (evaluating a frame heard, making a claim of its own, re-announcing the incumbent) records what it must return and the state after it. The outcomes are written by hand from the rules in spec/transport.cddl and spec/transport.md, never produced by an implementation: a strictly higher term wins, an equal term goes to the lowest device-id, a lower term loses, and a term with no integer above it that is exactly represented (2^53 - 1 and over) is dropped unevaluated. Device-ids here are structural bytes (every byte the same), not hashes of keys. */

import { cdeEncodeOptions, encode } from "cbor2";
import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import { wireHex } from "./secure-channel-crypto.ts";

export const ELECTION_LAYOUT_VERSION = 1;

const DEVICE_ID_BYTES = 32;
const ONE = 1;
/** The largest unsigned 64-bit integer, as text because it is beyond a number. */
const UINT64_MAX_TEXT = "18446744073709551615";
/** Number.MAX_SAFE_INTEGER: the first term that cannot be superseded. */
const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;
const CAPACITY_HINT = 64;
const SMALL_HINT = 9;

const DEVICES = { low: "01", mid: "02", high: "03" } as const;
type DeviceName = keyof typeof DEVICES;

function deviceHex(name: DeviceName): string {
  return DEVICES[name].repeat(DEVICE_ID_BYTES);
}

interface Claim {
  term: number;
  device: DeviceName;
  hint?: number;
}

function claimJson(claim: Claim | null): JsonWire {
  return claim === null
    ? null
    : {
        term: claim.term,
        coordinator_hex: deviceHex(claim.device),
        capacity_hint: claim.hint ?? null,
      };
}

/** A step and what it must return. */
type Step =
  | { evaluate: Claim; accepts: Claim }
  | { evaluate: Claim; retains: Claim }
  | { evaluate: Claim; rejects: true }
  | { claim: { hint?: number }; makes: Claim }
  | { claim: { hint?: number }; refuses: true }
  | { announce: true; gives: Claim | null };

interface Scenario {
  name: string;
  own: DeviceName;
  steps: readonly (Step & { then: Claim | null })[];
}

const scenarios: readonly Scenario[] = [
  {
    name: "a_first_claim_is_term_zero",
    own: "mid",
    steps: [
      {
        claim: {},
        makes: { term: 0, device: "mid" },
        then: { term: 0, device: "mid" },
      },
    ],
  },
  {
    name: "a_second_claim_raises_the_term",
    own: "mid",
    steps: [
      {
        claim: {},
        makes: { term: 0, device: "mid" },
        then: { term: 0, device: "mid" },
      },
      {
        claim: { hint: CAPACITY_HINT },
        makes: { term: 1, device: "mid", hint: CAPACITY_HINT },
        then: { term: 1, device: "mid", hint: CAPACITY_HINT },
      },
    ],
  },
  {
    name: "announcing_the_incumbent_keeps_its_term",
    own: "mid",
    steps: [
      { announce: true, gives: null, then: null },
      {
        claim: { hint: SMALL_HINT },
        makes: { term: 0, device: "mid", hint: SMALL_HINT },
        then: { term: 0, device: "mid", hint: SMALL_HINT },
      },
      {
        announce: true,
        gives: { term: 0, device: "mid", hint: SMALL_HINT },
        then: { term: 0, device: "mid", hint: SMALL_HINT },
      },
    ],
  },
  {
    name: "a_higher_term_supersedes",
    own: "mid",
    steps: [
      {
        evaluate: { term: 3, device: "high" },
        accepts: { term: 3, device: "high" },
        then: { term: 3, device: "high" },
      },
      {
        evaluate: { term: 4, device: "low" },
        accepts: { term: 4, device: "low" },
        then: { term: 4, device: "low" },
      },
    ],
  },
  {
    name: "a_lower_term_is_retained",
    own: "mid",
    steps: [
      {
        evaluate: { term: 5, device: "high" },
        accepts: { term: 5, device: "high" },
        then: { term: 5, device: "high" },
      },
      {
        evaluate: { term: 4, device: "low" },
        retains: { term: 5, device: "high" },
        then: { term: 5, device: "high" },
      },
      {
        announce: true,
        gives: { term: 5, device: "high" },
        then: { term: 5, device: "high" },
      },
    ],
  },
  {
    name: "an_equal_term_goes_to_the_lowest_device_id",
    own: "mid",
    steps: [
      {
        evaluate: { term: 2, device: "high" },
        accepts: { term: 2, device: "high" },
        then: { term: 2, device: "high" },
      },
      {
        evaluate: { term: 2, device: "low" },
        accepts: { term: 2, device: "low" },
        then: { term: 2, device: "low" },
      },
      {
        evaluate: { term: 2, device: "mid" },
        retains: { term: 2, device: "low" },
        then: { term: 2, device: "low" },
      },
      {
        evaluate: { term: 2, device: "low" },
        retains: { term: 2, device: "low" },
        then: { term: 2, device: "low" },
      },
    ],
  },
  {
    name: "a_repeated_claim_keeps_the_incumbent_as_it_was",
    own: "mid",
    steps: [
      {
        evaluate: { term: 1, device: "low" },
        accepts: { term: 1, device: "low" },
        then: { term: 1, device: "low" },
      },
      {
        evaluate: { term: 1, device: "low", hint: SMALL_HINT },
        retains: { term: 1, device: "low" },
        then: { term: 1, device: "low" },
      },
    ],
  },
  {
    name: "an_accepted_claim_replaces_the_capacity_hint",
    own: "mid",
    steps: [
      {
        evaluate: { term: 1, device: "high", hint: SMALL_HINT },
        accepts: { term: 1, device: "high", hint: SMALL_HINT },
        then: { term: 1, device: "high", hint: SMALL_HINT },
      },
      {
        evaluate: { term: 2, device: "low" },
        accepts: { term: 2, device: "low" },
        then: { term: 2, device: "low" },
      },
    ],
  },
  {
    name: "a_received_claim_with_the_largest_exact_capacity_hint_is_accepted",
    own: "mid",
    steps: [
      {
        evaluate: { term: 5, device: "low", hint: MAX_EXACT_INTEGER },
        accepts: { term: 5, device: "low", hint: MAX_EXACT_INTEGER },
        then: { term: 5, device: "low", hint: MAX_EXACT_INTEGER },
      },
    ],
  },
  {
    name: "a_claim_with_the_largest_exact_capacity_hint",
    own: "mid",
    steps: [
      {
        claim: { hint: MAX_EXACT_INTEGER },
        makes: { term: 0, device: "mid", hint: MAX_EXACT_INTEGER },
        then: { term: 0, device: "mid", hint: MAX_EXACT_INTEGER },
      },
    ],
  },
  {
    name: "a_claim_after_a_higher_term_beats_it",
    own: "mid",
    steps: [
      {
        evaluate: { term: 7, device: "low" },
        accepts: { term: 7, device: "low" },
        then: { term: 7, device: "low" },
      },
      {
        claim: {},
        makes: { term: 8, device: "mid" },
        then: { term: 8, device: "mid" },
      },
    ],
  },
  {
    name: "hearing_its_own_claim_makes_the_side_the_incumbent",
    own: "mid",
    steps: [
      {
        evaluate: { term: 1, device: "mid" },
        accepts: { term: 1, device: "mid" },
        then: { term: 1, device: "mid" },
      },
    ],
  },
  {
    name: "a_term_with_no_room_above_it_is_dropped_and_never_claimed_over",
    own: "mid",
    steps: [
      {
        evaluate: { term: MAX_EXACT_INTEGER, device: "low" },
        rejects: true,
        then: null,
      },
      {
        evaluate: { term: MAX_EXACT_INTEGER - 1, device: "low" },
        accepts: { term: MAX_EXACT_INTEGER - 1, device: "low" },
        then: { term: MAX_EXACT_INTEGER - 1, device: "low" },
      },
      {
        claim: {},
        refuses: true,
        then: { term: MAX_EXACT_INTEGER - 1, device: "low" },
      },
      {
        evaluate: { term: MAX_EXACT_INTEGER, device: "high" },
        rejects: true,
        then: { term: MAX_EXACT_INTEGER - 1, device: "low" },
      },
    ],
  },
];

/** Claims both implementations refuse to make: a capacity hint above 2^53 - 1 is not an integer the TypeScript holds exactly, so no peer could read the frame. */
const REFUSED_CLAIMS: readonly {
  name: string;
  capacityHint: number;
}[] = [
  {
    name: "a_capacity_hint_beyond_the_exact_integers",
    capacityHint: MAX_EXACT_INTEGER + 1,
  },
];

/** Frames only an implementation with a Rust-sized integer can be handed: the TypeScript decoder cannot hold the capacity hint, so such a frame never reaches its election. Each is a coordinator frame as wire bytes (a hint above 2^53 - 1 has no JSON number to be written as), and an election must drop it unevaluated, whatever it holds. */
const RUST_ONLY_FRAMES: readonly {
  name: string;
  term: number;
  hint: bigint;
}[] = [
  {
    name: "a_frame_with_a_capacity_hint_one_above_the_exact_integers",
    term: 5,
    hint: BigInt(MAX_EXACT_INTEGER) + BigInt(ONE),
  },
  {
    name: "a_frame_with_the_largest_capacity_hint",
    term: 5,
    hint: BigInt(UINT64_MAX_TEXT),
  },
];

function frameWireHex(term: number, hint: bigint): string {
  return Buffer.from(
    encode(
      {
        type: "coordinator",
        term,
        coordinator: Uint8Array.from(Buffer.from(deviceHex("low"), "hex")),
        "capacity-hint": hint,
      },
      cdeEncodeOptions,
    ),
  ).toString("hex");
}

const SUPERSEDABLE_TERMS: readonly { term: number; expected: boolean }[] = [
  { term: 0, expected: true },
  { term: 1, expected: true },
  { term: MAX_EXACT_INTEGER - 2, expected: true },
  { term: MAX_EXACT_INTEGER - 1, expected: true },
  { term: MAX_EXACT_INTEGER, expected: false },
];

const DEVICE_ORDERS: readonly {
  name: string;
  a: string;
  b: string;
  expected: number;
}[] = [
  {
    name: "a_lower_first_byte_is_lower",
    a: "01".repeat(DEVICE_ID_BYTES),
    b: "02".repeat(DEVICE_ID_BYTES),
    expected: -1,
  },
  {
    name: "a_higher_first_byte_is_higher",
    a: "02".repeat(DEVICE_ID_BYTES),
    b: "01".repeat(DEVICE_ID_BYTES),
    expected: 1,
  },
  {
    name: "the_same_id_is_equal",
    a: "02".repeat(DEVICE_ID_BYTES),
    b: "02".repeat(DEVICE_ID_BYTES),
    expected: 0,
  },
  {
    name: "the_first_differing_byte_decides_even_when_a_later_byte_points_the_other_way",
    a: `01${"ff".repeat(DEVICE_ID_BYTES - 1)}`,
    b: `02${"00".repeat(DEVICE_ID_BYTES - 1)}`,
    expected: -1,
  },
  {
    name: "a_difference_only_in_the_last_byte_decides",
    a: `${"00".repeat(DEVICE_ID_BYTES - 1)}01`,
    b: `${"00".repeat(DEVICE_ID_BYTES - 1)}02`,
    expected: -1,
  },
];

export function coordinatorElectionFile(): {
  vectors: Vector[];
  extra: Record<string, JsonWire>;
} {
  const vectors: Vector[] = [];
  const named = new Set<string>();

  /** Registers the frame of a claim as a vector, once, and returns its name. */
  function frame(claim: Claim): string {
    const name = `coordinator_t${String(claim.term)}_${claim.device}${
      claim.hint === undefined ? "" : `_hint${String(claim.hint)}`
    }`;
    if (!named.has(name)) {
      named.add(name);
      const message: JsonWire = {
        type: "coordinator",
        term: claim.term,
        coordinator: hex(deviceHex(claim.device)),
        ...(claim.hint === undefined ? {} : { "capacity-hint": claim.hint }),
      };
      vectors.push({ name, message, wire_hex: wireHex(message) });
    }

    return name;
  }

  const scenarioJson = scenarios.map((scenario): JsonWire => ({
    name: scenario.name,
    own_device_hex: deviceHex(scenario.own),
    steps: scenario.steps.map((step): JsonWire => {
      const state: JsonWire = {
        current: claimJson(step.then),
        is_self: step.then?.device === scenario.own,
      };
      if ("evaluate" in step) {
        const input = frame(step.evaluate);
        if ("rejects" in step) {
          return {
            op: "evaluate",
            frame: input,
            expected: { outcome: "rejected", incumbent: null },
            state,
          };
        }
        const accepted = "accepts" in step;
        const incumbent = "accepts" in step ? step.accepts : step.retains;

        return {
          op: "evaluate",
          frame: input,
          expected: {
            outcome: accepted ? "accepted" : "retained",
            incumbent: claimJson(incumbent),
          },
          state,
        };
      }
      if ("claim" in step) {
        return {
          op: "claim",
          capacity_hint: step.claim.hint ?? null,
          expected:
            "makes" in step
              ? { frame: frame(step.makes), refused: false }
              : { frame: null, refused: true },
          state,
        };
      }

      return {
        op: "announce_current",
        expected: { frame: step.gives === null ? null : frame(step.gives) },
        state,
      };
    }),
  }));

  return {
    vectors,
    extra: {
      coordinator_election: {
        layout_version: ELECTION_LAYOUT_VERSION,
        scenarios: scenarioJson,
        refused_claims: REFUSED_CLAIMS.map((entry) => ({
          name: entry.name,
          own_device_hex: deviceHex("mid"),
          capacity_hint: entry.capacityHint,
        })),
        rust_only_frames: RUST_ONLY_FRAMES.map((entry) => ({
          name: entry.name,
          own_device_hex: deviceHex("mid"),
          frame_wire_hex: frameWireHex(entry.term, entry.hint),
          expected: "rejected",
        })),
        supersedable_terms: SUPERSEDABLE_TERMS.map((entry) => ({
          term: entry.term,
          expected: entry.expected,
        })),
        device_orders: DEVICE_ORDERS.map((entry) => ({
          name: entry.name,
          a_hex: entry.a,
          b_hex: entry.b,
          expected: entry.expected,
        })),
        counts: {
          scenarios: scenarios.length,
          refused_claims: REFUSED_CLAIMS.length,
          rust_only_frames: RUST_ONLY_FRAMES.length,
          supersedable_terms: SUPERSEDABLE_TERMS.length,
          device_orders: DEVICE_ORDERS.length,
        },
      },
    },
  };
}
