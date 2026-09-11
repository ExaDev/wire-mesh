// A Worker-runtime IdentityPort implementation using the standard Web Crypto API (globalThis.crypto.subtle), which exists identically in Cloudflare Workers and in Node >= 19 -- mirroring core's node-identity adapter's algorithm coverage (ES256 P-256 and Ed25519, the two algorithms identity-key.alg carries in the spec's own conformance vectors) so the two adapters are drop-in substitutes for each other behind the same port.

import type { DeviceId, IdentityKey } from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";

const ES256 = -7;
const EDDSA = -8;

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
