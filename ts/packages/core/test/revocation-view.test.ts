import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { mintRevocationEntry } from "../src/domain/tokens.js";
import { createRevocationView } from "../src/domain/revocation-view.js";
import type { IdentityPort } from "../src/ports/identity.js";

const ES256 = -7;
const LOW_BYTE_MASK = 0xff; // XOR operand keeping the corrupted byte within one octet when tampering with a signature in this test

function buf(bytes: Uint8Array | ArrayLike<number>): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function generateEs256Identity(): Promise<IdentityPort> {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  return createNodeIdentity(keyPair.privateKey, publicKeyBytes, ES256);
}

describe("createRevocationView", () => {
  it("reports nothing revoked before any entry has been recorded", async () => {
    const view = createRevocationView();
    const issuer = await generateEs256Identity();
    const revoked = await view.isRevoked(buf([1]), issuer.deviceId);
    expect(revoked).toBe(false);
  });

  it("reports a token revoked once its issuer's own revocation-entry has been recorded", async () => {
    const view = createRevocationView();
    const issuer = await generateEs256Identity();
    const tokenId = buf([1]);
    const entry = await mintRevocationEntry({
      identity: issuer,
      tokenId,
      revokedAt: 1000,
    });

    const recordVerdict = await view.record(entry, { identity: issuer });
    expect(recordVerdict.ok).toBe(true);

    const revoked = await view.isRevoked(tokenId, issuer.deviceId);
    expect(revoked).toBe(true);
  });

  it("does not treat a third party's revocation-entry as revoking someone else's token with the same token-id", async () => {
    const view = createRevocationView();
    const actualIssuer = await generateEs256Identity();
    const impostor = await generateEs256Identity();
    const tokenId = buf([1]);
    const entry = await mintRevocationEntry({
      identity: impostor,
      tokenId,
      revokedAt: 1000,
    });

    const recordVerdict = await view.record(entry, { identity: impostor });
    expect(recordVerdict.ok).toBe(true);

    const revoked = await view.isRevoked(tokenId, actualIssuer.deviceId);
    expect(revoked).toBe(false);
  });

  it("does not treat a revocation-entry for a different token-id as revoking this one", async () => {
    const view = createRevocationView();
    const issuer = await generateEs256Identity();
    const entry = await mintRevocationEntry({
      identity: issuer,
      tokenId: buf([1]),
      revokedAt: 1000,
    });

    await view.record(entry, { identity: issuer });

    const revoked = await view.isRevoked(buf([2]), issuer.deviceId);
    expect(revoked).toBe(false);
  });

  it("refuses to record an entry whose signature does not verify, and does not let it revoke anything", async () => {
    const view = createRevocationView();
    const issuer = await generateEs256Identity();
    const tokenId = buf([1]);
    const entry = await mintRevocationEntry({
      identity: issuer,
      tokenId,
      revokedAt: 1000,
    });
    const [protectedHeader, unprotectedHeader, payload, signature] = entry;
    const tamperedSignature = buf(signature);
    tamperedSignature[0] = (tamperedSignature[0] ?? 0) ^ LOW_BYTE_MASK;
    const tamperedEntry: typeof entry = [
      protectedHeader,
      unprotectedHeader,
      payload,
      tamperedSignature,
    ];

    const recordVerdict = await view.record(tamperedEntry, {
      identity: issuer,
    });
    expect(recordVerdict.ok).toBe(false);

    const revoked = await view.isRevoked(tokenId, issuer.deviceId);
    expect(revoked).toBe(false);
  });

  it("keeps recording additional entries independently, so an earlier one is not overwritten", async () => {
    const view = createRevocationView();
    const issuer = await generateEs256Identity();
    const firstTokenId = buf([1]);
    const secondTokenId = buf([2]);
    await view.record(
      await mintRevocationEntry({
        identity: issuer,
        tokenId: firstTokenId,
        revokedAt: 1000,
      }),
      { identity: issuer },
    );
    await view.record(
      await mintRevocationEntry({
        identity: issuer,
        tokenId: secondTokenId,
        revokedAt: 2000,
      }),
      { identity: issuer },
    );

    expect(await view.isRevoked(firstTokenId, issuer.deviceId)).toBe(true);
    expect(await view.isRevoked(secondTokenId, issuer.deviceId)).toBe(true);
  });
});
