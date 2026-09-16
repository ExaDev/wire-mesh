/**
 * The application-ready noticeboard (spec/room.cddl's own noticeboard extension of core/room, wire-mesh#36): composes core/data's oplog replication (data-sync.ts), room-notice signing and verification (room.ts), and the room.rekey content-key machinery (group-key.ts, room-rekey.ts) into the one primitive an application actually wires -- post an encrypted notice to your own log, ingest a replicated peer entry, read back a room's notices verified and (where this side holds the epoch key) decrypted.
 *
 * Deliberately NOT included here, matching data-sync.ts's own "primitive vs. policy" split: when to send the returned data-have frame, which peers' logs to track, how to fan a catch-up request out -- all application policy. The board only guarantees what its pieces each already guarantee individually: own-log appends are monotonic, peer ingests are gap-rejecting, and nothing is ever surfaced unverified.
 *
 * readPeerNotices' honest read-confidentiality behaviour: a notice this side cannot decrypt (no key for its epoch -- a pre-join notice, or a post-kick epoch) still verifies and still appears in the read, with plaintext undefined. Authenticity and confidentiality are independent properties; the board never conflates them.
 */

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import {
  roomNoticeSchema,
  type CapabilityToken,
  type DataHaveFrame,
  type DeviceId,
  type RoomNotice,
  type RoomNoticeClaims,
} from "../generated/protocol.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import type { KeyValueStorage } from "../ports/storage.js";
import type { RevocationCheck } from "./tokens.js";
import {
  appendOwnEntry,
  handleDataEntries,
  headSeqFor,
  readEntries,
} from "./data-sync.js";
import {
  createRoomNotice,
  verifyRoomNotice,
  type RoomNoticeVerdictReason,
} from "./room.js";
import {
  decryptNoticeContent,
  encryptNoticeContent,
  encryptedContentType,
  isEncryptedContentType,
  plaintextContentType,
} from "./group-key.js";

/** The opaque byte length a caller-omitted noticeId gets: 16 random bytes, the same sizing token-id already uses. */
const GENERATED_NOTICE_ID_BYTE_LENGTH = 16;

/**
 * Where an application keeps the content keys its createRoomRekeyHandler unwraps, and where the owner's own side stores every epoch key it generated. Room-keyed and epoch-keyed, because a reader must locate exactly the epoch a notice names, never guess.
 */
export interface RoomKeyStore {
  get: (room: string, epoch: number) => Promise<Uint8Array | undefined>;
  set: (room: string, epoch: number, key: Uint8Array) => void;
  /** The highest epoch held for a room -- what postEncryptedNotice stamps a new notice with. */
  currentEpoch: (room: string) => Promise<number | undefined>;
}

/** One notice as read back from a log: always verified-or-not first, decrypted only when both the signature and the epoch key are held. */
export interface NoticeBoardEntry {
  /** Whether verifyRoomNotice passed every obligation. False means nothing else on this entry is populated except reason -- unverified content is never surfaced, not even as ciphertext. */
  verified: boolean;
  /** Why verification failed, when it did. */
  reason?: RoomNoticeVerdictReason;
  /** The notice's own TRUE (suffix-stripped) content-type, on a verified entry. */
  contentType?: string;
  /** The decrypted content, present iff verified AND this side holds the epoch key (or the notice was never encrypted). Undefined means "valid notice, can't read it" -- the confidentiality property, not an error. */
  plaintext?: Uint8Array;
  /** The fully verified claims, on a verified entry -- posted-at, poster, refs, everything a UI renders around the content itself. */
  claims?: RoomNoticeClaims;
}

export interface CreateNoticeBoardOptions {
  identity: IdentityPort;
  storage: KeyValueStorage;
  clock: Clock;
  revocation: RevocationCheck;
  roomKeys: RoomKeyStore;
}

export interface PostEncryptedNoticeOptions {
  room: string;
  /** The poster's own room:member token, embedded in full in the notice. */
  token: CapabilityToken;
  /** The notice's true content-type; the +aes256gcm suffix is applied here, never by the caller. */
  contentType: string;
  plaintext: Uint8Array;
  /** Caller-supplied notice id, matching createRoomNotice's own convention; fresh random bytes when omitted. */
  noticeId?: Uint8Array<ArrayBuffer>;
}

export interface PostedNotice {
  /** The data-have frame announcing the new entry -- the application decides when and to whom to actually send it. */
  dataHave: DataHaveFrame;
  notice: RoomNotice;
  /** The epoch the notice was encrypted under. */
  keyEpoch: number;
}

/** Serialises a minted notice to the canonical CBOR bytes an oplog entry carries. */
function noticeToEntryBytes(
  notice: Readonly<RoomNotice>,
): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encode(notice, cdeEncodeOptions));
}

export function createNoticeBoard(
  options: Readonly<CreateNoticeBoardOptions>,
): {
  postEncryptedNotice: (
    post: Readonly<PostEncryptedNoticeOptions>,
  ) => Promise<PostedNotice>;
  ingestPeerEntry: (
    peer: DeviceId,
    entry: Uint8Array<ArrayBuffer>,
  ) => Promise<void>;
  readOwnNotices: (room: string) => Promise<NoticeBoardEntry[]>;
  readPeerNotices: (
    peer: DeviceId,
    room: string,
  ) => Promise<NoticeBoardEntry[]>;
} {
  const { identity, storage, clock, revocation, roomKeys } = options;

  async function postEncryptedNotice(
    post: Readonly<PostEncryptedNoticeOptions>,
  ): Promise<PostedNotice> {
    const keyEpoch = await roomKeys.currentEpoch(post.room);
    if (keyEpoch === undefined) {
      throw new Error(
        `no content key held for room ${post.room}: room.rekey this room before posting encrypted notices`,
      );
    }
    const contentKey = await roomKeys.get(post.room, keyEpoch);
    if (contentKey === undefined) {
      throw new Error(
        `content key store is inconsistent: epoch ${String(keyEpoch)} is current for room ${post.room} but holds no key`,
      );
    }
    const noticeId: Uint8Array<ArrayBuffer> =
      post.noticeId ??
      crypto.getRandomValues(new Uint8Array(GENERATED_NOTICE_ID_BYTE_LENGTH));
    const ciphertext = await encryptNoticeContent(contentKey, post.plaintext);
    const notice = await createRoomNotice({
      identity,
      clock,
      room: post.room,
      token: post.token,
      noticeId,
      contentType: encryptedContentType(post.contentType),
      content: ciphertext,
      keyEpoch,
    });
    const { haveFrame: dataHave } = await appendOwnEntry(
      { identity, storage },
      noticeToEntryBytes(notice),
    );
    return { dataHave, notice, keyEpoch };
  }

  async function ingestPeerEntry(
    peer: DeviceId,
    entry: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const fromSeq = await headSeqFor(storage, peer);
    const result = await handleDataEntries(storage, {
      type: "data-entries",
      peer,
      "from-seq": fromSeq,
      entries: [entry],
    });
    if (!result.ok) {
      throw new Error(
        `gap rejecting entry for peer log (head ${String(fromSeq)})`,
      );
    }
  }

  async function readLog(
    peer: DeviceId,
    room: string,
  ): Promise<NoticeBoardEntry[]> {
    const entries = await readEntries(storage, peer, 0);
    const out: NoticeBoardEntry[] = [];
    for (const entry of entries) {
      out.push(await readOne(entry, room));
    }
    return out;
  }

  async function readOne(
    entry: Uint8Array,
    room: string,
  ): Promise<NoticeBoardEntry> {
    const notice = decodeNotice(entry);
    if (notice === undefined) {
      return { verified: false, reason: "malformed" };
    }
    const verdict = await verifyRoomNotice(notice, {
      identity,
      clock,
      revocation,
      expectedRoom: room,
    });
    if (!verdict.ok) {
      return { verified: false, reason: verdict.reason };
    }
    const claims = verdict.claims;
    if (!isEncryptedContentType(claims["content-type"])) {
      return {
        verified: true,
        contentType: claims["content-type"],
        plaintext: claims.content,
        claims,
      };
    }
    const keyEpoch = claims["key-epoch"];
    if (keyEpoch === undefined) {
      // Unreachable in practice: verifyRoomNotice's obligation-7 pairing check already refused this shape. Kept as a fail-closed guard.
      return { verified: false, reason: "key_epoch_mismatch" };
    }
    const contentKey = await roomKeys.get(claims.room, keyEpoch);
    const base = {
      verified: true,
      contentType: plaintextContentType(claims["content-type"]),
      claims,
    };
    if (contentKey === undefined) {
      return base;
    }
    try {
      const plaintext = await decryptNoticeContent(contentKey, claims.content);
      return { ...base, plaintext };
    } catch {
      // A held key that fails to decrypt is a genuine inconsistency (the notice wasn't encrypted under the key this epoch actually holds); report it as unreadable rather than as verified-and-empty.
      return base;
    }
  }

  function decodeNotice(entry: Uint8Array): RoomNotice | undefined {
    try {
      const decoded: unknown = decode(entry, cdeDecodeOptions);
      const parsed = roomNoticeSchema.safeParse(decoded);
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    postEncryptedNotice,
    ingestPeerEntry,
    readOwnNotices: async (room: string) => readLog(identity.deviceId, room),
    readPeerNotices: async (peer: DeviceId, room: string) =>
      readLog(peer, room),
  };
}
