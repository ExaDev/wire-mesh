import { describe, expect, it } from "vitest";
import {
  appendOwnEntry,
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
  headSeqFor,
  readEntries,
} from "../src/domain/data-sync.js";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import { deviceIdFromFillHex } from "./hex.js";
import { generateEs256Identity } from "./tokens-fixtures.js";
import type {
  DataEntriesFrame,
  DataHaveFrame,
} from "../src/generated/protocol.js";

const ENTRY_LIMIT = 10;
const THREE_ENTRIES_HEAD_SEQ = 3;

function bytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(new TextEncoder().encode(text));
}

describe("appendOwnEntry", () => {
  it("starts at sequence 1 for an empty log", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    const { seq } = await appendOwnEntry({ identity, storage }, bytes("a"));
    expect(seq).toBe(1);
  });

  it("increments sequence on each successive append", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    await appendOwnEntry({ identity, storage }, bytes("a"));
    const { seq } = await appendOwnEntry({ identity, storage }, bytes("b"));
    expect(seq).toBe(2);
  });

  it("returns a data-have frame naming this device and the new head-seq", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    const { haveFrame } = await appendOwnEntry(
      { identity, storage },
      bytes("a"),
    );
    expect(haveFrame).toEqual({
      type: "data-have",
      peer: identity.deviceId,
      "head-seq": 1,
    } satisfies DataHaveFrame);
  });
});

describe("headSeqFor", () => {
  it("is 0 for a peer this store has never heard of", async () => {
    const storage = createMemoryStorage();
    const unknownPeer = deviceIdFromFillHex("11");
    expect(await headSeqFor(storage, unknownPeer)).toBe(0);
  });

  it("reflects the current head after appends to that peer's own log", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    await appendOwnEntry({ identity, storage }, bytes("a"));
    await appendOwnEntry({ identity, storage }, bytes("b"));
    expect(await headSeqFor(storage, identity.deviceId)).toBe(2);
  });
});

describe("handleDataHave", () => {
  it("requests from its own current head when behind the announced head-seq", async () => {
    const storage = createMemoryStorage();
    const peer = deviceIdFromFillHex("11");
    const frame: DataHaveFrame = { type: "data-have", peer, "head-seq": 5 };
    expect(await handleDataHave(storage, frame)).toEqual({
      type: "data-request",
      peer,
      "from-seq": 0,
    });
  });

  it("returns null when already caught up to the announced head-seq", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    await appendOwnEntry({ identity, storage }, bytes("a"));
    const frame: DataHaveFrame = {
      type: "data-have",
      peer: identity.deviceId,
      "head-seq": 1,
    };
    expect(await handleDataHave(storage, frame)).toBeNull();
  });

  it("returns null when already ahead of the announced head-seq", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    await appendOwnEntry({ identity, storage }, bytes("a"));
    await appendOwnEntry({ identity, storage }, bytes("b"));
    const frame: DataHaveFrame = {
      type: "data-have",
      peer: identity.deviceId,
      "head-seq": 1,
    };
    expect(await handleDataHave(storage, frame)).toBeNull();
  });
});

describe("handleDataRequest", () => {
  it("returns null when this store holds nothing past the requested from-seq", async () => {
    const storage = createMemoryStorage();
    const peer = deviceIdFromFillHex("11");
    const result = await handleDataRequest(
      storage,
      { type: "data-request", peer, "from-seq": 0 },
      ENTRY_LIMIT,
    );
    expect(result).toBeNull();
  });

  it("returns every entry after from-seq when within limit", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    await appendOwnEntry({ identity, storage }, bytes("a"));
    await appendOwnEntry({ identity, storage }, bytes("b"));
    await appendOwnEntry({ identity, storage }, bytes("c"));

    const result = await handleDataRequest(
      storage,
      { type: "data-request", peer: identity.deviceId, "from-seq": 1 },
      ENTRY_LIMIT,
    );

    expect(result).toEqual({
      type: "data-entries",
      peer: identity.deviceId,
      "from-seq": 1,
      entries: [bytes("b"), bytes("c")],
    } satisfies DataEntriesFrame);
  });

  it("caps the response at limit entries, leaving the rest for a follow-up request", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    await appendOwnEntry({ identity, storage }, bytes("a"));
    await appendOwnEntry({ identity, storage }, bytes("b"));
    await appendOwnEntry({ identity, storage }, bytes("c"));

    const result = await handleDataRequest(
      storage,
      { type: "data-request", peer: identity.deviceId, "from-seq": 0 },
      2,
    );

    expect(result).toEqual({
      type: "data-entries",
      peer: identity.deviceId,
      "from-seq": 0,
      entries: [bytes("a"), bytes("b")],
    } satisfies DataEntriesFrame);
  });
});

describe("handleDataEntries", () => {
  it("persists entries and advances head-seq when from-seq matches this store's own current head", async () => {
    const storage = createMemoryStorage();
    const peer = deviceIdFromFillHex("11");
    const result = await handleDataEntries(storage, {
      type: "data-entries",
      peer,
      "from-seq": 0,
      entries: [bytes("a"), bytes("b")],
    });
    expect(result).toEqual({ ok: true });
    expect(await headSeqFor(storage, peer)).toBe(2);
    expect(await readEntries(storage, peer, 0)).toEqual([
      bytes("a"),
      bytes("b"),
    ]);
  });

  it("refuses entries whose from-seq is ahead of this store's own current head, a real gap", async () => {
    const storage = createMemoryStorage();
    const peer = deviceIdFromFillHex("11");
    const result = await handleDataEntries(storage, {
      type: "data-entries",
      peer,
      "from-seq": 5,
      entries: [bytes("z")],
    });
    expect(result).toEqual({ ok: false, reason: "gap" });
    expect(await headSeqFor(storage, peer)).toBe(0);
  });

  it("refuses entries whose from-seq is behind this store's own current head, a stale replay", async () => {
    const storage = createMemoryStorage();
    const peer = deviceIdFromFillHex("11");
    await handleDataEntries(storage, {
      type: "data-entries",
      peer,
      "from-seq": 0,
      entries: [bytes("a")],
    });
    const result = await handleDataEntries(storage, {
      type: "data-entries",
      peer,
      "from-seq": 0,
      entries: [bytes("a-replayed")],
    });
    expect(result).toEqual({ ok: false, reason: "gap" });
    expect(await headSeqFor(storage, peer)).toBe(1);
  });
});

describe("readEntries", () => {
  it("returns nothing when the store holds nothing past fromSeqExclusive", async () => {
    const identity = await generateEs256Identity();
    const storage = createMemoryStorage();
    await appendOwnEntry({ identity, storage }, bytes("a"));
    expect(await readEntries(storage, identity.deviceId, 1)).toEqual([]);
  });
});

describe("end-to-end sync between two independent stores", () => {
  it("catches a behind peer up to a full match via have -> request -> entries -> handleDataEntries", async () => {
    const author = await generateEs256Identity();
    const authorStorage = createMemoryStorage();
    await appendOwnEntry(
      { identity: author, storage: authorStorage },
      bytes("a"),
    );
    await appendOwnEntry(
      { identity: author, storage: authorStorage },
      bytes("b"),
    );
    const { haveFrame } = await appendOwnEntry(
      { identity: author, storage: authorStorage },
      bytes("c"),
    );

    const readerStorage = createMemoryStorage();
    const request = await handleDataHave(readerStorage, haveFrame);
    if (request === null) throw new Error("expected a data-request");

    const response = await handleDataRequest(
      authorStorage,
      request,
      ENTRY_LIMIT,
    );
    if (response === null) throw new Error("expected a data-entries response");

    const result = await handleDataEntries(readerStorage, response);
    expect(result).toEqual({ ok: true });
    expect(await headSeqFor(readerStorage, author.deviceId)).toBe(
      THREE_ENTRIES_HEAD_SEQ,
    );
    expect(await readEntries(readerStorage, author.deviceId, 0)).toEqual([
      bytes("a"),
      bytes("b"),
      bytes("c"),
    ]);
  });
});
