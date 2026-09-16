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
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type {
  CapabilityToken,
  DeviceId,
  Frame,
} from "wire-mesh-core/generated/protocol";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import type { RevocationCheck } from "wire-mesh-core/domain/tokens";

/** How many entries one catch-up data-entries frame may carry -- a bounding constant, not a protocol limit; a larger log simply takes more rounds. */
const CATCH_UP_BATCH_LIMIT = 32;

export interface NoticeWiring {
  /** Observes one inbound frame (pass from the session's own onFrame hook). Data-have, data-entries, and data-request are consumed here; everything else is ignored. */
  handleFrame: (frame: Frame) => void;
  /** Posts an encrypted notice and immediately announces it with a data-have on the wire. */
  post: (options: {
    room: string;
    token: CapabilityToken;
    contentType: string;
    plaintext: Uint8Array;
  }) => Promise<void>;
  /** Verified (and where this side holds the epoch key, decrypted) notices this side holds for one room, across every tracked peer log plus the own log. */
  readRoom: (room: string) => Promise<NoticeBoardEntry[]>;
  /** The key store createRoomRekeyHandler's onRekey feeds -- exposed so the rekey wiring and this module share one store. */
  roomKeys: RoomKeyStore;
}

export interface CreateNoticeWiringOptions {
  session: MeshSession;
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
  const { session, storage, identity, clock, revocation, roomKeys, onChange } =
    options;
  const board = createNoticeBoard({
    identity,
    storage,
    clock,
    revocation,
    roomKeys,
  });
  /** Logs this side tracks: hex device-id key (bytewise device-ids are reference-compared by Map, so equal bytes from separately decoded frames would duplicate), value the peer's device id. Seeded once the peer's first data-have arrives. */
  const trackedPeers = new Map<string, DeviceId>();

  async function requestCatchUp(peer: DeviceId): Promise<void> {
    const head = await headSeqFor(storage, peer);
    await session.sendDataFrame({
      type: "data-request",
      peer,
      "from-seq": head,
    });
  }

  function handleFrame(frame: Frame): void {
    if (frame.type === "data-have") {
      trackedPeers.set(deviceIdToHex(frame.peer), frame.peer);
      void requestCatchUp(frame.peer).catch(() => undefined);
      return;
    }
    if (frame.type === "data-entries") {
      void (async (): Promise<void> => {
        const result = await handleDataEntries(storage, frame);
        if (!result.ok) return;
        // A full batch means the sender may have had more; a short batch means its log ended there. One more round per full batch keeps catch-up bounded without a second bookkeeping mechanism.
        if (frame.entries.length >= CATCH_UP_BATCH_LIMIT) {
          await requestCatchUp(frame.peer).catch(() => undefined);
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
          await session.sendDataFrame(entries);
        }
      })().catch(() => undefined);
    }
  }

  return {
    handleFrame,
    async post(postOptions) {
      const { dataHave } = await board.postEncryptedNotice(postOptions);
      await session.sendDataFrame(dataHave);
      onChange();
    },
    async readRoom(room) {
      const own = await board.readOwnNotices(room);
      const perPeer = await Promise.all(
        [...trackedPeers.values()].map(async (peer) =>
          board.readPeerNotices(peer, room),
        ),
      );
      return [...own, ...perPeer.flat()];
    },
    roomKeys,
  };
}
