import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveDeviceId } from "../src/adapters/node-identity.js";

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
