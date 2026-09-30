import { describe, expect, it } from "vitest";
import {
  RELAY_OFFER_GOSSIP_KEY,
  buildRelayOfferExtension,
  readRelayOffer,
} from "../src/domain/relay-advert.js";
import type { PeerAdvert } from "../src/generated/protocol.js";

// Named addresses, so assertions read as the offer's own vocabulary rather than bare strings.
const OFFER_ADDRESS_A = "192.168.1.4:8787";
const OFFER_ADDRESS_B = "100.101.102.103:8787";

// Field sizes the advert's own schema fixes: device-id is a SHA-256 digest, identity-key a raw public key of the same width, signature twice that.
const DEVICE_ID_BYTES = 32;
const IDENTITY_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
// A value of the wrong type riding where an address belongs, for the malformed-extension cases.
const MALFORMED_ENTRY = 7;

/** An advert carrying only its mandatory fields plus whatever the test spreads in, the shape readRelayOffer reads from. */
function advertWith(extension: Record<string, unknown>): PeerAdvert {
  return {
    device: new Uint8Array(DEVICE_ID_BYTES),
    addresses: [],
    "snapshot-seconds": 0,
    "identity-key": new Uint8Array(IDENTITY_KEY_BYTES),
    signature: new Uint8Array(SIGNATURE_BYTES),
    ...extension,
  } as unknown as PeerAdvert;
}

describe("buildRelayOfferExtension", () => {
  it("carries the addresses under the wire-mesh relay-offer key", () => {
    expect(buildRelayOfferExtension([OFFER_ADDRESS_A])).toEqual({
      [RELAY_OFFER_GOSSIP_KEY]: [OFFER_ADDRESS_A],
    });
  });

  it("preserves every address in order", () => {
    expect(
      buildRelayOfferExtension([OFFER_ADDRESS_A, OFFER_ADDRESS_B])[
        RELAY_OFFER_GOSSIP_KEY
      ],
    ).toEqual([OFFER_ADDRESS_A, OFFER_ADDRESS_B]);
  });

  it("throws on an empty offer, which is no offer at all", () => {
    expect(() => buildRelayOfferExtension([])).toThrow();
  });
});

describe("readRelayOffer", () => {
  it("round-trips an offer built by the writer", () => {
    expect(
      readRelayOffer(
        advertWith(
          buildRelayOfferExtension([OFFER_ADDRESS_A, OFFER_ADDRESS_B]),
        ),
      ),
    ).toEqual([OFFER_ADDRESS_A, OFFER_ADDRESS_B]);
  });

  it("reads undefined from an advert with no offer", () => {
    expect(readRelayOffer(advertWith({}))).toBeUndefined();
  });

  it("treats a malformed extension as no offer rather than an error", () => {
    expect(
      readRelayOffer(advertWith({ [RELAY_OFFER_GOSSIP_KEY]: "not-a-list" })),
    ).toBeUndefined();
    expect(
      readRelayOffer(
        advertWith({
          [RELAY_OFFER_GOSSIP_KEY]: [OFFER_ADDRESS_A, MALFORMED_ENTRY],
        }),
      ),
    ).toBeUndefined();
    expect(
      readRelayOffer(advertWith({ [RELAY_OFFER_GOSSIP_KEY]: [] })),
    ).toBeUndefined();
  });
});
