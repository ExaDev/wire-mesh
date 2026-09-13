// Owns every peer-to-peer room session this console has open: attaching a negotiated WebRTC Connection as a full room session, tracking each one's message history and any pending join request, and exposing send/respond actions the UI calls into. Kept as one reducer-backed hook rather than one useState per session, since a message arriving for peer A must never re-render (or lose) peer B's own independently-evolving state.

import { useCallback, useReducer } from "react";
import { acceptMeshSession } from "wire-mesh-core/domain/mesh-session";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { Clock } from "wire-mesh-core/ports/clock";
import type {
  CapabilityToken,
  DeviceId,
} from "wire-mesh-core/generated/protocol";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "wire-mesh-core/domain/room-path";
import {
  createRoomRouter,
  requestToJoin,
  sendRoomMessage,
} from "../room-client.js";
import type { RoomJoinDecision } from "../room-client.js";
import { noRevocationCheck } from "../webrtc-negotiation.js";
import type { MessageStore, StoredMessage } from "../message-store.js";

// The domains a direct, WebRTC-negotiated peer session offers -- distinct from the connect-form's own domains list, which governs only what this console offers its relay/hub connection. core/management is implied by manage-request/response itself; core/room is what this session actually exists to speak.
const ROOM_SESSION_DOMAINS = ["core/management", "core/room"];
const LOCAL_MESSAGE_ID_BYTE_LENGTH = 16;

function randomLocalMessageId(): Uint8Array {
  const bytes = new Uint8Array(LOCAL_MESSAGE_ID_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return bytes;
}

export interface PendingJoinRequest {
  requesterHex: string;
  decide: (decision: Readonly<RoomJoinDecision>) => Promise<void>;
}

export interface RoomSessionView {
  peerHex: string;
  roomPath: string;
  status: "connected" | "closed";
  messages: readonly StoredMessage[];
  pendingJoinRequest: PendingJoinRequest | undefined;
}

interface RoomSessionInternal extends RoomSessionView {
  session: MeshSession;
  token: CapabilityToken | undefined;
}

type Action =
  | { type: "opened"; peerHex: string; roomPath: string; session: MeshSession }
  | { type: "message"; peerHex: string; message: StoredMessage }
  | { type: "join-request"; peerHex: string; request: PendingJoinRequest }
  | { type: "join-request-settled"; peerHex: string }
  | { type: "token"; peerHex: string; token: CapabilityToken }
  | { type: "closed"; peerHex: string };

function reduce(
  state: ReadonlyMap<string, RoomSessionInternal>,
  action: Readonly<Action>,
): ReadonlyMap<string, RoomSessionInternal> {
  const next = new Map(state);
  switch (action.type) {
    case "opened": {
      next.set(action.peerHex, {
        peerHex: action.peerHex,
        roomPath: action.roomPath,
        session: action.session,
        token: undefined,
        status: "connected",
        messages: [],
        pendingJoinRequest: undefined,
      });
      return next;
    }
    case "message": {
      const entry = next.get(action.peerHex);
      if (entry === undefined) return state;
      next.set(action.peerHex, {
        ...entry,
        messages: [...entry.messages, action.message],
      });
      return next;
    }
    case "join-request": {
      const entry = next.get(action.peerHex);
      if (entry === undefined) return state;
      next.set(action.peerHex, {
        ...entry,
        pendingJoinRequest: action.request,
      });
      return next;
    }
    case "join-request-settled": {
      const entry = next.get(action.peerHex);
      if (entry === undefined) return state;
      next.set(action.peerHex, { ...entry, pendingJoinRequest: undefined });
      return next;
    }
    case "token": {
      const entry = next.get(action.peerHex);
      if (entry === undefined) return state;
      next.set(action.peerHex, { ...entry, token: action.token });
      return next;
    }
    case "closed": {
      const entry = next.get(action.peerHex);
      if (entry === undefined) return state;
      next.set(action.peerHex, { ...entry, status: "closed" });
      return next;
    }
  }
  return state;
}

export interface RoomMessaging {
  sessions: RoomSessionView[];
  /** Wires a WebRTC-negotiated Connection up as a full room session -- either side: this console's own initiate() (knownPeerDevice supplied), or an incoming offer accepted via onIncomingConnection (peer device discovered from AcceptedMeshSession's own peerDeviceId). A no-op if a session for this peer already exists. */
  attach: (
    connection: Readonly<Connection>,
    knownPeerDevice?: DeviceId,
  ) => Promise<void>;
  send: (peerHex: string, text: string) => Promise<void>;
}

export function useRoomMessaging(
  identity: IdentityPort,
  clock: Readonly<Clock>,
  messageStore: Readonly<MessageStore>,
): RoomMessaging {
  const [sessions, dispatch] = useReducer(
    reduce,
    new Map<string, RoomSessionInternal>(),
  );
  const ownDeviceHex = deviceIdToHex(identity.deviceId);

  const attach = useCallback(
    async (
      connection: Readonly<Connection>,
      knownPeerDevice?: DeviceId,
    ): Promise<void> => {
      const accepted = await acceptMeshSession(
        connection,
        identity,
        ROOM_SESSION_DOMAINS,
        { clock },
      );
      const peerDevice = knownPeerDevice ?? (await accepted.peerDeviceId);
      const peerHex = deviceIdToHex(peerDevice);
      if (sessions.has(peerHex)) {
        // Both sides can race to negotiate a connection to each other at once; the second one to arrive here yields to whichever room session already exists rather than duplicating it.
        await accepted.close();
        return;
      }
      const roomPath = dmRoomPath(ownDeviceHex, peerHex);
      dispatch({ type: "opened", peerHex, roomPath, session: accepted });
      for (const stored of await messageStore.list(roomPath)) {
        dispatch({ type: "message", peerHex, message: stored });
      }

      createRoomRouter(
        accepted,
        {
          identity,
          clock,
          revocation: noRevocationCheck,
          peerDevice,
          currentMembers: () => [identity.deviceId, peerDevice],
        },
        {
          onMessage: (message) => {
            const stored: StoredMessage = {
              direction: "received",
              text: message.text,
              messageId: message.messageId,
              sentAt: message.sentAt,
            };
            void messageStore.append(roomPath, stored);
            dispatch({ type: "message", peerHex, message: stored });
          },
          onJoinRequest: (event) => {
            dispatch({
              type: "join-request",
              peerHex,
              request: {
                requesterHex: deviceIdToHex(event.requesterDevice),
                async decide(decision): Promise<void> {
                  dispatch({ type: "join-request-settled", peerHex });
                  await event.decide(decision);
                },
              },
            });
          },
        },
      );

      void (async (): Promise<void> => {
        for await (const sessionEvent of accepted.events) {
          if (sessionEvent.state.status === "closed") {
            dispatch({ type: "closed", peerHex });
          }
        }
      })();
    },
    [identity, clock, ownDeviceHex, sessions, messageStore],
  );

  const send = useCallback(
    async (peerHex: string, text: string): Promise<void> => {
      const entry = sessions.get(peerHex);
      if (entry === undefined) {
        return;
      }
      let token = entry.token;
      if (token === undefined) {
        const joined = await requestToJoin(entry.session, entry.roomPath);
        token = joined.token;
        dispatch({ type: "token", peerHex, token });
      }
      const outcome = await sendRoomMessage(
        entry.session,
        entry.roomPath,
        text,
        token,
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
      dispatch({ type: "message", peerHex, message: stored });
    },
    [sessions, clock],
  );

  return { sessions: [...sessions.values()], attach, send };
}
