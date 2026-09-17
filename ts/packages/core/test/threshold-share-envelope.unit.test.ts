import { describe, expect, it } from "vitest";
import { generateEd25519Identity } from "./tokens-fixtures.js";
import {
  mintShareEnvelope,
  verifyShareEnvelope,
} from "../src/domain/threshold-share-envelope.js";

const DEVICE_ID_LENGTH = 32;
const GROUP_DEVICE_BYTE = 9;
const OTHER_GROUP_DEVICE_BYTE = 1;
const FIRST_SESSION_ID = 42n;
const SECOND_SESSION_ID = 7n;
const THIRD_SESSION_ID = 1n;
const THIRD_BYTE = 3;
const FOURTH_BYTE = 4;
const FIFTH_BYTE = 5;
const SIXTH_BYTE = 6;
const SEVENTH_BYTE = 7;
const SHARE_BYTES = [1, 2, THIRD_BYTE, FOURTH_BYTE];
const OTHER_SHARE_BYTES = [FIFTH_BYTE, SIXTH_BYTE, SEVENTH_BYTE];
const TAMPER_SHARE_BYTES = [1, 2, THIRD_BYTE];
const XOR_MASK = 0xff;

function deviceId(byte: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(DEVICE_ID_LENGTH);
  bytes[DEVICE_ID_LENGTH - 1] = byte;
  return bytes;
}

describe("threshold-share-envelope: mint/verify", () => {
  it("mint then verify round-trips and the claims match", async () => {
    const personal = await generateEd25519Identity();
    const group = deviceId(GROUP_DEVICE_BYTE);
    const shareBytes = new Uint8Array(SHARE_BYTES);

    const envelope = await mintShareEnvelope(
      personal,
      FIRST_SESSION_ID,
      group,
      shareBytes,
    );
    const claims = await verifyShareEnvelope(personal, envelope);

    expect(claims).toBeDefined();
    expect(claims?.sessionId).toBe(FIRST_SESSION_ID);
    expect(claims?.group).toEqual(group);
    expect(claims?.share).toEqual(shareBytes);
    expect(claims?.issuer).toEqual(personal.deviceId);
  });

  it("verification only needs the embedded issuer-key, not the local verifier's own identity", async () => {
    const signer = await generateEd25519Identity();
    const verifier = await generateEd25519Identity();
    const group = deviceId(OTHER_GROUP_DEVICE_BYTE);

    const envelope = await mintShareEnvelope(
      signer,
      SECOND_SESSION_ID,
      group,
      new Uint8Array(OTHER_SHARE_BYTES),
    );

    const claims = await verifyShareEnvelope(verifier, envelope);
    expect(claims?.issuer).toEqual(signer.deviceId);
  });

  it("a tampered payload fails verification", async () => {
    const personal = await generateEd25519Identity();
    const group = deviceId(GROUP_DEVICE_BYTE);
    const envelope = await mintShareEnvelope(
      personal,
      THIRD_SESSION_ID,
      group,
      new Uint8Array(TAMPER_SHARE_BYTES),
    );
    const tamperedPayload =
      envelope[2] === null ? null : Uint8Array.from(envelope[2]);
    if (tamperedPayload !== null) {
      const lastIndex = tamperedPayload.length - 1;
      const lastByte = tamperedPayload[lastIndex];
      if (lastByte === undefined) {
        throw new Error("test fixture: expected a non-empty payload");
      }
      tamperedPayload[lastIndex] = lastByte ^ XOR_MASK;
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
