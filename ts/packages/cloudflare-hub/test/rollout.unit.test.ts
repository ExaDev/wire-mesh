import { describe, expect, it } from "vitest";
import {
  parseDeploymentStatus,
  parseUploadedVersion,
  readHealth,
  RollbackFailedError,
  RolloutFailedError,
  runRollout,
  versionSpecs,
  type DeploymentVersion,
  type HealthReading,
  type RolloutPorts,
  type RolloutSettings,
} from "../rollout/rollout.ts";

const FULL = 100;
const HTTP_OK = 200;
const HTTP_UNAVAILABLE = 503;
const ROUTING_STRIDE = 10;
const OLD = "old-version";
const NEW = "new-version";

const settings: RolloutSettings = {
  // Half the traffic, so any run of consecutive unpinned samples is certain to reach the new version in this deterministic router.
  canaryPercentage: 50,
  canarySamples: 20,
  settleSamples: 2,
  propagationAttempts: 4,
  propagationIntervalMs: 0,
};

/** A simulated Worker deployment. Cloudflare's behaviour is modelled as the docs state it: a version override reaches a version only while that version is in the deployment (even at 0%), and an unpinned request is routed by the percentages. `healthy` says which versions answer /health correctly; `propagationDelay` is how many probes still see the previous deployment after a change. */
class FakeCloudflare {
  deployment: DeploymentVersion[] = [{ versionId: OLD, percentage: FULL }];

  readonly deployCalls: DeploymentVersion[][] = [];

  healthy = new Map<string, boolean>([
    [OLD, true],
    [NEW, true],
  ]);

  failDeploy: ((split: readonly DeploymentVersion[]) => boolean) | undefined;

  ignoreOverrides = false;

  uploaded = 0;

  private routed = 0;

  readonly ports: RolloutPorts = {
    uploadVersion: async () => {
      this.uploaded += 1;

      return Promise.resolve(NEW);
    },
    currentDeployment: async () => Promise.resolve(this.deployment),
    deploy: async (split) => {
      this.deployCalls.push([...split]);
      if (this.failDeploy?.(split) === true) {
        return Promise.reject(new Error("wrangler versions deploy failed"));
      }
      this.deployment = [...split];

      return Promise.resolve();
    },
    probe: async (pinned) => Promise.resolve(this.answer(pinned)),
    sleep: async () => Promise.resolve(),
    log: () => undefined,
  };

  /** The version serving after the run: the one holding the whole deployment. */
  get serving(): string | undefined {
    const [only] = this.deployment.filter((entry) => entry.percentage > 0);

    return this.deployment.length >= 1 && only?.percentage === FULL
      ? only.versionId
      : undefined;
  }

  private answer(pinned: string | undefined): HealthReading {
    const inDeployment = (id: string): boolean =>
      this.deployment.some((entry) => entry.versionId === id);
    let version: string;
    if (pinned !== undefined && !this.ignoreOverrides && inDeployment(pinned)) {
      version = pinned;
    } else {
      version = this.route();
    }

    return this.healthy.get(version) === true
      ? { ok: true, version, detail: "healthy" }
      : { ok: false, version, detail: `${version} answered 500` };
  }

  /** Weighted by percentage, deterministically: the stride interleaves successive requests across the whole range, so a short run of them reaches every version holding a multiple of ten percent. */
  private route(): string {
    this.routed += 1;
    let slot = (this.routed * ROUTING_STRIDE) % FULL;
    for (const entry of this.deployment) {
      if (slot < entry.percentage) {
        return entry.versionId;
      }
      slot -= entry.percentage;
    }

    return this.deployment[0]?.versionId ?? "none";
  }
}

describe("runRollout", () => {
  it("stages the new version at 0%, then canaries, then promotes it", async () => {
    const cloud = new FakeCloudflare();

    await runRollout(cloud.ports, settings, "m");

    expect(cloud.deployCalls.map((split) => versionSpecs(split))).toEqual([
      [`${OLD}@100%`, `${NEW}@0%`],
      [`${OLD}@50%`, `${NEW}@50%`],
      [`${NEW}@100%`],
    ]);
    expect(cloud.serving).toBe(NEW);
  });

  it("keeps the old version serving when the new one fails its smoke test", async () => {
    const cloud = new FakeCloudflare();
    cloud.healthy.set(NEW, false);

    const failure = await runRollout(cloud.ports, settings, "m").catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(RolloutFailedError);
    expect((failure as RolloutFailedError).rolledBackTo).toBe(OLD);
    expect(cloud.serving).toBe(OLD);
    // The new version never held traffic: only the 0% stage and the restore were ever deployed.
    expect(
      cloud.deployCalls.some((split) =>
        split.some((entry) => entry.versionId === NEW && entry.percentage > 0),
      ),
    ).toBe(false);
  });

  it("rolls back when the canary turns unhealthy", async () => {
    const cloud = new FakeCloudflare();
    // Healthy under override at 0%, broken once real traffic reaches it.
    const probe = cloud.ports.probe.bind(cloud.ports);
    cloud.ports.probe = async (pinned) => {
      const split = cloud.deployment.find((entry) => entry.versionId === NEW);
      const reading = await probe(pinned);

      return reading.version === NEW &&
        pinned === undefined &&
        (split?.percentage ?? 0) > 0
        ? { ok: false, version: NEW, detail: "new version answered 500" }
        : reading;
    };

    await expect(runRollout(cloud.ports, settings, "m")).rejects.toBeInstanceOf(
      RolloutFailedError,
    );

    expect(cloud.serving).toBe(OLD);
    // The failure was caught at the canary: the new version was never given all the traffic.
    expect(
      cloud.deployCalls.some(
        (split) => split.length === 1 && split[0]?.versionId === NEW,
      ),
    ).toBe(false);
  });

  it("rolls back when the new version breaks only after promotion", async () => {
    const cloud = new FakeCloudflare();
    const probe = cloud.ports.probe.bind(cloud.ports);
    cloud.ports.probe = async (pinned) => {
      const reading = await probe(pinned);
      const promoted = cloud.deployment.every(
        (entry) => entry.versionId === NEW,
      );

      return promoted && reading.version === NEW
        ? { ok: false, version: NEW, detail: "new version answered 500" }
        : reading;
    };

    await expect(runRollout(cloud.ports, settings, "m")).rejects.toBeInstanceOf(
      RolloutFailedError,
    );

    expect(cloud.serving).toBe(OLD);
  });

  it("does not accept a healthy answer from the wrong version as the new version's", async () => {
    const cloud = new FakeCloudflare();
    cloud.ignoreOverrides = true;

    await expect(runRollout(cloud.ports, settings, "m")).rejects.toBeInstanceOf(
      RolloutFailedError,
    );

    expect(cloud.serving).toBe(OLD);
  });

  it("restores the previous version when a deploy command itself fails part way", async () => {
    const cloud = new FakeCloudflare();
    cloud.failDeploy = (split) =>
      split.length === 1 && split[0]?.versionId === NEW;

    await expect(runRollout(cloud.ports, settings, "m")).rejects.toBeInstanceOf(
      RolloutFailedError,
    );

    expect(cloud.serving).toBe(OLD);
  });

  it("changes nothing when the upload is what fails", async () => {
    const cloud = new FakeCloudflare();
    cloud.ports.uploadVersion = async () =>
      Promise.reject(new Error("upload failed"));

    await expect(runRollout(cloud.ports, settings, "m")).rejects.toThrow(
      "upload failed",
    );

    expect(cloud.deployCalls).toEqual([]);
  });

  it("reports a rollback that cannot be completed as its own error", async () => {
    const cloud = new FakeCloudflare();
    cloud.healthy.set(NEW, false);
    cloud.failDeploy = (split) =>
      split.length === 1 && split[0]?.versionId === OLD;

    await expect(runRollout(cloud.ports, settings, "m")).rejects.toBeInstanceOf(
      RollbackFailedError,
    );
  });

  it("refuses to start over a split deployment", async () => {
    const cloud = new FakeCloudflare();
    cloud.deployment = [
      { versionId: OLD, percentage: 50 },
      { versionId: "other", percentage: 50 },
    ];

    await expect(runRollout(cloud.ports, settings, "m")).rejects.toThrow(
      "not a single version",
    );

    expect(cloud.uploaded).toBe(0);
  });
});

describe("parsers", () => {
  it("reads a healthy answer only with ok:true and a version", () => {
    expect(readHealth(HTTP_OK, '{"ok":true,"version":"v1"}')).toMatchObject({
      ok: true,
      version: "v1",
    });
    expect(readHealth(HTTP_OK, '{"ok":true}').ok).toBe(false);
    expect(readHealth(HTTP_OK, '{"ok":false,"version":"v1"}').ok).toBe(false);
    expect(readHealth(HTTP_UNAVAILABLE, '{"ok":true,"version":"v1"}').ok).toBe(
      false,
    );
    expect(readHealth(HTTP_OK, "<html>").ok).toBe(false);
  });

  it("reads the deployment and the uploaded version from wrangler's output", () => {
    expect(
      parseDeploymentStatus(
        '{"id":"d","versions":[{"version_id":"a","percentage":100}]}',
      ),
    ).toEqual([{ versionId: "a", percentage: 100 }]);
    expect(
      parseUploadedVersion(
        '{"type":"wrangler-session","version":1}\n{"type":"version-upload","version_id":"v9"}\n',
      ),
    ).toBe("v9");
    expect(() => parseUploadedVersion("")).toThrow("no version-upload");
  });
});
