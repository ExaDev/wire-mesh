import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidStorageKeyError,
  type KeyRefusal,
} from "../src/adapters/node-fs-layout.js";
import { createNodeFsStorage } from "../src/adapters/node-fs-storage.js";
import { bytesFromHex } from "./hex.js";

let tmpDirs: string[] = [];

async function freshDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "node-fs-storage-"));
  tmpDirs.push(dir);

  return dir;
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(async () => {
  await Promise.all(
    tmpDirs.map(async (dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("createNodeFsStorage", () => {
  it("round-trips a set value through get", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    const value = bytesFromHex("010203");
    await storage.set("a", value);
    expect(await storage.get("a")).toEqual(value);
  });

  it("resolves undefined for a key that was never set", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    expect(await storage.get("missing")).toBeUndefined();
  });

  it("resolves undefined after deleting a key", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    await storage.set("a", bytesFromHex("01"));
    await storage.delete("a");
    expect(await storage.get("a")).toBeUndefined();
  });

  it("delete() on a key that was never set is a silent no-op, not an error", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    await expect(storage.delete("never-set")).resolves.toBeUndefined();
  });

  it("creates nested directories as needed for a key containing path separators", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    const value = bytesFromHex("0a0b0c");
    await storage.set("data/deadbeef/entry/1", value);
    expect(await storage.get("data/deadbeef/entry/1")).toEqual(value);
  });

  it("overwrites an existing value for the same key", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    await storage.set("a", bytesFromHex("01"));
    await storage.set("a", bytesFromHex("02"));
    expect(await storage.get("a")).toEqual(bytesFromHex("02"));
  });

  it("keys(prefix) returns exactly the matching keys among a mix of matching and non-matching ones", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    await storage.set("device/a", bytesFromHex("01"));
    await storage.set("device/b", bytesFromHex("02"));
    await storage.set("other/c", bytesFromHex("03"));

    const matched = await storage.keys("device/");
    expect(new Set(matched)).toEqual(new Set(["device/a", "device/b"]));
  });

  it("keys(prefix) finds entries several directory levels deep", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    await storage.set("data/deadbeef/entry/1", bytesFromHex("01"));
    await storage.set("data/deadbeef/entry/2", bytesFromHex("02"));
    await storage.set("data/cafebabe/entry/1", bytesFromHex("03"));

    const matched = await storage.keys("data/deadbeef/");
    expect(new Set(matched)).toEqual(
      new Set(["data/deadbeef/entry/1", "data/deadbeef/entry/2"]),
    );
  });

  it("keys(prefix) returns an empty array when nothing matches, including an empty store", async () => {
    const storage = createNodeFsStorage({ dir: await freshDir() });
    expect(await storage.keys("anything/")).toEqual([]);
    await storage.set("a", bytesFromHex("01"));
    expect(await storage.keys("nonexistent/")).toEqual([]);
  });

  it("persists across independent instances pointing at the same directory, proving it is genuinely filesystem-backed", async () => {
    const dir = await freshDir();
    const value = bytesFromHex("090807");

    const instanceA = createNodeFsStorage({ dir });
    await instanceA.set("shared", value);

    const instanceB = createNodeFsStorage({ dir });
    expect(await instanceB.get("shared")).toEqual(value);
  });

  const refusedKeys: readonly (readonly [string, KeyRefusal])[] = [
    ["", "empty"],
    ["a\0b", "nul"],
    ["a\\b", "backslash"],
    ["/a", "absolute"],
    ["a//b", "empty_segment"],
    ["a/", "empty_segment"],
    ["a/./b", "dot_segment"],
    ["./a", "dot_segment"],
    ["a/../b", "parent_segment"],
    ["../a", "parent_segment"],
  ];

  describe.each(refusedKeys)("the key %j", (key, refusal) => {
    it(`is refused as ${refusal} by get, set and delete, and nothing is written`, async () => {
      const dir = await freshDir();
      const parent = path.dirname(dir);
      const before = await fs.readdir(parent);
      const storage = createNodeFsStorage({ dir });
      const value = bytesFromHex("01");

      const refusals = await Promise.all(
        [
          async () => storage.get(key),
          async () => storage.set(key, value),
          async () => storage.delete(key),
        ].map(async (operation) =>
          operation().then(
            () => undefined,
            (error: unknown) => error,
          ),
        ),
      );
      for (const refused of refusals) {
        expect(refused).toBeInstanceOf(InvalidStorageKeyError);
        expect(refused).toMatchObject({ refusal });
      }

      expect(await storage.keys("")).toEqual([]);
      expect(await fs.readdir(parent)).toEqual(before);
    });
  });

  it("refuses a key that would leave the directory without touching the file it names", async () => {
    const dir = await freshDir();
    const sibling = `${dir}-outside`;
    await fs.writeFile(sibling, "kept");
    tmpDirs.push(sibling);
    const storage = createNodeFsStorage({ dir });

    await expect(
      storage.set(`../${path.basename(sibling)}`, bytesFromHex("ff")),
    ).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(
      storage.delete(`../${path.basename(sibling)}`),
    ).rejects.toBeInstanceOf(InvalidStorageKeyError);

    expect(await fs.readFile(sibling, "utf8")).toBe("kept");
  });

  it("accepts a key whose segments merely contain dots", async () => {
    const dir = await freshDir();
    const storage = createNodeFsStorage({ dir });
    const value = bytesFromHex("0a");

    await storage.set("a.b/..c/d..", value);

    expect(await storage.get("a.b/..c/d..")).toEqual(value);
    expect(await storage.keys("")).toEqual(["a.b/..c/d.."]);
  });

  it.skipIf(path.sep === "\\")(
    "keys() skips a file already on disk under a name the layout refuses, so every listed key can be read",
    async () => {
      const dir = await freshDir();
      const storage = createNodeFsStorage({ dir });
      await storage.set("kept/a", bytesFromHex("01"));
      await fs.writeFile(path.join(dir, "a\\b"), "older");

      const listed = await storage.keys("");

      expect(listed).toEqual(["kept/a"]);
      await expect(storage.get("a\\b")).rejects.toBeInstanceOf(
        InvalidStorageKeyError,
      );
      const read = await Promise.all(
        listed.map(async (key) => storage.get(key)),
      );
      expect(read).toEqual([bytesFromHex("01")]);
    },
  );

  it("reads data stored under a rewritten spelling by its plain key and refuses the old spelling", async () => {
    const dir = await freshDir();
    await fs.mkdir(path.join(dir, "a"));
    await fs.writeFile(path.join(dir, "a", "b"), "older");
    const storage = createNodeFsStorage({ dir });

    expect(await storage.get("a/b")).toEqual(
      new Uint8Array(Buffer.from("older")),
    );
    await expect(storage.get("a//b")).rejects.toBeInstanceOf(
      InvalidStorageKeyError,
    );
    expect(await storage.keys("")).toEqual(["a/b"]);
  });
});
