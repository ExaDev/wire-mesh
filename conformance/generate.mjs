// Produces conformance/{handshake,tokens,frames}.v1.json from the vector definitions below. Each vector's `wire_hex` is derived mechanically by canonically CBOR-encoding `message` via cbor2's CDE (CBOR Common Deterministic Encoding) mode -- the same RFC 8949 4.2 core deterministic rules DAG-CBOR builds on -- never hand-typed. Signature and public-key bytes throughout are clearly-synthetic filler, not real cryptographic material: this file freezes the wire-exact envelope shape (map key ordering, field presence, array structure, nesting), not a working signature, the same scope Cascade's own frozen frames/handshake/tokens vectors commit to for structural fields with no real crypto behind them.
//
// Run `npm run generate` after changing anything below, then `npm run verify` (or just this script's own built-in verification pass at the end) to confirm every vector round-trips.

import { writeFileSync } from "node:fs";
import { encode, cdeEncodeOptions } from "cbor2";
import { hex, toWire } from "./codec.mjs";

function wireHex(message) {
  return Buffer.from(encode(toWire(message), cdeEncodeOptions)).toString("hex");
}

function vector(name, message) {
  return { name, message, wire_hex: wireHex(message) };
}

// -- Shared synthetic identities, reused across files for a coherent story --

const deviceA = hex("11".repeat(32)); // issuer / coordinator
const deviceB = hex("22".repeat(32)); // bearer of the root token / delegator
const deviceC = hex("33".repeat(32)); // bearer of the delegated token
const deviceD = hex("44".repeat(32)); // handle-record subject

const publicKeyEs256A = hex("04" + "aa".repeat(32) + "bb".repeat(32)); // uncompressed P-256 point, synthetic
const publicKeyEs256B = hex("04" + "cc".repeat(32) + "dd".repeat(32));
const publicKeyEd25519D = hex("ee".repeat(32));

const signatureFiller = hex("ff".repeat(64)); // synthetic ES256/EdDSA-shaped signature

// -----------------------------------------------------------------------
// handshake.v1.json
// -----------------------------------------------------------------------

const handshakeVectors = [
  vector("handshake_v1_management_exec_federation", {
    type: "handshake",
    version: 1,
    domains: ["core/management", "core/exec", "core/federation"],
  }),
  vector("handshake_v1_with_forward_compatible_params", {
    type: "handshake",
    version: 1,
    domains: ["core/data"],
    params: { "max-frame-size": 65536 },
  }),
];

// -----------------------------------------------------------------------
// tokens.v1.json
// -----------------------------------------------------------------------

const rootTokenClaims = {
  "token-id": hex("01".repeat(16)),
  issuer: deviceA,
  "issuer-key": { alg: -7, "public-key": publicKeyEs256A },
  bearer: deviceB,
  capability: "exec:pty",
  scope: { kind: "folder", path: "/work" },
  expires: 1893456000000,
};

const rootToken = [
  hex(wireHex({ 1: -7, 4: deviceA })), // protected header, {alg: -7, kid: deviceA} -- see note below on int-keyed map JSON
  {},
  hex(wireHex(rootTokenClaims)),
  signatureFiller,
];

// The protected header above is the one place this file needs a genuinely int-keyed CBOR map (cose-token-headers' cose-header-alg/-kid labels), which JSON can't represent directly as `{1: -7, 4: ...}` -- object keys are always strings in JSON. `wireHex` is given a plain JS object with numeric keys here purely to drive cbor2's encoder (cbor2 uses `Reflect.ownKeys` order, and JS coerces integer-like keys to strings internally regardless, but CDE's canonical map-key comparison is on the *encoded* key bytes, not the JS type, so `{1: -7, 4: ...}` still produces the correct integer-keyed CBOR map). This one nested map is therefore computed directly rather than round-tripped through the hex-marker convention, since it's never itself a top-level `message` value being compared.

const rootTokenVector = vector("capability_token_v1_root_grant", rootToken);

const delegatedTokenClaims = {
  "token-id": hex("02".repeat(16)),
  issuer: deviceB,
  "issuer-key": { alg: -7, "public-key": publicKeyEs256B },
  bearer: deviceC,
  capability: "exec:pty",
  scope: { kind: "folder", path: "/work/subdir" },
  expires: 1861920000000, // earlier than the parent's expiry -- delegation narrows, never widens
  parent: hex(rootTokenVector.wire_hex),
};

const delegatedToken = [
  hex(wireHex({ 1: -7, 4: deviceB })),
  {},
  hex(wireHex(delegatedTokenClaims)),
  signatureFiller,
];

const delegatedTokenVector = vector("capability_token_v1_delegated_narrowed_scope", delegatedToken);

const handleClaims = {
  handle: "alice@example.com",
  "device-id": deviceD,
  "identity-key": { alg: -8, "public-key": publicKeyEd25519D },
  candidates: [{ address: "203.0.113.5:4433", kind: "host", priority: 100 }],
  issued: 1861833600000,
  expires: 1861920000000,
};

const handleRecordVector = vector("handle_record_v1_dns_anchored", [
  hex(wireHex({ 1: -8 })),
  {},
  hex(wireHex(handleClaims)),
  signatureFiller,
]);

const tokenVectors = [rootTokenVector, delegatedTokenVector, handleRecordVector];

// -----------------------------------------------------------------------
// frames.v1.json -- every $frame-variant in spec/frame.cddl except handshake-frame, which lives in handshake.v1.json above.
// -----------------------------------------------------------------------

const innerPingFrame = { type: "ping" };

const frameVectors = [
  vector("ping_v1", { type: "ping" }),
  vector("close_v1_with_reason", { type: "close", reason: "shutting down" }),
  vector("gossip_v1_two_peers", {
    type: "gossip",
    peers: [
      { device: deviceA, addresses: ["203.0.113.5:4433"], "snapshot-seconds": 1861833600 },
      { device: deviceB, addresses: ["203.0.113.9:4433", "198.51.100.2:4433"], "snapshot-seconds": 1861833601 },
    ],
  }),
  vector("candidates_v1_host_and_relayed", {
    type: "candidates",
    candidates: [
      { address: "203.0.113.5:4433", kind: "host", priority: 100 },
      { address: "198.51.100.2:7000", kind: "relayed", priority: 10 },
    ],
  }),
  vector("sync_punch_v1", { type: "sync-punch", nonce: 42, "deadline-unix-ms": 1861833605000 }),
  vector("observed_address_v1", { type: "observed-address", address: "203.0.113.5:51820" }),
  vector("relay_offer_v1", { type: "relay-offer", addresses: ["198.51.100.2:7000"] }),
  vector("relay_connect_v1", { type: "relay-connect", "target-device": deviceC }),
  vector("relay_data_v1", { type: "relay-data", payload: hex("de".repeat(24)) }),
  vector("relay_inbound_v1", { type: "relay-inbound", "source-device": deviceB }),
  vector("manage_request_v1_pty_spawn", {
    type: "manage-request",
    "request-id": 1,
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
  }),
  vector("manage_response_v1_ok", {
    type: "manage-response",
    "request-id": 1,
    outcome: { result: "ok" },
  }),
  vector("manage_response_v1_error", {
    type: "manage-response",
    "request-id": 2,
    outcome: { result: "error", code: "scope-denied", message: "token does not authorise this path" },
  }),
  vector("revocation_announce_v1_two_entries", {
    type: "revocation-announce",
    entries: [
      { "token-id": hex("01".repeat(16)), "revoked-at": 1861833700000 },
      { "token-id": hex("02".repeat(16)), "revoked-at": 1861833701000 },
    ],
  }),
  vector("stream_data_v1_stdout_chunk", {
    type: "stream-data",
    session: 7,
    seq: 3,
    channel: "stdout",
    bytes: hex("68656c6c6f0a"), // "hello\n"
  }),
  vector("stream_ack_v1", { type: "stream-ack", session: 7, "ack-seq": 3, window: 65536 }),
  vector("stream_end_v1_exit_code", { type: "stream-end", session: 7, "exit-code": 0 }),
  vector("data_have_v1", { type: "data-have", peer: deviceA, "head-seq": 128 }),
  vector("data_request_v1", { type: "data-request", peer: deviceA, "from-seq": 100 }),
  vector("data_entries_v1_two_entries", {
    type: "data-entries",
    peer: deviceA,
    "from-seq": 100,
    entries: [hex("aabbcc"), hex("ddeeff00")],
  }),
  vector("federation_link_request_v1", {
    type: "federation-link-request",
    "local-mesh": "exadev-internal",
    "local-name": "exadev",
    "offered-shares": [{ domain: "core/data", resource: { kind: "room", path: "general" }, direction: "outbound" }],
  }),
  vector("federation_link_accept_v1", {
    type: "federation-link-accept",
    "remote-mesh": "example-partner",
    "remote-name": "partner",
    "accepted-shares": [{ domain: "core/data", resource: { kind: "room", path: "general" }, direction: "outbound" }],
  }),
  vector("federation_link_reject_v1", {
    type: "federation-link-reject",
    reason: "no shared domains accepted",
  }),
  vector("federation_share_v1", {
    type: "federation-share",
    share: { domain: "core/data", resource: { kind: "room", path: "incidents" }, direction: "bidirectional" },
  }),
  vector("federation_unshare_v1", {
    type: "federation-unshare",
    share: { domain: "core/data", resource: { kind: "room", path: "incidents" }, direction: "bidirectional" },
  }),
  vector("federation_envelope_v1_wrapping_a_ping", {
    type: "federation-envelope",
    "origin-mesh": "example-partner",
    "origin-device": deviceC,
    resource: { kind: "room", path: "general" },
    inner: hex(wireHex(innerPingFrame)),
  }),
];

// -----------------------------------------------------------------------
// Write files
// -----------------------------------------------------------------------

function write(filename, description, vectors) {
  const content = { protocol_version: 1, description, vectors };
  writeFileSync(new URL(filename, import.meta.url), JSON.stringify(content, null, 2) + "\n");
  console.log(`wrote ${filename} (${vectors.length} vectors)`);
}

write(
  "handshake.v1.json",
  "Handshake conformance vectors for protocol version 1. A conformant codec must decode each wire_hex to the described message and re-encode that message to exactly wire_hex, using RFC 8949 4.2 core deterministic (DAG-CBOR-compatible) encoding.",
  handshakeVectors,
);

write(
  "tokens.v1.json",
  "Capability-token and handle-record conformance vectors for protocol version 1. Every cose-sign1 array's protected/payload byte strings are themselves canonical CBOR, decoded and re-verified the same way as any other bstr field. Signature and public-key bytes are structural placeholders (clearly-synthetic filler), not real cryptographic material -- this file freezes the byte-exact envelope shape (map key ordering, field presence, the recursive parent delegation chain), not a working signature, the same scope Cascade's own frozen vectors commit to for fields with no real crypto behind them yet.",
  tokenVectors,
);

write(
  "frames.v1.json",
  "Frame conformance vectors for protocol version 1, covering every $frame-variant in spec/frame.cddl except handshake-frame (see handshake.v1.json). manage-response-frame gets two vectors, one per branch of its manage-ok / manage-error outcome union.",
  frameVectors,
);
