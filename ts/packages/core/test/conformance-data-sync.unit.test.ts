/* Checks every scenario of conformance/data-sync.v1.json against the real data-sync functions over a memory store. The schemas are strict, so a key this test does not read fails it. In summary:

   - each scenario starts a store holding the keys the file lists and runs its steps in order;
   - each step is compared with what it returns (a head, a frame, whether entries applied, the entries read) and with the whole store after it, so a stray write or a missing one fails;
   - an append also returns the data-have frame announcing it;
   - the number of scenarios is the one the file's header says.

   Not compared, because they only name: every `name`, and the layout version (checked to be the one this test reads). */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMemoryStorage } from "../src/adapters/memory-storage.js";
import {
  appendOwnEntry,
  handleDataEntries,
  handleDataHave,
  handleDataRequest,
  headSeqFor,
  readEntries,
} from "../src/domain/data-sync.js";
import {
  dataEntriesFrameSchema,
  dataHaveFrameSchema,
  dataRequestFrameSchema,
  type DataEntriesFrame,
  type DataHaveFrame,
  type DataRequestFrame,
} from "../src/generated/protocol.js";
import { eachInOrder } from "../src/domain/sequential.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { bytesFromHex } from "./hex.js";

const LAYOUT_VERSION = 1;
const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const store = z.record(z.string(), hexString);
const frameName = z.string();

const stepSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("head_seq_for"),
    peer_hex: hexString,
    returns: z.number().int(),
    store,
  }),
  z.strictObject({
    op: z.literal("append_own_entry"),
    entry_hex: hexString,
    returns: z.number().int(),
    have_frame: frameName,
    store,
  }),
  z.strictObject({
    op: z.literal("handle_data_have"),
    frame: frameName,
    returns: frameName.nullable(),
    store,
  }),
  z.strictObject({
    op: z.literal("handle_data_request"),
    frame: frameName,
    limit: z.number().int(),
    returns: frameName.nullable(),
    store,
  }),
  z.strictObject({
    op: z.literal("handle_data_entries"),
    frame: frameName,
    returns: z.enum(["applied", "gap"]),
    store,
  }),
  z.strictObject({
    op: z.literal("read_entries"),
    peer_hex: hexString,
    after: z.number().int(),
    returns: z.array(hexString),
    store,
  }),
]);

const file = z
  .object({
    vectors: z.array(z.object({ name: z.string(), message: z.unknown() })),
    data_sync: z.strictObject({
      layout_version: z.literal(LAYOUT_VERSION),
      scenarios: z.array(
        z.strictObject({
          name: z.string(),
          own_device_hex: hexString,
          store,
          steps: z.array(stepSchema),
        }),
      ),
      counts: z.strictObject({ scenarios: z.number().int() }),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("../../../../conformance/data-sync.v1.json", import.meta.url),
        ),
        "utf8",
      ),
    ),
  );
const section = file.data_sync;

function messageOf(name: string): unknown {
  const found = file.vectors.find((vector) => vector.name === name);
  if (found === undefined) {
    throw new Error(`vector file has no vector ${name}`);
  }

  return found.message;
}

const bytes = z
  .strictObject({ hex: hexString })
  .transform((value) => bytesFromHex(value.hex));

/** A frame of the file, with its byte strings read from the `{ "hex": ... }` form the JSON carries. */
function haveOf(name: string): DataHaveFrame {
  const message = z
    .strictObject({
      type: z.literal("data-have"),
      peer: bytes,
      "head-seq": z.number().int(),
    })
    .parse(messageOf(name));

  return dataHaveFrameSchema.parse(message);
}

function requestOf(name: string): DataRequestFrame {
  const message = z
    .strictObject({
      type: z.literal("data-request"),
      peer: bytes,
      "from-seq": z.number().int(),
    })
    .parse(messageOf(name));

  return dataRequestFrameSchema.parse(message);
}

function entriesOf(name: string): DataEntriesFrame {
  const message = z
    .strictObject({
      type: z.literal("data-entries"),
      peer: bytes,
      "from-seq": z.number().int(),
      entries: z.array(bytes),
    })
    .parse(messageOf(name));

  return dataEntriesFrameSchema.parse(message);
}

/** The identity of a store's owner. Data-sync reads only its device-id, so every operation that would sign or verify fails loudly: a scenario that reached one would be testing something else. */
function identityOf(deviceHex: string): IdentityPort {
  const unused = (): never => {
    throw new Error("data-sync must not sign or verify");
  };

  return {
    deviceId: bytesFromHex(deviceHex),
    identityKey: { alg: -8, "public-key": new Uint8Array(0) },
    sign: unused,
    verify: unused,
    deriveDeviceId: unused,
  };
}

async function snapshot(
  storage: Readonly<ReturnType<typeof createMemoryStorage>>,
): Promise<Record<string, string>> {
  const keys = (await storage.keys("")).sort();
  const entries = await Promise.all(
    keys.map(async (key) => {
      const value = await storage.get(key);
      if (value === undefined) {
        throw new Error(`key ${key} listed but not held`);
      }

      return [key, Buffer.from(value).toString("hex")] as const;
    }),
  );

  return Object.fromEntries(entries);
}

describe("the file's own accounting", () => {
  it("holds the number of scenarios its header says", () => {
    expect(section.scenarios).toHaveLength(section.counts.scenarios);
  });
});

type Step = z.infer<typeof stepSchema>;

/** Runs one step against the store and compares what it returns. */
async function runStep(
  step: Step,
  identity: IdentityPort,
  storage: Readonly<ReturnType<typeof createMemoryStorage>>,
): Promise<void> {
  if (step.op === "head_seq_for") {
    expect(await headSeqFor(storage, bytesFromHex(step.peer_hex))).toBe(
      step.returns,
    );
  } else if (step.op === "append_own_entry") {
    const result = await appendOwnEntry(
      { identity, storage },
      bytesFromHex(step.entry_hex),
    );
    expect(result.seq).toBe(step.returns);
    expect(result.haveFrame).toEqual(haveOf(step.have_frame));
  } else if (step.op === "handle_data_have") {
    const verdict = await handleDataHave(storage, haveOf(step.frame));
    expect(verdict).toEqual(
      step.returns === null ? null : requestOf(step.returns),
    );
  } else if (step.op === "handle_data_request") {
    const verdict = await handleDataRequest(
      storage,
      requestOf(step.frame),
      step.limit,
    );
    expect(verdict).toEqual(
      step.returns === null ? null : entriesOf(step.returns),
    );
  } else if (step.op === "handle_data_entries") {
    const verdict = await handleDataEntries(storage, entriesOf(step.frame));
    expect(verdict.ok ? "applied" : verdict.reason).toBe(
      step.returns === "applied" ? "applied" : "gap",
    );
  } else {
    const read = await readEntries(
      storage,
      bytesFromHex(step.peer_hex),
      step.after,
    );
    expect(read.map((entry) => Buffer.from(entry).toString("hex"))).toEqual(
      step.returns,
    );
  }
  expect(await snapshot(storage), step.op).toEqual(step.store);
}

describe("data-sync", () => {
  for (const scenario of section.scenarios) {
    it(scenario.name, async () => {
      const storage = createMemoryStorage();
      await eachInOrder(
        Object.entries(scenario.store),
        async ([key, value]) => {
          await storage.set(key, bytesFromHex(value));
        },
      );
      const identity = identityOf(scenario.own_device_hex);
      await eachInOrder(scenario.steps, async (step) => {
        await runStep(step, identity, storage);
      });
    });
  }
});
