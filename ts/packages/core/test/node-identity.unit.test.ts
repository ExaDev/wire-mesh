import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createNodeIdentity,
  deriveDeviceId,
} from "../src/adapters/node-identity.js";
import type { IdentityPort } from "../src/ports/identity.js";

const ES256 = -7;
const EDDSA = -8;

/**
 * Generates an ES256 identity, optionally also wired for `deriveSharedSecret`: a caller wanting ECDH capability imports the same underlying scalar a second time under `{name: "ECDH"}`, mirroring the exact technique `createNodeIdentity`'s own doc comment describes as the caller's responsibility, not something the function does automatically.
 */
async function generateEs256Identity(withEcdh: boolean): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  if (!withEcdh) {
    return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
  }
  const privateJwk = await webcrypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey,
  );
  // The source JWK's own `alg`/`key_ops` fields describe its ECDSA usage, not this ECDH import -- importKey validates the requested usage against a JWK's own declared key_ops when present, so reusing the JWK object as-is throws a usage-mismatch error even though the underlying scalar and curve are identical. Strip both; the curve point (crv/x/y/d) is all ECDH actually needs.
  const ecdhJwk: JsonWebKey = { ...privateJwk, key_ops: ["deriveBits"] };
  delete ecdhJwk.alg;
  const ecdhPrivateKey = await webcrypto.subtle.importKey(
    "jwk",
    ecdhJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  return createNodeIdentity(
    keyPair.privateKey,
    publicKeyBytes,
    ES256,
    ecdhPrivateKey,
  );
}

describe("createNodeIdentity", () => {
  it("signs and verifies for an ES256 identity with no ecdhPrivateKey given", async () => {
    const identity = await generateEs256Identity(false);
    const message = new TextEncoder().encode("a Sig_structure's own bytes");

    const signature = await identity.sign(message);

    expect(
      await identity.verify(identity.identityKey, message, signature),
    ).toBe(true);
    expect(identity.deriveSharedSecret).toBeUndefined();
  });

  it("derives the identical ECDH shared secret both directions between two ES256 identities", async () => {
    const identityA = await generateEs256Identity(true);
    const identityB = await generateEs256Identity(true);
    if (
      identityA.deriveSharedSecret === undefined ||
      identityB.deriveSharedSecret === undefined
    ) {
      throw new Error(
        "an ecdhPrivateKey-wired identity must expose deriveSharedSecret",
      );
    }

    const fromA = await identityA.deriveSharedSecret(identityB.identityKey);
    const fromB = await identityB.deriveSharedSecret(identityA.identityKey);

    expect(fromA).toEqual(fromB);
  });

  it("derives a different shared secret against a different peer", async () => {
    const identityA = await generateEs256Identity(true);
    const identityB = await generateEs256Identity(true);
    const identityC = await generateEs256Identity(true);
    if (identityA.deriveSharedSecret === undefined) {
      throw new Error(
        "an ecdhPrivateKey-wired identity must expose deriveSharedSecret",
      );
    }

    const withB = await identityA.deriveSharedSecret(identityB.identityKey);
    const withC = await identityA.deriveSharedSecret(identityC.identityKey);

    expect(withB).not.toEqual(withC);
  });

  it("throws rather than silently mis-deriving when asked to derive against a non-ES256 peer", async () => {
    const identityA = await generateEs256Identity(true);
    if (identityA.deriveSharedSecret === undefined) {
      throw new Error(
        "an ecdhPrivateKey-wired identity must expose deriveSharedSecret",
      );
    }
    const ed25519PublicKeyBytes = Uint8Array.from({ length: 32 }, () => 0);

    await expect(
      identityA.deriveSharedSecret({
        alg: EDDSA,
        "public-key": ed25519PublicKeyBytes,
      }),
    ).rejects.toThrow(/ES256/);
  });

  it("has no deriveSharedSecret for an Ed25519 identity -- ECDH is not defined on that curve family here", async () => {
    // lib.dom's own generateKey overload table has no entry disambiguating a bare `{name: "Ed25519"}` as key-PAIR-generating (unlike e.g. ECDSA's namedCurve-carrying shape), so it resolves to the single-CryptoKey overload -- the runtime behaviour is correct per the Web Crypto spec (Ed25519 always generates a pair), only the type is wrong. `CryptoKey` and `CryptoKeyPair` share no properties at all, so even a type-guard predicate can't narrow one into the other (TS2677); the double cast is the only way past a genuine upstream lib.dom typing gap, not a shortcut around a real mismatch.
    const keyPair = (await webcrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as unknown as webcrypto.CryptoKeyPair;
    const publicKeyBytes = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
    );

    const identity = await createNodeIdentity(
      keyPair.privateKey,
      publicKeyBytes,
      EDDSA,
    );

    expect(identity.deriveSharedSecret).toBeUndefined();
  });
});

describe("deriveDeviceId", () => {
  it("is exactly sha256 of the raw public-key bytes, not of any certificate or DER wrapping", async () => {
    // Pins the derivation identity.cddl exists to guarantee: device-id = sha256(identity-key.public-key). Both Cascade and agent-comms previously shipped the whole-cert-DER fingerprint bug this rule exists to prevent -- a test that recomputes sha256 over the same raw bytes catches any drift back toward hashing anything else.
    const keyPair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const publicKeyBytes = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    const expected = Uint8Array.from(
      createHash("sha256").update(publicKeyBytes).digest(),
    );

    const deviceId = await deriveDeviceId(publicKeyBytes);

    expect(deviceId).toEqual(expected);
  });
});
