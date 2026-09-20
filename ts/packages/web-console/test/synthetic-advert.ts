import type { PeerAdvert } from "wire-mesh-core/generated/protocol";
import { bytesFromHex } from "./hex.js";

/** COSE algorithm identifier for EdDSA, the value identity-key.alg carries for an Ed25519 key. */
const COSE_ALG_EDDSA = -8;
/** Byte length of a device-id, and here of the synthetic key and signature filler too, since nothing reading them cares about their length. */
const FILLER_BYTE_LENGTH = 32;

/**
 * The two mandatory peer-advert fields (identity-key and signature) for an advert that only has to be well-formed because nothing under test verifies it, such as a codec round trip. The bytes are repeated-byte filler in the conformance suite's convention and are neither a real key nor a valid signature, so anything that verifies refuses an advert built from them; a test that feeds an advert to a session needs a real signed one instead.
 */
export function syntheticAdvertProof(): Pick<
  PeerAdvert,
  "identity-key" | "signature"
> {
  return {
    "identity-key": {
      alg: COSE_ALG_EDDSA,
      "public-key": bytesFromHex("cc".repeat(FILLER_BYTE_LENGTH)),
    },
    signature: bytesFromHex("dd".repeat(FILLER_BYTE_LENGTH)),
  };
}
