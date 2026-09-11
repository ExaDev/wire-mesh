// A Worker-runtime IdentityPort implementation using the standard Web Crypto API (globalThis.crypto.subtle), which exists identically in Cloudflare Workers and in Node >= 19 -- mirroring core's node-identity adapter's algorithm coverage (ES256 P-256 and Ed25519, the two algorithms identity-key.alg carries in the spec's own conformance vectors) so the two adapters are drop-in substitutes for each other behind the same port.

import { cdeDecodeOptions, cdeEncodeOptions, decode, encode } from "cbor2";
import type { DeviceId, IdentityKey } from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { KeyValueStorage } from "wire-mesh-core/ports/storage";

const ES256 = -7;
const EDDSA = -8;
const IDENTITY_STORAGE_KEY = "web-console/identity/es256";

function algParams(alg: number): EcdsaParams | { name: "Ed25519" } {
  if (alg === ES256) {
    return { name: "ECDSA", hash: "SHA-256" };
  }
  if (alg === EDDSA) {
    return { name: "Ed25519" };
  }
  throw new Error(`unsupported identity-key alg ${String(alg)}`);
}

/** Copies into a fresh, non-shared, whole-buffer Uint8Array -- Web Crypto's BufferSource parameters reject a view over a SharedArrayBuffer or a sub-range view, neither of which a caller-supplied Uint8Array is guaranteed not to be. */
function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function importPublicKey(key: IdentityKey): Promise<CryptoKey> {
  if (key.alg === ES256) {
    return crypto.subtle.importKey(
      "raw",
      toBufferSource(key["public-key"]),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  }
  if (key.alg === EDDSA) {
    return crypto.subtle.importKey(
      "raw",
      toBufferSource(key["public-key"]),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
  }
  throw new Error(`unsupported identity-key alg ${String(key.alg)}`);
}

export async function deriveDeviceId(publicKey: Uint8Array): Promise<DeviceId> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", toBufferSource(publicKey)),
  );
}

export async function verifyWithPublicKey(
  key: IdentityKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const cryptoKey = await importPublicKey(key);
  return crypto.subtle.verify(
    algParams(key.alg),
    cryptoKey,
    toBufferSource(signature),
    toBufferSource(message),
  );
}

/** Generates a fresh ES256 (ECDSA P-256) identity for this node and builds an IdentityPort from it -- P-256 because it is the one curve Web Crypto's non-extractable key generation supports uniformly across the Worker runtime and Node, and ES256 is the algorithm the spec's own conformance vectors use for every token issuer. */
export async function createWebCryptoIdentity(): Promise<IdentityPort> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const identityKey: IdentityKey = {
    alg: ES256,
    "public-key": publicKeyBytes,
  };
  const deviceId = await deriveDeviceId(publicKeyBytes);

  return {
    deviceId,
    identityKey,
    async sign(message) {
      const signature = await crypto.subtle.sign(
        algParams(ES256),
        keyPair.privateKey,
        toBufferSource(message),
      );
      return new Uint8Array(signature);
    },
    verify: verifyWithPublicKey,
    deriveDeviceId,
  };
}

interface StoredIdentityEnvelope {
  privateJwk: JsonWebKey;
  publicKeyRaw: Uint8Array<ArrayBuffer>;
}

function isStoredIdentityEnvelope(
  value: unknown,
): value is StoredIdentityEnvelope {
  if (typeof value !== "object" || value === null) return false;
  if (!("privateJwk" in value) || !("publicKeyRaw" in value)) return false;
  return (
    typeof value.privateJwk === "object" &&
    value.privateJwk !== null &&
    value.publicKeyRaw instanceof Uint8Array
  );
}

async function generateStoredIdentityEnvelope(): Promise<StoredIdentityEnvelope> {
  // extractable: true -- deliberately, and only here (createWebCryptoIdentity's ephemeral variant above uses extractable: false): a persisted identity's whole purpose is a stable device-id across reloads, which requires the private key to leave the CryptoKey object exactly once, to be written to storage. Per the Web Crypto spec, a key pair's PUBLIC key is always extractable regardless of this flag -- only the PRIVATE key's extractability is gated by it, so this unlocks exactly the one export that needs unlocking.
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return { privateJwk, publicKeyRaw };
}

async function identityFromStoredEnvelope(
  envelope: StoredIdentityEnvelope,
): Promise<IdentityPort> {
  // Re-imported non-extractable: the one-time export in generateStoredIdentityEnvelope is the only point this key's raw material is ever needed outside the CryptoKey -- least privilege for the rest of its in-memory lifetime.
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    envelope.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const identityKey: IdentityKey = {
    alg: ES256,
    "public-key": envelope.publicKeyRaw,
  };
  const deviceId = await deriveDeviceId(envelope.publicKeyRaw);

  return {
    deviceId,
    identityKey,
    async sign(message) {
      const signature = await crypto.subtle.sign(
        algParams(ES256),
        privateKey,
        toBufferSource(message),
      );
      return new Uint8Array(signature);
    },
    verify: verifyWithPublicKey,
    deriveDeviceId,
  };
}

/** An IdentityPort that survives a reload: the first call generates and persists a fresh ES256 identity, every subsequent call against the same storage re-derives the same IdentityPort from what's already there. A malformed stored envelope rejects loudly rather than silently regenerating -- silently minting a new identity on a corrupt read would change this device's identity without anyone deciding that. */
export async function createPersistedWebCryptoIdentity(
  storage: Readonly<KeyValueStorage>,
): Promise<IdentityPort> {
  const stored = await storage.get(IDENTITY_STORAGE_KEY);
  if (stored !== undefined) {
    const decoded: unknown = decode(stored, cdeDecodeOptions);
    if (!isStoredIdentityEnvelope(decoded)) {
      throw new Error("stored identity envelope is malformed");
    }
    return identityFromStoredEnvelope(decoded);
  }
  const envelope = await generateStoredIdentityEnvelope();
  await storage.set(
    IDENTITY_STORAGE_KEY,
    new Uint8Array(encode(envelope, cdeEncodeOptions)),
  );
  return identityFromStoredEnvelope(envelope);
}
