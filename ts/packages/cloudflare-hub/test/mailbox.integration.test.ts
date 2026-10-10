// The announcer role as the hibernating hub serves it: an owner's log pushed to the hub outlives the instance that took it, because the mailbox writes to storage and not to the instance.

import { describe, expect, it } from "vitest";
import { decode } from "cbor2";
import { createMailbox } from "wire-mesh-core/domain/hub-mailbox";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  createHibernatingRelayHub,
  type HubSocket,
} from "../src/hibernating-hub.js";
import { messageFromFrame } from "../src/adapters/websocket-transport.js";
import { mailboxLimits } from "../src/mailbox-limits.js";
import { createTestPeer } from "./signed-peers.js";

/** Storage that is not the instance: a Map that the next hub instance is handed as well. */
function sharedStorage(): KeyValueStorage {
  const values = new Map<string, Uint8Array<ArrayBuffer>>();

  return {
    get: async (key) => Promise.resolve(values.get(key)),
    set: async (key, value) => {
      values.set(key, value);

      return Promise.resolve();
    },
    delete: async (key) => {
      values.delete(key);

      return Promise.resolve();
    },
    keys: async (prefix) =>
      Promise.resolve([...values.keys()].filter((k) => k.startsWith(prefix))),
  };
}

class FakeHubSocket implements HubSocket {
  sent: Uint8Array[] = [];

  private attachment: unknown = null;

  send(message: Uint8Array<ArrayBuffer>): void {
    this.sent.push(message);
  }

  close(): void {
    return undefined;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  frames(): unknown[] {
    return this.sent.map((message) => decode(message));
  }
}

function buffer(frame: Frame): ArrayBuffer {
  const bytes = messageFromFrame(frame);

  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

const ENTRY = new Uint8Array([1, 2]);

describe("the hub's mailbox across a Durable Object eviction", () => {
  it("serves a log that an earlier instance took, to a client that connects after the eviction", async () => {
    const storage = sharedStorage();
    const author = await createTestPeer();
    const reader = await createTestPeer();
    const authorSocket = new FakeHubSocket();
    const readerSocket = new FakeHubSocket();
    const mailboxFor = (): ReturnType<typeof createMailbox> =>
      createMailbox({ storage, limits: mailboxLimits });

    const first = createHibernatingRelayHub(() => [authorSocket], mailboxFor());
    first.accept(authorSocket);
    await first.message(authorSocket, buffer(author.gossip));
    await first.message(
      authorSocket,
      buffer({
        type: "data-entries",
        peer: author.device,
        "from-seq": 0,
        entries: [ENTRY],
      }),
    );

    const woken = createHibernatingRelayHub(
      () => [authorSocket, readerSocket],
      mailboxFor(),
    );
    woken.accept(readerSocket);
    await woken.message(readerSocket, buffer(reader.gossip));
    await woken.message(
      readerSocket,
      buffer({ type: "data-request", peer: author.device, "from-seq": 0 }),
    );

    expect(
      readerSocket.frames().find((f) => (f as Frame).type === "data-entries"),
    ).toEqual({
      type: "data-entries",
      peer: author.device,
      "from-seq": 0,
      entries: [ENTRY],
    });
  });
});
