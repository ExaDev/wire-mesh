// Signing and verification for peer-advert (spec/transport.cddl), the one gossiped structure that travels beyond the connection it was sent on: a hub re-broadcasts what it receives, and a gateway forwards adverts for the local peers it fronts. Binding an advert to its arriving connection therefore cannot authenticate it -- the signature is what ties an advert to the device it names, and `identity-key` travelling inside the signed content is what makes it self-certifying, so a receiver with no prior contact with that device and no directory to consult can still check it (wire-mesh#225).
//
// Kept as one pure module rather than a method on either consumer: the relay hub (which verifies before registering or re-broadcasting) and the mesh session (which verifies before applying an advert to its own directory) must agree byte-for-byte on what "valid" means, and a hub is a facilitator for the directory rather than an authority over it, so a receiver never delegates this check to whoever forwarded the advert.

import { cdeEncodeOptions, encode } from "cbor2";
import type {
  DeviceId,
  IdentityKey,
  PeerAdvert,
} from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";
import { bytesEqual } from "./token-scope.js";

/** peer-advert's own signature field, the one entry the signature does not cover -- named once here so the signing input and the reserved-extension-key guard cannot drift apart. */
export const PEER_ADVERT_SIGNATURE_KEY = "signature";

/** peer-advert's own self-certifying key field. Covered by the signature like every other entry, so an advert cannot be re-keyed after signing. */
export const PEER_ADVERT_IDENTITY_KEY_KEY = "identity-key";

/**
 * The domain-separation prefix every peer-advert signature is computed over, per spec/transport.cddl: the ASCII string "wire-mesh/peer-advert/v1" followed by one zero byte.
 *
 * Deliberately not tokens.cddl's COSE Sig_structure, which every other signature in this codebase reuses via sig1ToBeSigned. An advert's extension tail is an open `* tstr => any` map, so an attacker can craft an advert whose canonical encoding also satisfies token-claims; a Sig_structure over that encoding would then be replayable as a capability token's own signed payload. This prefix makes the two byte strings disjoint by construction, since a Sig_structure always begins with the CBOR head of a 4-element array (0x84) rather than the ASCII "w" this one starts with.
 */
export const PEER_ADVERT_SIGNING_CONTEXT: Uint8Array<ArrayBuffer> =
  new TextEncoder().encode("wire-mesh/peer-advert/v1\u0000");

/**
 * Everything a peer-advert's signature covers: the whole advert apart from `signature` itself. Spelled out as its own interface rather than derived with `Omit<PeerAdvert, "signature">`, which collapses to the bare index signature because peer-advert's open extension tail makes `keyof PeerAdvert` a plain `string`.
 *
 * A full PeerAdvert satisfies this structurally, which is what lets peerAdvertSigningInput take either an advert being signed or one being verified without a second overload.
 */
export interface UnsignedPeerAdvert {
  readonly device: DeviceId;
  readonly addresses: string[];
  readonly "snapshot-seconds": number;
  readonly "identity-key": IdentityKey;
  /** peer-advert's own open extension tail (spec/CONVENTIONS.md's gossip-extension-namespacing convention). Every key here is signed over too, so nothing in the tail can be added, altered, or dropped without invalidating the advert. */
  readonly [key: string]: unknown;
}

/** The crypto primitives verification needs, and nothing else: an advert is self-certifying, so a verifier never consults its own device-id or private key to check one. Narrowed from IdentityPort so a relay hub, which has no reason to hold a signing identity, can be given a verifier without one. */
export type PeerAdvertVerifier = Pick<
  IdentityPort,
  "verify" | "deriveDeviceId"
>;

/** The signing half's own dependency: a node only ever signs adverts naming itself, which is exactly why a gateway forwards its local peers' adverts verbatim instead of re-signing them. */
export type PeerAdvertSigner = Pick<IdentityPort, "sign">;

/**
 * The exact bytes a peer-advert's signature is computed over: PEER_ADVERT_SIGNING_CONTEXT followed by the canonical CDE encoding of the advert with its `signature` entry removed and nothing else changed.
 *
 * Takes the advert rather than a pre-stripped copy so a verifier derives the input from precisely the bytes it received, leaving no room for the signed and checked views of an advert to disagree.
 */
export function peerAdvertSigningInput(
  advert: Readonly<UnsignedPeerAdvert>,
): Uint8Array<ArrayBuffer> {
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(advert)) {
    if (key === PEER_ADVERT_SIGNATURE_KEY) {
      continue;
    }
    content[key] = value;
  }
  const encoded = encode(content, cdeEncodeOptions);
  const input = new Uint8Array(
    PEER_ADVERT_SIGNING_CONTEXT.length + encoded.length,
  );
  input.set(PEER_ADVERT_SIGNING_CONTEXT, 0);
  input.set(encoded, PEER_ADVERT_SIGNING_CONTEXT.length);
  return input;
}

/** Signs an advert's content into the complete peer-advert that goes on the wire. The caller supplies `device` and `identity-key` itself rather than having them read off the signer, since the signer port carries only `sign`: a node building its own self-advert already holds both, and nothing else may legitimately sign an advert at all. */
export async function signPeerAdvert(
  identity: Readonly<PeerAdvertSigner>,
  advert: Readonly<UnsignedPeerAdvert>,
): Promise<PeerAdvert> {
  const signature = await identity.sign(peerAdvertSigningInput(advert));
  return { ...advert, [PEER_ADVERT_SIGNATURE_KEY]: signature };
}

/**
 * Both validity checks spec/transport.cddl states for a gossiped advert, in the order a verifier must apply them: the embedded identity-key self-certifies (sha256 of its public-key equals the advert's own `device`), and the signature verifies under that same key over peerAdvertSigningInput's bytes.
 *
 * Returns a verdict for every input, including a hostile one, and never throws. An advert's `alg` and `public-key` are attacker-chosen (identity-key constrains them to an int and a bstr, nothing more), so importing the key can legitimately fail for an algorithm no verifier implements or for key bytes of the wrong length -- an unverifiable advert is a refused advert, exactly as if its signature had simply been wrong, which is why the import failure is turned into `false` here rather than propagated to a caller iterating a frame's other adverts.
 */
export async function verifyPeerAdvert(
  identity: Readonly<PeerAdvertVerifier>,
  advert: Readonly<PeerAdvert>,
): Promise<boolean> {
  const key = advert[PEER_ADVERT_IDENTITY_KEY_KEY];
  try {
    const derived = await identity.deriveDeviceId(key["public-key"]);
    if (!bytesEqual(derived, advert.device)) {
      return false;
    }
    return await identity.verify(
      key,
      peerAdvertSigningInput(advert),
      advert[PEER_ADVERT_SIGNATURE_KEY],
    );
  } catch {
    return false;
  }
}
