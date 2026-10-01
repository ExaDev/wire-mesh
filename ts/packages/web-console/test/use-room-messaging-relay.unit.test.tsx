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
import {
  createPersistedWebCryptoIdentity,
  createWebCryptoIdentity,
} from "../src/adapters/web-crypto-identity.js";
import { useRoomMessaging } from "../src/hooks/use-room-messaging.js";
import { testCapabilities } from "./capability-services.js";
import type { TestCapabilities } from "./capability-services.js";
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
let capabilities: TestCapabilities;

beforeAll(async () => {
  // Only a persisted identity can derive the ECDH secret the first epoch key is wrapped under.
  const first = await createPersistedWebCryptoIdentity(createMemoryStorage());
  const second = await createPersistedWebCryptoIdentity(createMemoryStorage());
  // The lower device-id mints a DM's first epoch, so `own` is always that side.
  const ownIsLower =
    deviceIdToHex(first.deviceId) < deviceIdToHex(second.deviceId);
  own = ownIsLower ? first : second;
  peer = ownIsLower ? second : first;
  roomPath = dmRoomPath(
    deviceIdToHex(own.deviceId),
    deviceIdToHex(peer.deviceId),
  );
  capabilities = await testCapabilities(own, clock);
});

type SendManageRequest = MeshSession["sendManageRequest"];

/** A hub that answers a room.join with a grant from the peer and accepts every room.send. */
async function answeringHub(): Promise<{
  sendManageRequest: ReturnType<typeof vi.fn<SendManageRequest>>;
  sentDataFrames: Parameters<MeshSession["sendDataFrame"]>[0][];
  sendDataFrame: MeshSession["sendDataFrame"];
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
  const sentDataFrames: Parameters<MeshSession["sendDataFrame"]>[0][] = [];
  return {
    sendManageRequest,
    sentDataFrames,
    sendDataFrame: async (frame) => {
      sentDataFrames.push(frame);
      return Promise.resolve();
    },
  };
}

function render(): ReturnType<
  typeof renderHook<ReturnType<typeof useRoomMessaging>, unknown>
> {
  const store = createMessageStore(createMemoryStorage());
  const roomStorage = createMemoryStorage();
  return renderHook(() =>
    useRoomMessaging(own, clock, store, roomStorage, capabilities.services),
  );
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
        sendDataFrame: async () => Promise.resolve(),
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
        sendDataFrame: async () => Promise.resolve(),
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
        sendDataFrame: async () => Promise.resolve(),
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

  it("posts a durable notice over the hub: joins, hands the peer the first epoch key and announces the log", async () => {
    const { result } = render();
    const hub = await answeringHub();
    act(() => {
      result.current.openRelay(hub, peer.deviceId);
    });

    await act(async () => {
      await result.current.postNotice(roomPath, "note");
    });

    const rekey = hub.sendManageRequest.mock.calls.find(
      ([command]) => command.params.verb === "room.rekey",
    );
    expect(rekey?.[2]).toEqual(peer.deviceId);
    expect(hub.sentDataFrames.some((frame) => frame.type === "data-have")).toBe(
      true,
    );
    await waitFor(() => {
      expect(result.current.conversations[0]?.notices).toHaveLength(1);
    });
  });

  it("records the grant a join is answered with as held", async () => {
    const { result } = render();
    const hub = await answeringHub();
    act(() => {
      result.current.openRelay(hub, peer.deviceId);
    });

    await act(async () => result.current.send(roomPath, "hello"));

    const held = (await capabilities.grants.list()).filter(
      (record) => record.direction === "held",
    );
    expect(held.map((record) => deviceIdToHex(record.claims.issuer))).toContain(
      deviceIdToHex(peer.deviceId),
    );
  });

  it("reports a grant it could not save, and keeps the message that was sent", async () => {
    const STORAGE_FAILURE = "the origin's storage quota is exhausted";
    const store = createMessageStore(createMemoryStorage());
    const services = {
      ...capabilities.services,
      grants: {
        ...capabilities.grants,
        record: async () => Promise.reject(new Error(STORAGE_FAILURE)),
      },
    };
    const roomStorage = createMemoryStorage();
    const { result } = renderHook(() =>
      useRoomMessaging(own, clock, store, roomStorage, services),
    );
    const hub = await answeringHub();
    act(() => {
      result.current.openRelay(hub, peer.deviceId);
    });

    await act(async () => result.current.send(roomPath, "hello"));

    await waitFor(() => {
      expect(result.current.persistenceFailure).toBe(STORAGE_FAILURE);
    });
    expect(result.current.conversations[0]?.messages).toHaveLength(1);
  });

  it("records the grant an accepted join request issues, and refuses the peer's messages once it is revoked", async () => {
    const { result } = render();
    const incoming = createAsyncQueue<IncomingManageRequest>();
    act(() => {
      result.current.watchHub({
        sendManageRequest: async () => Promise.resolve({ result: "ok" }),
        sendDataFrame: async () => Promise.resolve(),
        incomingManageRequests: incoming.stream,
      });
    });
    const respondToJoin = vi.fn<IncomingManageRequest["respond"]>(async () =>
      Promise.resolve(),
    );
    incoming.push(incomingFromPeer({ respond: respondToJoin }));
    await waitFor(() => {
      expect(result.current.conversations[0]?.pendingJoinRequest).toBeDefined();
    });

    await act(async () =>
      result.current.conversations[0]?.pendingJoinRequest?.decide({
        kind: "accept",
        capability: "room:member",
        expires: TOKEN_EXPIRES,
      }),
    );

    const issued = (await capabilities.grants.list()).filter(
      (record) =>
        record.direction === "issued" &&
        deviceIdToHex(record.claims.bearer) === deviceIdToHex(peer.deviceId),
    );
    const grant = issued[0];
    if (grant === undefined) {
      throw new Error("expected the accepted join to be recorded as issued");
    }
    const send = async (text: string): Promise<ReturnType<typeof vi.fn>> => {
      const respond = vi.fn<IncomingManageRequest["respond"]>(async () =>
        Promise.resolve(),
      );
      incoming.push(
        incomingFromPeer({
          command: buildRoomSendCommand(text, MESSAGE_ID, SENT_AT),
          token: grant.token,
          respond,
        }),
      );
      await waitFor(() => {
        expect(respond).toHaveBeenCalled();
      });
      return respond;
    };

    expect(await send("before")).toHaveBeenCalledWith({ result: "ok" });

    await capabilities.revocations.revoke(grant.claims["token-id"]);

    expect(await send("after")).toHaveBeenCalledWith({
      result: "error",
      code: "unauthorized",
    });
  });
});
