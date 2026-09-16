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
 * Imports a peer's ES256 identity-key for ECDH deriveBits usage. Only ever called with an already-published public key (this node's own peers' identity-keys), never private material, so there is no custody concern here the way there is for the local node's own private key.
 */
async function importEs256PublicKeyForEcdh(
  key: IdentityKey,
): Promise<webcrypto.CryptoKey> {
  return webcrypto.subtle.importKey(
    "raw",
    toBufferSource(key["public-key"]),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

/**
 * Builds an IdentityPort from a Web Crypto private key already generated for this node -- ECDSA P-256 (alg -7) or Ed25519 (alg -8), the two algorithms identity-key.alg actually carries in the spec's own conformance vectors. Device-id derivation and signature verification are pure functions of the given key bytes (exported separately above), so they work for an arbitrary issuer-key too, not just this node's own.
 *
 * `ecdhPrivateKey`, when given, must be a `{name: "ECDH", namedCurve: "P-256"}`-usage `deriveBits`-capable CryptoKey imported from the SAME underlying scalar as `privateKey` -- Web Crypto permanently binds a CryptoKey to the one algorithm it was imported for, so an ECDSA-usage key can never itself be used for `deriveBits`, even though ECDH and ECDSA share the identical P-256 curve and scalar. Room rekey's own ECIES construction reuses each member's existing identity-key rather than minting a separate encryption key (wire-mesh#141), so a caller wanting `deriveSharedSecret` imports the same scalar a second time under `{name: "ECDH"}` and passes both keys here -- deliberately the CALLER's own choice, not done automatically inside this function, so a caller that generated `privateKey` as `extractable: false` for signing-only isn't forced to also make it extractable (the only way to obtain a second, differently-algorithmed CryptoKey from the same scalar) just to satisfy a capability it never asked for.
 */
export async function createNodeIdentity(
  privateKey: webcrypto.CryptoKey,
  publicKeyBytes: Uint8Array,
  alg: number,
  ecdhPrivateKey?: webcrypto.CryptoKey,
): Promise<IdentityPort> {
  const identityKey: IdentityKey = {
    alg,
    "public-key": toBufferSource(publicKeyBytes),
  };
  const deviceId = await deriveDeviceId(publicKeyBytes);

  const base = {
    deviceId,
    identityKey,
    async sign(message: Uint8Array) {
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

  if (alg !== ES256 || ecdhPrivateKey === undefined) {
    return base;
  }

  return {
    ...base,
    async deriveSharedSecret(peerKey: IdentityKey) {
      if (peerKey.alg !== ES256) {
        throw new Error(
          `ECDH is only defined for an ES256 peer identity-key, got alg ${String(peerKey.alg)}`,
        );
      }
      const peerPublicKey = await importEs256PublicKeyForEcdh(peerKey);
      const SHARED_SECRET_BIT_LENGTH = 256; // P-256's own field size
      const bits = await webcrypto.subtle.deriveBits(
        { name: "ECDH", public: peerPublicKey },
        ecdhPrivateKey,
        SHARED_SECRET_BIT_LENGTH,
      );
      return new Uint8Array(bits);
    },
  };
}
