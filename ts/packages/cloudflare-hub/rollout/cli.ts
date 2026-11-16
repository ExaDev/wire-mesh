/* Runs the staged rollout against Cloudflare: `node rollout/cli.ts --name <worker> --url <origin>` from this package's directory, with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment. The decisions live in rollout.ts; this file only maps its ports onto wrangler and fetch. Exits non-zero when the rollout failed, saying whether the previous version is serving again. */

import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  parseDeploymentStatus,
  parseUploadedVersion,
  readHealth,
  RollbackFailedError,
  runRollout,
  versionSpecs,
  type HealthReading,
  type RolloutPorts,
  type RolloutSettings,
} from "./rollout.ts";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    url: { type: "string" },
    message: { type: "string", default: "gradual rollout" },
    "canary-percentage": { type: "string", default: "10" },
  },
});
const { name, url } = values;
if (name === undefined || url === undefined) {
  throw new Error("--name and --url are required");
}

const MAX_CANARY_PERCENTAGE = 99;
// wrangler's output is read whole, and is small; a cap would only turn an unexpectedly long listing into a spurious failure.

const settings: RolloutSettings = {
  canaryPercentage: Number(values["canary-percentage"]),
  canarySamples: 20,
  settleSamples: 3,
  propagationAttempts: 36,
  propagationIntervalMs: 5000,
};
if (
  !Number.isInteger(settings.canaryPercentage) ||
  settings.canaryPercentage < 1 ||
  settings.canaryPercentage > MAX_CANARY_PERCENTAGE
) {
  throw new Error(
    `--canary-percentage must be an integer from 1 to ${String(MAX_CANARY_PERCENTAGE)}`,
  );
}

const PROBE_TIMEOUT_MS = 10_000;

async function wrangler(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "pnpm",
      ["exec", "wrangler", ...args],
      { env: { ...process.env, ...extraEnv }, maxBuffer: Infinity },
      (error, stdout, stderr) => {
        process.stderr.write(stderr);
        if (error === null) {
          resolve(stdout);
        } else {
          reject(
            new Error(`wrangler ${args.join(" ")} failed: ${error.message}`, {
              cause: error,
            }),
          );
        }
      },
    );
  });
}

const ports: RolloutPorts = {
  async uploadVersion() {
    const outputFile = join(
      await mkdtemp(join(tmpdir(), "hub-rollout-")),
      "wrangler-output.ndjson",
    );
    await wrangler(
      ["versions", "upload", "--name", name, "--message", values.message],
      { WRANGLER_OUTPUT_FILE_PATH: outputFile },
    );

    return parseUploadedVersion(await readFile(outputFile, "utf8"));
  },
  async currentDeployment() {
    return parseDeploymentStatus(
      await wrangler(["deployments", "status", "--name", name, "--json"]),
    );
  },
  async deploy(split, message) {
    await wrangler([
      "versions",
      "deploy",
      ...versionSpecs(split),
      "--name",
      name,
      "--message",
      message,
      "--yes",
    ]);
  },
  async probe(pinnedVersion): Promise<HealthReading> {
    try {
      const response = await fetch(new URL("/health", url), {
        headers:
          pinnedVersion === undefined
            ? {}
            : {
                "Cloudflare-Workers-Version-Overrides": `${name}="${pinnedVersion}"`,
              },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });

      return readHealth(response.status, await response.text());
    } catch (failure) {
      return {
        ok: false,
        version: undefined,
        detail: failure instanceof Error ? failure.message : String(failure),
      };
    }
  },
  sleep: async (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  log: (line) => {
    console.log(line);
  },
};

try {
  await runRollout(ports, settings, values.message);
  console.log("promoted: the new version serves 100% of traffic");
} catch (failure) {
  console.error(failure instanceof Error ? failure.message : String(failure));
  if (failure instanceof RollbackFailedError) {
    console.error(
      "::error::ROLLBACK FAILED, the hub may be serving a broken version",
    );
  }
  process.exitCode = 1;
}
