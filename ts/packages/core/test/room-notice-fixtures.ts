import { cdeEncodeOptions, encode } from "cbor2";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  CapabilityToken,
  DeviceId,
  MessageRef,
  RoomNotice,
  RoomNoticeClaims,
} from "../src/generated/protocol.js";

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

function encodeBuf(value: unknown): Uint8Array<ArrayBuffer> {
  return buf(encode(value, cdeEncodeOptions));
}

let issuedNoticeIds = 0;
/** A fresh, distinct notice-id per call -- the tests only need each notice to be distinguishable from the others, not any particular byte value. */
export function nextNoticeId(): Uint8Array<ArrayBuffer> {
  issuedNoticeIds += 1;
  return buf([issuedNoticeIds]);
}

export interface RoomNoticeSeed {
  room: string;
  /** The notice's own self-declared poster device-id. Defaults to `identity.deviceId` when omitted; tests exercising the self-certification obligation (obligation 1) pass a deliberately mismatched value instead. */
  poster?: DeviceId;
  token: CapabilityToken;
  noticeId?: Uint8Array<ArrayBuffer>;
  postedAt: number;
  contentType?: string;
  content?: Uint8Array<ArrayBuffer>;
  refs?: MessageRef[];
  validUntil?: number;
  /** Which room.rekey epoch content is encrypted under -- room.cddl obligation 7 requires this iff contentType carries the +aes256gcm suffix; the two RED tests in room-notice-verification.test.ts exercise exactly that pairing. */
  keyEpoch?: number;
}

/** Builds and signs one room-notice (a bare cose-sign1 over room-notice-claims) as `identity` -- explicit field-by-field construction, mirroring tokens-fixtures.ts's own signToken, since RoomNoticeClaims' `.catchall(z.unknown())` extension tail would otherwise lose specific field types under a spread. Deliberately performs none of verifyRoomNotice's own checks -- tests exercising its enforcement need to construct notices it would refuse. */
export async function signRoomNotice(
  identity: IdentityPort,
  seed: RoomNoticeSeed,
): Promise<RoomNotice> {
  const claims: RoomNoticeClaims = {
    room: seed.room,
    poster: seed.poster ?? identity.deviceId,
    "poster-key": identity.identityKey,
    token: seed.token,
    "notice-id": seed.noticeId ?? nextNoticeId(),
    "posted-at": seed.postedAt,
    "content-type": seed.contentType ?? "text/plain",
    content: seed.content ?? buf(new TextEncoder().encode("hello")),
    ...(seed.refs !== undefined ? { refs: seed.refs } : {}),
    ...(seed.validUntil !== undefined
      ? { "valid-until": seed.validUntil }
      : {}),
    ...(seed.keyEpoch !== undefined ? { "key-epoch": seed.keyEpoch } : {}),
  };

  const payload = encodeBuf(claims);
  const protectedHeader = encodeBuf({});
  const toBeSigned = encodeBuf([
    "Signature1",
    protectedHeader,
    new Uint8Array(0),
    payload,
  ]);
  const signature = await identity.sign(toBeSigned);
  return [protectedHeader, {}, payload, signature];
}
