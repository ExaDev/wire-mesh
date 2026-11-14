import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNodeIdentity } from "../src/adapters/node-identity.js";
import { verifyPeerAdvert } from "../src/domain/peer-advert.js";
import { verifyRoomNotice } from "../src/domain/room.js";
import {
  mintShareEnvelope,
  verifyShareEnvelope,
} from "../src/domain/threshold-share-envelope.js";
import {
  verifyCapabilityToken,
  verifyRevocationEntry,
} from "../src/domain/tokens.js";
import type { IdentityPort } from "../src/ports/identity.js";
import {
  EDDSA,
  HOUR_MS,
  fixedClock,
  generateEd25519Identity,
  neverRevoked,
  nextTokenId,
  signRevocationEntry,
  signToken,
} from "./tokens-fixtures.js";
import { signRoomNotice } from "./room-notice-fixtures.js";

const KEY_BYTES = 32;
const NOW_MS = 1_893_456_000_000;
const SESSION_ID = BigInt("1");
const SHARE = new Uint8Array(KEY_BYTES);

/** The identity element, a small-order point and so a key no verifier accepts. */
function identityElement(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(KEY_BYTES);
  bytes[0] = 1;

  return bytes;
}

/** An identity that signs with a real key but presents `publicKey` as its own, so its claims are self-consistent (the device-id is the hash of the presented bytes) and carry a key the verifier refuses. */
async function presenting(
  publicKey: Uint8Array<ArrayBuffer>,
): Promise<IdentityPort> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign", "verify"],
  );

  return createNodeIdentity(pair.privateKey, publicKey, EDDSA);
}

describe("every verifier gives a verdict for a key it refuses", () => {
  it("a capability token", async () => {
    const weak = await presenting(identityElement());
    const verifier = await generateEd25519Identity();
    const token = await signToken(weak, {
      tokenId: nextTokenId(),
      bearer: verifier.deviceId,
      scope: { kind: "folder", path: "/work" },
      expires: NOW_MS + HOUR_MS,
    });

    const verdict = await verifyCapabilityToken(token, {
      identity: verifier,
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
    });

    expect(verdict).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("a revocation entry", async () => {
    const weak = await presenting(identityElement());
    const verifier = await generateEd25519Identity();
    const entry = await signRevocationEntry(weak, nextTokenId());

    expect(await verifyRevocationEntry(entry, { identity: verifier })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("a room notice", async () => {
    const weak = await presenting(identityElement());
    const verifier = await generateEd25519Identity();
    const token = await signToken(weak, {
      tokenId: nextTokenId(),
      bearer: weak.deviceId,
      scope: { kind: "folder", path: "/work" },
      expires: NOW_MS + HOUR_MS,
    });
    const notice = await signRoomNotice(weak, {
      room: "/work",
      token,
      postedAt: NOW_MS,
    });

    const verdict = await verifyRoomNotice(notice, {
      identity: verifier,
      clock: fixedClock(NOW_MS),
      revocation: neverRevoked,
    });

    expect(verdict.ok).toBe(false);
  });

  it("a threshold share envelope", async () => {
    const weak = await presenting(identityElement());
    const verifier = await generateEd25519Identity();
    const envelope = await mintShareEnvelope(
      weak,
      SESSION_ID,
      verifier.deviceId,
      SHARE,
    );

    expect(await verifyShareEnvelope(verifier, envelope)).toBeUndefined();
  });

  it("a gossiped peer advert", async () => {
    const weak = await presenting(identityElement());
    const verifier = await generateEd25519Identity();

    const verdict = await verifyPeerAdvert(verifier, {
      device: weak.deviceId,
      addresses: [],
      "snapshot-seconds": 0,
      "identity-key": weak.identityKey,
      signature: new Uint8Array(KEY_BYTES * 2),
    });

    expect(verdict).toBe(false);
  });
});
