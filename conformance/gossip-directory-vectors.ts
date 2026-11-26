/* gossip-directory.v1.json: what a session does with the gossip it receives and sends.

   The top-level vectors are the gossip frames the scenarios deliver, round-tripped like any other file. The `gossip_directory` section holds three lists, written by hand from the rules of the TypeScript session and never produced by an implementation: `extension_validation` (the key bags a gossip update may carry, each accepted or refused for one named reason), `directory_scenarios` (frames delivered to a session in order, each step recording what became of every advert and the directory afterwards, as the devices and snapshot times it holds in first-heard order) and `self_adverts` (the structure of the advert a session sends: its device, addresses, time, the extension keys and the topology, which a consumer checks and whose signature it verifies).

   The adverts are signed with Ed25519 keys from fixed seeds, so every advert is the same bytes in every run. A scenario flagged `rust_only` pins a rule only the Rust session applies (it bounds what a hub can make it hold), and the TypeScript runner skips it. */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import { advertSigningInput, wireHex } from "./adverts.ts";

export const GOSSIP_DIRECTORY_LAYOUT_VERSION = 1;

const EDDSA = -8;
const SEED_BYTES = 32;
const PKCS8_ED25519_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex",
);
/** The largest an encoded gossip frame carrying one advert may be for the Rust directory to admit it. */
const BYTES_PER_KIB = 1024;
const ADVERT_CAP_KIB = 16;
const MAX_ADVERT_BYTES = ADVERT_CAP_KIB * BYTES_PER_KIB;
/** The snapshot times the scenarios use: a first advert, a later one and one between them. */
const FIRST = 10;
const BETWEEN = 15;
const LATER = 20;
const LOW_BYTE_MASK = 0xff;
/** The clock the self-advert cases read, in whole seconds. */
const CLOCK_SECONDS = 1_700_000_000;
const LARGEST_EXACT = Number.MAX_SAFE_INTEGER;

interface Identity {
  name: string;
  secretHex: string;
  publicKey: Buffer;
  deviceHex: string;
  sign: (input: Buffer) => Buffer;
}

function identity(name: string, seedFill: string): Identity {
  const secretHex = seedFill.repeat(SEED_BYTES);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(secretHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  if (typeof jwk.x !== "string") {
    throw new Error("the Ed25519 public key has no x coordinate");
  }
  const publicKey = Buffer.from(jwk.x, "base64url");

  return {
    name,
    secretHex,
    publicKey,
    deviceHex: createHash("sha256").update(publicKey).digest("hex"),
    sign: (input) => sign(null, input, privateKey),
  };
}

const ME = identity("me", "d4");
const A = identity("a", "a1");
const B = identity("b", "b2");
const C = identity("c", "c3");
const IDENTITIES = [ME, A, B, C];

interface Forgery {
  signer?: Identity;
  naming?: Identity;
  flipSignature?: boolean;
}

/** An advert of `who` carrying `extensions` in its open tail, signed by `who`; `forgery` has it name or be signed by another identity, or have its signature spoilt after signing. */
function forged(
  who: Identity,
  seconds: number,
  extensions: Readonly<Record<string, JsonWire>>,
  forgery: Readonly<Forgery>,
): Record<string, JsonWire> {
  const naming = forgery.naming ?? who;
  const content: Record<string, JsonWire> = {
    ...extensions,
    device: hex(naming.deviceHex),
    addresses: [],
    "snapshot-seconds": seconds,
    "identity-key": {
      alg: EDDSA,
      "public-key": hex(who.publicKey.toString("hex")),
    },
  };
  const signature = (forgery.signer ?? who).sign(advertSigningInput(content));
  if (forgery.flipSignature === true) {
    signature[0] = (signature[0] ?? 0) ^ LOW_BYTE_MASK;
  }

  return { ...content, signature: hex(signature.toString("hex")) };
}

function advert(
  who: Identity,
  seconds: number,
  extensions: Readonly<Record<string, JsonWire>>,
): Record<string, JsonWire> {
  return forged(who, seconds, extensions, {});
}

function gossip(...peers: readonly Record<string, JsonWire>[]): JsonWire {
  return { type: "gossip", peers: [...peers] };
}

interface Step {
  frame: JsonWire;
  outcomes: string[];
  directory: { device: string; snapshot_seconds: number }[];
}

interface Scenario {
  name: string;
  rustOnly: boolean;
  steps: Step[];
}

function entry(who: Identity, seconds: number): Step["directory"][number] {
  return { device: who.deviceHex, snapshot_seconds: seconds };
}

/** An advert of `who` padded with one extension so its encoded gossip frame is exactly `bytes` long. */
function paddedTo(
  who: Identity,
  seconds: number,
  bytes: number,
): Record<string, JsonWire> {
  const lengthOf = (text: number): number =>
    wireHex(gossip(advert(who, seconds, { "pad/x": "x".repeat(text) })))
      .length / 2;
  let low = 0;
  let high = bytes;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lengthOf(middle) < bytes) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (lengthOf(low) !== bytes) {
    throw new Error(
      `no padding gives an advert frame of ${String(bytes)} bytes`,
    );
  }

  return advert(who, seconds, { "pad/x": "x".repeat(low) });
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "adverts_enter_in_first_heard_order_and_a_newer_one_replaces_in_place",
    rustOnly: false,
    steps: [
      {
        frame: gossip(advert(A, FIRST, {})),
        outcomes: ["admitted"],
        directory: [entry(A, FIRST)],
      },
      {
        frame: gossip(advert(B, FIRST, {})),
        outcomes: ["admitted"],
        directory: [entry(A, FIRST), entry(B, FIRST)],
      },
      {
        frame: gossip(advert(A, LATER, { "presence/status": "busy" })),
        outcomes: ["admitted"],
        directory: [entry(A, LATER), entry(B, FIRST)],
      },
    ],
  },
  {
    name: "an_older_advert_a_hub_replays_does_not_displace_a_newer_one_and_one_of_the_same_time_replaces",
    rustOnly: false,
    steps: [
      {
        frame: gossip(advert(A, LATER, { "presence/status": "new" })),
        outcomes: ["admitted"],
        directory: [entry(A, LATER)],
      },
      {
        frame: gossip(advert(A, BETWEEN, { "presence/status": "old" })),
        outcomes: ["older"],
        directory: [entry(A, LATER)],
      },
      {
        frame: gossip(advert(A, LATER, { "presence/status": "same" })),
        outcomes: ["admitted"],
        directory: [entry(A, LATER)],
      },
    ],
  },
  {
    name: "an_advert_that_does_not_verify_is_dropped_alone_and_the_rest_of_its_frame_is_admitted",
    rustOnly: false,
    steps: [
      {
        frame: gossip(
          forged(B, FIRST, {}, { naming: C }),
          advert(A, FIRST, {}),
          forged(C, FIRST, {}, { flipSignature: true }),
        ),
        outcomes: ["wrong_device", "admitted", "bad_signature"],
        directory: [entry(A, FIRST)],
      },
    ],
  },
  {
    name: "an_advert_older_than_the_one_held_is_ignored_whether_or_not_it_is_genuine_and_a_newer_forged_one_is_dropped",
    rustOnly: false,
    steps: [
      {
        frame: gossip(advert(A, LATER, {})),
        outcomes: ["admitted"],
        directory: [entry(A, LATER)],
      },
      {
        frame: gossip(forged(A, BETWEEN, {}, { flipSignature: true })),
        outcomes: ["older"],
        directory: [entry(A, LATER)],
      },
      {
        frame: gossip(forged(A, LATER + 1, {}, { flipSignature: true })),
        outcomes: ["bad_signature"],
        directory: [entry(A, LATER)],
      },
    ],
  },
  {
    name: "an_advert_signed_by_another_key_than_its_own_is_dropped",
    rustOnly: false,
    steps: [
      {
        frame: gossip(forged(A, FIRST, {}, { signer: B })),
        outcomes: ["bad_signature"],
        directory: [],
      },
    ],
  },
  {
    name: "an_advert_exactly_at_the_size_cap_is_admitted",
    rustOnly: false,
    steps: [
      {
        frame: gossip(paddedTo(A, FIRST, MAX_ADVERT_BYTES)),
        outcomes: ["admitted"],
        directory: [entry(A, FIRST)],
      },
    ],
  },
  {
    name: "an_advert_one_byte_over_the_size_cap_is_refused",
    rustOnly: true,
    steps: [
      {
        frame: gossip(paddedTo(A, FIRST, MAX_ADVERT_BYTES + 1)),
        outcomes: ["too_large"],
        directory: [],
      },
    ],
  },
  {
    name: "a_snapshot_time_at_the_largest_exact_integer_is_admitted",
    rustOnly: false,
    steps: [
      {
        frame: gossip(advert(A, LARGEST_EXACT, {})),
        outcomes: ["admitted"],
        directory: [entry(A, LARGEST_EXACT)],
      },
    ],
  },
];

interface ExtensionCase {
  name: string;
  keys: string[];
  /** The first key refused and why, or null when the bag is accepted. */
  refused: { key: string; reason: string } | null;
}

const EXTENSION_CASES: readonly ExtensionCase[] = [
  { name: "an_empty_bag", keys: [], refused: null },
  { name: "a_domain_qualified_key", keys: ["presence/status"], refused: null },
  {
    name: "digits_and_hyphens_after_the_first_letter",
    keys: ["app-1/x-y2"],
    refused: null,
  },
  {
    name: "a_key_that_only_contains_a_reserved_name",
    keys: ["device/status", "wire-mesh/versions"],
    refused: null,
  },
  ...[
    "device",
    "addresses",
    "snapshot-seconds",
    "identity-key",
    "signature",
  ].map((key): ExtensionCase => ({
    name: `the_mandatory_field_${key.replaceAll("-", "_")}`,
    keys: [key],
    refused: { key, reason: "reserved_field" },
  })),
  {
    name: "the_topology_the_session_computes",
    keys: ["topology/peers"],
    refused: { key: "topology/peers", reason: "session_managed" },
  },
  {
    name: "the_version_this_crate_reports",
    keys: ["wire-mesh/version"],
    refused: { key: "wire-mesh/version", reason: "reserved_version" },
  },
  {
    name: "a_key_with_no_domain",
    keys: ["status"],
    refused: { key: "status", reason: "not_domain_qualified" },
  },
  {
    name: "an_uppercase_domain",
    keys: ["Presence/status"],
    refused: { key: "Presence/status", reason: "not_domain_qualified" },
  },
  {
    name: "an_uppercase_field",
    keys: ["presence/Status"],
    refused: { key: "presence/Status", reason: "not_domain_qualified" },
  },
  {
    name: "three_segments",
    keys: ["a/b/c"],
    refused: { key: "a/b/c", reason: "not_domain_qualified" },
  },
  {
    name: "a_leading_digit",
    keys: ["1a/b"],
    refused: { key: "1a/b", reason: "not_domain_qualified" },
  },
  {
    name: "an_underscore",
    keys: ["a_b/c"],
    refused: { key: "a_b/c", reason: "not_domain_qualified" },
  },
  {
    name: "an_empty_domain",
    keys: ["/x"],
    refused: { key: "/x", reason: "not_domain_qualified" },
  },
  {
    name: "an_empty_field",
    keys: ["x/"],
    refused: { key: "x/", reason: "not_domain_qualified" },
  },
  {
    name: "the_first_bad_key_is_the_one_named",
    keys: ["presence/status", "device", "status"],
    refused: { key: "device", reason: "reserved_field" },
  },
];

interface SelfAdvertCase {
  name: string;
  /** The extension a gossip update carried, or none. */
  extensions: Record<string, string>;
  /** The time the session's clock read, in whole seconds. */
  now_seconds: number;
}

const SELF_ADVERTS: readonly SelfAdvertCase[] = [
  {
    name: "a_session_with_no_extensions",
    extensions: {},
    now_seconds: CLOCK_SECONDS,
  },
  {
    name: "a_gossip_update_with_an_extension",
    extensions: { "presence/status": "idle" },
    now_seconds: CLOCK_SECONDS,
  },
];

export function gossipDirectoryFile(): {
  vectors: Vector[];
  extra: Record<string, JsonWire>;
} {
  const vectors: Vector[] = [];
  const scenarios = SCENARIOS.map((scenario): JsonWire => ({
    name: scenario.name,
    rust_only: scenario.rustOnly,
    steps: scenario.steps.map((step, index): JsonWire => {
      const name = `gossip_${scenario.name}_${String(index)}`;
      vectors.push({
        name,
        message: step.frame,
        wire_hex: wireHex(step.frame),
      });

      return {
        vector: name,
        outcomes: step.outcomes,
        directory: step.directory.map((held) => ({ ...held })),
      };
    }),
  }));

  return {
    vectors,
    extra: {
      gossip_directory: {
        layout_version: GOSSIP_DIRECTORY_LAYOUT_VERSION,
        identities: IDENTITIES.map((who): JsonWire => ({
          name: who.name,
          secret_hex: who.secretHex,
          public_key_hex: who.publicKey.toString("hex"),
          device_id_hex: who.deviceHex,
        })),
        extension_validation: EXTENSION_CASES.map((held): JsonWire => ({
          name: held.name,
          keys: held.keys,
          refused: held.refused === null ? null : { ...held.refused },
        })),
        directory_scenarios: scenarios,
        self_adverts: SELF_ADVERTS.map((held): JsonWire => ({
          name: held.name,
          identity: ME.name,
          extensions: { ...held.extensions },
          now_seconds: held.now_seconds,
          expected: {
            device_hex: ME.deviceHex,
            addresses: [],
            snapshot_seconds: held.now_seconds,
            extension_keys: [
              ...Object.keys(held.extensions),
              "topology/peers",
              "wire-mesh/version",
            ].sort(),
            topology: { direct: [], relayed: [] },
          },
        })),
        counts: {
          extension_validation: EXTENSION_CASES.length,
          directory_scenarios: SCENARIOS.length,
          self_adverts: SELF_ADVERTS.length,
        },
      },
    },
  };
}
