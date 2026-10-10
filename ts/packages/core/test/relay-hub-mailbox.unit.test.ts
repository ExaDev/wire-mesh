// The announcer role as a relay hub serves it: data frames sent to the hub by a connection whose advert it has verified, and what happens to the same frames without a mailbox. The rules of the mailbox itself are in hub-mailbox.unit.test.ts; this covers the hub's part, which is knowing which device a connection is.

import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import { createMailbox } from "../src/domain/hub-mailbox.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import {
  FakeConnection,
  createTestPeer,
  hubVerifier,
  settle,
} from "./relay-hub-test-helpers.js";

const ENTRY_BYTES = 4;
type MailboxRefusalHandler = NonNullable<
  Parameters<typeof createRelayHub>[0]["onMailboxRefused"]
>;

const limits = {
  maxLogs: 2,
  maxLogBytes: 100,
  maxEntryBytes: 50,
  readBatch: 2,
};

function connect(
  hub: Readonly<ReturnType<typeof createRelayHub>>,
): FakeConnection {
  const fake = new FakeConnection();
  void hub.handleConnection(fake.connection);

  return fake;
}

function entry(fill: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(ENTRY_BYTES).fill(fill);
}

describe("createRelayHub: mailbox", () => {
  it("holds an owner's log and serves it to another registered client", async () => {
    const hub = createRelayHub({
      identity: hubVerifier,
      mailbox: createMailbox({ storage: createMemoryStorage(), limits }),
    });
    const author = await createTestPeer();
    const reader = await createTestPeer();
    const fromAuthor = connect(hub);
    const fromReader = connect(hub);
    fromAuthor.push(author.gossip);
    fromReader.push(reader.gossip);
    await settle(fromAuthor, fromReader);

    fromAuthor.push({
      type: "data-have",
      peer: author.device,
      "head-seq": 2,
    });
    await settle(fromAuthor);
    expect(fromAuthor.sent.at(-1)).toEqual({
      type: "data-request",
      peer: author.device,
      "from-seq": 0,
    });
    fromAuthor.push({
      type: "data-entries",
      peer: author.device,
      "from-seq": 0,
      entries: [entry(1), entry(2)],
    });
    await settle(fromAuthor);
    fromReader.push({
      type: "data-request",
      peer: author.device,
      "from-seq": 0,
    });
    await settle(fromReader);

    expect(
      fromReader.sent.find((frame) => frame.type === "data-entries"),
    ).toEqual({
      type: "data-entries",
      peer: author.device,
      "from-seq": 0,
      entries: [entry(1), entry(2)],
    });
  });

  it("does not take another device's log from a connection that merely names it", async () => {
    const onMailboxRefused = vi.fn<MailboxRefusalHandler>();
    const hub = createRelayHub({
      identity: hubVerifier,
      mailbox: createMailbox({ storage: createMemoryStorage(), limits }),
      onMailboxRefused,
    });
    const owner = await createTestPeer();
    const intruder = await createTestPeer();
    const fromIntruder = connect(hub);
    fromIntruder.push(intruder.gossip);
    await settle(fromIntruder);

    fromIntruder.push({
      type: "data-entries",
      peer: owner.device,
      "from-seq": 0,
      entries: [entry(1)],
    });
    await settle(fromIntruder);

    expect(onMailboxRefused).toHaveBeenCalledWith({
      device: intruder.device,
      reason: "not-the-owner",
    });
  });

  it("refuses a connection that has not registered a device, and says so to the host", async () => {
    const onMailboxRefused = vi.fn<MailboxRefusalHandler>();
    const hub = createRelayHub({
      identity: hubVerifier,
      mailbox: createMailbox({ storage: createMemoryStorage(), limits }),
      onMailboxRefused,
    });
    const anonymous = connect(hub);
    const target = await createTestPeer();

    anonymous.push({
      type: "data-request",
      peer: target.device,
      "from-seq": 0,
    });
    await settle(anonymous);

    expect(anonymous.sent).toEqual([]);
    expect(onMailboxRefused).toHaveBeenCalledWith({
      device: undefined,
      reason: "unregistered-sender",
    });
  });

  it("ignores data frames when it has no mailbox, as it always has", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peer = await createTestPeer();
    const fromPeer = connect(hub);
    fromPeer.push(peer.gossip);
    await settle(fromPeer);
    const sentBefore = fromPeer.sent.length;

    fromPeer.push({ type: "data-have", peer: peer.device, "head-seq": 2 });
    await settle(fromPeer);

    expect(fromPeer.sent).toHaveLength(sentBefore);
  });
});
