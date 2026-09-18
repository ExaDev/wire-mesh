import { describe, expect, it } from "vitest";
import {
  LOCAL_DEV_HUB_ADDRESS,
  defaultHubAddress,
  sameOriginHubAddress,
} from "../src/default-hub-address.js";

describe("sameOriginHubAddress", () => {
  it("swaps https for wss, keeping the same host", () => {
    expect(
      sameOriginHubAddress({ protocol: "https:", host: "mesh.exadev.io" }),
    ).toBe("wss://mesh.exadev.io");
  });

  it("swaps http for ws, keeping the same host", () => {
    expect(
      sameOriginHubAddress({ protocol: "http:", host: "localhost:4173" }),
    ).toBe("ws://localhost:4173");
  });
});

describe("defaultHubAddress", () => {
  it("uses the hardcoded local hub port in dev, regardless of the page's own origin", () => {
    expect(
      defaultHubAddress(true, { protocol: "http:", host: "localhost:5173" }),
    ).toBe(LOCAL_DEV_HUB_ADDRESS);
  });

  it("points at the page's own origin outside dev, matching a build served from the same origin as its hub", () => {
    expect(
      defaultHubAddress(false, { protocol: "https:", host: "mesh.exadev.io" }),
    ).toBe("wss://mesh.exadev.io");
  });
});
