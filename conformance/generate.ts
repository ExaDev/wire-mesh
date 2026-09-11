// Produces conformance/{handshake,tokens,frames}.v1.json from the vector definitions below. Each vector's `wire_hex` is derived mechanically by canonically CBOR-encoding `message` via cbor2's CDE (CBOR Common Deterministic Encoding) mode -- the same RFC 8949 4.2 core deterministic rules DAG-CBOR builds on -- never hand-typed. Signature and public-key bytes throughout are clearly-synthetic filler, not real cryptographic material: this file freezes the wire-exact envelope shape (map key ordering, field presence, array structure, nesting), not a working signature, the same scope Cascade's own frozen frames/handshake/tokens vectors commit to for structural fields with no real crypto behind them.
//
// Run `pnpm generate` after changing anything below, then `pnpm test` to confirm every vector round-trips.

import { writeFileSync } from "node:fs";
import { encode, cdeEncodeOptions } from "cbor2";
import {
  hex,
  toWire,
  type JsonWire,
  type Vector,
} from "@exadev/wire-mesh-conformance";

function wireHex(message: JsonWire): string {
  return Buffer.from(encode(toWire(message), cdeEncodeOptions)).toString("hex");
}

function vector(name: string, message: JsonWire): Vector {
  return { name, message, wire_hex: wireHex(message) };
}

// -- Byte lengths named for what they actually are, not left as bare literals --

const SHA256_BYTE_LENGTH = 32; // device-id = SHA-256(identity-key.public-key)
const P256_COORDINATE_BYTE_LENGTH = 32; // uncompressed SEC1 point: 0x04 || X || Y, X and Y each this length
const ED25519_PUBLIC_KEY_BYTE_LENGTH = 32;
const SIGNATURE_BYTE_LENGTH = 64; // raw ES256/EdDSA signature length
const TOKEN_ID_BYTE_LENGTH = 16; // opaque token-id, arbitrarily sized like a UUID
const EXAMPLE_RELAY_PAYLOAD_BYTE_LENGTH = 24; // arbitrary example ciphertext length for relay-data-frame

// -- Shared synthetic identities, reused across files for a coherent story --

const deviceA = hex("11".repeat(SHA256_BYTE_LENGTH)); // issuer / coordinator
const deviceB = hex("22".repeat(SHA256_BYTE_LENGTH)); // bearer of the root token / delegator
const deviceC = hex("33".repeat(SHA256_BYTE_LENGTH)); // bearer of the delegated token
const deviceD = hex("44".repeat(SHA256_BYTE_LENGTH)); // handle-record subject

const publicKeyEs256A = hex(
  "04" +
    "aa".repeat(P256_COORDINATE_BYTE_LENGTH) +
    "bb".repeat(P256_COORDINATE_BYTE_LENGTH),
); // uncompressed P-256 point, synthetic
const publicKeyEs256B = hex(
  "04" +
    "cc".repeat(P256_COORDINATE_BYTE_LENGTH) +
    "dd".repeat(P256_COORDINATE_BYTE_LENGTH),
);
const publicKeyEd25519D = hex("ee".repeat(ED25519_PUBLIC_KEY_BYTE_LENGTH));

const signatureFiller = hex("ff".repeat(SIGNATURE_BYTE_LENGTH)); // synthetic ES256/EdDSA-shaped signature

// -----------------------------------------------------------------------
// handshake.v1.json
// -----------------------------------------------------------------------

const handshakeVectors: Vector[] = [
  vector("handshake_v1_management_exec_data", {
    type: "handshake",
    version: 1,
    domains: ["core/management", "core/exec", "core/data"],
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

const rootTokenClaims: JsonWire = {
  "token-id": hex("01".repeat(TOKEN_ID_BYTE_LENGTH)),
  issuer: deviceA,
  "issuer-key": { alg: -7, "public-key": publicKeyEs256A },
  bearer: deviceB,
  capability: "exec:pty",
  scope: { kind: "folder", path: "/work" },
  expires: 1893456000000,
};

// The protected header below is the one place this file needs a genuinely int-keyed CBOR map (cose-token-headers' cose-header-alg/-kid labels), which JSON can't represent directly as `{1: -7, 4: ...}` -- object keys are always strings in JSON. It is computed directly rather than round-tripped through the hex-marker convention, since it's never itself a top-level `message` value being compared; CDE's canonical map-key comparison is on the encoded key bytes, not the JS type, so a plain object with numeric-looking string keys still produces the correct integer-keyed CBOR map.
const rootToken: JsonWire = [
  hex(wireHex({ 1: -7, 4: deviceA })),
  {},
  hex(wireHex(rootTokenClaims)),
  signatureFiller,
];

const rootTokenVector = vector("capability_token_v1_root_grant", rootToken);

const delegatedTokenClaims: JsonWire = {
  "token-id": hex("02".repeat(TOKEN_ID_BYTE_LENGTH)),
  issuer: deviceB,
  "issuer-key": { alg: -7, "public-key": publicKeyEs256B },
  bearer: deviceC,
  capability: "exec:pty",
  scope: { kind: "folder", path: "/work/subdir" },
  expires: 1861920000000, // earlier than the parent's expiry -- delegation narrows, never widens
  parent: hex(rootTokenVector.wire_hex),
};

const delegatedToken: JsonWire = [
  hex(wireHex({ 1: -7, 4: deviceB })),
  {},
  hex(wireHex(delegatedTokenClaims)),
  signatureFiller,
];

const delegatedTokenVector = vector(
  "capability_token_v1_delegated_narrowed_scope",
  delegatedToken,
);

// core/room's own device-id-hex path components -- the tstr hex-string encoding room-path regexes match against, distinct from deviceA/deviceB/deviceC's bstr wire encoding used everywhere else. Reuses the same synthetic byte pattern so a reader can see it's the same device in both forms.
const deviceAHex = "11".repeat(SHA256_BYTE_LENGTH);
const deviceBHex = "22".repeat(SHA256_BYTE_LENGTH);
const deviceCHex = "33".repeat(SHA256_BYTE_LENGTH);

// A room:member grant chain demonstrating this session's own delegations-remaining fix: the owner (deviceA) issues a root grant to deviceB capped at one further re-delegation, and deviceB narrows it (a strictly lower value, 0) when re-delegating to deviceC -- deviceC's own token therefore bears no further-delegation authority at all, closing the unbounded-admission gap the claim exists to fix.
const roomMemberRootTokenClaims: JsonWire = {
  "token-id": hex("03".repeat(TOKEN_ID_BYTE_LENGTH)),
  issuer: deviceA,
  "issuer-key": { alg: -7, "public-key": publicKeyEs256A },
  bearer: deviceB,
  capability: "room:member",
  scope: { kind: "room", path: `${deviceAHex}/general` },
  expires: 1893456000000,
  "delegations-remaining": 1,
};

const roomMemberRootToken: JsonWire = [
  hex(wireHex({ 1: -7, 4: deviceA })),
  {},
  hex(wireHex(roomMemberRootTokenClaims)),
  signatureFiller,
];

const roomMemberRootTokenVector = vector(
  "capability_token_v1_room_member_root_grant",
  roomMemberRootToken,
);

const roomMemberDelegatedTokenClaims: JsonWire = {
  "token-id": hex("04".repeat(TOKEN_ID_BYTE_LENGTH)),
  issuer: deviceB,
  "issuer-key": { alg: -7, "public-key": publicKeyEs256B },
  bearer: deviceC,
  capability: "room:member",
  scope: { kind: "room", path: `${deviceAHex}/general` },
  expires: 1861920000000,
  parent: hex(roomMemberRootTokenVector.wire_hex),
  "delegations-remaining": 0,
};

const roomMemberDelegatedToken: JsonWire = [
  hex(wireHex({ 1: -7, 4: deviceB })),
  {},
  hex(wireHex(roomMemberDelegatedTokenClaims)),
  signatureFiller,
];

const roomMemberDelegatedTokenVector = vector(
  "capability_token_v1_room_member_delegated_no_further_delegation",
  roomMemberDelegatedToken,
);

// core/room's own noticeboard entry (room.cddl's room-notice), self-certifying the same way capability-token and handle-record already are. deviceB posts to the same general room its roomMemberRootToken already grants it membership in, embedding that exact token in full so a reader with no other context can verify posting authority from the notice alone.
const NOTICE_ID_BYTE_LENGTH = 16; // opaque notice-id, arbitrarily sized like token-id

const roomNoticeClaims: JsonWire = {
  room: `${deviceAHex}/general`,
  poster: deviceB,
  "poster-key": { alg: -7, "public-key": publicKeyEs256B },
  token: roomMemberRootToken,
  "notice-id": hex("a1".repeat(NOTICE_ID_BYTE_LENGTH)),
  "posted-at": 1861920000000,
  "content-type": "text/plain",
  content: hex(wireHex("see you at the usual spot")),
};

const roomNotice: JsonWire = [
  hex(wireHex({ 1: -7, 4: deviceB })),
  {},
  hex(wireHex(roomNoticeClaims)),
  signatureFiller,
];

const roomNoticeVector = vector("room_notice_v1_posted", roomNotice);

// Forwarding a notice needs no new verification mechanism: the proof of what was forwarded is nesting the ORIGINAL notice's own still-independently-verifiable room-notice as this notice's own `content`, content-type naming it as such. deviceC (also a member per its own delegated token) forwards deviceB's notice above into the same room; room/poster/poster-key stay signed inside the ORIGINAL envelope no matter how many times it's re-forwarded.
const roomNoticeForwardClaims: JsonWire = {
  room: `${deviceAHex}/general`,
  poster: deviceC,
  "poster-key": { alg: -7, "public-key": publicKeyEs256B }, // reusing B's synthetic key bytes for C is fine here -- this file freezes envelope shape, not real per-device key material
  token: roomMemberDelegatedToken,
  "notice-id": hex("a2".repeat(NOTICE_ID_BYTE_LENGTH)),
  "posted-at": 1861920100000,
  "content-type": "application/x-room-notice",
  content: hex(roomNoticeVector.wire_hex),
  refs: [{ id: hex("a1".repeat(NOTICE_ID_BYTE_LENGTH)), relation: "forward" }],
};

const roomNoticeForward: JsonWire = [
  hex(wireHex({ 1: -7, 4: deviceC })),
  {},
  hex(wireHex(roomNoticeForwardClaims)),
  signatureFiller,
];

const roomNoticeForwardVector = vector(
  "room_notice_v1_forwarded",
  roomNoticeForward,
);

const handleClaims: JsonWire = {
  handle: "alice@example.com",
  "device-id": deviceD,
  "identity-key": { alg: -8, "public-key": publicKeyEd25519D },
  candidates: [{ address: "203.0.113.5:4433", kind: "host", priority: 100 }],
  mailboxes: [deviceA, deviceB],
  issued: 1861833600000,
  expires: 1861920000000,
};

const handleRecordVector = vector("handle_record_v1_dns_anchored", [
  hex(wireHex({ 1: -8 })),
  {},
  hex(wireHex(handleClaims)),
  signatureFiller,
]);

const tokenVectors: Vector[] = [
  rootTokenVector,
  delegatedTokenVector,
  roomMemberRootTokenVector,
  roomMemberDelegatedTokenVector,
  roomNoticeVector,
  roomNoticeForwardVector,
  handleRecordVector,
];

// -----------------------------------------------------------------------
// frames.v1.json -- every $frame-variant in spec/frame.cddl except handshake-frame, which lives in handshake.v1.json above.
// -----------------------------------------------------------------------

const frameVectors: Vector[] = [
  vector("ping_v1", { type: "ping" }),
  vector("close_v1_with_reason", { type: "close", reason: "shutting down" }),
  vector("gossip_v1_two_peers", {
    type: "gossip",
    peers: [
      {
        device: deviceA,
        addresses: ["203.0.113.5:4433"],
        "snapshot-seconds": 1861833600,
      },
      {
        device: deviceB,
        addresses: ["203.0.113.9:4433", "198.51.100.2:4433"],
        "snapshot-seconds": 1861833601,
      },
    ],
  }),
  vector("candidates_v1_host_and_relayed", {
    type: "candidates",
    candidates: [
      { address: "203.0.113.5:4433", kind: "host", priority: 100 },
      { address: "198.51.100.2:7000", kind: "relayed", priority: 10 },
    ],
  }),
  vector("sync_punch_v1", {
    type: "sync-punch",
    nonce: 42,
    "deadline-unix-ms": 1861833605000,
  }),
  vector("observed_address_v1", {
    type: "observed-address",
    address: "203.0.113.5:51820",
  }),
  vector("relay_offer_v1", {
    type: "relay-offer",
    addresses: ["198.51.100.2:7000"],
  }),
  vector("relay_connect_v1", {
    type: "relay-connect",
    "target-device": deviceC,
  }),
  vector("relay_data_v1", {
    type: "relay-data",
    payload: hex("de".repeat(EXAMPLE_RELAY_PAYLOAD_BYTE_LENGTH)),
  }),
  vector("relay_inbound_v1", {
    type: "relay-inbound",
    "source-device": deviceB,
  }),
  vector("coordinator_v1_with_capacity_hint", {
    type: "coordinator",
    term: 3,
    coordinator: deviceA,
    "capacity-hint": 64,
  }),
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
    outcome: {
      result: "error",
      code: "scope-denied",
      message: "token does not authorise this path",
    },
  }),
  vector("manage_request_v1_webrtc_offer", {
    type: "manage-request",
    "request-id": 3,
    command: {
      verb: "webrtc:signal",
      params: {
        verb: "webrtc.offer",
        "negotiation-id": 1,
        sdp: "v=0\r\no=- 46117317 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
      },
    },
    scope: { kind: "node" },
    token: rootToken,
  }),
  vector("manage_request_v1_webrtc_answer", {
    type: "manage-request",
    "request-id": 4,
    command: {
      verb: "webrtc:signal",
      params: {
        verb: "webrtc.answer",
        "negotiation-id": 1,
        sdp: "v=0\r\no=- 55221190 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n",
      },
    },
    scope: { kind: "node" },
  }),
  vector("manage_request_v1_webrtc_ice_candidate", {
    type: "manage-request",
    "request-id": 5,
    command: {
      verb: "webrtc:signal",
      params: {
        verb: "webrtc.ice-candidate",
        "negotiation-id": 1,
        candidate: {
          candidate: "candidate:1 1 UDP 2130706431 203.0.113.5 54400 typ host",
          "sdp-mid": "0",
          "sdp-m-line-index": 0,
          "username-fragment": "abcd",
        },
      },
    },
    scope: { kind: "node" },
  }),
  vector("manage_request_v1_webrtc_ice_candidate_end_of_candidates", {
    type: "manage-request",
    "request-id": 6,
    command: {
      verb: "webrtc:signal",
      params: { verb: "webrtc.ice-candidate", "negotiation-id": 1 },
    },
    scope: { kind: "node" },
  }),
  // core/room -- room.send carries sent-at (self-asserted, mandatory), an optional content-type, and an optional refs array (message-ref's own open relation string), exercising the reply/forward reference mechanism alongside the gated room:member token.
  vector("manage_request_v1_room_send_with_reply_ref", {
    type: "manage-request",
    "request-id": 7,
    command: {
      verb: "room:member",
      params: {
        verb: "room.send",
        "message-id": hex("aa01"),
        "sent-at": 1893456000000,
        text: "sounds good, see you then",
        "content-type": "text/plain",
        refs: [{ id: hex("aa00"), relation: "reply" }],
      },
    },
    scope: { kind: "room", path: `${deviceAHex}/general` },
    token: roomMemberRootToken,
  }),
  // room.read is batched -- an agent typically drains and marks read several messages in one pass, and a one-message-per-round-trip receipt verb would turn one drain into N round trips per peer.
  vector("manage_request_v1_room_read", {
    type: "manage-request",
    "request-id": 8,
    command: {
      verb: "room:member",
      params: {
        verb: "room.read",
        messages: [hex("aa01"), hex("aa02")],
        at: 1893456005000,
      },
    },
    scope: { kind: "room", path: `${deviceAHex}/general` },
    token: roomMemberRootToken,
  }),
  vector("manage_request_v1_room_leave", {
    type: "manage-request",
    "request-id": 9,
    command: {
      verb: "room:member",
      params: { verb: "room.leave" },
    },
    scope: { kind: "room", path: `${deviceAHex}/general` },
    token: roomMemberRootToken,
  }),
  vector("manage_request_v1_room_members", {
    type: "manage-request",
    "request-id": 10,
    command: {
      verb: "room:member",
      params: { verb: "room.members" },
    },
    scope: { kind: "room", path: `${deviceAHex}/general` },
    token: roomMemberRootToken,
  }),
  // room.join and room.invite are deliberately ungated (no token field) -- access control is a human's explicit approval in the receiving UI, not a pre-shared token, the first verbs in this spec to work that way. This join vector uses a DM room path (the sorted device-id pair), the shape a first, tokenless contact actually needs.
  vector("manage_request_v1_room_join_dm", {
    type: "manage-request",
    "request-id": 11,
    command: {
      verb: "room:member",
      params: { verb: "room.join" },
    },
    scope: { kind: "room", path: `${deviceBHex}+${deviceCHex}` },
  }),
  // room.invite pushes the freshly minted grant in the request itself -- unlike room.join (a pull, answered by room-join-ok on the SAME round trip), an invite has no approval response of its own to carry the grant back on, so the token travels here instead.
  vector("manage_request_v1_room_invite", {
    type: "manage-request",
    "request-id": 12,
    command: {
      verb: "room:member",
      params: {
        verb: "room.invite",
        invitee: deviceC,
        token: roomMemberDelegatedToken,
      },
    },
    scope: { kind: "room", path: `${deviceAHex}/general` },
  }),
  // room-join-ok: the approval response to room.join, carrying the freshly minted grant AND the room's current membership so a joiner learns who else is there on the same round trip that grants it membership.
  vector("manage_response_v1_room_join_ok", {
    type: "manage-response",
    "request-id": 11,
    outcome: {
      result: "ok",
      "granted-token": roomMemberDelegatedToken,
      members: [{ device: deviceA }, { device: deviceB }],
    },
  }),
  // room-members-ok: a plain membership refresh, no grant involved -- the requester already held a valid room:member token to reach this verb at all.
  vector("manage_response_v1_room_members_ok", {
    type: "manage-response",
    "request-id": 10,
    outcome: {
      result: "ok",
      members: [{ device: deviceA }, { device: deviceB }, { device: deviceC }],
    },
  }),
  vector("revocation_announce_v1_two_entries", {
    type: "revocation-announce",
    // Each entry is its own cose-sign1 (same shape as capability-token), so a revocation carries the same self-certifying attribution as the token it revokes: a verifier checks revocation-claims.issuer against the token's own issuer field, not merely that some signature verifies -- only a token's own issuer may revoke it.
    entries: [
      [
        hex(wireHex({ 1: -7, 4: deviceA })),
        {},
        hex(
          wireHex({
            "token-id": hex("01".repeat(TOKEN_ID_BYTE_LENGTH)),
            issuer: deviceA,
            "issuer-key": { alg: -7, "public-key": publicKeyEs256A },
            "revoked-at": 1861833700000,
          }),
        ),
        signatureFiller,
      ],
      [
        hex(wireHex({ 1: -7, 4: deviceB })),
        {},
        hex(
          wireHex({
            "token-id": hex("02".repeat(TOKEN_ID_BYTE_LENGTH)),
            issuer: deviceB,
            "issuer-key": { alg: -7, "public-key": publicKeyEs256B },
            "revoked-at": 1861833701000,
          }),
        ),
        signatureFiller,
      ],
    ],
  }),
  vector("stream_data_v1_stdout_chunk", {
    type: "stream-data",
    session: 7,
    seq: 3,
    channel: "stdout",
    bytes: hex("68656c6c6f0a"), // "hello\n"
  }),
  vector("stream_ack_v1", {
    type: "stream-ack",
    session: 7,
    "ack-seq": 3,
    window: 65536,
  }),
  vector("stream_end_v1_exit_code", {
    type: "stream-end",
    session: 7,
    "exit-code": 0,
  }),
  vector("data_have_v1", { type: "data-have", peer: deviceA, "head-seq": 128 }),
  vector("data_request_v1", {
    type: "data-request",
    peer: deviceA,
    "from-seq": 100,
  }),
  vector("data_entries_v1_two_entries", {
    type: "data-entries",
    peer: deviceA,
    "from-seq": 100,
    entries: [hex("aabbcc"), hex("ddeeff00")],
  }),
];

// -----------------------------------------------------------------------
// Write files
// -----------------------------------------------------------------------

function write(
  filename: string,
  description: string,
  vectors: readonly Vector[],
): void {
  const content = { protocol_version: 1, description, vectors };
  writeFileSync(
    new URL(filename, import.meta.url),
    JSON.stringify(content, null, 2) + "\n",
  );
  console.log(`wrote ${filename} (${String(vectors.length)} vectors)`);
}

write(
  "handshake.v1.json",
  "Handshake conformance vectors for protocol version 1. A conformant codec must decode each wire_hex to the described message and re-encode that message to exactly wire_hex, using RFC 8949 4.2 core deterministic (DAG-CBOR-compatible) encoding.",
  handshakeVectors,
);

write(
  "tokens.v1.json",
  "Capability-token, room-notice, and handle-record conformance vectors for protocol version 1. Every cose-sign1 array's protected/payload byte strings are themselves canonical CBOR, decoded and re-verified the same way as any other bstr field. Signature and public-key bytes are structural placeholders (clearly-synthetic filler), not real cryptographic material -- this file freezes the byte-exact envelope shape (map key ordering, field presence, the recursive parent delegation chain), not a working signature, the same scope Cascade's own frozen vectors commit to for fields with no real crypto behind them yet. The two room-notice vectors exercise core/room's noticeboard entry schema: the first is an ordinary posted notice embedding its poster's own room:member token in full; the second forwards it, nesting the first notice's own still-independently-verifiable room-notice as its content with a content-type naming it as such, and a refs entry with relation \"forward\" pointing at the original notice-id.",
  tokenVectors,
);

write(
  "frames.v1.json",
  "Frame conformance vectors for protocol version 1, covering every $frame-variant in spec/frame.cddl except handshake-frame (see handshake.v1.json). manage-response-frame gets two vectors, one per branch of its manage-ok / manage-error outcome union. The four core/webrtc vectors (offer, answer, ice-candidate, end-of-candidates) exercise manage-request-frame's params socket with new content, not a new frame kind; the offer vector is also the first in this file to exercise manage-request-frame's optional token field. The core/room vectors (send with sent-at/content-type/a reply ref, batched read, leave, members, invite carrying its own pushed grant) carry the room:member token from tokens.v1.json's own root grant; the join vector is the first in this file to exercise an ungated manage-request (no token field at all). room-join-ok and room-members-ok are this domain's own named manage-ok variants (a minted grant plus membership, and a plain membership refresh, respectively), not the generic `* tstr => any` tail alone.",
  frameVectors,
);
