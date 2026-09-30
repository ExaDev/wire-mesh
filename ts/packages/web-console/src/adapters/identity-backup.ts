// A deliberate, consented copy of this device's identity key material, and its restoration. The backup is a JSON file the person saves themselves: it holds the private key as a standard JWK, so anything that reads ES256 JWKs can use it, and it is never logged or shown on screen. Restoring replaces the stored identity, and takes effect the next time the console loads.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import { bytesToHex, deviceIdToHex } from "wire-mesh-core/domain/device-id";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";
import {
  IDENTITY_STORAGE_KEY,
  deriveDeviceId,
  isStoredIdentityEnvelope,
} from "./web-crypto-identity.js";

export const IDENTITY_BACKUP_FORMAT = "wire-mesh-console-identity";
export const IDENTITY_BACKUP_VERSION = 1;
const ES256_NAME = "ES256";

/** The contents of a backup file. */
export interface IdentityBackup {
  format: typeof IDENTITY_BACKUP_FORMAT;
  version: typeof IDENTITY_BACKUP_VERSION;
  alg: typeof ES256_NAME;
  /** Hex device-id this key derives, so a person can tell which identity a file holds without opening it. */
  deviceId: string;
  /** Hex of the raw (uncompressed point) P-256 public key. */
  publicKey: string;
  /** The private key. Whoever holds it can act as this device. */
  privateJwk: JsonWebKey;
}

export interface IdentityBackupService {
  /**
   * The backup of the stored identity.
   * @throws Error when no identity is stored, or the stored one is malformed.
   */
  export: () => Promise<IdentityBackup>;
  /** Replaces the stored identity with the backup's, which applies the next time the console loads. */
  restore: (backup: Readonly<IdentityBackup>) => Promise<void>;
}

const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
const UNCOMPRESSED_POINT_PREFIX = 4;

function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / HEX_DIGITS_PER_BYTE);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(
      hex.slice(index * HEX_DIGITS_PER_BYTE, (index + 1) * HEX_DIGITS_PER_BYTE),
      HEX_RADIX,
    );
  }
  return bytes;
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The raw uncompressed public point a P-256 private JWK carries in its x and y. */
function publicPointOf(jwk: Readonly<JsonWebKey>): Uint8Array<ArrayBuffer> {
  if (
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    jwk.x === undefined ||
    jwk.y === undefined ||
    jwk.d === undefined
  ) {
    throw new Error("the backup does not hold a P-256 private key");
  }
  return Uint8Array.from([
    UNCOMPRESSED_POINT_PREFIX,
    ...fromBase64Url(jwk.x),
    ...fromBase64Url(jwk.y),
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads and checks the text of a backup file, including that its private key really is the one its public key and device-id name.
 * @throws Error describing what is wrong with the file.
 */
export async function parseIdentityBackup(
  text: string,
): Promise<IdentityBackup> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the file is not JSON");
  }
  if (
    !isRecord(parsed) ||
    parsed.format !== IDENTITY_BACKUP_FORMAT ||
    parsed.version !== IDENTITY_BACKUP_VERSION ||
    parsed.alg !== ES256_NAME ||
    typeof parsed.deviceId !== "string" ||
    typeof parsed.publicKey !== "string" ||
    !isRecord(parsed.privateJwk)
  ) {
    throw new Error("the file is not a wire-mesh console identity backup");
  }
  const privateJwk: JsonWebKey = parsed.privateJwk;
  const point = publicPointOf(privateJwk);
  if (bytesToHex(point) !== parsed.publicKey) {
    throw new Error("the private key does not match the backup's public key");
  }
  if (deviceIdToHex(await deriveDeviceId(point)) !== parsed.deviceId) {
    throw new Error("the backup's device-id does not match its public key");
  }
  return {
    format: IDENTITY_BACKUP_FORMAT,
    version: IDENTITY_BACKUP_VERSION,
    alg: ES256_NAME,
    deviceId: parsed.deviceId,
    publicKey: parsed.publicKey,
    privateJwk,
  };
}

export function createIdentityBackupService(
  storage: Readonly<KeyValueStorage>,
): IdentityBackupService {
  return {
    async export() {
      const stored = await storage.get(IDENTITY_STORAGE_KEY);
      if (stored === undefined) {
        throw new Error("no identity is stored on this device");
      }
      const envelope: unknown = decode(stored, cdeDecodeOptions);
      if (!isStoredIdentityEnvelope(envelope)) {
        throw new Error("stored identity envelope is malformed");
      }
      return {
        format: IDENTITY_BACKUP_FORMAT,
        version: IDENTITY_BACKUP_VERSION,
        alg: ES256_NAME,
        deviceId: deviceIdToHex(await deriveDeviceId(envelope.publicKeyRaw)),
        publicKey: bytesToHex(envelope.publicKeyRaw),
        privateJwk: envelope.privateJwk,
      };
    },
    async restore(backup) {
      await storage.set(
        IDENTITY_STORAGE_KEY,
        new Uint8Array(
          encode(
            {
              privateJwk: backup.privateJwk,
              publicKeyRaw: bytesFromHex(backup.publicKey),
            },
            cdeEncodeOptions,
          ),
        ),
      );
    },
  };
}
