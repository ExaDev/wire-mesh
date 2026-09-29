// Owns every conversation this console holds, keyed by room path. A conversation reaches its peer by up to two routes at once: a direct WebRTC connection, when one has been negotiated, and a hub, through a relay pairing and a secure channel, which needs nothing but a connection both sides already have. This module attaches each route as it appears, restores persisted conversations that have no route yet, tracks each one's message history, unread count and any pending join request, and exposes send and respond actions the UI calls into. Kept as one reducer-backed hook rather than one useState per conversation, since a message arriving in one conversation must never re-render (or lose) another's own independently-evolving state.

import { useCallback, useEffect, useReducer, useRef } from "react";
import { acceptMeshSession } from "wire-mesh-core/domain/mesh-session";
import type {
  IncomingManageRequest,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import { createAsyncQueue } from "wire-mesh-core/domain/async-queue";
import type { AsyncQueue } from "wire-mesh-core/domain/async-queue";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type {
  CapabilityToken,
  DeviceId,
  Frame,
} from "wire-mesh-core/generated/protocol";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "wire-mesh-core/domain/room-path";
import {
  createRoomRouter,
  requestToJoin,
  sendRoomMessage,
  type RoomRouterHandlers,
} from "../room-client.js";
import { noRevocationCheck } from "../webrtc-negotiation.js";
import type { MessageStore, StoredMessage } from "../message-store.js";
import {
  participantsOf,
  reduceConversations,
  type ConversationInternal,
  type ConversationView,
  type RelaySender,
} from "../conversations.js";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import type { RoomKeyStore } from "wire-mesh-core/domain/notice-board";
import { createRoomRekeyHandler } from "wire-mesh-core/domain/room-rekey";
import { bootstrapDmEpoch1, createNoticeWiring } from "../notices.js";

// The domains a direct, WebRTC-negotiated peer session offers -- distinct from the connect-form's own domains list, which governs only what this console offers its relay/hub connection. core/management is implied by manage-request/response itself; core/room is what this session actually exists to speak.
const ROOM_SESSION_DOMAINS = ["core/management", "core/room"];
const LOCAL_MESSAGE_ID_BYTE_LENGTH = 16;

function randomLocalMessageId(): Uint8Array {
  const bytes = new Uint8Array(LOCAL_MESSAGE_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** A hub connection as this hook needs it: something to send through, and the stream of room requests that arrive on it from any peer. */
export type HubEndpoint = RelaySender &
  Pick<MeshSession, "incomingManageRequests">;

export interface RoomMessaging {
  conversations: ConversationView[];
  /** Opens the peer's DM conversation over a hub, so it can be used at once with no connection of its own. The direct route is preferred whenever one is attached later. */
  openRelay: (hub: Readonly<RelaySender>, peer: DeviceId) => void;
  /** Starts answering the room requests that arrive on a hub connection, opening a conversation the first time a peer writes. */
  watchHub: (hub: Readonly<HubEndpoint>) => void;
  /** Forgets a hub as a route, as when its connection is closed. */
  dropHub: (hub: Readonly<RelaySender>) => void;
  /** Wires a WebRTC-negotiated Connection up as the direct route of the peer's DM conversation -- either side: this console's own initiate() (knownPeerDevice supplied), or an incoming offer accepted via onIncomingConnection (peer device discovered from AcceptedMeshSession's own peerDeviceId). A no-op if that conversation already has a live session; a conversation restored from storage, or whose session has closed, takes the new one. */
  attach: (
    connection: Readonly<Connection>,
    knownPeerDevice?: DeviceId,
  ) => Promise<void>;
  /** Sends into a conversation. Never rejects: the message shows in the conversation as sending, then either joins its history or stays as a failed message with the reason. */
  send: (roomPath: string, text: string) => Promise<void>;
  /** Retries a failed outgoing message, in place. */
  retry: (roomPath: string, localId: string) => Promise<void>;
  /** Dismisses an outgoing message without sending it. */
  discard: (roomPath: string, localId: string) => void;
  /** Posts one durable encrypted notice to the DM room, over the direct connection only (the notice board syncs with data frames, which a hub route does not carry): joins if no token yet, bootstraps epoch 1 when this side is the lower participant and no epoch exists, then posts and announces via the notice wiring. */
  postNotice: (roomPath: string, text: string) => Promise<void>;
  /** Acknowledges a conversation's unread messages. */
  markRead: (roomPath: string) => void;
}

/** Where a conversation's requests go: the direct session, or a hub with the peer to address. Sending needs one; a conversation restored from storage, or whose routes have all closed, has none. */
function routeOf(entry: Readonly<ConversationInternal> | undefined): {
  session: RelaySender;
  target: DeviceId | undefined;
} {
  if (entry?.direct !== undefined) {
    return { session: entry.direct, target: undefined };
  }
  if (entry?.relay !== undefined) {
    return { session: entry.relay.hub, target: entry.relay.peer };
  }
  throw new Error("conversation is not connected");
}

export function useRoomMessaging(
  identity: IdentityPort,
  clock: Readonly<Clock>,
  messageStore: Readonly<MessageStore>,
): RoomMessaging {
  const [sessions, dispatch] = useReducer(
    reduceConversations,
    new Map<string, ConversationInternal>(),
  );
  const ownDeviceHex = deviceIdToHex(identity.deviceId);

  useEffect(() => {
    const unmounted = new AbortController();
    void (async (): Promise<void> => {
      for (const roomPath of await messageStore.roomPaths()) {
        const messages = await messageStore.list(roomPath);
        if (unmounted.signal.aborted) return;
        dispatch({
          type: "restored",
          roomPath,
          participants: participantsOf(roomPath, ownDeviceHex),
          messages,
        });
      }
    })();
    return () => {
      unmounted.abort();
    };
  }, [messageStore, ownDeviceHex]);
  /** Per-session notice machinery, outside the reducer: mutable wiring state the frame flow drives directly, with reducer-visible changes surfaced through "notices" actions. */
  const noticeState = useRef(
    new Map<
      string,
      {
        wiring: ReturnType<typeof createNoticeWiring>;
        roomKeys: RoomKeyStore;
        refresh: () => void;
      }
    >(),
  );
  /** The latest held token per session, for the lazily-built rekey handler -- a ref, not reducer state, because the handler closes over it at dispatch time and must see the current value. */
  const tokenRef = useRef(new Map<string, CapabilityToken>());

  function makeNoticeLifecycle(
    session: MeshSession,
    roomPath: string,
  ): {
    wiring: ReturnType<typeof createNoticeWiring>;
    roomKeys: RoomKeyStore;
    refresh: () => void;
  } {
    const keys = new Map<string, Map<number, Uint8Array>>();
    const roomKeys: RoomKeyStore = {
      get: async (room, epoch) => Promise.resolve(keys.get(room)?.get(epoch)),
      set: (room, epoch, key) => {
        const perRoom = keys.get(room) ?? new Map<number, Uint8Array>();
        perRoom.set(epoch, key);
        keys.set(room, perRoom);
      },
      currentEpoch: async (room) =>
        Promise.resolve(
          [...(keys.get(room)?.keys() ?? [])].sort((a, b) => b - a)[0],
        ),
    };
    // The wiring's onChange needs refresh; refresh needs the wiring. An
    // object holder breaks the cycle without a let-reassignment: refresh
    // reads lifecycle.wiring, which is populated immediately after
    // construction and can only be called from the wiring's own events (or
    // externally, after construction) -- never before it exists.
    const lifecycle: {
      wiring?: ReturnType<typeof createNoticeWiring>;
    } = {};
    const refresh = (): void => {
      const wiring = lifecycle.wiring;
      if (wiring === undefined) {
        return;
      }
      void wiring.readRoom(roomPath).then((notices) => {
        dispatch({ type: "notices", roomPath, notices: [...notices] });
      });
    };
    const wiring = createNoticeWiring({
      session,
      storage: createMemoryStorage(),
      identity,
      clock,
      revocation: noRevocationCheck,
      roomKeys,
      onChange: () => {
        refresh();
      },
    });
    lifecycle.wiring = wiring;
    return { wiring, roomKeys, refresh };
  }

  /** What to do with each room request that arrives for a conversation, whichever route it came over. `notice` is the conversation's notice board, which only a direct connection has: a rekey that arrives without one is refused, since there is nowhere to keep the key. */
  function roomHandlers(
    roomPath: string,
    notice: ReturnType<typeof makeNoticeLifecycle> | undefined,
  ): RoomRouterHandlers {
    return {
      onMessage: (message) => {
        const stored: StoredMessage = {
          direction: "received",
          text: message.text,
          messageId: message.messageId,
          sentAt: message.sentAt,
        };
        void messageStore.append(roomPath, stored);
        dispatch({ type: "message", roomPath, message: stored });
      },
      onJoinRequest: (event) => {
        dispatch({
          type: "join-request",
          roomPath,
          request: {
            requesterHex: deviceIdToHex(event.requesterDevice),
            async decide(decision): Promise<void> {
              dispatch({ type: "join-request-settled", roomPath });
              await event.decide(decision);
            },
          },
        });
      },
      // The inbound room.rekey path, built lazily per request so the
      // recipient's own token is read at its current value -- tokens
      // arrive only after the join/grant exchange, and a rekey that
      // lands before this side holds one fails closed (no_token) until
      // the peer retries, which the DM bootstrap's lower-mints ordering
      // makes the steady state anyway.
      onRekey: async (incoming) => {
        if (notice === undefined) {
          await incoming.respond({
            result: "error",
            code: "unsupported_route",
          });
          return;
        }
        const ownToken = tokenRef.current.get(roomPath);
        if (ownToken === undefined) {
          await incoming.respond({
            result: "error",
            code: "no_token",
          });
          return;
        }
        const handler = createRoomRekeyHandler({
          identity,
          clock,
          revocation: noRevocationCheck,
          ownRoomMemberToken: ownToken,
          onRekey: (event) => {
            event.contentKeys.forEach((key, i) => {
              notice.roomKeys.set(
                roomPath,
                event.keyEpoch - event.contentKeys.length + 1 + i,
                key,
              );
            });
            notice.refresh();
          },
        });
        await handler(incoming);
      },
    };
  }

  const attach = useCallback(
    async (
      connection: Readonly<Connection>,
      knownPeerDevice?: DeviceId,
    ): Promise<void> => {
      // The wiring needs the session (sendDataFrame) and the session's own
      // onFrame hook needs the wiring -- but the peer's device-id (and with
      // it the DM room path) only resolves after the handshake. A late-bound
      // hook bridges the gap: early frames (handshake/gossip) find nothing
      // to observe; once the lifecycle exists every frame reaches it.
      const frameSink: { current?: (frame: Frame) => void } = {};
      const accepted = await acceptMeshSession(
        connection,
        identity,
        ROOM_SESSION_DOMAINS,
        {
          clock,
          onFrame: (_conn, frame) => {
            frameSink.current?.(frame);
          },
        },
      );
      const peerDevice = knownPeerDevice ?? (await accepted.peerDeviceId);
      const peerHex = deviceIdToHex(peerDevice);
      const roomPath = dmRoomPath(ownDeviceHex, peerHex);
      if (sessions.get(roomPath)?.direct !== undefined) {
        // Both sides can race to negotiate a connection to each other at once; the second one to arrive here yields to whichever direct session the conversation already has rather than duplicating it.
        await accepted.close();
        return;
      }
      const notice = makeNoticeLifecycle(accepted, roomPath);
      noticeState.current.set(roomPath, notice);
      frameSink.current = (frame) => {
        notice.wiring.handleFrame(frame);
      };
      dispatch({
        type: "direct-opened",
        roomPath,
        participants: [peerHex],
        session: accepted,
      });
      dispatch({
        type: "restored",
        roomPath,
        participants: [peerHex],
        messages: await messageStore.list(roomPath),
      });

      createRoomRouter(
        accepted,
        {
          identity,
          clock,
          revocation: noRevocationCheck,
          peerDevice,
          currentMembers: () => [identity.deviceId, peerDevice],
        },
        roomHandlers(roomPath, notice),
      );

      void (async (): Promise<void> => {
        for await (const sessionEvent of accepted.events) {
          if (sessionEvent.state.status === "closed") {
            dispatch({ type: "direct-closed", roomPath });
          }
        }
      })();
    },
    [identity, clock, ownDeviceHex, sessions, messageStore],
  );

  /** One delivery attempt: joins the room if this side holds no token yet, sends, and persists the message. Reports each phase it is in through onPhase, since the join waits on the other side's consent. Throws on any failure; the caller decides how that is surfaced. */
  const deliver = useCallback(
    async (
      roomPath: string,
      text: string,
      onPhase: (phase: "awaiting-approval" | "sending") => void,
    ): Promise<StoredMessage> => {
      const entry = sessions.get(roomPath);
      const { session, target } = routeOf(entry);
      let token = entry?.token;
      if (token === undefined) {
        onPhase("awaiting-approval");
        const joined = await requestToJoin(session, roomPath, target);
        onPhase("sending");
        token = joined.token;
        tokenRef.current.set(roomPath, token);
        dispatch({ type: "token", roomPath, token });
        // Opportunistic DM bootstrap: once this side holds its join-grant,
        // the lower participant mints epoch 1 for the noticeboard. Fire-and-
        // observe rather than awaited -- messaging must not block on it. Only
        // a direct connection has a notice board to bootstrap.
        const notice = noticeState.current.get(roomPath);
        if (entry?.direct !== undefined && notice !== undefined) {
          void bootstrapDmEpoch1({
            session: entry.direct,
            identity,
            clock,
            revocation: noRevocationCheck,
            ownRoomMemberToken: token,
            roomPath,
            roomKeys: notice.roomKeys,
          }).catch(() => undefined);
        }
      }
      const outcome = await sendRoomMessage(
        session,
        roomPath,
        text,
        token,
        target,
      );
      if (outcome.result !== "ok") {
        throw new Error(`send failed: ${outcome.code}`);
      }
      const stored: StoredMessage = {
        direction: "sent",
        text,
        messageId: randomLocalMessageId(),
        sentAt: clock.now(),
      };
      await messageStore.append(roomPath, stored);
      return stored;
    },
    [sessions, clock, messageStore, identity],
  );

  /** Runs one delivery attempt for a pending outgoing message. Success moves it into the history; failure keeps it in the list as failed, with the reason, so the user can retry or dismiss it instead of losing the text. */
  const attempt = useCallback(
    async (roomPath: string, localId: string, text: string): Promise<void> => {
      dispatch({
        type: "outgoing",
        roomPath,
        entry: { localId, text, status: "sending" },
      });
      try {
        const stored = await deliver(roomPath, text, (status) => {
          dispatch({
            type: "outgoing",
            roomPath,
            entry: { localId, text, status },
          });
        });
        dispatch({ type: "message", roomPath, message: stored });
        dispatch({ type: "outgoing-removed", roomPath, localId });
      } catch (error) {
        dispatch({
          type: "outgoing",
          roomPath,
          entry: {
            localId,
            text,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
    [deliver],
  );

  const send = useCallback(
    async (roomPath: string, text: string): Promise<void> =>
      attempt(roomPath, crypto.randomUUID(), text),
    [attempt],
  );

  const retry = useCallback(
    async (roomPath: string, localId: string): Promise<void> => {
      const pending = sessions
        .get(roomPath)
        ?.outgoing.find((entry) => entry.localId === localId);
      if (pending === undefined) return;
      await attempt(roomPath, localId, pending.text);
    },
    [sessions, attempt],
  );

  const discard = useCallback((roomPath: string, localId: string): void => {
    dispatch({ type: "outgoing-removed", roomPath, localId });
  }, []);

  const postNotice = useCallback(
    async (roomPath: string, text: string): Promise<void> => {
      const entry = sessions.get(roomPath);
      const session = entry?.direct;
      const notice = noticeState.current.get(roomPath);
      if (session === undefined || notice === undefined) {
        throw new Error("durable notices need a direct connection");
      }
      let token = entry?.token ?? tokenRef.current.get(roomPath);
      if (token === undefined) {
        const joined = await requestToJoin(session, roomPath);
        token = joined.token;
        tokenRef.current.set(roomPath, token);
        dispatch({ type: "token", roomPath, token });
      }
      // Awaited here (unlike send()'s opportunistic trigger): posting
      // without a key would throw inside the wiring -- the bootstrap must
      // complete first, and for the lower participant it is exactly one
      // wrap + one send.
      await bootstrapDmEpoch1({
        session,
        identity,
        clock,
        revocation: noRevocationCheck,
        ownRoomMemberToken: token,
        roomPath,
        roomKeys: notice.roomKeys,
      });
      await notice.wiring.post({
        room: roomPath,
        token,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode(text),
      });
      notice.refresh();
    },
    [sessions, identity, clock],
  );

  const markRead = useCallback((roomPath: string): void => {
    dispatch({ type: "read", roomPath });
  }, []);

  const openRelay = useCallback(
    (hub: Readonly<RelaySender>, peer: DeviceId): void => {
      const roomPath = dmRoomPath(ownDeviceHex, deviceIdToHex(peer));
      const participants = [deviceIdToHex(peer)];
      dispatch({
        type: "relay-opened",
        roomPath,
        participants,
        route: { hub, peer },
      });
      void messageStore.list(roomPath).then((messages) => {
        dispatch({ type: "restored", roomPath, participants, messages });
      });
    },
    [ownDeviceHex, messageStore],
  );

  const watchHub = useCallback(
    (hub: Readonly<HubEndpoint>): void => {
      // One reader for the hub's room requests, splitting them by the device each channel authenticated: a conversation's router reads only its own peer's, and the first request from a peer opens that peer's conversation.
      const perPeer = new Map<string, AsyncQueue<IncomingManageRequest>>();
      void (async (): Promise<void> => {
        for await (const incoming of hub.incomingManageRequests) {
          const peer = incoming.fromDevice;
          if (peer === undefined) continue;
          const key = deviceIdToHex(peer);
          let queue = perPeer.get(key);
          if (queue === undefined) {
            queue = createAsyncQueue<IncomingManageRequest>();
            perPeer.set(key, queue);
            const roomPath = dmRoomPath(ownDeviceHex, key);
            openRelay(hub, peer);
            createRoomRouter(
              { incomingManageRequests: queue.stream },
              {
                identity,
                clock,
                revocation: noRevocationCheck,
                peerDevice: peer,
                currentMembers: () => [identity.deviceId, peer],
              },
              roomHandlers(roomPath, undefined),
            );
          }
          queue.push(incoming);
        }
      })();
    },
    [identity, clock, ownDeviceHex, openRelay],
  );

  const dropHub = useCallback((hub: Readonly<RelaySender>): void => {
    dispatch({ type: "hub-closed", hub });
  }, []);

  return {
    conversations: [...sessions.values()],
    openRelay,
    watchHub,
    dropHub,
    attach,
    send,
    retry,
    discard,
    postNotice,
    markRead,
  };
}
