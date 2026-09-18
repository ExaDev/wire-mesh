import { describe, expect, it } from "vitest";
import {
  computeTopologyPeers,
  createTopologySnapshotTracker,
} from "../src/domain/topology-snapshot.js";
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

describe("createTopologySnapshotTracker", () => {
  it("computes nothing when its own sources report nothing", () => {
    const tracker = createTopologySnapshotTracker({
      getAuthenticatedPeer: () => undefined,
      isAccepted: false,
      getRelayedDevices: () => [],
    });

    expect(tracker.compute()).toEqual({ direct: [], relayed: [] });
  });

  it("re-reads its own sources live on every compute() call", () => {
    const sources = {
      authenticatedPeer: undefined as typeof deviceA | undefined,
      relayedDevices: [] as (typeof deviceB)[],
    };
    const tracker = createTopologySnapshotTracker({
      getAuthenticatedPeer: () => sources.authenticatedPeer,
      isAccepted: false,
      getRelayedDevices: () => sources.relayedDevices,
    });

    expect(tracker.compute()).toEqual({ direct: [], relayed: [] });

    sources.authenticatedPeer = deviceA;
    sources.relayedDevices = [deviceB];
    expect(tracker.compute()).toEqual({
      direct: [deviceA],
      relayed: [{ device: deviceB, via: deviceA }],
    });
  });

  it("records only the first advert, and only uses it when accepted", () => {
    const tracker = createTopologySnapshotTracker({
      getAuthenticatedPeer: () => undefined,
      isAccepted: true,
      getRelayedDevices: () => [],
    });

    tracker.recordAdvert(deviceA);
    tracker.recordAdvert(deviceB);

    expect(tracker.compute()).toEqual({ direct: [deviceA], relayed: [] });
  });
});
