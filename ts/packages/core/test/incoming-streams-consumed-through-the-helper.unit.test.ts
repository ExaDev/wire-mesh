// Every consumer of a session's incoming streams goes through consume-incoming.ts, so the rule that one failed item never ends the loop, and that no rejection escapes to whoever started it, holds for a consumer written later too. Two source checks hold it: a `for await` is either in the list of readers of a connection or a transport below or fails here, whatever it is named or passed through, and an async function started with `void (async ...)()` ends in a rejection handler. A promise started with `void` in any other form is not covered by this file.

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

/** How much of a started function is quoted in a failure. */
const EXCERPT_LENGTH = 60;

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

/** The text of every `for await (... of <expression>)` header in `source`. */
function forAwaitSources(source: string): string[] {
  return [
    ...source.matchAll(/for await \(\s*(?:const|let)\s+\w+\s+of\s+([^)]+)\)/gu),
  ].map((match) => match[1] ?? "");
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

/** Whether what follows a started function handles its rejection: a `.catch(...)`, or a `.then(...)` that is given a rejection handler as its second argument. */
function handlesRejection(after: string): boolean {
  if (after.startsWith(".catch(")) return true;
  if (!after.startsWith(".then(")) return false;
  const open = ".then".length;
  const args = after.slice(open + 1, closingParenthesis(after, open));
  let depth = 0;
  let commas = 0;
  for (const char of args) {
    if ("([{".includes(char)) depth += 1;
    if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) commas += 1;
  }

  return (commas >= 1 && !args.trimEnd().endsWith(",")) || commas >= 2;
}

/** Every `void (async ...)()` in `source`: its text up to the end of its call, and what follows it. */
function voidStartedFunctions(
  source: string,
): { text: string; after: string }[] {
  return [...source.matchAll(/void \(async/gu)].map((match) => {
    const open = match.index + "void ".length;
    const close = closingParenthesis(source, open);
    const call = source.slice(close + 1).startsWith("()") ? 2 : 0;
    const end = close + 1 + call;

    return {
      text: source.slice(match.index, end),
      after: source.slice(end).trimStart(),
    };
  });
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

  it("are never left to a function started with void and no rejection handler", () => {
    const unhandled: string[] = [];
    for (const file of packageSources) {
      for (const { text, after } of voidStartedFunctions(
        readFileSync(file, "utf8"),
      )) {
        if (!handlesRejection(after)) {
          unhandled.push(`${file}: ${text.slice(0, EXCERPT_LENGTH)}`);
        }
      }
    }

    expect(unhandled).toEqual([]);
  });

  it("finds a void-started function with and without a handler", () => {
    const found = voidStartedFunctions(
      "void (async () => { await a(); })();\nvoid (async () => { await b(); })().catch(() => undefined);",
    );

    expect(found.map(({ after }) => handlesRejection(after))).toEqual([
      false,
      true,
    ]);
    expect(
      voidStartedFunctions("void (async () => {})().then(() => 1);").map(
        ({ after }) => handlesRejection(after),
      ),
    ).toEqual([false]);
    expect(
      voidStartedFunctions(
        "void (async () => {})().then(() => 1, (e: unknown) => report(e));",
      ).map(({ after }) => handlesRejection(after)),
    ).toEqual([true]);
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
  });
});
