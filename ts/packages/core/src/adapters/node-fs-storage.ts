/** A Node filesystem-backed KeyValueStorage, the durable Node-side counterpart to indexeddb-storage.ts's browser one, and memory-storage.ts's in-process one, satisfying the identical contract. Every key is a relative path under the given directory (creating nested directories as needed), in the layout node-fs-layout.ts defines, so a directory written by one implementation is read by another. A key the layout refuses (empty, `.` and `..` segments, a leading, doubled or trailing separator, a backslash, a NUL) throws InvalidStorageKeyError, since a key that left the directory or that `path.join` rewrites would be stored under a name other than its own. keys() lists only names the layout accepts: a file already in the directory under a refused name (one containing a backslash, or written outside the layout by other means) is skipped, so every listed key can be passed to get, set and delete. A store written before the layout was enforced keeps its files: a key `path.join` rewrote is read under its normalised spelling, and the old spelling now throws. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KeyValueStorage } from "../ports/storage.js";
import { refusalOfKey, segmentsOfKey } from "./node-fs-layout.js";

export interface NodeFsStorageOptions {
  /** Directory to store entries under. Created on first write if it doesn't already exist. */
  dir: string;
}

function isEnoent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!("code" in error)) return false;

  return error.code === "ENOENT";
}

function keyToFilePath(baseDir: string, key: string): string {
  return path.join(baseDir, ...segmentsOfKey(key));
}

/** Every regular file under baseDir, as a relative path using "/" separators regardless of the host OS, so a caller's own "/"-joined key strings compare correctly against what this returns, the same key shape set()/get() already use. */
async function listAllRelativePaths(baseDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir, { recursive: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const stats = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      stat: await fs.stat(path.join(baseDir, entry)).catch(() => null),
    })),
  );

  return stats
    .filter(({ stat }) => stat?.isFile() === true)
    .map(({ entry }) => entry.split(path.sep).join("/"))
    .filter((key) => refusalOfKey(key) === undefined);
}

export function createNodeFsStorage(
  options: Readonly<NodeFsStorageOptions>,
): KeyValueStorage {
  const baseDir = options.dir;

  return {
    async get(key) {
      try {
        const contents = await fs.readFile(keyToFilePath(baseDir, key));

        return new Uint8Array(contents);
      } catch (error) {
        if (isEnoent(error)) return undefined;
        throw error;
      }
    },
    async set(key, value) {
      const filePath = keyToFilePath(baseDir, key);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, value);
    },
    async delete(key) {
      try {
        await fs.unlink(keyToFilePath(baseDir, key));
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    },
    async keys(prefix) {
      const all = await listAllRelativePaths(baseDir);

      return all.filter((key) => key.startsWith(prefix));
    },
  };
}
