import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "wire-mesh-core/adapters/memory-storage";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import {
  IDENTITY_BACKUP_FORMAT,
  createIdentityBackupService,
  parseIdentityBackup,
} from "../src/adapters/identity-backup.js";
import { createPersistedWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";

const JSON_INDENT = 2;

async function storedIdentity(): Promise<{
  storage: ReturnType<typeof createMemoryStorage>;
  deviceHex: string;
}> {
  const storage = createMemoryStorage();
  const identity = await createPersistedWebCryptoIdentity(storage);
  return { storage, deviceHex: deviceIdToHex(identity.deviceId) };
}

describe("identity backup", () => {
  it("exports the stored identity with the device-id it derives", async () => {
    const { storage, deviceHex } = await storedIdentity();

    const backup = await createIdentityBackupService(storage).export();

    expect(backup.format).toBe(IDENTITY_BACKUP_FORMAT);
    expect(backup.deviceId).toBe(deviceHex);
    expect(backup.privateJwk.kty).toBe("EC");
    expect(backup.privateJwk.d).toBeDefined();
  });

  it("restores into empty storage so the same identity loads from it", async () => {
    const { storage, deviceHex } = await storedIdentity();
    const text = JSON.stringify(
      await createIdentityBackupService(storage).export(),
      undefined,
      JSON_INDENT,
    );
    const fresh = createMemoryStorage();

    await createIdentityBackupService(fresh).restore(
      await parseIdentityBackup(text),
    );

    const restored = await createPersistedWebCryptoIdentity(fresh);
    expect(deviceIdToHex(restored.deviceId)).toBe(deviceHex);
  });

  it("replaces an identity already stored, which is the one loaded next", async () => {
    const original = await storedIdentity();
    const replacement = await storedIdentity();
    const backup = await createIdentityBackupService(
      replacement.storage,
    ).export();

    await createIdentityBackupService(original.storage).restore(backup);

    expect(
      deviceIdToHex(
        (await createPersistedWebCryptoIdentity(original.storage)).deviceId,
      ),
    ).toBe(replacement.deviceHex);
  });

  it("has nothing to export when no identity is stored", async () => {
    await expect(
      createIdentityBackupService(createMemoryStorage()).export(),
    ).rejects.toThrow("no identity is stored");
  });
});

describe("parseIdentityBackup", () => {
  async function exported(): Promise<Record<string, unknown>> {
    const { storage } = await storedIdentity();
    const backup = await createIdentityBackupService(storage).export();
    return { ...backup };
  }

  it("refuses text that is not JSON, and JSON that is not a backup", async () => {
    await expect(parseIdentityBackup("not json")).rejects.toThrow("not JSON");
    await expect(parseIdentityBackup("{}")).rejects.toThrow(
      "not a wire-mesh console identity backup",
    );
  });

  it("refuses a backup whose public key is not the private key's", async () => {
    const backup = await exported();
    const other = await exported();

    await expect(
      parseIdentityBackup(
        JSON.stringify({ ...backup, publicKey: other.publicKey }),
      ),
    ).rejects.toThrow("does not match the backup's public key");
  });

  it("refuses a backup whose device-id is not the public key's", async () => {
    const backup = await exported();
    const other = await exported();

    await expect(
      parseIdentityBackup(
        JSON.stringify({ ...backup, deviceId: other.deviceId }),
      ),
    ).rejects.toThrow("device-id does not match");
  });

  it("refuses a backup holding no private key", async () => {
    const backup = await exported();
    const jwk: Record<string, unknown> = { ...(backup.privateJwk as object) };
    delete jwk.d;

    await expect(
      parseIdentityBackup(JSON.stringify({ ...backup, privateJwk: jwk })),
    ).rejects.toThrow("does not hold a P-256 private key");
  });

  it("refuses a backup whose private scalar belongs to another key, which would stop the console starting after a restore", async () => {
    const backup = await exported();
    const other = await exported();
    const swapped = {
      ...(backup.privateJwk as object),
      d: (other.privateJwk as { d: string }).d,
    };

    await expect(
      parseIdentityBackup(JSON.stringify({ ...backup, privateJwk: swapped })),
    ).rejects.toThrow("private key cannot be loaded");
  });

  it("refuses a backup whose key is limited to operations the console needs to sign with", async () => {
    const backup = await exported();
    const verifyOnly = {
      ...(backup.privateJwk as object),
      key_ops: ["verify"],
    };

    await expect(
      parseIdentityBackup(
        JSON.stringify({ ...backup, privateJwk: verifyOnly }),
      ),
    ).rejects.toThrow("private key cannot be loaded");
  });

  it("names malformed key encoding rather than surfacing a raw platform error", async () => {
    const backup = await exported();
    const garbled = { ...(backup.privateJwk as object), x: "***" };

    await expect(
      parseIdentityBackup(JSON.stringify({ ...backup, privateJwk: garbled })),
    ).rejects.toThrow("not valid base64url");
  });

  it("accepts a backup whose key pair is sound", async () => {
    const backup = await exported();

    await expect(
      parseIdentityBackup(JSON.stringify(backup)),
    ).resolves.toMatchObject({ deviceId: backup.deviceId });
  });
});
