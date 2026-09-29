// The announcer role over real sockets and a real directory: an owner pushes its log to a node started with a mailbox, disconnects, and a second client that connects afterwards reads it back, from files that a fresh mailbox over the same directory also serves.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFsStorage } from "wire-mesh-core/adapters/node-fs-storage";
import { createMailbox } from "wire-mesh-core/domain/hub-mailbox";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { Frame } from "wire-mesh-core/generated/protocol";
import { createNodeWebSocketTransport } from "../src/adapters/node-websocket-transport.js";
import { nodeMailboxLimits } from "../src/mailbox-limits.js";
import { createTestPeer, hubVerifier } from "./signed-peers.js";

const FRAME_WAIT_TIMEOUT_MS = 2000;
const FRAME_POLL_INTERVAL_MS = 10;

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A client that keeps every frame the node sends it and lets a test wait for the next of a type. */
async function client(address: string): Promise<{
  connection: Connection;
  next: (type: Frame["type"]) => Promise<Frame>;
}> {
  const connection = await createNodeWebSocketTransport().connect(address);
  const received: Frame[] = [];
  void (async () => {
    for await (const frame of connection.receive()) received.push(frame);
  })();
  return {
    connection,
    async next(type) {
      const deadline = Date.now() + FRAME_WAIT_TIMEOUT_MS;
      for (;;) {
        const index = received.findIndex((frame) => frame.type === type);
        const [frame] = index === -1 ? [] : received.splice(index, 1);
        if (frame !== undefined) return frame;
        if (Date.now() > deadline) throw new Error(`no ${type} frame arrived`);
        await new Promise((resolve) => {
          setTimeout(resolve, FRAME_POLL_INTERVAL_MS);
        });
      }
    },
  };
}

async function serve(
  directory: string,
): ReturnType<ReturnType<typeof createNodeWebSocketTransport>["listen"]> {
  const hub = createRelayHub({
    identity: hubVerifier,
    mailbox: createMailbox({
      storage: createNodeFsStorage({ dir: directory }),
      limits: nodeMailboxLimits,
    }),
  });
  return createNodeWebSocketTransport().listen("127.0.0.1:0", (connection) => {
    void hub.handleConnection(connection);
  });
}

describe("a node started with a mailbox", () => {
  it("serves an owner's log to a client that connects after the owner has gone", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wire-mesh-node-mailbox-"));
    directories.push(directory);
    const listener = await serve(directory);
    const author = await createTestPeer();
    const reader = await createTestPeer();
    const entry = new Uint8Array([1, 2]);

    const owner = await client(listener.address);
    await owner.connection.send(author.gossip);
    // Once the hub asks for what is announced it has registered the owner's device, and the owner's entries can be pushed.
    await owner.connection.send({
      type: "data-have",
      peer: author.device,
      "head-seq": 1,
    });
    await owner.next("data-request");
    await owner.connection.send({
      type: "data-entries",
      peer: author.device,
      "from-seq": 0,
      entries: [entry],
    });
    // Reading its own log back is how the owner knows the push has been stored before it goes.
    await owner.connection.send({
      type: "data-request",
      peer: author.device,
      "from-seq": 0,
    });
    await owner.next("data-entries");
    await owner.connection.close();

    const late = await client(listener.address);
    await late.connection.send(reader.gossip);
    await late.connection.send({
      type: "data-request",
      peer: author.device,
      "from-seq": 0,
    });

    expect(await late.next("data-entries")).toEqual({
      type: "data-entries",
      peer: author.device,
      "from-seq": 0,
      entries: [entry],
    });
    await late.connection.close();
    await listener.close();
  });
});
