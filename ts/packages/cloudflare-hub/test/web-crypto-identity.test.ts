import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createWebCryptoIdentity,
  deriveDeviceId,
} from "../src/adapters/web-crypto-identity.js";
import {
  createNodeIdentity,
  verifyWithPublicKey as verifyWithNodeIdentity,
} from "@exadev/wire-mesh-core/adapters/node-identity";
import { bytesFromHex } from "./hex.js";

const ES256 = -7;
const SHA256_BYTE_LENGTH = 32;
const UNCOMPRESSED_P256_POINT_BYTE_LENGTH = 65; // 0x04 || X || Y

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
    // A genuinely different message (same bytes in a fresh buffer would still
    // legitimately verify -- the signature covers content, not identity).
    const tampered = bytesFromHex("0102030406");
    expect(
      await identity.verify(identity.identityKey, tampered, signature),
    ).toBe(false);
  });

  it("round-trips independently with core's node-identity adapter -- a signature made by one adapter verifies under the other", async () => {
    // The hub's Worker adapter signs; core's Node adapter verifies.
    const workerIdentity = await createWebCryptoIdentity();
    const message = someMessage();
    const signature = await workerIdentity.sign(message);
    expect(
      await verifyWithNodeIdentity(
        workerIdentity.identityKey,
        message,
        signature,
      ),
    ).toBe(true);

    // And the mirror direction: a Node-side keypair signs, the Worker adapter verifies.
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
      await workerIdentity.verify(
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
});
