// verifyPeerAdvert is the single gate both the relay hub and every mesh session run a gossiped advert through, so these cover each way an advert can fail it independently: an untouched advert passes, a change to any covered field (typed or extension) breaks the signature, an identity-key that does not hash to the claimed device fails self-certification, a corrupted signature fails outright, and an identity-key carrying an algorithm or key bytes no verifier can import produces a false verdict rather than a thrown error.

import { describe, expect, it } from "vitest";
import { cdeEncodeOptions, encode } from "cbor2";
import {
  PEER_ADVERT_SIGNING_CONTEXT,
  peerAdvertSigningInput,
  signPeerAdvert,
  verifyPeerAdvert,
  type UnsignedPeerAdvert,
} from "../src/domain/peer-advert.js";
import type { PeerAdvert } from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import {
  buf,
  generateEd25519Identity,
  generateEs256Identity,
  LOW_BYTE_MASK,
} from "./tokens-fixtures.js";

const SNAPSHOT_SECONDS = 1861833600;
/** An alg no identity-key in this spec's own registry uses, so importing a key under it fails rather than verifying. */
const UNSUPPORTED_ALG = 9999;

function unsignedAdvert(identity: IdentityPort): UnsignedPeerAdvert {
  return {
    device: identity.deviceId,
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": SNAPSHOT_SECONDS,
    "identity-key": identity.identityKey,
    "presence/status": "idle",
  };
}

describe("peerAdvertSigningInput", () => {
  it("prefixes the domain-separation context and omits only the signature", async () => {
    const identity = await generateEd25519Identity();
    const unsigned = unsignedAdvert(identity);
    const advert = await signPeerAdvert(identity, unsigned);

    const expected = new Uint8Array([
      ...PEER_ADVERT_SIGNING_CONTEXT,
      ...encode(unsigned, cdeEncodeOptions),
    ]);
    expect(peerAdvertSigningInput(advert)).toEqual(expected);
  });

  it("starts with an ASCII byte no COSE Sig_structure can start with", () => {
    // A Sig_structure is always a 4-element CBOR array (0x84) whose first element is "Signature1", so a signature over this input can never be replayed as a capability token's own signed payload and vice versa.
    const COSE_SIG_STRUCTURE_FIRST_BYTE = 0x84;
    expect(PEER_ADVERT_SIGNING_CONTEXT[0]).not.toBe(
      COSE_SIG_STRUCTURE_FIRST_BYTE,
    );
  });
});

describe("verifyPeerAdvert", () => {
  it("accepts an advert signed by the device it names", async () => {
    const identity = await generateEd25519Identity();
    const advert = await signPeerAdvert(identity, unsignedAdvert(identity));
    await expect(verifyPeerAdvert(identity, advert)).resolves.toBe(true);
  });

  it("accepts an ES256 advert verified by an unrelated node's identity port", async () => {
    // The verifier is only ever a source of crypto primitives here: an advert is self-certifying, so a node with no prior contact with the advertised device checks it with its own identity port and nothing else.
    const advertiser = await generateEs256Identity();
    const verifier = await generateEd25519Identity();
    const advert = await signPeerAdvert(advertiser, unsignedAdvert(advertiser));
    await expect(verifyPeerAdvert(verifier, advert)).resolves.toBe(true);
  });

  it("rejects an advert whose typed field was altered after signing", async () => {
    const identity = await generateEd25519Identity();
    const advert = await signPeerAdvert(identity, unsignedAdvert(identity));
    const tampered: PeerAdvert = {
      ...advert,
      addresses: ["198.51.100.2:4433"],
    };
    await expect(verifyPeerAdvert(identity, tampered)).resolves.toBe(false);
  });

  it("rejects an advert whose extension value was altered after signing", async () => {
    const identity = await generateEd25519Identity();
    const advert = await signPeerAdvert(identity, unsignedAdvert(identity));
    const tampered: PeerAdvert = { ...advert, "presence/status": "active" };
    await expect(verifyPeerAdvert(identity, tampered)).resolves.toBe(false);
  });

  it("rejects an advert that gained an extension key after signing", async () => {
    const identity = await generateEd25519Identity();
    const advert = await signPeerAdvert(identity, unsignedAdvert(identity));
    const tampered: PeerAdvert = { ...advert, "room/hosted": ["general"] };
    await expect(verifyPeerAdvert(identity, tampered)).resolves.toBe(false);
  });

  it("rejects an advert that lost an extension key after signing", async () => {
    const identity = await generateEd25519Identity();
    const advert = await signPeerAdvert(identity, unsignedAdvert(identity));
    const stripped: Record<string, unknown> = { ...advert };
    delete stripped["presence/status"];
    await expect(
      verifyPeerAdvert(identity, stripped as unknown as PeerAdvert),
    ).resolves.toBe(false);
  });

  it("rejects an advert whose identity-key does not hash to the device it names", async () => {
    const advertiser = await generateEd25519Identity();
    const other = await generateEd25519Identity();
    // Signed under the advertiser's own key but naming another device: the signature itself is genuine, and only the self-certification check catches this.
    const advert = await signPeerAdvert(advertiser, {
      ...unsignedAdvert(advertiser),
      device: other.deviceId,
    });
    await expect(verifyPeerAdvert(advertiser, advert)).resolves.toBe(false);
  });

  it("rejects an advert carrying another device's identity-key", async () => {
    const advertiser = await generateEd25519Identity();
    const victim = await generateEd25519Identity();
    const advert = await signPeerAdvert(advertiser, {
      ...unsignedAdvert(advertiser),
      device: victim.deviceId,
      "identity-key": victim.identityKey,
    });
    // Self-certification passes -- the key really does hash to the named device -- so only the signature check, which the advertiser could not produce without the victim's private key, refuses it.
    await expect(verifyPeerAdvert(advertiser, advert)).resolves.toBe(false);
  });

  it("rejects an advert whose signature was corrupted", async () => {
    const identity = await generateEd25519Identity();
    const advert = await signPeerAdvert(identity, unsignedAdvert(identity));
    const corrupted = buf(advert.signature);
    corrupted[0] ^= LOW_BYTE_MASK;
    await expect(
      verifyPeerAdvert(identity, { ...advert, signature: corrupted }),
    ).resolves.toBe(false);
  });

  it("returns false rather than throwing for an unsupported identity-key alg", async () => {
    const identity = await generateEd25519Identity();
    const advert = await signPeerAdvert(identity, unsignedAdvert(identity));
    const badAlg: PeerAdvert = {
      ...advert,
      "identity-key": {
        alg: UNSUPPORTED_ALG,
        "public-key": identity.identityKey["public-key"],
      },
    };
    await expect(verifyPeerAdvert(identity, badAlg)).resolves.toBe(false);
  });

  it("returns false rather than throwing for public-key bytes of the wrong length", async () => {
    const identity = await generateEd25519Identity();
    const oversized = buf([
      ...identity.identityKey["public-key"],
      ...identity.identityKey["public-key"],
    ]);
    // Self-certification passes by construction, so the refusal has to come from the key import failing inside verify rather than from a mismatched device-id.
    const device = await identity.deriveDeviceId(oversized);
    const advert = await signPeerAdvert(identity, {
      ...unsignedAdvert(identity),
      device,
      "identity-key": { alg: identity.identityKey.alg, "public-key": oversized },
    });
    await expect(verifyPeerAdvert(identity, advert)).resolves.toBe(false);
  });
});
