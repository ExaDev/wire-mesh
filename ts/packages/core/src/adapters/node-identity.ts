import { webcrypto } from "node:crypto";
import type { DeviceId, IdentityKey } from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";

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

async function importPublicKey(key: IdentityKey): Promise<webcrypto.CryptoKey> {
  if (key.alg === ES256) {
    return webcrypto.subtle.importKey(
      "raw",
      toBufferSource(key["public-key"]),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  }
  if (key.alg === EDDSA) {
    return webcrypto.subtle.importKey(
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
    await webcrypto.subtle.digest("SHA-256", toBufferSource(publicKey)),
  );
}

export async function verifyWithPublicKey(
  key: IdentityKey,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const cryptoKey = await importPublicKey(key);
  return webcrypto.subtle.verify(
    algParams(key.alg),
    cryptoKey,
    toBufferSource(signature),
    toBufferSource(message),
  );
}

/**
 * Builds an IdentityPort from a Web Crypto private key already generated for this node -- ECDSA P-256 (alg -7) or Ed25519 (alg -8), the two algorithms identity-key.alg actually carries in the spec's own conformance vectors. Device-id derivation and signature verification are pure functions of the given key bytes (exported separately above), so they work for an arbitrary issuer-key too, not just this node's own.
 */
export async function createNodeIdentity(
  privateKey: webcrypto.CryptoKey,
  publicKeyBytes: Uint8Array,
  alg: number,
): Promise<IdentityPort> {
  const identityKey: IdentityKey = {
    alg,
    "public-key": toBufferSource(publicKeyBytes),
  };
  const deviceId = await deriveDeviceId(publicKeyBytes);

  return {
    deviceId,
    identityKey,
    async sign(message) {
      const signature = await webcrypto.subtle.sign(
        algParams(alg),
        privateKey,
        toBufferSource(message),
      );
      return new Uint8Array(signature);
    },
    verify: verifyWithPublicKey,
    deriveDeviceId,
  };
}
