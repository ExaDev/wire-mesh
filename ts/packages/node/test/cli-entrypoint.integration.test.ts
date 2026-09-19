import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { helpText } from "../src/cli-options.js";

// The built entrypoint, not src/server.ts: this exercises the bin exactly as a package manager installs it, and only the build output is ever what a consumer runs.
const BUILT_ENTRYPOINT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "server.mjs",
);
const STARTUP_TIMEOUT_MS = 20_000;
const PACKAGE_MANIFEST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);
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

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawns `node <entrypoint> ...args` and resolves once it exits on its own, so a run that wrongly starts a server (which never exits) fails on the timeout rather than passing. */
async function runToExit(
  entrypoint: string,
  args: readonly string[],
): Promise<RunResult> {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  try {
    return await new Promise<RunResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `still running after ${String(STARTUP_TIMEOUT_MS)}ms; stdout: ${stdout || "(empty)"}`,
          ),
        );
      }, STARTUP_TIMEOUT_MS);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
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

async function packageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(
    await readFile(PACKAGE_MANIFEST, "utf-8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("package.json has no string version");
  }
  return manifest.version;
}

describe("the CLI entrypoint's informational flags", () => {
  it.each([["--help"], ["-h"]])(
    "prints usage and exits 0 without starting a server for %s",
    async (flag) => {
      const result = await runToExit(BUILT_ENTRYPOINT, [flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${helpText()}\n`);
      expect(result.stderr).toBe("");
    },
  );

  it.each([["--version"], ["-v"]])(
    "prints the package's own version and exits 0 for %s",
    async (flag) => {
      const result = await runToExit(BUILT_ENTRYPOINT, [flag]);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(`${await packageVersion()}\n`);
      expect(result.stderr).toBe("");
    },
  );

  it("prints the version when invoked through a symlink, as an installed bin is", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wire-mesh-bin-"));
    temporaryDirectories.push(directory);
    const binLink = join(directory, "wire-mesh");
    await symlink(BUILT_ENTRYPOINT, binLink);

    const result = await runToExit(binLink, ["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${await packageVersion()}\n`);
  });
});

describe("the CLI entrypoint's rejection of bad arguments", () => {
  it.each([
    ["an unknown flag", ["--bogus"], "--bogus"],
    ["a flag missing its value", ["--bind"], "--bind"],
    ["a malformed --bind value", ["--bind", "no-port"], "--bind"],
    [
      "--tls-cert without --tls-key",
      ["--tls-cert", "cert.pem"],
      "--tls-cert and --tls-key must be given together",
    ],
  ])(
    "exits non-zero naming the problem, and starts no server, for %s",
    async (_, args, expectedInStderr) => {
      const result = await runToExit(BUILT_ENTRYPOINT, args);
      expect(result.code).not.toBe(0);
      expect(result.code).not.toBeNull();
      expect(result.stderr).toContain(expectedInStderr);
      expect(result.stdout).toBe("");
    },
  );

  it("exits non-zero naming the file when a TLS file cannot be read", async () => {
    const result = await runToExit(BUILT_ENTRYPOINT, [
      "--bind",
      EPHEMERAL_BIND,
      "--tls-cert",
      "/nonexistent/cert.pem",
      "--tls-key",
      "/nonexistent/key.pem",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("/nonexistent/cert.pem");
  });
});
