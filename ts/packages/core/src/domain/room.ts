/**
 * Room-notice verification (spec/room.cddl's own noticeboard extension of core/room). A room-notice is self-certifying the same way a capability-token or revocation-entry already is: a bare cose-sign1 whose payload carries its own signer's key, so a reader verifies posting authority from the entry alone, with no prior contact with the poster and no central gatekeeper. This module is the first TypeScript verifier for it -- no `room.ts` domain module existed anywhere before this, despite the CDDL claim (including `valid-until`) having shipped already.
 */

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  roomNoticeClaimsSchema,
  type CapabilityToken,
  type MessageRef,
  type RoomNotice,
  type RoomNoticeClaims,
  type RoomPath,
} from "../generated/protocol.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import type { RevocationCheck } from "./tokens.js";
import {
  verifyRoomToken,
  type RoomTokenVerdictReason,
} from "./room-token-verification.js";

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

/** The COSE protected header a room-notice signs over: label 1 (alg) and label 4 (kid, the poster's own device-id) -- the identical shape tokens.ts's own protectedHeaderFor uses for capability-token/revocation-entry envelopes, reimplemented here rather than imported since tokens.ts does not export it (matching sig1ToBeSigned's own precedent below). verifyRoomNotice never inspects this header's own decoded content -- it only needs the same bytes fed back into its own signature check -- but a real, kid-bearing header keeps a room-notice's wire shape consistent with every other signed envelope in this spec, rather than the empty header a merely-self-consistent test fixture can get away with. */
function protectedHeaderFor(identity: IdentityPort): Uint8Array<ArrayBuffer> {
  return encodeBuf({ 1: identity.identityKey.alg, 4: identity.deviceId });
}

/**
 * RFC 9052 §4.4 Sig_structure for a COSE_Sign1 with no external AAD -- identical in shape to tokens.ts's own private helper of the same name, but reimplemented here rather than imported, since tokens.ts does not export it. Worth consolidating into a shared cose.ts once a third caller needs the identical helper, but two independent five-line copies is not yet a real duplication problem on its own.
 */
function sig1ToBeSigned(
  protectedHeader: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  return encode(
    ["Signature1", protectedHeader, new Uint8Array(0), payload],
    cdeEncodeOptions,
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Lexicographic (bytewise-ascending) ordering -- the same convention room.cddl's own DM room-path already uses for its sorted pair. Shorter-but-equal-prefix sorts first, matching how Uint8Array.prototype comparisons behave nowhere natively, so this exists at all. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const byteA = a[i];
    const byteB = b[i];
    // Unreachable: i is bounded by Math.min(a.length, b.length), so both indices are always in range -- noUncheckedIndexedAccess just can't see that statically.
    if (byteA === undefined || byteB === undefined) {
      throw new Error("compareBytes: index out of range");
    }
    if (byteA !== byteB) return byteA - byteB;
  }
  return a.length - b.length;
}

export type RoomNoticeVerdictReason =
  | "malformed"
  | "wrong_room"
  | "bad_signature"
  | "wrong_poster"
  | "content_expired"
  | RoomTokenVerdictReason;

export type RoomNoticeVerdict =
  | { ok: true; claims: RoomNoticeClaims }
  | { ok: false; reason: RoomNoticeVerdictReason };

export interface VerifyRoomNoticeOptions {
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /**
   * When given, refuses any notice not claiming exactly this room -- "is this the room I actually asked to read", checked against the notice's own self-declared `room` field before any cryptographic work, so a caller scanning a mixed stream of notices can cheaply skip ones for other rooms. Independent of, and layered on top of, this function's own unconditional internal self-consistency check (the embedded token's scope.path MUST equal the notice's own `room` field regardless of whether expectedRoom is given at all) -- a notice can be internally self-consistent yet still be for a room other than the one a caller expected, and this is the option that catches that case. Mirrors verifyCapabilityToken's own optional expectedBearer for the same "also assert it matches what I expected" shape.
   */
  expectedRoom?: RoomPath;
}

/**
 * Verifies one room-notice (spec/room.cddl) against every obligation its own "Six verifier obligations" comment documents, including `valid-until` (obligation 6): the envelope is a well-formed COSE_Sign1 whose signature verifies against its own embedded poster-key, and poster-key is self-certifying (sha256(poster-key.public-key) equals poster); the embedded token independently passes every ordinary capability-token obligation (signature, expiry, not-before, revocation, delegations- remaining, and -- since the embedded token is itself room-scoped -- the chain-root and scope obligations spec/room.cddl's own six general verifier obligations require of any room:member token) with its bearer pinned to this notice's own `poster` field and its scope pinned to this notice's own `room` field; and, if present, `valid-until` has not yet elapsed as of the injected clock. Checks run cheapest-and-structural first, signature next, the recursive token-chain verification last, mirroring tokens.ts's own ordering discipline.
 *
 * Cross-author ordering (obligation 4) is deliberately NOT checked here -- it is a property of how a reader merges several posters' notices into one sequence, not a pass/fail condition on any single notice. Use compareRoomNotices for that once notices are already individually verified.
 *
 * Revocation (obligation 5) needs no separate step of its own: verifying the embedded token below already walks the full delegation chain against `options.revocation` as part of ordinary capability-token verification, and obligation 5 explicitly disclaims any retroactive "was the poster revoked as of posted-at" check -- only the token's own present-tense validity matters, which the embedded-token verification already establishes.
 */
export async function verifyRoomNotice(
  notice: RoomNotice,
  options: Readonly<VerifyRoomNoticeOptions>,
): Promise<RoomNoticeVerdict> {
  const [protectedHeader, , payload, signature] = notice;
  if (payload === null) {
    return { ok: false, reason: "malformed" };
  }

  let decoded: unknown;
  try {
    decoded = decode(payload, cdeDecodeOptions);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parsed = roomNoticeClaimsSchema.safeParse(decoded);
  if (!parsed.success) {
    return { ok: false, reason: "malformed" };
  }
  const claims = parsed.data;

  if (
    options.expectedRoom !== undefined &&
    claims.room !== options.expectedRoom
  ) {
    return { ok: false, reason: "wrong_room" };
  }

  const signatureOk = await options.identity.verify(
    claims["poster-key"],
    sig1ToBeSigned(protectedHeader, payload),
    signature,
  );
  if (!signatureOk) {
    return { ok: false, reason: "bad_signature" };
  }

  const derivedPosterId = await options.identity.deriveDeviceId(
    claims["poster-key"]["public-key"],
  );
  if (!bytesEqual(derivedPosterId, claims.poster)) {
    return { ok: false, reason: "wrong_poster" };
  }

  const validUntil = claims["valid-until"];
  if (validUntil !== undefined && validUntil <= options.clock.now()) {
    return { ok: false, reason: "content_expired" };
  }

  const tokenVerdict = await verifyRoomToken(claims.token, {
    identity: options.identity,
    clock: options.clock,
    revocation: options.revocation,
    // Obligation 2 (bearer MUST equal poster): a live room verb binds a token's bearer to the peer identity authenticated on the arriving connection; a notice has no connection to bind to, so its own signed `poster` field stands in for that role here -- the underlying check (claims.bearer === expectedBearer) is the identical structural equality either way, only the source of the compared value differs.
    expectedBearer: claims.poster,
    // Obligation 3 (scope.kind MUST be "room" and scope.path MUST equal this notice's own `room` field): this notice's internal self-consistency, independent of options.expectedRoom above, which instead asserts the room against what the CALLER expected.
    roomPath: claims.room,
  });
  if (!tokenVerdict.ok) {
    return { ok: false, reason: tokenVerdict.reason };
  }

  return { ok: true, claims };
}

/**
 * Deterministic display ordering for room-notice entries from possibly several different posters (spec/room.cddl obligation 4): sorts by (posted-at, poster, notice-id), the exact tiebreak idiom the CDDL comment specifies -- the same "lowest wins" idea coordinator-frame's own lowest-device-id rule already uses for equal-term claims elsewhere in this spec. Takes already-verified claims (the output of verifyRoomNotice) -- this is purely a merge-order comparator, never a validity check, so it is kept structurally separate from verifyRoomNotice's own pass/fail verdict.
 */
export function compareRoomNotices(
  a: Readonly<RoomNoticeClaims>,
  b: Readonly<RoomNoticeClaims>,
): number {
  if (a["posted-at"] !== b["posted-at"]) {
    return a["posted-at"] - b["posted-at"];
  }
  const posterOrder = compareBytes(a.poster, b.poster);
  if (posterOrder !== 0) return posterOrder;
  return compareBytes(a["notice-id"], b["notice-id"]);
}

export interface CreateRoomNoticeOptions {
  identity: IdentityPort;
  clock: Clock;
  room: RoomPath;
  /** The poster's own room:member token, embedded in full -- a reader checks token-claims.bearer against this notice's own signed poster field (see verifyRoomNotice's own obligation 2), so there is no live connection for the bearer binding to ride on the way a real room.send has. */
  token: CapabilityToken;
  /** Caller-supplied, matching mintCapabilityToken's own tokenId/mintRevocationEntry's own tokenId convention -- this module has no opinion on how a noticeId is generated (random bytes, a counter, anything else), only that it is unique enough for compareRoomNotices' own cross-author tiebreak to work. */
  noticeId: Uint8Array<ArrayBuffer>;
  contentType: string;
  content: Uint8Array<ArrayBuffer>;
  refs?: readonly MessageRef[];
  validUntil?: number;
  /** Which room.rekey epoch content is encrypted under (wire-mesh#141), present iff content-type names an encrypted content-type -- see room-notice-claims' own obligation 7 comment in room.cddl. This function does not itself encrypt content: the caller encrypts via group-key.ts's encryptNoticeContent beforehand and passes the resulting ciphertext as content, exactly as it would pass any other opaque bytes. */
  keyEpoch?: number;
}

/**
 * Mints one self-certifying room-notice as `identity` -- the counterpart to verifyRoomNotice above, producing exactly what it accepts. `posted-at` is always stamped from the injected clock, never caller-supplied, matching obligation 4's own requirement that a poster's own log stay non-decreasing: a caller backdating its own posted-at would be indistinguishable from a clock bug at mint time, so this function simply doesn't expose the field to override.
 */
export async function createRoomNotice(
  options: Readonly<CreateRoomNoticeOptions>,
): Promise<RoomNotice> {
  const claims: RoomNoticeClaims = {
    room: options.room,
    poster: options.identity.deviceId,
    "poster-key": options.identity.identityKey,
    token: options.token,
    "notice-id": options.noticeId,
    "posted-at": options.clock.now(),
    "content-type": options.contentType,
    content: options.content,
    ...(options.refs !== undefined ? { refs: [...options.refs] } : {}),
    ...(options.validUntil !== undefined
      ? { "valid-until": options.validUntil }
      : {}),
    ...(options.keyEpoch !== undefined
      ? { "key-epoch": options.keyEpoch }
      : {}),
  };
  const payload = encodeBuf(claims);
  const protectedHeader = protectedHeaderFor(options.identity);
  const signature = await options.identity.sign(
    sig1ToBeSigned(protectedHeader, payload),
  );
  return [protectedHeader, {}, payload, signature];
}
