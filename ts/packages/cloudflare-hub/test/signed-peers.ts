// Fixture peers for the hub tests, each holding a real identity from this package's own Web Crypto adapter. The hub verifies every gossiped advert against the key it carries (wire-mesh#225), so an advert naming a device-id no keypair produced is never registered, and a test built on one would exercise only the rejection path.

import type {
  DeviceId,
  Frame,
  PeerAdvert,
} from "wire-mesh-core/generated/protocol";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import {
  signPeerAdvert,
  type PeerAdvertVerifier,
} from "wire-mesh-core/domain/peer-advert";
import {
  createWebCryptoIdentity,
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/web-crypto-identity.js";

/** The verification half of this package's Web Crypto identity, which is all a relay hub is given: an advert is self-certifying, so a hub needs no signing identity of its own. Matches how hibernating-hub.ts builds its own. */
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

/** Mints a fresh identity and the signed advert the hub accepts for it. */
export async function createTestPeer(): Promise<TestPeer> {
  const identity = await createWebCryptoIdentity();
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
