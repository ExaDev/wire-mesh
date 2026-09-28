// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { dmRoomPath } from "wire-mesh-core/domain/room-path";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { useRoomMessaging } from "../src/hooks/use-room-messaging.js";
import { createMessageStore } from "../src/message-store.js";

const DEVICE_ID_HEX_LENGTH = 64;
const PEER = "2".repeat(DEVICE_ID_HEX_LENGTH);
const clock = { now: () => 0 };

let identity: IdentityPort;
let roomPath: string;

beforeAll(async () => {
  identity = await createWebCryptoIdentity();
  roomPath = dmRoomPath(deviceIdToHex(identity.deviceId), PEER);
});

/** A conversation restored from storage, which has no live session to send through. */
async function renderRestoredConversation(): Promise<
  ReturnType<typeof renderHook<ReturnType<typeof useRoomMessaging>, unknown>>
> {
  const store = createMessageStore(createMemoryStorage());
  await store.append(roomPath, {
    direction: "received",
    text: "earlier",
    messageId: new Uint8Array([1]),
    sentAt: 1,
  });
  const rendered = renderHook(() => useRoomMessaging(identity, clock, store));
  await waitFor(() => {
    expect(rendered.result.current.conversations).toHaveLength(1);
  });
  return rendered;
}

describe("useRoomMessaging", () => {
  it("restores a stored conversation as offline with its history", async () => {
    const { result } = await renderRestoredConversation();

    const [conversation] = result.current.conversations;
    expect(conversation?.status).toBe("closed");
    expect(conversation?.messages.map((m) => m.text)).toEqual(["earlier"]);
    expect(conversation?.participants).toEqual([PEER]);
  });

  it("keeps a send to a conversation with no live session as a failed message with the reason", async () => {
    const { result } = await renderRestoredConversation();

    await act(async () => result.current.send(roomPath, "hello"));

    const [conversation] = result.current.conversations;
    expect(conversation?.messages).toHaveLength(1);
    expect(conversation?.outgoing).toEqual([
      {
        localId: expect.any(String) as string,
        text: "hello",
        status: "failed",
        error: "conversation is not connected",
      },
    ]);
  });

  it("retries a failed message under the same entry, and dismisses it on request", async () => {
    const { result } = await renderRestoredConversation();
    await act(async () => result.current.send(roomPath, "hello"));
    const failed = result.current.conversations[0]?.outgoing[0];
    if (failed === undefined) throw new Error("no failed message to retry");

    await act(async () => result.current.retry(roomPath, failed.localId));
    expect(result.current.conversations[0]?.outgoing).toEqual([failed]);

    act(() => {
      result.current.discard(roomPath, failed.localId);
    });
    expect(result.current.conversations[0]?.outgoing).toEqual([]);
  });

  it("counts nothing unread for restored history", async () => {
    const { result } = await renderRestoredConversation();

    expect(result.current.conversations[0]?.unread).toBe(0);
  });
});
