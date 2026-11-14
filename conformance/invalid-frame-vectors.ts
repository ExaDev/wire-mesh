/* invalid-frames.v1.json: values that break a `.regexp` pattern of the spec, which matches the whole string. Every vector is well-formed CBOR in the shape of a valid frame (or of valid token claims) with exactly one string value outside the grammar, and a conformant decoder refuses it, at decoding or at validation: no consumer may produce a frame or claims from one.

   Each vector carries `valid_control_wire_hex`, the same bytes with a value inside the grammar, which every consumer must accept: a vector that is refused for any other reason than the pattern cannot pass for it. `kind` says what the bytes are (`frame`, or `token-claims` for a `token-claims` map), `pattern` names the CDDL rule broken, and `message` and `wire_hex` follow the shared round-trip contract, so the round-trip suites read this file like any other. */

import { cdeEncodeOptions, encode } from "cbor2";
import {
  hex,
  toWire,
  type JsonWire,
  type Vector,
} from "@exadev/wire-mesh-conformance";

export interface InvalidFrameVector extends Vector {
  /** What `wire_hex` is: a frame, or a token-claims map. */
  kind: "frame" | "token-claims";
  /** The CDDL rule whose `.regexp` the value breaks. */
  pattern: string;
  /** Always true: a conformant decoder refuses the bytes. Present so a consumer cannot read the file as a list of values to accept. */
  refused: true;
  /** The same bytes with a value inside the grammar, which a conformant decoder accepts. */
  valid_control_wire_hex: string;
}

function wireHex(message: JsonWire): string {
  return Buffer.from(encode(toWire(message), cdeEncodeOptions)).toString("hex");
}

function manageRequest(verb: string): JsonWire {
  return {
    type: "manage-request",
    "request-id": 1,
    command: { verb, params: { verb: "exec.list" } },
    scope: { kind: "folder" },
  };
}

function handshake(domain: string): JsonWire {
  return { type: "handshake", version: 1, domains: [domain] };
}

const TOKEN_ID_BYTES = 16;
const KEY_BYTES = 32;
const ED25519 = -8;
const SOME_EXPIRY = 1861920000000;

/** Token claims whose verbs are as given: the required fields with synthetic filler, then whichever of the three verb fields are present. */
function tokenClaims(
  verbs: Readonly<{
    capability: string;
    grants?: string;
    requests?: string;
  }>,
): JsonWire {
  return {
    "token-id": hex("a1".repeat(TOKEN_ID_BYTES)),
    issuer: hex("b2".repeat(KEY_BYTES)),
    "issuer-key": { alg: ED25519, "public-key": hex("c3".repeat(KEY_BYTES)) },
    bearer: hex("d4".repeat(KEY_BYTES)),
    capability: verbs.capability,
    ...(verbs.grants === undefined
      ? {}
      : { "grants-capability": verbs.grants }),
    ...(verbs.requests === undefined
      ? {}
      : { "requests-capability": verbs.requests }),
    scope: { kind: "folder" },
    expires: SOME_EXPIRY,
  };
}

interface Case {
  name: string;
  pattern: string;
  kind: InvalidFrameVector["kind"];
  invalid: JsonWire;
  valid: JsonWire;
}

const VALID_CORE = "exec:pty";
const VALID_NAMESPACED = "example.com/tool:run";
const VALID_PRIVATE = "x-local:run";
const VALID_NAMESPACED_DOMAIN = "example.com/thing";
const VALID_PRIVATE_DOMAIN = "x-thing";

function verbCase(
  name: string,
  pattern: string,
  invalidVerb: string,
  validVerb: string,
): Case {
  return {
    name: `manage_request_v1_${name}`,
    pattern,
    kind: "frame",
    invalid: manageRequest(invalidVerb),
    valid: manageRequest(validVerb),
  };
}

function domainCase(
  name: string,
  pattern: string,
  invalidDomain: string,
  validDomain: string,
): Case {
  return {
    name: `handshake_v1_${name}`,
    pattern,
    kind: "frame",
    invalid: handshake(invalidDomain),
    valid: handshake(validDomain),
  };
}

/** The capability verbs outside the grammar, as [name, rule broken, value, a valid verb of the same rule]. */
export const INVALID_CAPABILITY_VERBS: readonly (readonly [
  string,
  string,
  string,
  string,
])[] = [
  ["invalid_capability_verb", "core-capability", "two:colons:here", VALID_CORE],
  [
    "invalid_capability_verb_trailing_text",
    "core-capability",
    "exec:pty extra",
    VALID_CORE,
  ],
  [
    "invalid_capability_verb_trailing_newline",
    "core-capability",
    "exec:pty\n",
    VALID_CORE,
  ],
  [
    "invalid_capability_verb_leading_hyphen",
    "core-capability",
    "-x:pty",
    VALID_CORE,
  ],
  [
    "invalid_capability_verb_digit_action",
    "core-capability",
    "exec:1",
    VALID_CORE,
  ],
  [
    "invalid_namespaced_capability_verb",
    "namespaced-capability",
    "example.com/tool:run:more",
    VALID_NAMESPACED,
  ],
  [
    "invalid_namespaced_capability_verb_leading_text",
    "namespaced-capability",
    "!example.com/tool:run",
    VALID_NAMESPACED,
  ],
  [
    "invalid_namespaced_capability_verb_trailing_newline",
    "namespaced-capability",
    "example.com/tool:run\n",
    VALID_NAMESPACED,
  ],
  [
    "invalid_private_use_capability_verb",
    "private-use-capability",
    "x-local:run extra",
    VALID_PRIVATE,
  ],
  [
    "invalid_private_use_capability_verb_trailing_newline",
    "private-use-capability",
    "x-local:run\n",
    VALID_PRIVATE,
  ],
];

const cases: readonly Case[] = [
  ...INVALID_CAPABILITY_VERBS.map(([name, pattern, invalid, valid]) =>
    verbCase(name, pattern, invalid, valid),
  ),
  domainCase(
    "invalid_namespaced_domain_trailing_text",
    "namespaced-domain-id",
    "example.com/thing extra",
    VALID_NAMESPACED_DOMAIN,
  ),
  domainCase(
    "invalid_namespaced_domain_leading_text",
    "namespaced-domain-id",
    "!example.com/thing",
    VALID_NAMESPACED_DOMAIN,
  ),
  domainCase(
    "invalid_namespaced_domain_trailing_newline",
    "namespaced-domain-id",
    "example.com/thing\n",
    VALID_NAMESPACED_DOMAIN,
  ),
  domainCase(
    "invalid_namespaced_domain_embedded_separator",
    "namespaced-domain-id",
    "example.com/thing/more",
    VALID_NAMESPACED_DOMAIN,
  ),
  domainCase(
    "invalid_private_use_domain",
    "private-use-domain-id",
    "x-thing extra",
    VALID_PRIVATE_DOMAIN,
  ),
  domainCase(
    "invalid_private_use_domain_trailing_newline",
    "private-use-domain-id",
    "x-thing\n",
    VALID_PRIVATE_DOMAIN,
  ),
  domainCase(
    "invalid_private_use_domain_embedded_separator",
    "private-use-domain-id",
    "x-thing/more",
    VALID_PRIVATE_DOMAIN,
  ),
  // The three verb fields of token claims, each broken on its own with the other two valid.
  {
    name: "token_claims_v1_invalid_capability",
    pattern: "capability-verb",
    kind: "token-claims",
    invalid: tokenClaims({ capability: "two:colons:here" }),
    valid: tokenClaims({ capability: VALID_CORE }),
  },
  {
    name: "token_claims_v1_invalid_grants_capability",
    pattern: "capability-verb",
    kind: "token-claims",
    invalid: tokenClaims({ capability: VALID_CORE, grants: "exec:pty extra" }),
    valid: tokenClaims({ capability: VALID_CORE, grants: VALID_CORE }),
  },
  {
    name: "token_claims_v1_invalid_requests_capability",
    pattern: "capability-verb",
    kind: "token-claims",
    invalid: tokenClaims({ capability: VALID_CORE, requests: "-x:pty" }),
    valid: tokenClaims({ capability: VALID_CORE, requests: VALID_CORE }),
  },
];

export const invalidFrameVectors: InvalidFrameVector[] = cases.map((item) => ({
  name: item.name,
  message: item.invalid,
  wire_hex: wireHex(item.invalid),
  kind: item.kind,
  pattern: item.pattern,
  refused: true,
  valid_control_wire_hex: wireHex(item.valid),
}));

/** The invalid verbs sealed inside a secure-data frame in secure-channel.v1.json: the first of each capability-verb pattern, as the plaintext (the encoded frame) under the name of the sequence that seals it. */
export const SEALED_INVALID_FRAMES: readonly (readonly [string, Buffer])[] =
  INVALID_CAPABILITY_VERBS.filter(
    ([name]) =>
      name === "invalid_capability_verb" ||
      name === "invalid_namespaced_capability_verb" ||
      name === "invalid_private_use_capability_verb",
  ).map(([name, , verb]) => [
    name,
    Buffer.from(wireHex(manageRequest(verb)), "hex"),
  ]);
