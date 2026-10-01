// The per-session noticeboard wiring (wire-mesh#36): composes wire-mesh-core's notice-board primitive with a MeshSession's own frame flow -- the board owns posting, ingesting, and verified+decrypted reads; this module owns the transport policy around it (send the data-have after posting, answer inbound data-haves with catch-up requests, apply inbound data-entries), which data-sync.ts itself deliberately leaves application-side. DOM-free by design: the React layer subscribes to onChange and re-reads; nothing here touches the DOM.

import {
  createNoticeBoard,
  type NoticeBoardEntry,
  type RoomKeyStore,
} from "wire-mesh-core/domain/notice-board";
import {
  handleDataEntries,
  handleDataRequest,
  headSeqFor,
} from "wire-mesh-core/domain/data-sync";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import { sendRoomRekey } from "wire-mesh-core/domain/room-rekey";
import { verifyRoomToken } from "wire-mesh-core/domain/room-token-verification";
import {
  deriveWrappingKey,
  generateContentKey,
  wrapContentKey,
} from "wire-mesh-core/domain/group-key";
import type { RevocationCheck } from "wire-mesh-core/domain/tokens";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type {
  CapabilityToken,
  DeviceId,
  Frame,
} from "wire-mesh-core/generated/protocol";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";

/** How many entries one catch-up data-entries frame may carry -- a bounding constant, not a protocol limit; a larger log simply takes more rounds. */
const CATCH_UP_BATCH_LIMIT = 32;

/** Where a data frame can be sent: a direct peer session or a hub. */
export type DataFrameSender = Pick<MeshSession, "sendDataFrame">;

export interface NoticeWiring {
  /** Observes one inbound frame (pass from a session's own onFrame hook) together with the sender it arrived through, which any reply goes back to. Data-have, data-entries, and data-request are consumed here; everything else is ignored. */
  handleFrame: (frame: Frame, from: Readonly<DataFrameSender>) => void;
  /** Posts an encrypted notice and announces it, with a data-have, to every sender connected at that moment. A sender that is not connected is skipped: the notice is in the own log, and `sync` announces it when that sender connects. */
  post: (options: {
    room: string;
    token: CapabilityToken;
    contentType: string;
    plaintext: Uint8Array;
  }) => Promise<void>;
  /** Verified (and where this side holds the epoch key, decrypted) notices this side holds for one room: the own log plus the logs of `peers`, the room's other members. */
  readRoom: (
    room: string,
    peers: readonly DeviceId[],
  ) => Promise<NoticeBoardEntry[]>;
  /** Announces the own log to `sender` and asks it for the logs of `peers`, as when a connection opens: whatever was posted or written while the two were apart is exchanged. Rejects when the sender is not connected. */
  sync: (
    sender: Readonly<DataFrameSender>,
    peers: readonly DeviceId[],
  ) => Promise<void>;
  /** Asks every connected sender for the logs of `peers`, as when something suggests a peer has written: a message from it arrived. */
  pull: (peers: readonly DeviceId[]) => Promise<void>;
  /** The key store createRoomRekeyHandler's onRekey feeds -- exposed so the rekey wiring and this module share one store. */
  roomKeys: RoomKeyStore;
}

export interface CreateNoticeWiringOptions {
  /** Every sender that is connected right now; consulted on each post. */
  senders: () => readonly DataFrameSender[];
  storage: KeyValueStorage;
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  roomKeys: RoomKeyStore;
  /** Fired after any event that may have changed what readRoom returns. */
  onChange: () => void;
}

export function createNoticeWiring(
  options: Readonly<CreateNoticeWiringOptions>,
): NoticeWiring {
  const { senders, storage, identity, clock, revocation, roomKeys, onChange } =
    options;
  const board = createNoticeBoard({
    identity,
    storage,
    clock,
    revocation,
    roomKeys,
  });

  async function requestCatchUp(
    from: Readonly<DataFrameSender>,
    peer: DeviceId,
  ): Promise<void> {
    const head = await headSeqFor(storage, peer);
    await from.sendDataFrame({
      type: "data-request",
      peer,
      "from-seq": head,
    });
  }

  async function announceOwnLog(to: Readonly<DataFrameSender>): Promise<void> {
    const head = await headSeqFor(storage, identity.deviceId);
    if (head === 0) return;
    await to.sendDataFrame({
      type: "data-have",
      peer: identity.deviceId,
      "head-seq": head,
    });
  }

  function handleFrame(frame: Frame, from: Readonly<DataFrameSender>): void {
    if (frame.type === "data-have") {
      void requestCatchUp(from, frame.peer).catch(() => undefined);
      return;
    }
    if (frame.type === "data-entries") {
      void (async (): Promise<void> => {
        const result = await handleDataEntries(storage, frame);
        if (!result.ok) return;
        // A full batch means the sender may have had more; a short batch means its log ended there. One more round per full batch keeps catch-up bounded without a second bookkeeping mechanism.
        if (frame.entries.length >= CATCH_UP_BATCH_LIMIT) {
          await requestCatchUp(from, frame.peer).catch(() => undefined);
        }
        onChange();
      })();
      return;
    }
    if (frame.type === "data-request") {
      void (async (): Promise<void> => {
        const entries = await handleDataRequest(
          storage,
          frame,
          CATCH_UP_BATCH_LIMIT,
        );
        if (entries !== null) {
          await from.sendDataFrame(entries);
        }
      })().catch(() => undefined);
    }
  }

  return {
    handleFrame,
    async post(postOptions) {
      const { dataHave } = await board.postEncryptedNotice(postOptions);
      await Promise.allSettled(
        senders().map(async (sender) => sender.sendDataFrame(dataHave)),
      );
      onChange();
    },
    async readRoom(room, peers) {
      const own = await board.readOwnNotices(room);
      const perPeer = await Promise.all(
        peers.map(async (peer) => board.readPeerNotices(peer, room)),
      );
      return [...own, ...perPeer.flat()];
    },
    async sync(sender, peers) {
      await announceOwnLog(sender);
      await Promise.all(
        peers.map(async (peer) => requestCatchUp(sender, peer)),
      );
    },
    async pull(peers) {
      await Promise.allSettled(
        senders().flatMap((sender) =>
          peers.map(async (peer) => requestCatchUp(sender, peer)),
        ),
      );
    },
    roomKeys,
  };
}

/** Whether the peer has been given a room's first epoch key, kept so a rekey that failed (the peer offline, or not yet holding its own token) is sent again by the next call instead of being forgotten. */
export interface RoomKeyDelivery {
  isDelivered: (room: string) => Promise<boolean>;
  markDelivered: (room: string) => Promise<void>;
}

export interface BootstrapDmEpoch1Options {
  /** Where the rekey is sent: the direct session to the peer, or a hub with `target` naming the peer to reach through it. */
  session: Pick<MeshSession, "sendManageRequest">;
  target?: DeviceId | undefined;
  identity: IdentityPort;
  clock: Clock;
  revocation: RevocationCheck;
  /** This side's own held room:member token for the DM -- verified fresh, under the rekey-scoped either-participant root policy, to extract the peer's identity-key as the token chain's root. */
  ownRoomMemberToken: CapabilityToken;
  roomPath: string;
  roomKeys: RoomKeyStore;
  delivery: RoomKeyDelivery;
}

/**
 * The DM first-epoch bootstrap (wire-mesh#36): the LOWER device-id participant,
 * once it holds its own join-grant, mints epoch 1 -- generating the content key,
 * storing it locally, and wrapping it for the peer via ECDH against the peer's
 * identity-key, which is exactly the chain root of this side's own granted token
 * (I approved your join, so my token chains to you; your key wraps my epoch).
 * The higher participant never calls this: it waits to receive room.rekey, per
 * the deterministic lower-mints rule that mirrors dmRoomPath's own sorted-pair
 * convention. Idempotent once the peer has acknowledged the key; until then each
 * call sends the same epoch-1 key again, and rejects when the peer cannot take
 * it yet, so the caller can try again later.
 */
export async function bootstrapDmEpoch1(
  options: Readonly<BootstrapDmEpoch1Options>,
): Promise<void> {
  const {
    session,
    target,
    identity,
    clock,
    revocation,
    ownRoomMemberToken,
    roomPath,
    roomKeys,
    delivery,
  } = options;
  const FIRST_EPOCH = 1;
  // Only the lower participant mints epoch 1: dmRoomPath embeds the sorted
  // pair (lower + "+" + higher), so this side mints iff its own hex sorts
  // strictly below the peer's -- the participant names ARE the path halves.
  const lower = roomPath.split("+")[0] ?? "";
  if (lower === "" || deviceIdToHex(identity.deviceId) !== lower) {
    return;
  }
  const epoch = await roomKeys.currentEpoch(roomPath);
  if (epoch !== undefined && epoch !== FIRST_EPOCH) {
    return;
  }
  if (await delivery.isDelivered(roomPath)) {
    return;
  }
  const verdict = await verifyRoomToken(ownRoomMemberToken, {
    identity,
    clock,
    revocation,
    expectedBearer: identity.deviceId,
    roomPath,
    dmRootPolicy: "either-participant",
  });
  if (!verdict.ok) {
    throw new Error(`own room token failed verification: ${verdict.reason}`);
  }
  const deriveSharedSecret = identity.deriveSharedSecret;
  if (deriveSharedSecret === undefined) {
    throw new Error("this identity cannot derive ECDH shared secrets");
  }
  const contentKey =
    epoch === undefined
      ? generateContentKey()
      : await roomKeys.get(roomPath, FIRST_EPOCH);
  if (contentKey === undefined) {
    throw new Error(
      `room ${roomPath} lost its epoch ${String(FIRST_EPOCH)} key`,
    );
  }
  const sharedSecret = await deriveSharedSecret(verdict.rootIssuerKey);
  const wrappingKey = await deriveWrappingKey(sharedSecret, {
    room: roomPath,
    keyEpoch: FIRST_EPOCH,
  });
  const wrapped = await wrapContentKey(wrappingKey, contentKey);
  if (epoch === undefined) {
    await roomKeys.set(roomPath, FIRST_EPOCH, contentKey);
  }
  const outcome = await sendRoomRekey(
    session,
    roomPath,
    FIRST_EPOCH,
    wrapped,
    target,
    ownRoomMemberToken,
  );
  if (outcome.result !== "ok") {
    throw new Error(`room.rekey was refused: ${outcome.code}`);
  }
  await delivery.markDelivered(roomPath);
}
