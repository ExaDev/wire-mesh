// A Worker-runtime IdentityPort implementation using the standard Web Crypto API (globalThis.crypto.subtle), which exists identically in Cloudflare Workers and in Node >= 19 -- mirroring core's node-identity adapter's algorithm coverage (ES256 P-256 and Ed25519, the two algorithms identity-key.alg carries in the spec's own conformance vectors) so the two adapters are drop-in substitutes for each other behind the same port.

import {
  ed25519KeyFault,
  ed25519SignatureIsStrict,
} from "wire-mesh-core/domain/ed25519-identity-key";
import type { DeviceId, IdentityKey } from "wire-mesh-core/generated/protocol";
import {
  IdentityKeyError,
  type IdentityPort,
} from "wire-mesh-core/ports/identity";

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

/** Imports the raw public key, reporting an algorithm this adapter does not implement, and a key Web Crypto cannot import (the wrong size, or not a point on the curve), as an IdentityKeyError, so a caller can tell a key it cannot use from a failure of this adapter. An Ed25519 key is checked before the import by `ed25519KeyFault`, since the import itself accepts keys that are not points. */
async function importPublicKey(key: IdentityKey): Promise<CryptoKey> {
  const algorithm =
    key.alg === ES256
      ? { name: "ECDSA", namedCurve: "P-256" }
      : key.alg === EDDSA
        ? { name: "Ed25519" }
        : undefined;
  if (algorithm === undefined) {
    throw new IdentityKeyError(
      "unsupported_alg",
      `unsupported identity-key alg ${String(key.alg)}`,
    );
  }
  if (key.alg === EDDSA) {
    // Decided here, never by the platform's Ed25519 import, which differs between crypto libraries on a small-order or non-canonical key.
    const fault = ed25519KeyFault(key["public-key"]);
    if (fault !== undefined) {
      throw new IdentityKeyError(
        "invalid_key",
        `identity-key public-key is not a usable Ed25519 key (${fault})`,
      );
    }
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      toBufferSource(key["public-key"]),
      algorithm,
      false,
      ["verify"],
    );
  } catch (cause) {
    throw new IdentityKeyError(
      "invalid_key",
      `identity-key public-key does not import as an alg ${String(key.alg)} key`,
      { cause },
    );
  }
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
  if (key.alg === EDDSA && !ed25519SignatureIsStrict(signature)) {
    return false;
  }

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
