import { encode } from "cbor2";
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import {
  createMessageStore,
  type StoredMessage,
} from "../src/message-store.js";

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    direction: "sent",
    text: "hello",
    messageId: new Uint8Array([1]),
    sentAt: 1000,
    ...overrides,
  };
}

describe("createMessageStore", () => {
  it("lists an appended message back for its room path", async () => {
    const store = createMessageStore(createMemoryStorage());
    const stored = message();

    await store.append("room-path", stored);

    expect(await store.list("room-path")).toEqual([stored]);
  });

  it("lists messages in sentAt order regardless of append order", async () => {
    const store = createMessageStore(createMemoryStorage());
    const earlier = message({ sentAt: 1000, text: "first" });
    const later = message({ sentAt: 2000, text: "second" });

    await store.append("room-path", later);
    await store.append("room-path", earlier);

    expect(await store.list("room-path")).toEqual([earlier, later]);
  });

  it("keeps messages from different rooms isolated", async () => {
    const store = createMessageStore(createMemoryStorage());
    const roomOne = message({ text: "for room one" });
    const roomTwo = message({ text: "for room two" });

    await store.append("room-one", roomOne);
    await store.append("room-two", roomTwo);

    expect(await store.list("room-one")).toEqual([roomOne]);
    expect(await store.list("room-two")).toEqual([roomTwo]);
  });

  it("returns an empty list for a room with no stored messages", async () => {
    const store = createMessageStore(createMemoryStorage());

    expect(await store.list("no-such-room")).toEqual([]);
  });

  it("rejects a stored value that doesn't decode as a StoredMessage", async () => {
    const storage = createMemoryStorage();
    const store = createMessageStore(storage);
    await store.append("room-path", message());
    const [key] = await storage.keys("message/room-path/");
    if (key === undefined) throw new Error("expected a stored key");
    await storage.set(key, new Uint8Array(encode({ not: "a message" })));

    await expect(store.list("room-path")).rejects.toThrow(/malformed/);
  });
});
