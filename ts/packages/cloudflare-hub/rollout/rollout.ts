/* The staged rollout of a hub Worker version: upload it beside the serving one, prove it healthy before it takes traffic, shift traffic to it in steps, and put the previous version back at 100% if any check fails. Cloudflare keeps the previous version in the deployment throughout, so at no point is the hub served by nothing.

   Everything that touches the outside world (wrangler, the network, the clock) comes in through RolloutPorts, so the decision logic here runs unchanged under test and under the CLI in cli.ts. This file imports nothing from Node for the same reason. */

import { z } from "zod";

export interface DeploymentVersion {
  readonly versionId: string;
  readonly percentage: number;
}

/** What one probe of the hub's /health learned. `version` is the Worker version that answered, absent when no answer was read. */
export interface HealthReading {
  readonly ok: boolean;
  readonly version: string | undefined;
  readonly detail: string;
}

export interface RolloutPorts {
  /** Uploads the built Worker as a new version that serves no traffic, and returns its version id. */
  uploadVersion: () => Promise<string>;
  /** The versions the live deployment routes to, with their traffic shares. */
  currentDeployment: () => Promise<readonly DeploymentVersion[]>;
  /** Makes `split` the live deployment. A version at 0% is addressable by override only. */
  deploy: (
    split: readonly DeploymentVersion[],
    message: string,
  ) => Promise<void>;
  /** One request to /health. With `pinnedVersion` the request carries the version override for that version; without it the request is routed by the deployment's percentages. A failed request is a reading with ok false, never a throw. */
  probe: (pinnedVersion: string | undefined) => Promise<HealthReading>;
  sleep: (milliseconds: number) => Promise<void>;
  log: (line: string) => void;
}

export interface RolloutSettings {
  /** The traffic share the new version takes first, 1 to 99. */
  readonly canaryPercentage: number;
  /** Unpinned requests that must all be healthy at the canary step. */
  readonly canarySamples: number;
  /** Consecutive healthy requests that must all report the expected version before a step counts as live. */
  readonly settleSamples: number;
  /** Polls allowed for a deployment change to reach the network, and the pause between them. */
  readonly propagationAttempts: number;
  readonly propagationIntervalMs: number;
}

export type RolloutOutcome = "promoted";

export class RolloutFailedError extends Error {
  readonly rolledBackTo: string | undefined;

  constructor(
    message: string,
    rolledBackTo: string | undefined,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "RolloutFailedError";
    this.rolledBackTo = rolledBackTo;
  }
}

export class RollbackFailedError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "RollbackFailedError";
  }
}

const FULL_TRAFFIC = 100;
const HTTP_OK = 200;

/** The one version serving all traffic. Anything else (a split left by another run, no deployment) is refused: rolling back to "the previous version" is only defined when exactly one is serving. */
export function soleServingVersion(
  deployment: readonly DeploymentVersion[],
): string {
  const serving = deployment.filter((entry) => entry.percentage > 0);
  const [only] = serving;
  if (
    only === undefined ||
    serving.length !== 1 ||
    only.percentage !== FULL_TRAFFIC
  ) {
    throw new Error(
      `Refusing to roll out over a deployment that is not a single version at ${String(FULL_TRAFFIC)}%: ${describeSplit(deployment)}`,
    );
  }

  return only.versionId;
}

export function describeSplit(split: readonly DeploymentVersion[]): string {
  return split
    .map((entry) => `${entry.versionId}@${String(entry.percentage)}%`)
    .join(" ");
}

export async function runRollout(
  ports: Readonly<RolloutPorts>,
  settings: RolloutSettings,
  message: string,
): Promise<RolloutOutcome> {
  const previous = soleServingVersion(await ports.currentDeployment());
  const next = await ports.uploadVersion();
  if (next === previous) {
    throw new Error(
      `The uploaded version ${next} is already the serving version; nothing to roll out`,
    );
  }
  ports.log(`previous ${previous}, new ${next}`);

  const { canaryPercentage } = settings;
  const stages = {
    // Both versions in the deployment, the new one at 0%: it can be addressed by override and takes no traffic, so the previous version keeps serving while it is proven.
    stage: [
      { versionId: previous, percentage: FULL_TRAFFIC },
      { versionId: next, percentage: 0 },
    ],
    canary: [
      { versionId: previous, percentage: FULL_TRAFFIC - canaryPercentage },
      { versionId: next, percentage: canaryPercentage },
    ],
    promote: [{ versionId: next, percentage: FULL_TRAFFIC }],
    restore: [{ versionId: previous, percentage: FULL_TRAFFIC }],
  } as const;

  // Set before the first deploy call, not after it: a deploy that errors may still have changed the deployment, and putting the previous version back is harmless when it did not.
  const deployed: string[] = [];
  const apply = async (
    name: "stage" | "canary" | "promote" | "restore",
  ): Promise<void> => {
    deployed.push(name);
    ports.log(`deploy ${name}: ${describeSplit(stages[name])}`);
    await ports.deploy(stages[name], `${message} (${name})`);
  };

  try {
    await apply("stage");
    await expectVersion(ports, settings, previous, undefined);
    await expectVersion(ports, settings, next, next);

    await apply("canary");
    await expectVersion(ports, settings, next, next);
    await sampleSplit(ports, settings, new Set([previous, next]));

    await apply("promote");
    await expectVersion(ports, settings, next, undefined);
  } catch (failure) {
    ports.log(`rollout failed: ${errorText(failure)}`);
    if (deployed.length === 0) {
      throw new RolloutFailedError(errorText(failure), undefined, failure);
    }
    try {
      await apply("restore");
      await expectVersion(ports, settings, previous, undefined);
    } catch (restoreFailure) {
      throw new RollbackFailedError(
        `Restoring ${previous} failed after the rollout failed (${errorText(failure)}): ${errorText(restoreFailure)}`,
        restoreFailure,
      );
    }
    throw new RolloutFailedError(
      `${errorText(failure)}; ${previous} is serving again`,
      previous,
      failure,
    );
  }

  return "promoted";
}

/** Waits for `settleSamples` consecutive healthy readings that all name `expected`, polling while the deployment change propagates. A reading from a different version is not a failure until the attempts run out, since a location may still be on the old deployment. A healthy-looking answer from the wrong version never passes: an override that was ignored still returns 200. */
async function expectVersion(
  ports: Readonly<RolloutPorts>,
  settings: RolloutSettings,
  expected: string,
  pinnedVersion: string | undefined,
): Promise<void> {
  // Polling is sequential by nature: each reading decides whether another is needed, so it recurses rather than looping over awaits.
  const poll = async (
    attemptsLeft: number,
    consecutive: number,
    last: string,
  ): Promise<void> => {
    if (attemptsLeft === 0) {
      throw new Error(
        `Health did not report ${expected}${pinnedVersion === undefined ? "" : " by override"} within ${String(settings.propagationAttempts)} attempts: ${last}`,
      );
    }
    const reading = await ports.probe(pinnedVersion);
    const matched = reading.ok && reading.version === expected;
    if (matched && consecutive + 1 >= settings.settleSamples) {
      return;
    }
    await ports.sleep(settings.propagationIntervalMs);
    await poll(
      attemptsLeft - 1,
      matched ? consecutive + 1 : 0,
      matched ? last : reading.detail,
    );
  };
  await poll(settings.propagationAttempts, 0, "no reading taken");
}

/** At the canary step requests land on either version: every one must be healthy and name a version of the deployment. */
async function sampleSplit(
  ports: Readonly<RolloutPorts>,
  settings: RolloutSettings,
  allowed: ReadonlySet<string>,
): Promise<void> {
  const sample = async (samplesLeft: number): Promise<void> => {
    if (samplesLeft === 0) {
      return;
    }
    const reading = await ports.probe(undefined);
    if (!reading.ok) {
      throw new Error(`Unhealthy during the canary: ${reading.detail}`);
    }
    if (reading.version === undefined || !allowed.has(reading.version)) {
      throw new Error(
        `A canary request was answered by a version outside the deployment: ${reading.detail}`,
      );
    }
    await ports.sleep(settings.propagationIntervalMs);
    await sample(samplesLeft - 1);
  };
  await sample(settings.canarySamples);
}

function errorText(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

const healthBody = z.object({
  ok: z.literal(true),
  version: z.string().min(1),
});

/** Reads a /health response. Healthy means a 200 whose body carries `ok: true` and the answering Worker's version id. */
export function readHealth(status: number, body: string): HealthReading {
  if (status !== HTTP_OK) {
    return { ok: false, version: undefined, detail: `HTTP ${String(status)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, version: undefined, detail: "body is not JSON" };
  }
  const parsed = healthBody.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      version: undefined,
      detail: "body lacks ok:true and a version",
    };
  }

  return { ok: true, version: parsed.data.version, detail: "healthy" };
}

const deploymentStatus = z.object({
  versions: z.array(
    z.object({ version_id: z.string().min(1), percentage: z.number() }),
  ),
});

/** The `wrangler deployments status --json` output: the live deployment, each version with its traffic share. */
export function parseDeploymentStatus(json: string): DeploymentVersion[] {
  return deploymentStatus.parse(JSON.parse(json)).versions.map((entry) => ({
    versionId: entry.version_id,
    percentage: entry.percentage,
  }));
}

const uploadEntry = z.object({
  type: z.literal("version-upload"),
  version_id: z.string().min(1),
});

/** The version id from wrangler's WRANGLER_OUTPUT_FILE_PATH file, one JSON entry per line. */
export function parseUploadedVersion(outputFile: string): string {
  for (const line of outputFile.split("\n")) {
    if (line.trim() === "") {
      continue;
    }
    const entry = uploadEntry.safeParse(JSON.parse(line));
    if (entry.success) {
      return entry.data.version_id;
    }
  }
  throw new Error("wrangler's output holds no version-upload entry");
}

/** Wrangler's version-spec arguments for `versions deploy`: `<id>@<percentage>%` each. */
export function versionSpecs(split: readonly DeploymentVersion[]): string[] {
  return split.map(
    (entry) => `${entry.versionId}@${String(entry.percentage)}%`,
  );
}
