import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import {
  createMailbox,
  type MailboxLimits,
  type MailboxRefusalReason,
} from "../src/domain/hub-mailbox.js";
import { headSeqFor } from "../src/domain/data-sync.js";
import type { DeviceId } from "../src/generated/protocol.js";

const DEVICE_ID_BYTE_LENGTH = 32;

/** A device-id of the given fill byte: the mailbox only compares them, so the fixtures need no real keys. */
function device(fill: number): DeviceId {
  return new Uint8Array(DEVICE_ID_BYTE_LENGTH).fill(fill);
}

const ALICE_FILL = 1;
const BOB_FILL = 2;
const CAROL_FILL = 3;
const alice = device(ALICE_FILL);
const bob = device(BOB_FILL);
const carol = device(CAROL_FILL);

/** Sizes chosen so each limit can be hit on its own: an entry of SMALL fits many times, one of MEDIUM twice. */
const SMALL = 4;
const MEDIUM = 6;
const generousLimits: MailboxLimits = {
  maxLogs: 10,
  maxLogBytes: 1000,
  maxEntryBytes: 100,
  readBatch: 2,
};

function entry(size: number, fill = 7): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size).fill(fill);
}

function setup(limits: MailboxLimits = generousLimits) {
  const storage = createMemoryStorage();
  const mailbox = createMailbox({ storage, limits });
  const refusals: MailboxRefusalReason[] = [];
  const handle: typeof mailbox.handle = async (sender, frame) =>
    mailbox.handle(sender, frame, (reason) => {
      refusals.push(reason);
    });

  return { storage, handle, refusals };
}

describe("createMailbox", () => {
  it("asks the owner for the entries it announces, from the start of an empty log", async () => {
    const { handle } = setup();

    const reply = await handle(alice, {
      type: "data-have",
      peer: alice,
      "head-seq": 2,
    });

    expect(reply).toEqual({ type: "data-request", peer: alice, "from-seq": 0 });
  });

  it("holds what the owner pushes and hands it to another device that asks", async () => {
    const { handle, storage } = setup();
    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(SMALL, 1), entry(SMALL, 2)],
    });

    const reply = await handle(bob, {
      type: "data-request",
      peer: alice,
      "from-seq": 0,
    });

    expect(await headSeqFor(storage, alice)).toBe(2);
    expect(reply).toEqual({
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(SMALL, 1), entry(SMALL, 2)],
    });
  });

  it("answers a read one batch at a time", async () => {
    const { handle } = setup({ ...generousLimits, readBatch: 1 });
    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(1, 1), entry(1, 2)],
    });

    const reply = await handle(bob, {
      type: "data-request",
      peer: alice,
      "from-seq": 0,
    });

    expect(reply).toMatchObject({ entries: [entry(1, 1)] });
  });

  it("says nothing to a read for a log it does not hold", async () => {
    const { handle } = setup();

    expect(
      await handle(bob, { type: "data-request", peer: alice, "from-seq": 0 }),
    ).toBeNull();
  });

  it("refuses entries for a log the sender does not own, keeping nothing", async () => {
    const { handle, storage, refusals } = setup();

    const reply = await handle(bob, {
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(SMALL)],
    });

    expect(reply).toBeNull();
    expect(refusals).toEqual(["not-the-owner"]);
    expect(await headSeqFor(storage, alice)).toBe(0);
  });

  it("refuses an announcement for a log the sender does not own", async () => {
    const { handle, refusals } = setup();

    const reply = await handle(bob, {
      type: "data-have",
      peer: alice,
      "head-seq": 5,
    });

    expect(reply).toBeNull();
    expect(refusals).toEqual(["not-the-owner"]);
  });

  it("refuses every data frame from a connection that has no verified device", async () => {
    const { handle, refusals } = setup();

    await handle(undefined, { type: "data-have", peer: alice, "head-seq": 1 });
    await handle(undefined, {
      type: "data-request",
      peer: alice,
      "from-seq": 0,
    });

    expect(refusals).toEqual(["unregistered-sender", "unregistered-sender"]);
  });

  it("refuses a frame carrying an entry larger than allowed, keeping none of its entries", async () => {
    const { handle, storage, refusals } = setup();

    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(SMALL), entry(generousLimits.maxEntryBytes + 1)],
    });

    expect(refusals).toEqual(["size-limit"]);
    expect(await headSeqFor(storage, alice)).toBe(0);
  });

  it("refuses a frame that would take a log past its byte limit, and accepts what still fits", async () => {
    const { handle, storage, refusals } = setup({
      ...generousLimits,
      maxLogBytes: 10,
    });
    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(MEDIUM)],
    });

    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 1,
      entries: [entry(MEDIUM)],
    });
    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 1,
      entries: [entry(SMALL)],
    });

    expect(refusals).toEqual(["entry-limit"]);
    expect(await headSeqFor(storage, alice)).toBe(2);
  });

  it("holds no more logs than it is allowed, and keeps serving the ones it has", async () => {
    const { handle, storage, refusals } = setup({
      ...generousLimits,
      maxLogs: 1,
    });
    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(2)],
    });

    await handle(bob, {
      type: "data-have",
      peer: bob,
      "head-seq": 1,
    });
    await handle(bob, {
      type: "data-entries",
      peer: bob,
      "from-seq": 0,
      entries: [entry(2)],
    });
    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 1,
      entries: [entry(2)],
    });

    expect(refusals).toEqual(["log-limit", "log-limit"]);
    expect(await headSeqFor(storage, bob)).toBe(0);
    expect(await headSeqFor(storage, alice)).toBe(2);
  });

  it("refuses entries that leave a gap after what it holds", async () => {
    const { handle, refusals, storage } = setup();

    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 4,
      entries: [entry(2)],
    });

    expect(refusals).toEqual(["gap"]);
    expect(await headSeqFor(storage, alice)).toBe(0);
  });

  it("counts a log's bytes per owner, so one device filling its log leaves another's room", async () => {
    const { handle, storage } = setup({ ...generousLimits, maxLogBytes: 4 });
    await handle(alice, {
      type: "data-entries",
      peer: alice,
      "from-seq": 0,
      entries: [entry(SMALL)],
    });

    await handle(carol, {
      type: "data-entries",
      peer: carol,
      "from-seq": 0,
      entries: [entry(SMALL)],
    });

    expect(await headSeqFor(storage, carol)).toBe(1);
  });
});
