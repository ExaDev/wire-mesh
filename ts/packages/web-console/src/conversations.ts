// The state of every conversation this console holds, keyed by room path, and the pure reducer that evolves it. Kept apart from the hook that feeds it so the merge, unread and restore rules can be tested without a live session.

import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import type {
  CapabilityToken,
  DeviceId,
} from "wire-mesh-core/generated/protocol";
import type { NoticeBoardEntry } from "wire-mesh-core/domain/notice-board";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import { parseRoomPath } from "wire-mesh-core/domain/room-path";
import type { RoomJoinDecision } from "./room-client.js";
import type { StoredMessage } from "./message-store.js";

export interface PendingJoinRequest {
  requesterHex: string;
  decide: (decision: Readonly<RoomJoinDecision>) => Promise<void>;
}

/** A message the user has sent that is not yet in the conversation's history: held for the other side's consent, in flight, or refused with the reason, until it is retried or dismissed. */
export type PendingOutgoing = {
  /** Identifies this attempt locally; the message id it will be stored under is only minted once it is delivered. */
  localId: string;
  text: string;
} &
  /** awaiting-approval: the first message to a peer asks that peer to allow messages, and waits for their answer. */
  (
    | { status: "awaiting-approval" | "sending" }
    /** error is why the last attempt failed. */
    | { status: "failed"; error: string }
  );

/** What a conversation needs from a hub connection to send through it: the relay peer is addressed by device-id on each request. */
export type RelaySender = Pick<MeshSession, "sendManageRequest">;

/** A conversation's route through a hub, where the peer is reached by a relay pairing and a secure channel instead of a connection of its own. */
export interface RelayRoute {
  readonly hub: RelaySender;
  readonly peer: DeviceId;
}

/** How a conversation's messages travel: over a direct connection to the peer, or through a hub. A direct connection is preferred whenever there is one. */
export type ConversationVia = "direct" | "hub";

export interface ConversationView {
  roomPath: string;
  /** Hex device-ids of the other members of the room: the one peer for a DM. */
  participants: readonly string[];
  /** "closed" covers both a conversation whose routes have all ended and one restored from storage that has not been given a route yet. */
  status: "connected" | "closed";
  /** The route messages take, undefined while the conversation has none. */
  via: ConversationVia | undefined;
  messages: readonly StoredMessage[];
  notices: readonly NoticeBoardEntry[];
  outgoing: readonly PendingOutgoing[];
  pendingJoinRequest: PendingJoinRequest | undefined;
  /** Received messages not yet acknowledged through markRead. Restored history is never counted. */
  unread: number;
}

export interface ConversationInternal extends ConversationView {
  direct: MeshSession | undefined;
  relay: RelayRoute | undefined;
  token: CapabilityToken | undefined;
}

export type ConversationAction =
  | {
      type: "direct-opened";
      roomPath: string;
      participants: readonly string[];
      session: MeshSession;
    }
  | {
      type: "relay-opened";
      roomPath: string;
      participants: readonly string[];
      route: RelayRoute;
    }
  | { type: "direct-closed"; roomPath: string }
  | { type: "hub-closed"; hub: RelaySender }
  | {
      type: "restored";
      roomPath: string;
      participants: readonly string[];
      messages: readonly StoredMessage[];
    }
  | { type: "message"; roomPath: string; message: StoredMessage }
  | { type: "read"; roomPath: string }
  | { type: "outgoing"; roomPath: string; entry: PendingOutgoing }
  | { type: "outgoing-removed"; roomPath: string; localId: string }
  | { type: "notices"; roomPath: string; notices: NoticeBoardEntry[] }
  | { type: "join-request"; roomPath: string; request: PendingJoinRequest }
  | { type: "join-request-settled"; roomPath: string }
  | { type: "token"; roomPath: string; token: CapabilityToken };

/** Message order matches message-store.ts's own list order (sentAt, then message id), so a history load and a live message interleave the same way a reload would show them. */
function compareMessages(a: StoredMessage, b: StoredMessage): number {
  if (a.sentAt !== b.sentAt) return a.sentAt - b.sentAt;
  return bytesToHex(a.messageId).localeCompare(bytesToHex(b.messageId));
}

/** Adds messages not already present (identified by message id), keeping order. History is loaded both when a conversation is restored and when its session attaches, in either order, so the same message can legitimately arrive twice. */
export function mergeMessages(
  existing: readonly StoredMessage[],
  incoming: readonly StoredMessage[],
): readonly StoredMessage[] {
  const known = new Set(existing.map((m) => bytesToHex(m.messageId)));
  const added = incoming.filter((m) => !known.has(bytesToHex(m.messageId)));
  if (added.length === 0) return existing;
  return [...existing, ...added].sort(compareMessages);
}

function update(
  state: ReadonlyMap<string, ConversationInternal>,
  roomPath: string,
  change: (entry: ConversationInternal) => ConversationInternal,
): ReadonlyMap<string, ConversationInternal> {
  const entry = state.get(roomPath);
  if (entry === undefined) return state;
  return new Map(state).set(roomPath, change(entry));
}

function blank(
  roomPath: string,
  participants: readonly string[],
): ConversationInternal {
  return {
    roomPath,
    participants,
    direct: undefined,
    relay: undefined,
    via: undefined,
    token: undefined,
    status: "closed",
    messages: [],
    notices: [],
    outgoing: [],
    pendingJoinRequest: undefined,
    unread: 0,
  };
}

/** The conversation with its routes replaced, and the route it reports and its status following from them: a direct connection wins over a hub. */
function withRoutes(
  entry: Readonly<ConversationInternal>,
  direct: MeshSession | undefined,
  relay: RelayRoute | undefined,
): ConversationInternal {
  const via: ConversationVia | undefined =
    direct !== undefined ? "direct" : relay !== undefined ? "hub" : undefined;
  return {
    ...entry,
    direct,
    relay,
    via,
    status: via === undefined ? "closed" : "connected",
  };
}

export function reduceConversations(
  state: ReadonlyMap<string, ConversationInternal>,
  action: Readonly<ConversationAction>,
): ReadonlyMap<string, ConversationInternal> {
  switch (action.type) {
    case "direct-opened": {
      const entry =
        state.get(action.roomPath) ??
        blank(action.roomPath, action.participants);
      // A new direct connection starts with an empty notice board; the token and any pending request belong to the conversation and outlive the connection they arrived on.
      return new Map(state).set(action.roomPath, {
        ...withRoutes(entry, action.session, entry.relay),
        participants: action.participants,
        notices: [],
      });
    }
    case "relay-opened": {
      const entry =
        state.get(action.roomPath) ??
        blank(action.roomPath, action.participants);
      return new Map(state).set(
        action.roomPath,
        withRoutes(entry, entry.direct, action.route),
      );
    }
    case "direct-closed":
      return update(state, action.roomPath, (entry) =>
        withRoutes(entry, undefined, entry.relay),
      );
    case "hub-closed": {
      let next = state;
      for (const entry of state.values()) {
        if (entry.relay?.hub === action.hub) {
          next = update(next, entry.roomPath, (current) =>
            withRoutes(current, current.direct, undefined),
          );
        }
      }
      return next;
    }
    case "restored": {
      const existing = state.get(action.roomPath);
      if (existing !== undefined) {
        return update(state, action.roomPath, (entry) => ({
          ...entry,
          messages: mergeMessages(entry.messages, action.messages),
        }));
      }
      return new Map(state).set(action.roomPath, {
        ...blank(action.roomPath, action.participants),
        messages: mergeMessages([], action.messages),
      });
    }
    case "notices":
      return update(state, action.roomPath, (entry) => ({
        ...entry,
        notices: action.notices,
      }));
    case "message":
      return update(state, action.roomPath, (entry) => {
        const messages = mergeMessages(entry.messages, [action.message]);
        const isNew = messages !== entry.messages;
        return {
          ...entry,
          messages,
          unread:
            isNew && action.message.direction === "received"
              ? entry.unread + 1
              : entry.unread,
        };
      });
    case "read":
      return update(state, action.roomPath, (entry) =>
        entry.unread === 0 ? entry : { ...entry, unread: 0 },
      );
    case "outgoing":
      return update(state, action.roomPath, (entry) => ({
        ...entry,
        outgoing: entry.outgoing.some((o) => o.localId === action.entry.localId)
          ? entry.outgoing.map((o) =>
              o.localId === action.entry.localId ? action.entry : o,
            )
          : [...entry.outgoing, action.entry],
      }));
    case "outgoing-removed":
      return update(state, action.roomPath, (entry) => ({
        ...entry,
        outgoing: entry.outgoing.filter((o) => o.localId !== action.localId),
      }));
    case "join-request":
      return update(state, action.roomPath, (entry) => ({
        ...entry,
        pendingJoinRequest: action.request,
      }));
    case "join-request-settled":
      return update(state, action.roomPath, (entry) => ({
        ...entry,
        pendingJoinRequest: undefined,
      }));
    case "token":
      return update(state, action.roomPath, (entry) => ({
        ...entry,
        token: action.token,
      }));
  }
  return state;
}

/** The other members of a stored conversation's room, for showing a conversation that has no live session. */
export function participantsOf(
  roomPath: string,
  ownDeviceHex: string,
): readonly string[] {
  const parsed = parseRoomPath(roomPath);
  if (parsed.kind === "dm") {
    return parsed.participants.filter((hex) => hex !== ownDeviceHex);
  }
  return parsed.owner === ownDeviceHex ? [] : [parsed.owner];
}

/** How a conversation's other members are named in the UI. A device-id is long, so this shows enough leading hex to tell devices apart at a glance; a conversation with no other members is named by its room path. */
const DEVICE_LABEL_LENGTH = 12;

export function participantLabel(
  view: Readonly<Pick<ConversationView, "participants" | "roomPath">>,
): string {
  if (view.participants.length === 0) return view.roomPath;
  return view.participants
    .map((hex) => hex.slice(0, DEVICE_LABEL_LENGTH))
    .join(", ");
}
