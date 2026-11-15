import { describe, expect, it } from "vitest";
import {
  InvalidLogHeadError,
  appendOwnEntry,
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
  headSeqFor,
  readEntries,
} from "../src/domain/data-sync.js";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import { eachInOrder } from "../src/domain/sequential.js";
import { deviceIdFromFillHex } from "./hex.js";
import type { KeyValueStorage } from "../src/ports/storage.js";
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

/** The head text of a log a store may hold, and why each is not a head. */
const MALFORMED_HEADS: readonly (readonly [string, string])[] = [
  ["empty", ""],
  ["not a number", "abc"],
  ["hexadecimal", "0x10"],
  ["an exponent", "1e3"],
  ["negative", "-1"],
  ["fractional", "1.5"],
  ["NaN", "NaN"],
  ["with leading zeros", "01"],
  ["with a leading sign", "+1"],
  ["with surrounding space", " 1"],
  ["above the safe integers", "9007199254740993"],
  ["infinite", "Infinity"],
];

describe("a stored head that is not a decimal integer", () => {
  const OWN = deviceIdFromFillHex("01");

  async function storeWithHead(text: string): Promise<{
    storage: KeyValueStorage;
    before: string[];
  }> {
    const storage = createMemoryStorage();
    await storage.set(`data/${deviceIdToHex(OWN)}/head`, bytes(text));
    const before = await storage.keys("");

    return { storage, before };
  }

  it.each(MALFORMED_HEADS)("is refused when it is %s", async (_why, text) => {
    const { storage, before } = await storeWithHead(text);
    await expect(headSeqFor(storage, OWN)).rejects.toThrow(InvalidLogHeadError);
    await expect(
      handleDataHave(storage, { type: "data-have", peer: OWN, "head-seq": 1 }),
    ).rejects.toThrow(InvalidLogHeadError);
    await expect(
      handleDataRequest(
        storage,
        { type: "data-request", peer: OWN, "from-seq": 0 },
        ENTRY_LIMIT,
      ),
    ).rejects.toThrow(InvalidLogHeadError);
    await expect(
      handleDataEntries(storage, {
        type: "data-entries",
        peer: OWN,
        "from-seq": 0,
        entries: [bytes("x")],
      }),
    ).rejects.toThrow(InvalidLogHeadError);
    await expect(readEntries(storage, OWN, 0)).rejects.toThrow(
      InvalidLogHeadError,
    );
    expect(await storage.keys("")).toEqual(before);
  });

  it("names the head it refused", async () => {
    const { storage } = await storeWithHead("abc");
    await expect(headSeqFor(storage, OWN)).rejects.toThrow(/"abc"/);
  });

  it("is never overwritten by an append and writes nothing", async () => {
    const identity = await generateEs256Identity();
    const own = identity.deviceId;
    const storage = createMemoryStorage();
    const key = `data/${deviceIdToHex(own)}/head`;
    await storage.set(key, bytes("abc"));
    await expect(
      appendOwnEntry({ identity, storage }, bytes("a")),
    ).rejects.toThrow(InvalidLogHeadError);
    expect(await storage.keys("")).toEqual([key]);
    expect(new TextDecoder().decode(await storage.get(key))).toBe("abc");
  });

  it("accepts the plain decimal forms a head is written as", async () => {
    await eachInOrder(["0", "1", "10", "9007199254740991"], async (text) => {
      const { storage } = await storeWithHead(text);
      await expect(headSeqFor(storage, OWN)).resolves.toBe(Number(text));
    });
  });
});

/** A storage that fails every set from the failAt-th one on (counting from 1), so a test can see what a failure part way leaves behind. */
function failingStorage(failAt: number): {
  storage: KeyValueStorage;
  inner: KeyValueStorage;
} {
  const inner = createMemoryStorage();
  let sets = 0;

  return {
    inner,
    storage: {
      get: async (key) => inner.get(key),
      set: async (key, value) => {
        sets += 1;
        if (sets >= failAt) {
          throw new Error("injected failure");
        }
        await inner.set(key, value);
      },
      delete: async (key) => inner.delete(key),
      keys: async (prefix) => inner.keys(prefix),
    },
  };
}

describe("the write order of a log", () => {
  const PEER = deviceIdFromFillHex("02");
  const PEER_HEX = deviceIdToHex(PEER);
  const FIRST_SET = 1;
  const FAIL_POINTS_OF_AN_APPEND = [FIRST_SET, FIRST_SET + 1];
  // Three entries are applied by four writes (the entries, then the head): failing at each leaves a different prefix.
  const SEQUENCES = [1, 2, THREE_ENTRIES_HEAD_SEQ];
  const FAIL_POINTS_OF_THREE_ENTRIES = [...SEQUENCES, SEQUENCES.length + 1];

  async function headOf(
    inner: Readonly<KeyValueStorage>,
    hex: string,
  ): Promise<number> {
    const raw = await inner.get(`data/${hex}/head`);

    return raw === undefined ? 0 : Number(new TextDecoder().decode(raw));
  }

  /** Which of the entries 1 to 3 the store holds. */
  async function heldEntries(
    inner: Readonly<KeyValueStorage>,
    hex: string,
  ): Promise<boolean[]> {
    return Promise.all(
      SEQUENCES.map(
        async (seq) =>
          (await inner.get(`data/${hex}/entry/${String(seq)}`)) !== undefined,
      ),
    );
  }

  /** The invariant of the write order: every sequence up to the head has its entry, so the head is never ahead of the entries. */
  async function assertHeadIsCovered(
    inner: Readonly<KeyValueStorage>,
    hex: string,
  ): Promise<void> {
    const head = await headOf(inner, hex);
    const held = await heldEntries(inner, hex);
    SEQUENCES.filter((seq) => seq <= head).forEach((seq) => {
      expect(
        held[seq - 1],
        `the head ${String(head)} is ahead of the entry ${String(seq)}`,
      ).toBe(true);
    });
  }

  it("never leaves the head ahead of its entry when an append fails", async () => {
    const identity = await generateEs256Identity();
    const ownHex = deviceIdToHex(identity.deviceId);
    await eachInOrder(FAIL_POINTS_OF_AN_APPEND, async (failAt) => {
      const { storage, inner } = failingStorage(failAt);
      await expect(
        appendOwnEntry({ identity, storage }, bytes("a")),
      ).rejects.toThrow("injected failure");
      await assertHeadIsCovered(inner, ownHex);
      expect(await headOf(inner, ownHex)).toBe(0);
    });
  });

  it("leaves a contiguous prefix the head does not cover when applying entries fails", async () => {
    const frame: DataEntriesFrame = {
      type: "data-entries",
      peer: PEER,
      "from-seq": 0,
      entries: [bytes("x"), bytes("y"), bytes("z")],
    };
    await eachInOrder(FAIL_POINTS_OF_THREE_ENTRIES, async (failAt) => {
      const { storage, inner } = failingStorage(failAt);
      await expect(handleDataEntries(storage, frame)).rejects.toThrow(
        "injected failure",
      );
      await assertHeadIsCovered(inner, PEER_HEX);
      expect(await headOf(inner, PEER_HEX)).toBe(0);
      const held = await heldEntries(inner, PEER_HEX);
      // A prefix: an entry is held only when every entry before it is.
      held.forEach((isHeld, index) => {
        expect(
          !isHeld || held.slice(0, index).every(Boolean),
          `entry ${String(index + 1)} follows a missing one`,
        ).toBe(true);
      });
    });
  });
});
