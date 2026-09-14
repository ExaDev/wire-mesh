/** A Node filesystem-backed KeyValueStorage -- the durable Node-side counterpart to indexeddb-storage.ts's browser one, and memory-storage.ts's in-process one, satisfying the identical contract. Every key is treated directly as a relative path under the given directory (creating nested directories as needed), which every key this codebase constructs is already suited to: internally generated, ASCII, path-shaped by design (e.g. "data/<peer-hex>/entry/<seq>") rather than arbitrary untrusted input, matching the same assumption indexeddb-storage.ts's own comment already states for its key range bounds. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { KeyValueStorage } from "../ports/storage.js";

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
  return path.join(baseDir, key);
}

/** Every regular file under baseDir, as a relative path using "/" separators regardless of the host OS -- so a caller's own "/"-joined key strings compare correctly against what this returns, the same key shape set()/get() already use. */
async function listAllRelativePaths(baseDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(baseDir, { recursive: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const stat = await fs.stat(path.join(baseDir, entry)).catch(() => null);
    if (stat?.isFile() === true) {
      files.push(entry.split(path.sep).join("/"));
    }
  }
  return files;
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
