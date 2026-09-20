// validateGossipExtensions on its own, rather than only through sendGossipUpdate: every rule here is a caller bug that must fail loudly at the call site, and the two authentication-related reserved names (wire-mesh#225) matter most, since an extension able to shadow either would let a caller replace the very fields an advert's authenticity rests on.

import { describe, expect, it } from "vitest";
import { validateGossipExtensions } from "../src/domain/gossip-extensions.js";

describe("validateGossipExtensions", () => {
  it("accepts a domain-qualified key", () => {
    expect(() => {
      validateGossipExtensions({ "presence/status": "idle" });
    }).not.toThrow();
  });

  it("accepts an empty bag", () => {
    expect(() => {
      validateGossipExtensions({});
    }).not.toThrow();
  });

  for (const key of [
    "device",
    "addresses",
    "snapshot-seconds",
    "identity-key",
    "signature",
  ]) {
    it(`rejects "${key}", one of peer-advert's own typed fields`, () => {
      expect(() => {
        validateGossipExtensions({ [key]: "anything" });
      }).toThrow(/collides with a mandatory peer-advert field/);
    });
  }

  it("rejects the session-managed topology field", () => {
    expect(() => {
      validateGossipExtensions({ "topology/peers": { direct: [] } });
    }).toThrow(/collides with a session-managed gossip field/);
  });

  it("rejects the key core reserves for its own version", () => {
    expect(() => {
      validateGossipExtensions({ "wire-mesh/version": "9.9.9" });
    }).toThrow(/reserved for wire-mesh-core's own self-reported version/);
  });

  it("rejects a bare, non-domain-qualified key", () => {
    expect(() => {
      validateGossipExtensions({ status: "idle" });
    }).toThrow(/must be domain-qualified/);
  });
});
