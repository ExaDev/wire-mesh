/* The room-notice cases of mint.v1.json: what creating a notice produces, byte for byte, from fixed Ed25519 identities.

   Each notice is built here from the spec text (room.cddl's room-notice-claims) with node:crypto alone, never by an implementation. Whether a notice verifies is written by hand: a notice with a key-epoch that does not pair with its content-type is created all the same and is refused by the reader, as obligation 7 of room.cddl says. */

import { hex, type JsonWire, type Vector } from "@exadev/wire-mesh-conformance";
import { identityNamed } from "./secure-channel-crypto.ts";

const NOTICE_ID_BYTES = 16;
const HEX_RADIX = 16;
const BYTE_HEX_DIGITS = 2;
const FIVE_SECONDS_MS = 5_000;
const ENCRYPTED_SUFFIX = "+aes256gcm";
/** Number.MAX_SAFE_INTEGER, the largest integer the TypeScript holds exactly. */
const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;
/** The first integer above it, 2^53, which a double still holds exactly. */
const BEYOND_EXACT_INTEGER = MAX_EXACT_INTEGER + 1;

/** What the notice cases need from the file they are added to. */
export interface NoticeContext {
  /** The top-level vectors, to which each created notice is added. */
  vectors: Vector[];
  /** The COSE_Sign1 of `claims` signed by the named identity. */
  sign: (
    identity: string,
    claims: JsonWire,
  ) => { message: JsonWire; wireHex: string };
  /** Mints, as the root identity `a`, the `room:member` token of `poster` for `room`, as the vector `mint_<name>`. */
  mintMemberToken: (poster: string, name: string, room: string) => void;
  nowMs: number;
  hourMs: number;
}

interface NoticeSeed {
  name: string;
  poster: string;
  /** The vector of the poster's room:member token, embedded in full. */
  tokenVector: string;
  room: string;
  noticeIdByte: number;
  contentType: string;
  /** The content, or absent when it is the wire form of the earlier notice named by `forwards`. */
  contentHex?: string;
  /** The name of an earlier notice whose wire form is this notice's content. */
  forwards?: string;
  refs?: readonly { idByte: number; relation: string }[];
  validUntil?: number;
  keyEpoch?: number;
  nowMs: number;
  /** The reader's verdict: "valid", or the reason it refuses. Absent when creation itself is refused. */
  verdict?: string;
  /** The refusal creation gives for an integer the TypeScript cannot hold exactly: the case is Rust-only and has no notice. */
  refusal?: "value_not_representable";
}

function textHex(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

function noticeIdHex(byte: number): string {
  return byte
    .toString(HEX_RADIX)
    .padStart(BYTE_HEX_DIGITS, "0")
    .repeat(NOTICE_ID_BYTES);
}

/** The cases, in the order the file lists them; each also adds its notice to `context.vectors`. */
export function noticeCases(context: Readonly<NoticeContext>): JsonWire[] {
  const { nowMs, hourMs } = context;
  const room = `${identityNamed("a").deviceId.toString("hex")}/general`;
  const roomMemberTokens: Record<string, string> = {};
  for (const poster of ["b", "c"]) {
    const name = `room_member_token_${poster}`;
    context.mintMemberToken(poster, name, room);
    roomMemberTokens[poster] = `mint_${name}`;
  }
  const plainContent = textHex("see you at the usual spot");
  const seeds: NoticeSeed[] = [
    {
      name: "notice_plain",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa1,
      contentType: "text/plain",
      contentHex: plainContent,
      nowMs,
      verdict: "valid",
    },
    {
      name: "notice_forwarded",
      poster: "c",
      tokenVector: requireToken(roomMemberTokens, "c"),
      room,
      noticeIdByte: 0xa2,
      contentType: "application/x-room-notice",
      forwards: "notice_plain",
      refs: [{ idByte: 0xa1, relation: "forward" }],
      nowMs,
      verdict: "valid",
    },
    {
      name: "notice_with_expiry",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa3,
      contentType: "text/plain",
      contentHex: plainContent,
      validUntil: nowMs + hourMs,
      nowMs,
      verdict: "valid",
    },
    {
      name: "notice_encrypted",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa4,
      contentType: `text/plain${ENCRYPTED_SUFFIX}`,
      contentHex: "deadbeef",
      keyEpoch: 1,
      nowMs,
      verdict: "valid",
    },
    {
      name: "notice_stamped_from_a_later_clock",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa5,
      contentType: "text/plain",
      contentHex: plainContent,
      nowMs: nowMs + FIVE_SECONDS_MS,
      verdict: "valid",
    },
    {
      name: "notice_encrypted_type_without_an_epoch",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa6,
      contentType: `text/plain${ENCRYPTED_SUFFIX}`,
      contentHex: "deadbeef",
      nowMs,
      verdict: "key_epoch_mismatch",
    },
    {
      name: "notice_epoch_on_a_plaintext_type",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa7,
      contentType: "text/plain",
      contentHex: plainContent,
      keyEpoch: 1,
      nowMs,
      verdict: "key_epoch_mismatch",
    },
    {
      name: "notice_with_an_empty_refs_array",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa8,
      contentType: "text/plain",
      contentHex: plainContent,
      refs: [],
      nowMs,
      verdict: "valid",
    },
    {
      name: "notice_with_a_reply_reference",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xa9,
      contentType: "text/plain",
      contentHex: plainContent,
      refs: [{ idByte: 0xa1, relation: "reply" }],
      nowMs,
      verdict: "valid",
    },
    {
      name: "notice_whose_expiry_has_passed_at_creation",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xaa,
      contentType: "text/plain",
      contentHex: plainContent,
      validUntil: nowMs,
      nowMs,
      verdict: "content_expired",
    },
    {
      name: "notice_with_the_largest_exact_expiry_and_epoch",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xab,
      contentType: `text/plain${ENCRYPTED_SUFFIX}`,
      contentHex: "deadbeef",
      validUntil: MAX_EXACT_INTEGER,
      keyEpoch: MAX_EXACT_INTEGER,
      nowMs,
      verdict: "valid",
    },
    {
      name: "notice_with_an_expiry_beyond_the_exact_integers",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xac,
      contentType: "text/plain",
      contentHex: plainContent,
      validUntil: BEYOND_EXACT_INTEGER,
      nowMs,
      refusal: "value_not_representable",
    },
    {
      name: "notice_with_an_epoch_beyond_the_exact_integers",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xad,
      contentType: `text/plain${ENCRYPTED_SUFFIX}`,
      contentHex: "deadbeef",
      keyEpoch: BEYOND_EXACT_INTEGER,
      nowMs,
      refusal: "value_not_representable",
    },
    {
      name: "notice_created_at_a_clock_beyond_the_exact_integers",
      poster: "b",
      tokenVector: requireToken(roomMemberTokens, "b"),
      room,
      noticeIdByte: 0xae,
      contentType: "text/plain",
      contentHex: plainContent,
      nowMs: BEYOND_EXACT_INTEGER,
      refusal: "value_not_representable",
    },
  ];

  return seeds.map((seed) => caseOf(context, seed));
}

function requireToken(
  tokens: Readonly<Record<string, string>>,
  poster: string,
): string {
  const found = tokens[poster];
  if (found === undefined) {
    throw new Error(`no room:member token for ${poster}`);
  }

  return found;
}

/** The wire-form message of a vector already created. */
function messageOf(context: Readonly<NoticeContext>, name: string): JsonWire {
  const found = context.vectors.find((vector) => vector.name === name);
  if (found === undefined) {
    throw new Error(`no vector named ${name}`);
  }

  return found.message;
}

function contentOf(context: Readonly<NoticeContext>, seed: NoticeSeed): string {
  if (seed.forwards === undefined) {
    if (seed.contentHex === undefined) {
      throw new Error(`notice ${seed.name} has no content`);
    }

    return seed.contentHex;
  }
  const forwards = seed.forwards;
  const earlier = context.vectors.find(
    (vector) => vector.name === `mint_${forwards}`,
  );
  if (earlier === undefined) {
    throw new Error(`notice ${seed.name} forwards a notice not yet created`);
  }

  return earlier.wire_hex;
}

function caseOf(context: Readonly<NoticeContext>, seed: NoticeSeed): JsonWire {
  const poster = identityNamed(seed.poster);
  const contentHex = contentOf(context, seed);
  const claims: JsonWire = {
    room: seed.room,
    poster: hex(poster.deviceId.toString("hex")),
    "poster-key": {
      alg: poster.alg,
      "public-key": hex(poster.publicKey.toString("hex")),
    },
    token: messageOf(context, seed.tokenVector),
    "notice-id": hex(noticeIdHex(seed.noticeIdByte)),
    "posted-at": seed.nowMs,
    "content-type": seed.contentType,
    content: hex(contentHex),
    ...(seed.refs === undefined
      ? {}
      : {
          refs: seed.refs.map((ref) => ({
            id: hex(noticeIdHex(ref.idByte)),
            relation: ref.relation,
          })),
        }),
    ...(seed.validUntil === undefined
      ? {}
      : { "valid-until": seed.validUntil }),
    ...(seed.keyEpoch === undefined ? {} : { "key-epoch": seed.keyEpoch }),
  };
  const base = {
    name: seed.name,
    poster: seed.poster,
    token_vector: seed.tokenVector,
    room: seed.room,
    notice_id_hex: noticeIdHex(seed.noticeIdByte),
    content_type: seed.contentType,
    content_hex: contentHex,
    refs:
      seed.refs === undefined
        ? null
        : seed.refs.map((ref) => ({
            id_hex: noticeIdHex(ref.idByte),
            relation: ref.relation,
          })),
    valid_until: seed.validUntil ?? null,
    key_epoch: seed.keyEpoch ?? null,
    now_ms: seed.nowMs,
    rust_only: seed.refusal !== undefined,
  };
  if (seed.refusal !== undefined) {
    // Creation is refused, so there is no notice to record: the TypeScript cannot hold the value, and its runner skips the case.
    return { ...base, expected: { refusal: seed.refusal } };
  }
  const notice = context.sign(seed.poster, claims);
  context.vectors.push({
    name: `mint_${seed.name}`,
    message: notice.message,
    wire_hex: notice.wireHex,
  });

  return {
    ...base,
    expected: {
      vector: `mint_${seed.name}`,
      verdict: seed.verdict ?? "valid",
    },
  };
}
