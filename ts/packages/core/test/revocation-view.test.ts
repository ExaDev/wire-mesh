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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
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
  it("reports nothing recorded before any entry has been recorded", async () => {
    const view = createRevocationView();
    const entries = await view.entriesFor(buf([1]));
    expect(entries).toEqual([]);
  });

  it("returns the recorded revocation-claims once its issuer's own revocation-entry has been recorded", async () => {
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

    const entries = await view.entriesFor(tokenId);
    expect(entries).toHaveLength(1);
    expect(
      equalBytes(entries[0]?.issuer ?? new Uint8Array(), issuer.deviceId),
    ).toBe(true);
  });

  it("still returns a third party's own recorded revocation-entry for someone else's token-id -- filtering by issuer is the caller's (verifyTokenChain's) obligation, not the store's", async () => {
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

    const entries = await view.entriesFor(tokenId);
    expect(entries).toHaveLength(1);
    expect(
      equalBytes(entries[0]?.issuer ?? new Uint8Array(), actualIssuer.deviceId),
    ).toBe(false);
    expect(
      equalBytes(entries[0]?.issuer ?? new Uint8Array(), impostor.deviceId),
    ).toBe(true);
  });

  it("does not return a revocation-entry for a different token-id", async () => {
    const view = createRevocationView();
    const issuer = await generateEs256Identity();
    const entry = await mintRevocationEntry({
      identity: issuer,
      tokenId: buf([1]),
      revokedAt: 1000,
    });

    await view.record(entry, { identity: issuer });

    const entries = await view.entriesFor(buf([2]));
    expect(entries).toEqual([]);
  });

  it("refuses to record an entry whose signature does not verify, and does not let it appear in entriesFor", async () => {
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

    const entries = await view.entriesFor(tokenId);
    expect(entries).toEqual([]);
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

    expect(await view.entriesFor(firstTokenId)).toHaveLength(1);
    expect(await view.entriesFor(secondTokenId)).toHaveLength(1);
  });

  it("records multiple entries for the same token-id from different issuers, returning both", async () => {
    const view = createRevocationView();
    const originalIssuer = await generateEs256Identity();
    const delegatedRevoker = await generateEs256Identity();
    const tokenId = buf([1]);
    await view.record(
      await mintRevocationEntry({
        identity: originalIssuer,
        tokenId,
        revokedAt: 1000,
      }),
      { identity: originalIssuer },
    );
    await view.record(
      await mintRevocationEntry({
        identity: delegatedRevoker,
        tokenId,
        revokedAt: 2000,
      }),
      { identity: delegatedRevoker },
    );

    const entries = await view.entriesFor(tokenId);
    expect(entries).toHaveLength(2);
  });
});
