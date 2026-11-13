import "fake-indexeddb/auto";
import { createHash, webcrypto } from "node:crypto";
import { encode, cdeEncodeOptions } from "cbor2";
import { describe, expect, it } from "vitest";
import {
  createPersistedWebCryptoIdentity,
  createWebCryptoIdentity,
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/web-crypto-identity.js";
import { createIndexedDbStorage } from "../src/adapters/indexeddb-storage.js";
import {
  createNodeIdentity,
  verifyWithPublicKey as verifyWithNodeIdentity,
} from "wire-mesh-core/adapters/node-identity";
import { bytesFromHex } from "./hex.js";
import { IdentityKeyError } from "wire-mesh-core/ports/identity";

const ES256 = -7;
// a real COSE algorithm this adapter deliberately does not implement
const ES512 = -36;
const SHA256_BYTE_LENGTH = 32;
// 0x04 || X || Y
const UNCOMPRESSED_P256_POINT_BYTE_LENGTH = 65;

function someMessage(): Uint8Array {
  return bytesFromHex("0102030405");
}

/** Byte-for-byte equality without Buffer -- the two type packages loaded for this mixed Node/Workers environment make Buffer's own overloads resolve as any under eslint's type info, and a plain comparison needs none of it. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

describe("createWebCryptoIdentity", () => {
  it("derives device-id as sha256 of the raw public-key bytes, not any container encoding", async () => {
    const identity = await createWebCryptoIdentity();
    const rawKeyBytes = identity.identityKey["public-key"];

    expect(rawKeyBytes.byteLength).toBe(UNCOMPRESSED_P256_POINT_BYTE_LENGTH);
    const expected = createHash("sha256").update(rawKeyBytes).digest();
    expect(bytesEqual(identity.deviceId, expected)).toBe(true);
    expect(identity.deviceId.byteLength).toBe(SHA256_BYTE_LENGTH);
  });

  it("signs with the private key and verifies its own signature through the port", async () => {
    const identity = await createWebCryptoIdentity();
    const message = someMessage();
    const signature = await identity.sign(message);

    expect(
      await identity.verify(identity.identityKey, message, signature),
    ).toBe(true);
    // A genuinely different message (same bytes in a fresh buffer would still legitimately verify -- the signature covers content, not identity).
    const tampered = bytesFromHex("0102030406");
    expect(
      await identity.verify(identity.identityKey, tampered, signature),
    ).toBe(false);
  });

  it("round-trips independently with core's node-identity adapter -- a signature made by one adapter verifies under the other", async () => {
    // The console's Web Crypto adapter signs; core's Node adapter verifies.
    const consoleIdentity = await createWebCryptoIdentity();
    const message = someMessage();
    const signature = await consoleIdentity.sign(message);
    expect(
      await verifyWithNodeIdentity(
        consoleIdentity.identityKey,
        message,
        signature,
      ),
    ).toBe(true);

    // And the mirror direction: a Node-side keypair signs, the Web Crypto adapter verifies.
    const keyPair = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const publicKeyBytes = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
    );
    const nodeIdentity = await createNodeIdentity(
      keyPair.privateKey,
      publicKeyBytes,
      ES256,
    );
    const nodeSignature = await nodeIdentity.sign(message);
    expect(
      await consoleIdentity.verify(
        nodeIdentity.identityKey,
        message,
        nodeSignature,
      ),
    ).toBe(true);
  });

  it("deriveDeviceId is a pure function of the key bytes, matching an independent sha256 computation", async () => {
    const { publicKey } = await webcrypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    );
    const raw = new Uint8Array(
      await webcrypto.subtle.exportKey("raw", publicKey),
    );
    const derived = await deriveDeviceId(raw);
    const expected = createHash("sha256").update(raw).digest();
    expect(bytesEqual(derived, expected)).toBe(true);
  });

  it("throws loudly on an identity-key algorithm it does not implement, rather than mis-verifying", async () => {
    const identity = await createWebCryptoIdentity();
    const message = someMessage();
    const signature = await identity.sign(message);
    const es512Key = {
      ...identity.identityKey,
      alg: ES512,
    };
    await expect(
      verifyWithPublicKey(es512Key, message, signature),
    ).rejects.toThrow("unsupported identity-key alg -36");
  });
});

describe("createPersistedWebCryptoIdentity", () => {
  it("generates and persists a fresh identity on first use, and it signs/verifies correctly", async () => {
    const storage = await createIndexedDbStorage({
      dbName: crypto.randomUUID(),
    });
    const identity = await createPersistedWebCryptoIdentity(storage);
    const message = someMessage();
    const signature = await identity.sign(message);

    expect(
      await identity.verify(identity.identityKey, message, signature),
    ).toBe(true);
    const expectedDeviceId = await deriveDeviceId(
      identity.identityKey["public-key"],
    );
    expect(bytesEqual(identity.deviceId, expectedDeviceId)).toBe(true);
  });

  it("derives a symmetric ECDH shared secret a persisted peer identity can match", async () => {
    const storageA = await createIndexedDbStorage({
      dbName: crypto.randomUUID(),
    });
    const storageB = await createIndexedDbStorage({
      dbName: crypto.randomUUID(),
    });
    const a = await createPersistedWebCryptoIdentity(storageA);
    const b = await createPersistedWebCryptoIdentity(storageB);
    if (
      a.deriveSharedSecret === undefined ||
      b.deriveSharedSecret === undefined
    ) {
      throw new Error("a persisted identity must expose deriveSharedSecret");
    }

    const fromA = await a.deriveSharedSecret(b.identityKey);
    const fromB = await b.deriveSharedSecret(a.identityKey);

    expect(bytesEqual(fromA, fromB)).toBe(true);
  });

  it("returns the same device-id on a second call against the same storage, simulating a reload", async () => {
    const storage = await createIndexedDbStorage({
      dbName: crypto.randomUUID(),
    });
    const first = await createPersistedWebCryptoIdentity(storage);
    const second = await createPersistedWebCryptoIdentity(storage);

    expect(bytesEqual(first.deviceId, second.deviceId)).toBe(true);
    expect(
      bytesEqual(
        first.identityKey["public-key"],
        second.identityKey["public-key"],
      ),
    ).toBe(true);

    // And the reloaded identity's private key genuinely still signs for the same public key.
    const message = someMessage();
    const signature = await second.sign(message);
    expect(await first.verify(second.identityKey, message, signature)).toBe(
      true,
    );
  });

  it("rejects rather than silently regenerating when the stored envelope is corrupted", async () => {
    const storage = await createIndexedDbStorage({
      dbName: crypto.randomUUID(),
    });
    await storage.set(
      "web-console/identity/es256",
      new Uint8Array(encode({ garbage: true }, cdeEncodeOptions)),
    );

    await expect(createPersistedWebCryptoIdentity(storage)).rejects.toThrow(
      "stored identity envelope is malformed",
    );
  });
});

describe("verifyWithPublicKey reports a key it cannot use as an IdentityKeyError", () => {
  const EDDSA = -8;
  const P256_POINT_BYTES = 65;
  const SIGNATURE_BYTES = 64;
  const KEY_BYTES = 32;
  const SHORT_KEY_BYTES = 3;
  const SEC1_UNCOMPRESSED = 4;
  const message = new Uint8Array([1]);
  const signature = new Uint8Array(SIGNATURE_BYTES);

  it("names an unsupported algorithm", async () => {
    await expect(
      verifyWithPublicKey(
        { alg: ES512, "public-key": new Uint8Array(KEY_BYTES) },
        message,
        signature,
      ),
    ).rejects.toMatchObject({ name: "IdentityKeyError", fault: "unsupported_alg" });
  });

  it("names a key of the wrong size, for each algorithm", async () => {
    await Promise.all(
      [ES256, EDDSA].map(async (alg) =>
        expect(
          verifyWithPublicKey(
            { alg, "public-key": new Uint8Array(SHORT_KEY_BYTES) },
            message,
            signature,
          ),
          String(alg),
        ).rejects.toMatchObject({ fault: "invalid_key" }),
      ),
    );
  });

  it("names an ES256 key that is not a point on the curve, with the Web Crypto error as its cause", async () => {
    const offCurve = new Uint8Array(P256_POINT_BYTES).fill(1);
    offCurve[0] = SEC1_UNCOMPRESSED;

    const failure: unknown = await verifyWithPublicKey(
      { alg: ES256, "public-key": offCurve },
      message,
      signature,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(IdentityKeyError);
    expect(failure).toMatchObject({ fault: "invalid_key" });
    expect(failure instanceof Error ? failure.cause : undefined).toBeDefined();
  });
});
