import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// The built entrypoint, not src/server.ts: this exercises the bin exactly as a package manager installs it, and only the build output is ever what a consumer runs.
const BUILT_ENTRYPOINT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "server.mjs",
);
const STARTUP_TIMEOUT_MS = 20_000;
// Port 0 asks the OS for any free port, so concurrent runs of this suite never contend for one.
const EPHEMERAL_BIND = "127.0.0.1:0";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map(async (directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

/** Spawns `node <entrypoint> --bind 127.0.0.1:0` and resolves with the first stdout line, or rejects if the process exits before printing one. */
async function startupLineOf(entrypoint: string): Promise<string> {
  const child = spawn(
    process.execPath,
    [entrypoint, "--bind", EPHEMERAL_BIND],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`no startup line within ${String(STARTUP_TIMEOUT_MS)}ms`),
        );
      }, STARTUP_TIMEOUT_MS);
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stdout.once("data", (chunk: string) => {
        clearTimeout(timer);
        resolve(chunk.trim());
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          new Error(
            `exited with code ${String(code)} without starting a server; stderr: ${stderr || "(empty)"}`,
          ),
        );
      });
      child.once("error", (cause: Error) => {
        clearTimeout(timer);
        reject(cause);
      });
    });
  } finally {
    child.kill("SIGKILL");
  }
}

describe("the CLI entrypoint's run-when-invoked-directly guard", () => {
  it("starts the server when the built entrypoint is run by its own path", async () => {
    await expect(startupLineOf(BUILT_ENTRYPOINT)).resolves.toContain(
      "wire-mesh listening on ws://127.0.0.1:",
    );
  });

  // The regression this file exists for. `npm install` puts the bin in node_modules/.bin as a symlink at dist/server.mjs and runs it by that path, so argv[1] names the symlink while Node resolves it away before recording import.meta.url. Comparing the two unresolved made the guard permanently false through a real install: `npx wire-mesh` exited 0 having started nothing at all.
  it("starts the server when invoked through a symlink, as an installed bin is", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wire-mesh-bin-"));
    temporaryDirectories.push(directory);
    const binLink = join(directory, "wire-mesh");
    await symlink(BUILT_ENTRYPOINT, binLink);

    await expect(startupLineOf(binLink)).resolves.toContain(
      "wire-mesh listening on ws://127.0.0.1:",
    );
  });
});
