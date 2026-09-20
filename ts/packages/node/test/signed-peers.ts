// Fixture peers for the relay tests, each holding a real Ed25519 identity. The hub verifies every gossiped advert against the key it carries (wire-mesh#225), so an advert naming a device-id no keypair produced is never registered, and a test built on one would exercise only the rejection path.

import { webcrypto } from "node:crypto";
import {
  createNodeIdentity,
  deriveDeviceId,
  verifyWithPublicKey,
} from "wire-mesh-core/adapters/node-identity";
import {
  signPeerAdvert,
  type PeerAdvertVerifier,
} from "wire-mesh-core/domain/peer-advert";
import type {
  DeviceId,
  Frame,
  PeerAdvert,
} from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";

/** COSE algorithm identifier for EdDSA, the value identity-key.alg carries for an Ed25519 key. */
const EDDSA = -8;

/** The verification half of core's Node identity adapter, which is all a relay hub is given: an advert is self-certifying, so a hub needs no signing identity of its own. Matches how server.ts builds its own. */
export const hubVerifier: PeerAdvertVerifier = {
  verify: verifyWithPublicKey,
  deriveDeviceId,
};

/** The snapshot second every fixture advert carries, so two peers' adverts differ only in who signed them. */
const FIXTURE_SNAPSHOT_SECONDS = 1861833600;

/** A real identity paired with the advert and single-peer gossip frame the hub will accept for it, so a test can name a peer once and reuse both. */
export interface TestPeer {
  readonly identity: IdentityPort;
  readonly device: DeviceId;
  readonly advert: PeerAdvert;
  readonly gossip: Frame;
}

/** Mints a fresh Ed25519 identity and the signed advert the hub accepts for it. */
export async function createTestPeer(): Promise<TestPeer> {
  // @types/node's generateKey overloads mis-resolve a bare { name: "Ed25519" } to the CryptoKey-only overload, because it structurally matches KmacKeyGenParams. Supplying `namedCurve` steers resolution to the CryptoKeyPair-returning one with no runtime effect: Web Crypto dispatches Ed25519 key generation on `name` alone and never reads `namedCurve` for it.
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "Ed25519", namedCurve: "Ed25519" },
    true,
    ["sign", "verify"],
  );
  const publicKeyBytes = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", keyPair.publicKey),
  );
  const identity = await createNodeIdentity(
    keyPair.privateKey,
    publicKeyBytes,
    EDDSA,
  );
  const advert = await signPeerAdvert(identity, {
    device: identity.deviceId,
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": FIXTURE_SNAPSHOT_SECONDS,
    "identity-key": identity.identityKey,
  });
  return {
    identity,
    device: identity.deviceId,
    advert,
    gossip: { type: "gossip", peers: [advert] },
  };
}
