import { describe, expect, it } from "vitest";
import { computeTopologyPeers } from "../src/domain/topology-snapshot.js";
import { deviceIdFromFillHex } from "./hex.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");

describe("computeTopologyPeers", () => {
  it("reports no direct peer and no relayed devices when nothing is known", () => {
    expect(
      computeTopologyPeers({
        firstAdvertisedPeer: null,
        isAccepted: false,
        relayedDevices: [],
      }),
    ).toEqual({ direct: [], relayed: [] });
  });

  it("prefers the authenticated peer over the first-advertised one", () => {
    expect(
      computeTopologyPeers({
        authenticatedPeer: deviceA,
        firstAdvertisedPeer: deviceB,
        isAccepted: true,
        relayedDevices: [],
      }),
    ).toEqual({ direct: [deviceA], relayed: [] });
  });

  it("falls back to the first-advertised peer only when accepted", () => {
    expect(
      computeTopologyPeers({
        firstAdvertisedPeer: deviceB,
        isAccepted: true,
        relayedDevices: [],
      }),
    ).toEqual({ direct: [deviceB], relayed: [] });
  });

  it("ignores the first-advertised peer on the dial side, even when set", () => {
    expect(
      computeTopologyPeers({
        firstAdvertisedPeer: deviceB,
        isAccepted: false,
        relayedDevices: [],
      }),
    ).toEqual({ direct: [], relayed: [] });
  });

  it("attributes every relayed device to the known direct peer via `via`", () => {
    expect(
      computeTopologyPeers({
        authenticatedPeer: deviceA,
        firstAdvertisedPeer: null,
        isAccepted: false,
        relayedDevices: [deviceB],
      }),
    ).toEqual({
      direct: [deviceA],
      relayed: [{ device: deviceB, via: deviceA }],
    });
  });

  it("omits `via` for a relayed device when no direct peer is known", () => {
    expect(
      computeTopologyPeers({
        firstAdvertisedPeer: null,
        isAccepted: false,
        relayedDevices: [deviceB],
      }),
    ).toEqual({ direct: [], relayed: [{ device: deviceB }] });
  });
});
