import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import {
  ADVERTISED_CERTIFICATES,
  advanceCertificateSchedule,
} from "../src/adapters/certificate-schedule.js";

const MS_PER_DAY = 86_400_000;
const LIFETIME_DAYS = 10;
const LIFETIME_MS = LIFETIME_DAYS * MS_PER_DAY;
const SERVING_MS = LIFETIME_MS / 2;
const START = new Date("2030-01-01T00:00:00Z");
const SHA256_HEX_LENGTH = 64;

function later(ms: number): Date {
  return new Date(START.getTime() + ms);
}

function hashesOf(schedule: {
  advertised: readonly { sha256Hex: string }[];
}): string[] {
  return schedule.advertised.map((certificate) => certificate.sha256Hex);
}

describe("advanceCertificateSchedule", () => {
  it("starts a schedule with the serving certificate and the successors an address lists", async () => {
    const schedule = await advanceCertificateSchedule(
      createMemoryStorage(),
      START,
      { lifetimeMs: LIFETIME_MS },
    );
    expect(schedule.advertised).toHaveLength(ADVERTISED_CERTIFICATES);
    expect(new Set(hashesOf(schedule)).size).toBe(ADVERTISED_CERTIFICATES);
    expect(schedule.serving.sha256Hex).toHaveLength(SHA256_HEX_LENGTH);
    expect(schedule.serving.notBefore).toEqual(START);
    expect(schedule.rotatesAt.getTime() - START.getTime()).toBe(SERVING_MS);
  });

  it("resumes the stored certificates on a restart within the serving period", async () => {
    const storage = createMemoryStorage();
    const first = await advanceCertificateSchedule(storage, START, {
      lifetimeMs: LIFETIME_MS,
    });
    const resumed = await advanceCertificateSchedule(
      storage,
      later(SERVING_MS / 2),
      { lifetimeMs: LIFETIME_MS },
    );
    expect(hashesOf(resumed)).toEqual(hashesOf(first));
  });

  it("rotates to the next certificate and lists a new successor, keeping the overlap an old address relies on", async () => {
    const storage = createMemoryStorage();
    const first = await advanceCertificateSchedule(storage, START, {
      lifetimeMs: LIFETIME_MS,
    });
    const rotated = await advanceCertificateSchedule(
      storage,
      later(SERVING_MS),
      { lifetimeMs: LIFETIME_MS },
    );
    const before = hashesOf(first);
    const after = hashesOf(rotated);
    expect(rotated.serving.sha256Hex).toBe(before[1]);
    expect(after.slice(0, ADVERTISED_CERTIFICATES - 1)).toEqual(
      before.slice(1),
    );
    expect(after[ADVERTISED_CERTIFICATES - 1]).not.toBe(
      before[ADVERTISED_CERTIFICATES - 1],
    );
    // An address copied before the rotation lists the certificate now served.
    expect(before).toContain(rotated.serving.sha256Hex);
  });

  it("keeps every advertised certificate valid at the time it starts serving", async () => {
    const schedule = await advanceCertificateSchedule(
      createMemoryStorage(),
      START,
      { lifetimeMs: LIFETIME_MS },
    );
    schedule.advertised.forEach((certificate, index) => {
      const startsServing = START.getTime() + index * SERVING_MS;
      expect(certificate.notBefore.getTime()).toBeLessThanOrEqual(
        startsServing,
      );
      expect(certificate.notAfter.getTime()).toBeGreaterThan(
        startsServing + SERVING_MS,
      );
    });
  });

  it("starts a new schedule when every stored certificate has expired", async () => {
    const storage = createMemoryStorage();
    const first = await advanceCertificateSchedule(storage, START, {
      lifetimeMs: LIFETIME_MS,
    });
    const afterDowntime = await advanceCertificateSchedule(
      storage,
      later(LIFETIME_MS * ADVERTISED_CERTIFICATES * 2),
      { lifetimeMs: LIFETIME_MS },
    );
    const overlap = hashesOf(afterDowntime).filter((hash) =>
      hashesOf(first).includes(hash),
    );
    expect(overlap).toEqual([]);
  });
});
