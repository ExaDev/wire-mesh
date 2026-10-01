// Owns every conversation this console holds, keyed by room path. A conversation reaches its peer by up to two routes at once: a direct WebRTC connection, when one has been negotiated, and a hub, through a relay pairing and a secure channel, which needs nothing but a connection both sides already have. This module attaches each route as it appears, restores persisted conversations that have no route yet, tracks each one's message history, unread count and any pending join request, and exposes send and respond actions the UI calls into. Kept as one reducer-backed hook rather than one useState per conversation, since a message arriving in one conversation must never re-render (or lose) another's own independently-evolving state.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
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
import {
  deviceIdFromHex,
  deviceIdToHex,
} from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "wire-mesh-core/domain/room-path";
import {
  createRoomRouter,
  requestToJoin,
  sendRoomMessage,
  type RoomRouterHandlers,
} from "../room-client.js";
import type { CapabilityServices } from "../capability-services.js";
import type { MessageStore, StoredMessage } from "../message-store.js";
import {
  participantsOf,
  reduceConversations,
  type ConversationInternal,
  type ConversationView,
  type RelaySender,
} from "../conversations.js";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  createPersistentRoomKeyDelivery,
  createPersistentRoomKeyStore,
  createPersistentRoomTokenStore,
} from "../persistent-room-state.js";
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
  /** Why a message or a grant could not be written to this console's storage, for the person to see. The conversation carries on in memory, but what failed to save will be missing after a reload. */
  persistenceFailure: string | undefined;
  /** Opens the peer's DM conversation over a hub, so it can be used at once with no connection of its own. The direct route is preferred whenever one is attached later. */
  openRelay: (hub: Readonly<RelaySender>, peer: DeviceId) => void;
  /** Starts answering the room requests that arrive on a hub connection, opening a conversation the first time a peer writes. */
  watchHub: (hub: Readonly<HubEndpoint>) => void;
  /** Forgets a hub as a route, as when its connection is closed. */
  dropHub: (hub: Readonly<RelaySender>) => void;
  /** Feeds one frame received on a hub connection. The first frame on a connection, which is also the first after a reconnect, announces this side's notice log to the hub and asks it for the logs of every peer this console talks to. */
  onHubFrame: (
    hub: Readonly<RelaySender>,
    connection: Readonly<Connection>,
    frame: Frame,
  ) => void;
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
  /** Posts one durable encrypted notice to the DM room, over whichever route the conversation has: joins if no token yet, bootstraps epoch 1 when this side is the lower participant and no epoch exists, then posts. The notice is announced to every connected route, and a hub that holds it delivers it to a peer that was offline. */
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
  roomStorage: Readonly<KeyValueStorage>,
  capabilities: Readonly<CapabilityServices>,
): RoomMessaging {
  const { revocation, grants } = capabilities;
  const [sessions, dispatch] = useReducer(
    reduceConversations,
    new Map<string, ConversationInternal>(),
  );
  const ownDeviceHex = deviceIdToHex(identity.deviceId);
  const [persistenceFailure, setPersistenceFailure] = useState<
    string | undefined
  >(undefined);
  /** Runs a write nothing waits for, reporting its failure instead of leaving an unhandled rejection. */
  const persist = useCallback((write: Readonly<Promise<unknown>>): void => {
    write.then(undefined, (error: unknown) => {
      setPersistenceFailure(
        error instanceof Error ? error.message : String(error),
      );
    });
  }, []);

  /** The latest conversations and hubs, for callbacks that outlive the render that created them. */
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);
  const hubsRef = useRef(new Set<Readonly<RelaySender>>());
  const seenConnectionsRef = useRef(new WeakSet<object>());
  const roomKeyStore = useMemo(
    () => createPersistentRoomKeyStore(roomStorage),
    [roomStorage],
  );

  /** The other members of every conversation this console holds. */
  function knownPeers(): DeviceId[] {
    return [...sessionsRef.current.values()].flatMap((entry) =>
      entry.participants.map((hex) => deviceIdFromHex(hex)),
    );
  }

  const refreshAllRef = useRef<() => void>(() => undefined);
  const noticeWiring = useMemo(
    () =>
      createNoticeWiring({
        senders: () => [
          ...new Set([
            ...[...sessionsRef.current.values()].flatMap((entry) => [
              ...(entry.direct === undefined ? [] : [entry.direct]),
              ...(entry.relay === undefined ? [] : [entry.relay.hub]),
            ]),
            ...hubsRef.current,
          ]),
        ],
        storage: roomStorage,
        identity,
        clock,
        revocation,
        roomKeys: roomKeyStore,
        onChange: () => {
          refreshAllRef.current();
        },
      }),
    [identity, clock, roomStorage, roomKeyStore, revocation],
  );

  /** Re-reads one conversation's notices into its state. */
  function refreshRoom(roomPath: string): void {
    const participants = sessionsRef.current.get(roomPath)?.participants;
    if (participants === undefined) return;
    void noticeWiring
      .readRoom(
        roomPath,
        participants.map((hex) => deviceIdFromHex(hex)),
      )
      .then((notices) => {
        dispatch({ type: "notices", roomPath, notices: [...notices] });
      });
  }
  useEffect(() => {
    refreshAllRef.current = (): void => {
      for (const roomPath of sessionsRef.current.keys()) {
        refreshRoom(roomPath);
      }
    };
  });

  /** The latest held token per session, for the lazily-built rekey handler -- a ref, not reducer state, because the handler closes over it at dispatch time and must see the current value. */
  const tokenRef = useRef(new Map<string, CapabilityToken>());
  const keyDelivery = useMemo(
    () => createPersistentRoomKeyDelivery(roomStorage),
    [roomStorage],
  );
  const tokenStore = useMemo(
    () =>
      createPersistentRoomTokenStore(roomStorage, identity, clock, revocation),
    [roomStorage, identity, clock, revocation],
  );
  /** Holds a token for the session and keeps it across reloads. */
  async function rememberToken(
    roomPath: string,
    token: CapabilityToken,
  ): Promise<void> {
    tokenRef.current.set(roomPath, token);
    await tokenStore.set(roomPath, token);
  }
  /** The token held for a room: the one from this session, otherwise one kept from an earlier session that still verifies. */
  async function heldToken(
    roomPath: string,
  ): Promise<CapabilityToken | undefined> {
    const current = tokenRef.current.get(roomPath);
    if (current !== undefined) return current;
    const restored = await tokenStore.get(roomPath);
    if (restored !== undefined) tokenRef.current.set(roomPath, restored);
    return restored;
  }

  useEffect(() => {
    const unmounted = new AbortController();
    void (async (): Promise<void> => {
      const roomPaths = new Set([
        ...(await messageStore.roomPaths()),
        ...(await tokenStore.rooms()),
      ]);
      for (const roomPath of roomPaths) {
        const messages = await messageStore.list(roomPath);
        if (unmounted.signal.aborted) return;
        const participants = participantsOf(roomPath, ownDeviceHex);
        dispatch({ type: "restored", roomPath, participants, messages });
        // The reducer has not applied the action yet, so the notices are read for the participants directly.
        void noticeWiring
          .readRoom(
            roomPath,
            participants.map((hex) => deviceIdFromHex(hex)),
          )
          .then((notices) => {
            dispatch({ type: "notices", roomPath, notices: [...notices] });
          });
      }
    })();
    return () => {
      unmounted.abort();
    };
  }, [messageStore, tokenStore, noticeWiring, ownDeviceHex]);

  /** The first-epoch deliveries under way, by room: a second call for a room joins the first instead of starting its own, because two that both found no key would each mint one and leave the two sides holding different keys. */
  const firstEpochInFlight = useRef(new Map<string, Promise<void>>());

  /** Hands the peer the DM's first epoch key if this side is the one that mints it and the peer has not yet acknowledged it. Rejects when the peer cannot take it yet. */
  async function deliverFirstEpoch(
    roomPath: string,
    token: CapabilityToken,
    route: { session: RelaySender; target: DeviceId | undefined },
  ): Promise<void> {
    const running = firstEpochInFlight.current.get(roomPath);
    if (running !== undefined) return running;
    const delivery = bootstrapDmEpoch1({
      session: route.session,
      target: route.target,
      identity,
      clock,
      revocation,
      ownRoomMemberToken: token,
      roomPath,
      roomKeys: roomKeyStore,
      delivery: keyDelivery,
    }).finally(() => {
      firstEpochInFlight.current.delete(roomPath);
    });
    firstEpochInFlight.current.set(roomPath, delivery);
    return delivery;
  }

  /** What to do with each room request that arrives for a conversation, whichever route it came over. */
  function roomHandlers(roomPath: string): RoomRouterHandlers {
    return {
      onMessage: (message) => {
        const stored: StoredMessage = {
          direction: "received",
          text: message.text,
          messageId: message.messageId,
          sentAt: message.sentAt,
        };
        persist(messageStore.append(roomPath, stored));
        dispatch({ type: "message", roomPath, message: stored });
        // A peer that is writing may have written notices too, and a hub does not announce them to the other side.
        void noticeWiring.pull(
          (sessionsRef.current.get(roomPath)?.participants ?? []).map((hex) =>
            deviceIdFromHex(hex),
          ),
        );
      },
      onGrantIssued: (token) => {
        persist(grants.record("issued", token, clock.now()));
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
              // Once the peer holds its token it can take the first epoch key, which a rekey sent before then could not.
              void (async (): Promise<void> => {
                const token = await heldToken(roomPath);
                const entry = sessionsRef.current.get(roomPath);
                if (token === undefined || entry === undefined) return;
                await deliverFirstEpoch(roomPath, token, routeOf(entry));
              })().catch(() => undefined);
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
        const ownToken = await heldToken(roomPath);
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
          revocation: revocation,
          ownRoomMemberToken: ownToken,
          onRekey: async (event) => {
            for (const [i, key] of event.contentKeys.entries()) {
              await roomKeyStore.set(
                roomPath,
                event.keyEpoch - event.contentKeys.length + 1 + i,
                key,
              );
            }
            refreshRoom(roomPath);
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
      // The peer's device-id (and with it the DM room path) only resolves
      // after the handshake, but the session's onFrame hook exists from the
      // start; a late-bound sink bridges the gap: early frames (handshake,
      // gossip) find nothing to observe, and once the sink is set every frame
      // reaches the notice wiring.
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
      frameSink.current = (frame) => {
        noticeWiring.handleFrame(frame, accepted);
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
      void noticeWiring.sync(accepted, [peerDevice]).catch(() => undefined);

      createRoomRouter(
        accepted,
        {
          identity,
          clock,
          revocation: revocation,
          peerDevice,
          currentMembers: () => [identity.deviceId, peerDevice],
        },
        roomHandlers(roomPath),
      );

      void (async (): Promise<void> => {
        for await (const sessionEvent of accepted.events) {
          if (sessionEvent.state.status === "closed") {
            dispatch({ type: "direct-closed", roomPath });
          }
        }
      })();
    },
    [identity, clock, ownDeviceHex, sessions, messageStore, noticeWiring],
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
        await rememberToken(roomPath, token);
        persist(grants.record("held", token, clock.now()));
        dispatch({ type: "token", roomPath, token });
        // Opportunistic DM bootstrap: once this side holds its join-grant,
        // the lower participant mints epoch 1 for the noticeboard. Fire-and-
        // observe rather than awaited -- messaging must not block on it.
        void deliverFirstEpoch(roomPath, token, { session, target }).catch(
          () => undefined,
        );
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
    [sessions, clock, messageStore, identity, roomKeyStore],
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
      const { session, target } = routeOf(entry);
      let token = entry?.token ?? (await heldToken(roomPath));
      if (token === undefined) {
        const joined = await requestToJoin(session, roomPath, target);
        token = joined.token;
        await rememberToken(roomPath, token);
        persist(grants.record("held", token, clock.now()));
        dispatch({ type: "token", roomPath, token });
      }
      // Awaited here (unlike send()'s opportunistic trigger): posting
      // without a key would throw inside the wiring -- the bootstrap must
      // complete first, and for the lower participant it is exactly one
      // wrap + one send.
      await deliverFirstEpoch(roomPath, token, { session, target });
      await noticeWiring.post({
        room: roomPath,
        token,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode(text),
      });
      refreshRoom(roomPath);
    },
    [sessions, identity, clock, roomKeyStore, noticeWiring],
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
      void noticeWiring.sync(hub, [peer]).catch(() => undefined);
    },
    [ownDeviceHex, messageStore, noticeWiring],
  );

  const watchHub = useCallback(
    (hub: Readonly<HubEndpoint>): void => {
      // One reader for the hub's room requests, splitting them by the device each channel authenticated: a conversation's router reads only its own peer's, and the first request from a peer opens that peer's conversation.
      const perPeer = new Map<string, AsyncQueue<IncomingManageRequest>>();
      hubsRef.current.add(hub);
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
                revocation: revocation,
                peerDevice: peer,
                currentMembers: () => [identity.deviceId, peer],
              },
              roomHandlers(roomPath),
            );
          }
          queue.push(incoming);
        }
      })();
    },
    [identity, clock, ownDeviceHex, openRelay],
  );

  const dropHub = useCallback((hub: Readonly<RelaySender>): void => {
    hubsRef.current.delete(hub);
    dispatch({ type: "hub-closed", hub });
  }, []);

  const onHubFrame = useCallback(
    (
      hub: Readonly<RelaySender>,
      connection: Readonly<Connection>,
      frame: Frame,
    ): void => {
      if (!seenConnectionsRef.current.has(connection)) {
        seenConnectionsRef.current.add(connection);
        void noticeWiring.sync(hub, knownPeers()).catch(() => undefined);
      }
      noticeWiring.handleFrame(frame, hub);
    },
    [noticeWiring],
  );

  return {
    conversations: [...sessions.values()],
    persistenceFailure,
    openRelay,
    watchHub,
    dropHub,
    onHubFrame,
    attach,
    send,
    retry,
    discard,
    postNotice,
    markRead,
  };
}
