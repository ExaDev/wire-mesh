import { beforeAll, describe, expect, it } from "vitest";
import { createMeshSession } from "wire-mesh-core/domain/mesh-session";
import type { MeshSession } from "wire-mesh-core/domain/mesh-session";
import {
  dmRoomPath,
  ownerNamedRoomPath,
} from "wire-mesh-core/domain/room-path";
import { createBrowserTransport } from "../src/adapters/websocket-transport.js";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import {
  mergeMessages,
  participantLabel,
  participantsOf,
  reduceConversations,
  type ConversationAction,
  type ConversationInternal,
} from "../src/conversations.js";
import type { StoredMessage } from "../src/message-store.js";

const DEVICE_ID_HEX_LENGTH = 64;
const OWN = "1".repeat(DEVICE_ID_HEX_LENGTH);
const PEER = "2".repeat(DEVICE_ID_HEX_LENGTH);
const OTHER_PEER = "3".repeat(DEVICE_ID_HEX_LENGTH);
const DM = dmRoomPath(OWN, PEER);
const OTHER_DM = dmRoomPath(OWN, OTHER_PEER);
const SENT_AT_STEP_MS = 1000;
const THIRD_MESSAGE = 3;
const NO_RECONNECT = { maxAttempts: 0, delayMs: () => 0 };

let session: MeshSession;

beforeAll(async () => {
  session = createMeshSession(
    createBrowserTransport(),
    await createWebCryptoIdentity(),
    { now: () => 0 },
    NO_RECONNECT,
  );
});

function message(
  id: number,
  overrides: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    direction: "received",
    text: `message ${String(id)}`,
    messageId: new Uint8Array([id]),
    sentAt: id * SENT_AT_STEP_MS,
    ...overrides,
  };
}

function apply(
  actions: readonly ConversationAction[],
): ReadonlyMap<string, ConversationInternal> {
  return actions.reduce(
    reduceConversations,
    new Map<string, ConversationInternal>(),
  );
}

function conversation(
  state: ReadonlyMap<string, ConversationInternal>,
  roomPath: string,
): ConversationInternal {
  const found = state.get(roomPath);
  if (found === undefined) throw new Error(`no conversation ${roomPath}`);
  return found;
}

describe("reduceConversations", () => {
  it("restores a stored conversation as closed, with its history and nothing unread", () => {
    const state = apply([
      {
        type: "restored",
        roomPath: DM,
        participants: [PEER],
        messages: [message(2), message(1)],
      },
    ]);

    const restored = conversation(state, DM);
    expect(restored.status).toBe("closed");
    expect(restored.session).toBeUndefined();
    expect(restored.participants).toEqual([PEER]);
    expect(restored.messages.map((m) => m.text)).toEqual([
      "message 1",
      "message 2",
    ]);
    expect(restored.unread).toBe(0);
  });

  it("keeps conversations for different room paths separate", () => {
    const state = apply([
      {
        type: "restored",
        roomPath: DM,
        participants: [PEER],
        messages: [message(1)],
      },
      {
        type: "restored",
        roomPath: OTHER_DM,
        participants: [OTHER_PEER],
        messages: [],
      },
      { type: "message", roomPath: OTHER_DM, message: message(2) },
    ]);

    expect(conversation(state, DM).messages).toHaveLength(1);
    expect(conversation(state, OTHER_DM).messages.map((m) => m.text)).toEqual([
      "message 2",
    ]);
  });

  it("counts a new received message as unread and never a sent one", () => {
    const state = apply([
      { type: "restored", roomPath: DM, participants: [PEER], messages: [] },
      { type: "message", roomPath: DM, message: message(1) },
      {
        type: "message",
        roomPath: DM,
        message: message(2, { direction: "sent" }),
      },
      { type: "message", roomPath: DM, message: message(THIRD_MESSAGE) },
    ]);

    expect(conversation(state, DM).unread).toBe(2);
  });

  it("does not count or duplicate a message it already holds", () => {
    const state = apply([
      { type: "restored", roomPath: DM, participants: [PEER], messages: [] },
      { type: "message", roomPath: DM, message: message(1) },
      { type: "message", roomPath: DM, message: message(1) },
    ]);

    expect(conversation(state, DM).messages).toHaveLength(1);
    expect(conversation(state, DM).unread).toBe(1);
  });

  it("clears the unread count on read", () => {
    const state = apply([
      { type: "restored", roomPath: DM, participants: [PEER], messages: [] },
      { type: "message", roomPath: DM, message: message(1) },
      { type: "read", roomPath: DM },
    ]);

    expect(conversation(state, DM).unread).toBe(0);
  });

  it("gives a restored conversation a live session without losing its history or unread count", () => {
    const state = apply([
      {
        type: "restored",
        roomPath: DM,
        participants: [PEER],
        messages: [message(1)],
      },
      { type: "opened", roomPath: DM, participants: [PEER], session },
    ]);

    const opened = conversation(state, DM);
    expect(opened.status).toBe("connected");
    expect(opened.session).toBe(session);
    expect(opened.messages.map((m) => m.text)).toEqual(["message 1"]);
  });

  it("merges history restored after the session opened into the live conversation", () => {
    const state = apply([
      { type: "opened", roomPath: DM, participants: [PEER], session },
      { type: "message", roomPath: DM, message: message(2) },
      {
        type: "restored",
        roomPath: DM,
        participants: [PEER],
        messages: [message(1), message(2)],
      },
    ]);

    const merged = conversation(state, DM);
    expect(merged.status).toBe("connected");
    expect(merged.messages.map((m) => m.text)).toEqual([
      "message 1",
      "message 2",
    ]);
    expect(merged.unread).toBe(1);
  });

  it("drops the previous session's token and pending request when a new session opens", () => {
    const state = apply([
      { type: "opened", roomPath: DM, participants: [PEER], session },
      {
        type: "join-request",
        roomPath: DM,
        request: { requesterHex: PEER, decide: async () => Promise.resolve() },
      },
      { type: "closed", roomPath: DM },
      { type: "opened", roomPath: DM, participants: [PEER], session },
    ]);

    expect(conversation(state, DM).pendingJoinRequest).toBeUndefined();
    expect(conversation(state, DM).token).toBeUndefined();
    expect(conversation(state, DM).status).toBe("connected");
  });

  it("marks a live conversation closed when its session ends, keeping its history", () => {
    const state = apply([
      { type: "opened", roomPath: DM, participants: [PEER], session },
      { type: "message", roomPath: DM, message: message(1) },
      { type: "closed", roomPath: DM },
    ]);

    expect(conversation(state, DM).status).toBe("closed");
    expect(conversation(state, DM).messages).toHaveLength(1);
  });

  it("adds an outgoing message, then updates it in place when its status changes", () => {
    const state = apply([
      { type: "restored", roomPath: DM, participants: [PEER], messages: [] },
      {
        type: "outgoing",
        roomPath: DM,
        entry: { localId: "a", text: "hi", status: "sending" },
      },
      {
        type: "outgoing",
        roomPath: DM,
        entry: { localId: "b", text: "again", status: "sending" },
      },
      {
        type: "outgoing",
        roomPath: DM,
        entry: { localId: "a", text: "hi", status: "failed", error: "denied" },
      },
    ]);

    expect(conversation(state, DM).outgoing).toEqual([
      { localId: "a", text: "hi", status: "failed", error: "denied" },
      { localId: "b", text: "again", status: "sending" },
    ]);
  });

  it("removes only the named outgoing message", () => {
    const state = apply([
      { type: "restored", roomPath: DM, participants: [PEER], messages: [] },
      {
        type: "outgoing",
        roomPath: DM,
        entry: { localId: "a", text: "one", status: "sending" },
      },
      {
        type: "outgoing",
        roomPath: DM,
        entry: { localId: "b", text: "two", status: "sending" },
      },
      { type: "outgoing-removed", roomPath: DM, localId: "a" },
    ]);

    expect(conversation(state, DM).outgoing.map((o) => o.localId)).toEqual([
      "b",
    ]);
  });

  it("keeps a failed outgoing message when a new session opens, so it can be retried", () => {
    const state = apply([
      { type: "restored", roomPath: DM, participants: [PEER], messages: [] },
      {
        type: "outgoing",
        roomPath: DM,
        entry: {
          localId: "a",
          text: "hi",
          status: "failed",
          error: "not connected",
        },
      },
      { type: "opened", roomPath: DM, participants: [PEER], session },
    ]);

    expect(conversation(state, DM).outgoing).toHaveLength(1);
  });

  it("ignores an action for a conversation it does not hold", () => {
    const empty = new Map<string, ConversationInternal>();

    expect(reduceConversations(empty, { type: "closed", roomPath: DM })).toBe(
      empty,
    );
    expect(
      reduceConversations(empty, {
        type: "message",
        roomPath: DM,
        message: message(1),
      }),
    ).toBe(empty);
  });
});

describe("mergeMessages", () => {
  it("orders by sentAt, then by message id when two share a timestamp", () => {
    const first = message(1, { sentAt: 5000 });
    const second = message(2, { sentAt: 5000 });

    expect(mergeMessages([second], [first])).toEqual([first, second]);
  });

  it("returns the existing array itself when nothing is new", () => {
    const existing = [message(1)];

    expect(mergeMessages(existing, [message(1)])).toBe(existing);
  });
});

describe("participantsOf", () => {
  it("names the other side of a DM whichever side sorts first", () => {
    expect(participantsOf(dmRoomPath(OWN, PEER), OWN)).toEqual([PEER]);
    expect(participantsOf(dmRoomPath(PEER, OWN), PEER)).toEqual([OWN]);
  });

  it("names the owner of a room owned by someone else, and nobody for one this device owns", () => {
    const room = ownerNamedRoomPath(PEER, "general");

    expect(participantsOf(room, OWN)).toEqual([PEER]);
    expect(participantsOf(room, PEER)).toEqual([]);
  });
});

describe("participantLabel", () => {
  it("shortens each participant's device-id and joins them", () => {
    expect(
      participantLabel({ roomPath: DM, participants: [PEER, OTHER_PEER] }),
    ).toBe("222222222222, 333333333333");
  });

  it("falls back to the room path when nobody else is in the room", () => {
    expect(participantLabel({ roomPath: DM, participants: [] })).toBe(DM);
  });
});
