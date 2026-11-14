// Every consumer of a session's incoming streams goes through consume-incoming.ts, so the rule that one failed item never ends the loop, and that no rejection escapes to whoever started it, holds for a consumer written later too. A bare `for await` over one of those streams fails here.

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

/** The text of every `for await (... of <expression>)` header in `source`. */
function forAwaitSources(source: string): string[] {
  return [
    ...source.matchAll(/for await \(\s*(?:const|let)\s+\w+\s+of\s+([^)]+)\)/gu),
  ].map((match) => match[1] ?? "");
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
