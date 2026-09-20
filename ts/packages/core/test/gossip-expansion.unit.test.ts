import { describe, expect, it, vi } from "vitest";
import type { PeerAdvert } from "../src/generated/protocol.js";
import type { MeshSession } from "../src/domain/mesh-session.js";
import {
  createGossipExpansion,
  type GossipExpansionCandidate,
} from "../src/domain/gossip-expansion.js";
import {
  deviceA,
  deviceB,
  testIdentityDeviceId,
} from "./mesh-session-fixtures.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";

const ADDRESS_A = "203.0.113.5:4433";
const ADDRESS_A2 = "203.0.113.5:4434";
const ADDRESS_B = "203.0.113.9:4433";

function advertFor(
  device: Uint8Array<ArrayBuffer>,
  addresses: readonly string[],
): PeerAdvert {
  return {
    device,
    addresses: [...addresses],
    "snapshot-seconds": 0,
    ...syntheticAdvertProof(),
  };
}

function fakeSession(): MeshSession {
  return {} as MeshSession;
}

describe("createGossipExpansion", () => {
  it("asks shouldExpand for a newly-discovered device with addresses, then dials on approval", async () => {
    const shouldExpand = vi.fn().mockResolvedValue(true);
    const session = fakeSession();
    const dial = vi.fn().mockResolvedValue(session);
    const onExpanded =
      vi.fn<
        (
          candidate: GossipExpansionCandidate,
          address: string,
          session: MeshSession,
        ) => void
      >();
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand,
      dial,
      onExpanded,
    });

    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A]));
    await vi.waitFor(() => {
      expect(onExpanded).toHaveBeenCalled();
    });

    expect(shouldExpand).toHaveBeenCalledExactlyOnceWith({
      device: deviceA,
      addresses: [ADDRESS_A],
    });
    expect(dial).toHaveBeenCalledExactlyOnceWith(ADDRESS_A);
    expect(onExpanded).toHaveBeenCalledExactlyOnceWith(
      { device: deviceA, addresses: [ADDRESS_A] },
      ADDRESS_A,
      session,
    );
  });

  it("never considers its own device-id, even when it advertises itself", () => {
    const shouldExpand = vi.fn();
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand,
      dial: vi.fn(),
      onExpanded:
        vi.fn<
          (
            candidate: GossipExpansionCandidate,
            address: string,
            session: MeshSession,
          ) => void
        >(),
    });

    expansion.considerAdvert(advertFor(testIdentityDeviceId, [ADDRESS_A]));

    expect(shouldExpand).not.toHaveBeenCalled();
  });

  it("never considers a device advertising no addresses -- nothing to dial", () => {
    const shouldExpand = vi.fn();
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand,
      dial: vi.fn(),
      onExpanded:
        vi.fn<
          (
            candidate: GossipExpansionCandidate,
            address: string,
            session: MeshSession,
          ) => void
        >(),
    });

    expansion.considerAdvert(advertFor(deviceA, []));

    expect(shouldExpand).not.toHaveBeenCalled();
  });

  it("reports a decline through onExpansionDeclined and never dials", async () => {
    const dial = vi.fn();
    const onExpansionDeclined =
      vi.fn<(candidate: GossipExpansionCandidate) => void>();
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand: () => false,
      dial,
      onExpanded:
        vi.fn<
          (
            candidate: GossipExpansionCandidate,
            address: string,
            session: MeshSession,
          ) => void
        >(),
      onExpansionDeclined,
    });

    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A]));
    await vi.waitFor(() => {
      expect(onExpansionDeclined).toHaveBeenCalled();
    });

    expect(dial).not.toHaveBeenCalled();
    expect(onExpansionDeclined).toHaveBeenCalledExactlyOnceWith({
      device: deviceA,
      addresses: [ADDRESS_A],
    });
  });

  it("never re-asks about a device it has already considered, even if it re-adverts", async () => {
    const shouldExpand = vi.fn().mockResolvedValue(true);
    const dial = vi.fn().mockResolvedValue(fakeSession());
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand,
      dial,
      onExpanded:
        vi.fn<
          (
            candidate: GossipExpansionCandidate,
            address: string,
            session: MeshSession,
          ) => void
        >(),
    });

    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A]));
    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A2]));
    await vi.waitFor(() => {
      expect(dial).toHaveBeenCalled();
    });

    expect(shouldExpand).toHaveBeenCalledTimes(1);
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it("tries each of a candidate's addresses in order, stopping at the first that connects", async () => {
    const session = fakeSession();
    const dial = vi
      .fn()
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValueOnce(session);
    const onExpanded =
      vi.fn<
        (
          candidate: GossipExpansionCandidate,
          address: string,
          session: MeshSession,
        ) => void
      >();
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand: () => true,
      dial,
      onExpanded,
    });

    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A, ADDRESS_A2]));
    await vi.waitFor(() => {
      expect(onExpanded).toHaveBeenCalled();
    });

    expect(dial).toHaveBeenNthCalledWith(1, ADDRESS_A);
    expect(dial).toHaveBeenNthCalledWith(2, ADDRESS_A2);
    expect(onExpanded).toHaveBeenCalledExactlyOnceWith(
      { device: deviceA, addresses: [ADDRESS_A, ADDRESS_A2] },
      ADDRESS_A2,
      session,
    );
  });

  it("reports every address's failure through onExpansionFailed once all of them fail", async () => {
    const failureA = new Error("unreachable a");
    const failureA2 = new Error("unreachable a2");
    const dial = vi
      .fn()
      .mockRejectedValueOnce(failureA)
      .mockRejectedValueOnce(failureA2);
    const onExpansionFailed =
      vi.fn<
        (candidate: GossipExpansionCandidate, errors: readonly Error[]) => void
      >();
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand: () => true,
      dial,
      onExpanded:
        vi.fn<
          (
            candidate: GossipExpansionCandidate,
            address: string,
            session: MeshSession,
          ) => void
        >(),
      onExpansionFailed,
    });

    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A, ADDRESS_A2]));
    await vi.waitFor(() => {
      expect(onExpansionFailed).toHaveBeenCalled();
    });

    expect(onExpansionFailed).toHaveBeenCalledExactlyOnceWith(
      { device: deviceA, addresses: [ADDRESS_A, ADDRESS_A2] },
      [failureA, failureA2],
    );
  });

  it("treats a rejecting shouldExpand as a failure rather than an unhandled rejection, and never dials", async () => {
    const refusal = new Error("policy check failed");
    const dial = vi.fn();
    const onExpansionFailed =
      vi.fn<
        (candidate: GossipExpansionCandidate, errors: readonly Error[]) => void
      >();
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand: async () => Promise.reject(refusal),
      dial,
      onExpanded:
        vi.fn<
          (
            candidate: GossipExpansionCandidate,
            address: string,
            session: MeshSession,
          ) => void
        >(),
      onExpansionFailed,
    });

    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A]));
    await vi.waitFor(() => {
      expect(onExpansionFailed).toHaveBeenCalled();
    });

    expect(dial).not.toHaveBeenCalled();
    expect(onExpansionFailed).toHaveBeenCalledExactlyOnceWith(
      { device: deviceA, addresses: [ADDRESS_A] },
      [refusal],
    );
  });

  it("considers two different newly-discovered devices independently", async () => {
    const shouldExpand = vi.fn().mockResolvedValue(true);
    const dial = vi.fn().mockResolvedValue(fakeSession());
    const expansion = createGossipExpansion({
      selfDeviceId: testIdentityDeviceId,
      shouldExpand,
      dial,
      onExpanded:
        vi.fn<
          (
            candidate: GossipExpansionCandidate,
            address: string,
            session: MeshSession,
          ) => void
        >(),
    });

    expansion.considerAdvert(advertFor(deviceA, [ADDRESS_A]));
    expansion.considerAdvert(advertFor(deviceB, [ADDRESS_B]));
    await vi.waitFor(() => {
      expect(dial).toHaveBeenCalledTimes(2);
    });

    expect(shouldExpand).toHaveBeenCalledWith({
      device: deviceA,
      addresses: [ADDRESS_A],
    });
    expect(shouldExpand).toHaveBeenCalledWith({
      device: deviceB,
      addresses: [ADDRESS_B],
    });
  });
});
