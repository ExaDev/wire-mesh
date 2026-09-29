// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createAsyncQueue } from "wire-mesh-core/domain/async-queue";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { buildCapabilityRequestCommand } from "wire-mesh-core/domain/capability-request";
import type {
  IncomingManageRequest,
  MeshSession,
} from "wire-mesh-core/domain/mesh-session";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "wire-mesh-core/domain/room-path";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { useRoomMessaging } from "../src/hooks/use-room-messaging.js";
import { createMessageStore } from "../src/message-store.js";
import {
  buildRoomSendCommand,
  mintRoomInviteGrant,
} from "../src/room-client.js";

const clock = { now: () => 0 };
const TOKEN_EXPIRES = 1_000_000;
const SENT_AT = 5;
const SOME_BYTE = 9;
const MESSAGE_ID = new Uint8Array([SOME_BYTE]);

let own: IdentityPort;
let peer: IdentityPort;
let roomPath: string;

beforeAll(async () => {
  own = await createWebCryptoIdentity();
  peer = await createWebCryptoIdentity();
  roomPath = dmRoomPath(
    deviceIdToHex(own.deviceId),
    deviceIdToHex(peer.deviceId),
  );
});

type SendManageRequest = MeshSession["sendManageRequest"];

/** A hub that answers a room.join with a grant from the peer and accepts every room.send. */
async function answeringHub(): Promise<{
  sendManageRequest: ReturnType<typeof vi.fn<SendManageRequest>>;
}> {
  const grant = await mintRoomInviteGrant(
    peer,
    clock,
    roomPath,
    own.deviceId,
    TOKEN_EXPIRES,
  );
  const sendManageRequest = vi.fn<SendManageRequest>(async (command) =>
    Promise.resolve(
      command.params.verb === "capability.request"
        ? {
            result: "ok",
            "granted-token": grant,
            members: [{ device: own.deviceId }, { device: peer.deviceId }],
          }
        : { result: "ok" },
    ),
  );
  return { sendManageRequest };
}

function render(): ReturnType<
  typeof renderHook<ReturnType<typeof useRoomMessaging>, unknown>
> {
  const store = createMessageStore(createMemoryStorage());
  return renderHook(() => useRoomMessaging(own, clock, store));
}

function incomingFromPeer(
  overrides: Partial<IncomingManageRequest>,
): IncomingManageRequest {
  return {
    requestId: 1,
    command: buildCapabilityRequestCommand("room:member"),
    scope: { kind: "room", path: roomPath },
    fromDevice: peer.deviceId,
    respond: async () => Promise.resolve(),
    ...overrides,
  };
}

describe("a conversation over a hub", () => {
  it("opens with no connection of its own, reaching the peer through the hub", async () => {
    const { result } = render();
    const hub = await answeringHub();

    act(() => {
      result.current.openRelay(hub, peer.deviceId);
    });

    const [conversation] = result.current.conversations;
    expect(conversation?.via).toBe("hub");
    expect(conversation?.status).toBe("connected");
    expect(conversation?.participants).toEqual([deviceIdToHex(peer.deviceId)]);
  });

  it("sends through the hub, addressing the peer on both the join and the message", async () => {
    const { result } = render();
    const hub = await answeringHub();
    act(() => {
      result.current.openRelay(hub, peer.deviceId);
    });

    await act(async () => result.current.send(roomPath, "hello"));

    expect(hub.sendManageRequest).toHaveBeenCalledTimes(2);
    const [join, message] = hub.sendManageRequest.mock.calls;
    expect(join?.[0].params.verb).toBe("capability.request");
    expect(message?.[0].params.verb).toBe("room.send");
    expect(join?.[2]).toEqual(peer.deviceId);
    expect(message?.[2]).toEqual(peer.deviceId);
    const [conversation] = result.current.conversations;
    expect(conversation?.messages.map((m) => m.text)).toEqual(["hello"]);
    expect(conversation?.outgoing).toEqual([]);
  });

  it("opens a conversation the first time a peer writes through the hub, and delivers what it sent", async () => {
    const { result } = render();
    const incoming = createAsyncQueue<IncomingManageRequest>();
    act(() => {
      result.current.watchHub({
        sendManageRequest: async () => Promise.resolve({ result: "ok" }),
        incomingManageRequests: incoming.stream,
      });
    });
    const token = await mintRoomInviteGrant(
      own,
      clock,
      roomPath,
      peer.deviceId,
      TOKEN_EXPIRES,
    );
    const respond = vi.fn<IncomingManageRequest["respond"]>(async () =>
      Promise.resolve(),
    );

    incoming.push(
      incomingFromPeer({
        command: buildRoomSendCommand("hello there", MESSAGE_ID, SENT_AT),
        token,
        respond,
      }),
    );

    await waitFor(() => {
      expect(result.current.conversations[0]?.messages).toHaveLength(1);
    });
    const [conversation] = result.current.conversations;
    expect(conversation?.via).toBe("hub");
    expect(conversation?.messages[0]?.text).toBe("hello there");
    expect(conversation?.unread).toBe(1);
    expect(respond).toHaveBeenCalledWith({ result: "ok" });
  });

  it("refuses a message from the hub whose token was not issued for this conversation's peer", async () => {
    const { result } = render();
    const incoming = createAsyncQueue<IncomingManageRequest>();
    act(() => {
      result.current.watchHub({
        sendManageRequest: async () => Promise.resolve({ result: "ok" }),
        incomingManageRequests: incoming.stream,
      });
    });
    const stranger = await createWebCryptoIdentity();
    const tokenForSomeoneElse = await mintRoomInviteGrant(
      own,
      clock,
      roomPath,
      stranger.deviceId,
      TOKEN_EXPIRES,
    );
    const respond = vi.fn<IncomingManageRequest["respond"]>(async () =>
      Promise.resolve(),
    );

    incoming.push(
      incomingFromPeer({
        command: buildRoomSendCommand("spoofed", MESSAGE_ID, SENT_AT),
        token: tokenForSomeoneElse,
        respond,
      }),
    );

    await waitFor(() => {
      expect(respond).toHaveBeenCalledWith({
        result: "error",
        code: "unauthorized",
      });
    });
    expect(result.current.conversations[0]?.messages).toEqual([]);
  });

  it("surfaces a join request that arrives through the hub for a decision", async () => {
    const { result } = render();
    const incoming = createAsyncQueue<IncomingManageRequest>();
    act(() => {
      result.current.watchHub({
        sendManageRequest: async () => Promise.resolve({ result: "ok" }),
        incomingManageRequests: incoming.stream,
      });
    });

    incoming.push(incomingFromPeer({}));

    await waitFor(() => {
      expect(
        result.current.conversations[0]?.pendingJoinRequest?.requesterHex,
      ).toBe(deviceIdToHex(peer.deviceId));
    });
  });

  it("goes offline when the hub is dropped, keeping its history", async () => {
    const { result } = render();
    const hub = await answeringHub();
    act(() => {
      result.current.openRelay(hub, peer.deviceId);
    });
    await act(async () => result.current.send(roomPath, "hello"));

    act(() => {
      result.current.dropHub(hub);
    });

    const [conversation] = result.current.conversations;
    expect(conversation?.via).toBeUndefined();
    expect(conversation?.status).toBe("closed");
    expect(conversation?.messages).toHaveLength(1);
  });

  it("does not post a durable notice, which needs a direct connection", async () => {
    const { result } = render();
    const hub = await answeringHub();
    act(() => {
      result.current.openRelay(hub, peer.deviceId);
    });

    await expect(result.current.postNotice(roomPath, "note")).rejects.toThrow(
      "durable notices need a direct connection",
    );
  });
});
