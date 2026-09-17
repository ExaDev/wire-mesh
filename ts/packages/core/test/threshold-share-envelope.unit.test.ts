import { describe, expect, it } from "vitest";
import { generateEd25519Identity } from "./tokens-fixtures.js";
import {
  mintShareEnvelope,
  verifyShareEnvelope,
} from "../src/domain/threshold-share-envelope.js";

const DEVICE_ID_LENGTH = 32;

function deviceId(byte: number): Uint8Array {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

describe("threshold-share-envelope: mint/verify", () => {
  it("mint then verify round-trips and the claims match", async () => {
    const personal = await generateEd25519Identity();
    const group = deviceId(9);
    const shareBytes = new Uint8Array([1, 2, 3, 4]);

    const envelope = await mintShareEnvelope(personal, 42n, group, shareBytes);
    const claims = await verifyShareEnvelope(personal, envelope);

    expect(claims).toBeDefined();
    expect(claims?.sessionId).toBe(42n);
    expect(claims?.group).toEqual(group);
    expect(claims?.share).toEqual(shareBytes);
    expect(claims?.issuer).toEqual(personal.deviceId);
  });

  it("verification only needs the embedded issuer-key, not the local verifier's own identity", async () => {
    const signer = await generateEd25519Identity();
    const verifier = await generateEd25519Identity();
    const group = deviceId(1);

    const envelope = await mintShareEnvelope(
      signer,
      7n,
      group,
      new Uint8Array([5, 6, 7]),
    );

    const claims = await verifyShareEnvelope(verifier, envelope);
    expect(claims?.issuer).toEqual(signer.deviceId);
  });

  it("a tampered payload fails verification", async () => {
    const personal = await generateEd25519Identity();
    const group = deviceId(9);
    const envelope = await mintShareEnvelope(
      personal,
      1n,
      group,
      new Uint8Array([1, 2, 3]),
    );
    const tamperedPayload =
      envelope[2] === null ? null : Uint8Array.from(envelope[2]);
    if (tamperedPayload !== null) {
      tamperedPayload[tamperedPayload.length - 1] ^= 0xff;
    }
    const tampered: typeof envelope = [
      envelope[0],
      envelope[1],
      tamperedPayload,
      envelope[3],
    ];

    const claims = await verifyShareEnvelope(personal, tampered);
    expect(claims).toBeUndefined();
  });
});
