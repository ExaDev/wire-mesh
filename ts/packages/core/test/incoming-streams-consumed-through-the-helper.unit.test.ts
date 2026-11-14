// Every consumer of a session's incoming streams goes through consume-incoming.ts, so the rule that one failed item never ends the loop, and that no rejection escapes to whoever started it, holds for a consumer written later too. This file is a tripwire for the accident of a new bare `for await` over one of those streams, in any package's `src`: a `for await` is either a listed reader of a connection or a transport, or it fails here, whatever shape its loop variable has (a name, a destructuring pattern, a pre-declared variable) and whatever the stream is called or passed through. It does not see a manual `next()` loop, a `ReadableStream` reader or a stream consumed outside `packages/*/src`. The other half of the rule, that no loop is started without a rejection handler, is the repository's lint: `@typescript-eslint/no-floating-promises` with `ignoreVoid: false` in every package.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The streams of a MeshSession that carry what a peer sent. */
const INCOMING_STREAMS = [
  "incomingManageRequests",
  "incomingDataFrames",
  "revocationAnnouncements",
  "coordinatorFrames",
  "events",
];

const packagesRoot = fileURLToPath(new URL("../../", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (name === "node_modules" || name === "dist") return [];
    const path = `${directory}/${name}`;
    if (statSync(path).isDirectory()) return sourceFiles(path);

    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

const packageSources = readdirSync(packagesRoot).flatMap((name) => {
  const src = `${packagesRoot}${name}/src`;
  try {
    return sourceFiles(src);
  } catch {
    return [];
  }
});

/** The expression every `for await (... of <expression>)` in `source` reads, whatever shape the loop variable has. */
function forAwaitSources(source: string): string[] {
  return [...source.matchAll(/for await \(/gu)].map((match) => {
    const open = match.index + "for await ".length;
    const header = source.slice(open + 1, closingParenthesis(source, open));
    const separator = /\sof\s/u.exec(header);

    return separator === null
      ? header
      : header.slice(separator.index + separator[0].length);
  });
}

/** The `for await` loops that read a connection, a transport or a byte source, not a session's incoming streams: the file each is in and the start of what it reads. A loop not listed fails the check below, so one that reads a stream through an alias or a parameter is caught too. */
const CONNECTION_READERS: readonly (readonly [string, string])[] = [
  ["/core/src/adapters/byte-stream-connection.ts", "chunksOf(reader"],
  ["/core/src/domain/relay-hub.ts", "connection.receive("],
  ["/core/src/domain/mesh-session.ts", "link.receive("],
  ["/core/src/domain/sharded-delivery.ts", "source(0"],
  ["/core/src/domain/sharded-delivery.ts", "connection.receive("],
  ["/core/src/domain/bulk.ts", "options.source(fromSeq"],
  ["/core/src/domain/bulk.ts", "options.source(0"],
  ["/core/src/domain/direct-manage-request.ts", "link.receive("],
  ["/node/src/adapters/webtransport-transport.ts", "started.sessionStream("],
];

/** The index of the parenthesis closing the one at `open`. */
function closingParenthesis(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return source.length;
}

describe("the session's incoming streams", () => {
  it("are found in the packages' sources", () => {
    expect(packageSources.length).toBeGreaterThan(0);
  });

  it("are never read by a bare for-await loop outside consume-incoming.ts", () => {
    const bare: string[] = [];
    for (const file of packageSources) {
      if (file.endsWith("/domain/consume-incoming.ts")) continue;
      for (const header of forAwaitSources(readFileSync(file, "utf8"))) {
        if (INCOMING_STREAMS.some((stream) => header.includes(stream))) {
          bare.push(`${file}: for await over ${header}`);
        }
      }
    }

    expect(bare).toEqual([]);
  });

  it("are read only by the listed readers of a connection or a transport, in every package", () => {
    const unlisted: string[] = [];
    for (const file of packageSources) {
      if (file.endsWith("/domain/consume-incoming.ts")) continue;
      for (const header of forAwaitSources(readFileSync(file, "utf8"))) {
        const listed = CONNECTION_READERS.some(
          ([suffix, reads]) =>
            file.endsWith(suffix) && header.startsWith(reads),
        );
        if (!listed) unlisted.push(`${file}: for await over ${header}`);
      }
    }

    expect(unlisted).toEqual([]);
  });

  it("are detected by the pattern the check above relies on", () => {
    expect(
      forAwaitSources(
        "for await (const incoming of session.incomingManageRequests) {}",
      ),
    ).toEqual(["session.incomingManageRequests"]);
    expect(
      forAwaitSources("for await (const e of options.session.events) {}"),
    ).toEqual(["options.session.events"]);
    expect(
      forAwaitSources(
        "for await (const { command, respond } of session.incomingManageRequests) {}",
      ),
    ).toEqual(["session.incomingManageRequests"]);
    expect(
      forAwaitSources("for await (const [first] of session.events) {}"),
    ).toEqual(["session.events"]);
    expect(forAwaitSources("for await (item of stream) {}")).toEqual([
      "stream",
    ]);
  });
});
