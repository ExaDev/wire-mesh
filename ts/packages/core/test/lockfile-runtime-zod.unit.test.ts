// The generated schemas, the runtime helpers re-exported from cddl.js and every consumer's own parsing build and call one another's zod schemas, so the lockfile must hold exactly one zod version reachable from this package's runtime dependencies. The lockfile is read as pnpm writes it (lockfileVersion 9): an `importers` entry per workspace package and a `snapshots` entry per installed package, each with its own dependency blocks.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const INDENT_IMPORTER_KEY = 2;
const INDENT_BLOCK_KEY = 4;
const INDENT_ENTRY = 6;

interface Lock {
  /** The `name@version` snapshot keys each importer's runtime dependency resolves to, by importer path. */
  importers: Map<string, string[]>;
  /** The `name@version` snapshot keys each snapshot's dependencies and optional dependencies resolve to, by snapshot key. */
  snapshots: Map<string, string[]>;
}

function unquote(text: string): string {
  return text.replace(/^'(.*)'$/u, "$1");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Strips the peer-dependency suffix pnpm appends to a version, `1.2.3(peer@4)`, leaving the version. */
function bareVersion(version: string): string {
  const open = version.indexOf("(");

  return open === -1 ? version : version.slice(0, open);
}

function parseLock(text: string): Lock {
  const importers = new Map<string, string[]>();
  const snapshots = new Map<string, string[]>();
  let section = "";
  let owner = "";
  let block = "";
  let pendingName = "";

  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const indent = indentOf(line);
    const content = line.trim();
    if (indent === 0) {
      section = content.replace(/:.*$/u, "");
      owner = "";
      block = "";
      continue;
    }
    if (section !== "importers" && section !== "snapshots") continue;
    const target = section === "importers" ? importers : snapshots;
    if (indent === INDENT_IMPORTER_KEY) {
      // A snapshot installed with different peer dependencies has one key per variant: they are one package here, so their dependencies are merged.
      owner = bareVersion(unquote(content.replace(/:( \{\})?$/u, "")));
      block = "";
      if (!target.has(owner)) target.set(owner, []);
      continue;
    }
    if (indent === INDENT_BLOCK_KEY) {
      block = content.replace(/:.*$/u, "");
      continue;
    }
    const runtime =
      block === "dependencies" || block === "optionalDependencies";
    if (!runtime || owner === "") continue;
    const entries = target.get(owner);
    if (entries === undefined) continue;
    if (section === "snapshots" && indent === INDENT_ENTRY) {
      const separator = content.lastIndexOf(": ");
      const name = unquote(content.slice(0, separator));
      entries.push(`${name}@${bareVersion(content.slice(separator + 2))}`);
    } else if (section === "importers" && indent === INDENT_ENTRY) {
      pendingName = unquote(content.replace(/:$/u, ""));
    } else if (section === "importers" && content.startsWith("version: ")) {
      entries.push(
        `${pendingName}@${bareVersion(content.slice("version: ".length))}`,
      );
    }
  }

  return { importers, snapshots };
}

/** The snapshot keys reachable from `start` through runtime dependencies, `start` included. */
function reachable(lock: Lock, start: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const pending = [...start];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of lock.snapshots.get(key) ?? []) {
      pending.push(next);
    }
  }

  return seen;
}

function zodVersions(keys: ReadonlySet<string>): string[] {
  return [...keys]
    .filter((key) => key.startsWith("zod@"))
    .map((key) => key.slice("zod@".length))
    .sort();
}

const lockText = readFileSync(
  fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url)),
  "utf8",
);

describe("the lockfile's zod copies reachable from wire-mesh-core's runtime dependencies", () => {
  it("is exactly one version", () => {
    const lock = parseLock(lockText);
    const start = lock.importers.get("packages/core");
    expect(start, "the packages/core importer").toBeDefined();

    expect(zodVersions(reachable(lock, start ?? []))).toHaveLength(1);
  });

  it("is found by the parser when a second version is reachable", () => {
    const lock = parseLock(
      [
        "importers:",
        "  packages/core:",
        "    dependencies:",
        "      a:",
        "        specifier: 1.0.0",
        "        version: 1.0.0",
        "      zod:",
        "        specifier: 4.5.4",
        "        version: 4.5.4",
        "snapshots:",
        "  a@1.0.0:",
        "    dependencies:",
        "      zod: 4.6.6",
        "  zod@4.5.4: {}",
        "  zod@4.6.6: {}",
      ].join("\n"),
    );

    expect(
      zodVersions(reachable(lock, lock.importers.get("packages/core") ?? [])),
    ).toEqual(["4.5.4", "4.6.6"]);
  });

  it("follows a version carrying a peer suffix and a quoted scoped name", () => {
    const lock = parseLock(
      [
        "importers:",
        "  packages/core:",
        "    dependencies:",
        "      '@s/a':",
        "        specifier: 1.0.0",
        "        version: 1.0.0(zod@4.6.6)",
        "snapshots:",
        "  '@s/a@1.0.0(zod@4.6.6)':",
        "    dependencies:",
        "      zod: 4.6.6",
        "  zod@4.6.6: {}",
      ].join("\n"),
    );

    expect(
      zodVersions(reachable(lock, lock.importers.get("packages/core") ?? [])),
    ).toEqual(["4.6.6"]);
  });
});
