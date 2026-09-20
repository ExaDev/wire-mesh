import type { PeerAdvert } from "../src/generated/protocol.js";
import { deviceIdFromFillHex } from "./hex.js";
import { EDDSA } from "./tokens-fixtures.js";

/** Repeated-byte fill for the synthetic key, following the conformance suite's convention for synthetic crypto material. */
const SYNTHETIC_PUBLIC_KEY_FILL = "cc";
/** Repeated-byte fill for the synthetic signature. */
const SYNTHETIC_SIGNATURE_FILL = "dd";

/**
 * The two mandatory peer-advert fields (identity-key and signature) for an advert that only has to be well-formed because nothing under test verifies it: a codec round trip, a directory reader, a policy callback. The bytes are repeated-byte filler and are neither a real key nor a valid signature, so an advert built from them is refused by anything that verifies; a test that sends an advert through a session or a hub needs a real signed one instead (see createTestPeer in relay-hub-test-helpers.ts).
 */
export function syntheticAdvertProof(): Pick<
  PeerAdvert,
  "identity-key" | "signature"
> {
  return {
    "identity-key": {
      alg: EDDSA,
      "public-key": deviceIdFromFillHex(SYNTHETIC_PUBLIC_KEY_FILL),
    },
    signature: deviceIdFromFillHex(SYNTHETIC_SIGNATURE_FILL),
  };
}
