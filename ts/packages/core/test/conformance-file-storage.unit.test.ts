/* Checks every case of conformance/file-storage.v1.json against the real file-backed storage and its layout functions. The schemas are strict, so a key this test does not read fails it. In summary:

   - each key is accepted with the path the file names, or refused with the reason the file names, by the pure layout functions;
   - each scenario materialises its starting directory with plain file operations (so the storage reads what another implementation wrote), runs its operations, and compares what each returns and the whole directory after it, read back with plain file operations (so what the storage wrote is what another implementation reads);
   - every refusal reason has a case, and every list holds the number of entries the file's header says.

   Not compared, because they only name: every `name`, and the layout version (checked to be the one this test reads). */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createNodeFsStorage } from "../src/adapters/node-fs-storage.js";
import {
  InvalidStorageKeyError,
  refusalOfKey,
  segmentsOfKey,
  type KeyRefusal,
} from "../src/adapters/node-fs-layout.js";
import { eachInOrder } from "../src/domain/sequential.js";
import { bytesFromHex } from "./hex.js";

const LAYOUT_VERSION = 1;
const hexString = z.string().regex(/^(?:[0-9a-f]{2})*$/);
const directory = z.record(z.string(), hexString);

const stepSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("get"),
    key: z.string(),
    returns: hexString.nullable().or(z.enum(["error", "refused"])),
    directory,
  }),
  z.strictObject({
    op: z.literal("set"),
    key: z.string(),
    value_hex: hexString,
    returns: z.enum(["ok", "error", "refused"]),
    directory,
  }),
  z.strictObject({
    op: z.literal("delete"),
    key: z.string(),
    returns: z.enum(["ok", "error", "refused"]),
    directory,
  }),
  z.strictObject({
    op: z.literal("keys"),
    prefix: z.string(),
    returns: z.array(z.string()),
    directory,
  }),
]);

const file = z
  .object({
    file_storage: z.strictObject({
      layout_version: z.literal(LAYOUT_VERSION),
      key_layout: z.array(
        z.strictObject({
          name: z.string(),
          key: z.string(),
          expected: z.union([
            z.strictObject({ path: z.string() }),
            z.strictObject({ refusal: z.string() }),
          ]),
        }),
      ),
      scenarios: z.array(
        z.strictObject({
          name: z.string(),
          start: directory,
          steps: z.array(stepSchema),
        }),
      ),
      counts: z.strictObject({
        key_layout: z.number().int(),
        scenarios: z.number().int(),
      }),
    }),
  })
  .parse(
    JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL(
            "../../../../conformance/file-storage.v1.json",
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  );
const section = file.file_storage;

/** Every refusal the layout can give, each of which has a case in the file. */
const REFUSALS = [
  "empty",
  "nul",
  "backslash",
  "absolute",
  "empty_segment",
  "dot_segment",
  "parent_segment",
  "drive_prefix",
] as const satisfies readonly KeyRefusal[];

describe("the file's own accounting", () => {
  it("holds the number of entries its header says", () => {
    expect(section.key_layout).toHaveLength(section.counts.key_layout);
    expect(section.scenarios).toHaveLength(section.counts.scenarios);
  });

  it("has a case for every refusal", () => {
    const named = new Set(
      section.key_layout.flatMap((entry) =>
        "refusal" in entry.expected ? [entry.expected.refusal] : [],
      ),
    );
    for (const refusal of REFUSALS) {
      expect(named, refusal).toContain(refusal);
    }
  });
});

describe("the key layout", () => {
  for (const entry of section.key_layout) {
    it(entry.name, () => {
      if ("path" in entry.expected) {
        expect(refusalOfKey(entry.key)).toBeUndefined();
        expect(segmentsOfKey(entry.key).join("/")).toBe(entry.expected.path);
      } else {
        expect(refusalOfKey(entry.key)).toBe(entry.expected.refusal);
        expect(() => segmentsOfKey(entry.key)).toThrow(InvalidStorageKeyError);
      }
    });
  }
});

const roots: string[] = [];

afterEach(async () => {
  await eachInOrder(roots.splice(0), async (root) => {
    await rm(root, { recursive: true, force: true });
  });
});

/** Writes `files` under `root` with plain file operations: the directory another implementation would have written. A directory with no files is not created, so the storage is also checked over a directory that does not exist. */
async function materialise(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await eachInOrder(Object.entries(files), async ([path, content]) => {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytesFromHex(content));
  });
}

/** Every file under `root` with its content in hex, read with plain file operations: what another implementation would read. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const names = await readdir(root, {
    recursive: true,
    withFileTypes: true,
  }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const files = names
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
    .sort();
  const held = await Promise.all(
    files.map(async (path) => [
      path.split(sep).join("/"),
      (await readFile(join(root, path))).toString("hex"),
    ]),
  );

  return Object.fromEntries(held) as Record<string, string>;
}

type Step = z.infer<typeof stepSchema>;

/** What an operation did, as the file names it: `ok`, `refused` for a key the layout refuses, `error` for an operating system error. */
async function outcome(
  run: () => Promise<unknown>,
): Promise<"ok" | "refused" | "error"> {
  try {
    await run();

    return "ok";
  } catch (error) {
    return error instanceof InvalidStorageKeyError ? "refused" : "error";
  }
}

async function runStep(
  step: Step,
  storage: Readonly<ReturnType<typeof createNodeFsStorage>>,
): Promise<void> {
  if (step.op === "get") {
    let got: string | null;
    try {
      const value = await storage.get(step.key);
      got = value === undefined ? null : Buffer.from(value).toString("hex");
    } catch (error) {
      got = error instanceof InvalidStorageKeyError ? "refused" : "error";
    }
    expect(got, `get ${step.key}`).toBe(step.returns);
  } else if (step.op === "set") {
    expect(
      await outcome(async () =>
        storage.set(step.key, bytesFromHex(step.value_hex)),
      ),
      `set ${step.key}`,
    ).toBe(step.returns);
  } else if (step.op === "delete") {
    expect(
      await outcome(async () => storage.delete(step.key)),
      `delete ${step.key}`,
    ).toBe(step.returns);
  } else {
    expect((await storage.keys(step.prefix)).sort()).toEqual(step.returns);
  }
}

describe("createNodeFsStorage over the file's directories", () => {
  for (const scenario of section.scenarios) {
    it(scenario.name, async () => {
      const parent = await mkdtemp(join(tmpdir(), "file-storage-vectors-"));
      roots.push(parent);
      const root = join(parent, "store");
      await materialise(root, scenario.start);
      const storage = createNodeFsStorage({ dir: root });

      await eachInOrder(scenario.steps, async (step) => {
        await runStep(step, storage);
        expect(await snapshot(root), `directory after ${step.op}`).toEqual(
          step.directory,
        );
      });
    });
  }
});
