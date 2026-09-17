import { describe, expect, it, vi } from "vitest";
import type { Frame } from "../src/generated/protocol.js";
import type { Connection } from "../src/ports/transport.js";
import {
  createGatedRelayFrameHandler,
  createRelayUseAuthorizationTracker,
} from "../src/domain/relay-use-gate.js";
import { deviceIdFromFillHex } from "./hex.js";

const deviceB = deviceIdFromFillHex("22");

function fakeConnection(): Readonly<Connection> {
  return {
    send: vi.fn(async (): Promise<void> => Promise.resolve()),
    receive: () => {
      throw new Error("not used in these tests");
    },
    close: vi.fn(async (): Promise<void> => Promise.resolve()),
  };
}

describe("createRelayUseAuthorizationTracker", () => {
  it("reports a connection as unauthorized until authorize() is called for it", () => {
    const tracker = createRelayUseAuthorizationTracker();
    const connection = fakeConnection();

    expect(tracker.isAuthorized(connection)).toBe(false);
    tracker.authorize(connection);
    expect(tracker.isAuthorized(connection)).toBe(true);
  });

  it("tracks connections independently -- authorizing one never authorizes another", () => {
    const tracker = createRelayUseAuthorizationTracker();
    const a = fakeConnection();
    const b = fakeConnection();

    tracker.authorize(a);

    expect(tracker.isAuthorized(a)).toBe(true);
    expect(tracker.isAuthorized(b)).toBe(false);
  });

  it("revoke() removes a connection's own authorization", () => {
    const tracker = createRelayUseAuthorizationTracker();
    const connection = fakeConnection();
    tracker.authorize(connection);

    tracker.revoke(connection);

    expect(tracker.isAuthorized(connection)).toBe(false);
  });
});

describe("createGatedRelayFrameHandler", () => {
  it("passes every frame through to the wrapped hub when the connection is authorized", async () => {
    const hubOnFrame = vi.fn(async (): Promise<void> => Promise.resolve());
    const connection = fakeConnection();
    const gated = createGatedRelayFrameHandler({
      onFrame: hubOnFrame,
      isAuthorized: () => true,
    });

    const frame: Frame = { type: "relay-connect", "target-device": deviceB };
    await gated(connection, frame);

    expect(hubOnFrame).toHaveBeenCalledWith(connection, frame);
  });

  it("silently drops a relay-connect from an unauthorized connection, never reaching the wrapped hub", async () => {
    const hubOnFrame = vi.fn(async (): Promise<void> => Promise.resolve());
    const connection = fakeConnection();
    const gated = createGatedRelayFrameHandler({
      onFrame: hubOnFrame,
      isAuthorized: () => false,
    });

    await gated(connection, {
      type: "relay-connect",
      "target-device": deviceB,
    });

    expect(hubOnFrame).not.toHaveBeenCalled();
  });

  it("passes gossip frames through regardless of relay:use authorization -- gating is scoped to relay-connect only, not the whole frame stream", async () => {
    const hubOnFrame = vi.fn(async (): Promise<void> => Promise.resolve());
    const connection = fakeConnection();
    const gated = createGatedRelayFrameHandler({
      onFrame: hubOnFrame,
      isAuthorized: () => false,
    });

    const gossip: Frame = {
      type: "gossip",
      peers: [{ device: deviceB, addresses: [], "snapshot-seconds": 0 }],
    };
    await gated(connection, gossip);

    expect(hubOnFrame).toHaveBeenCalledWith(connection, gossip);
  });

  it("passes relay-data frames through regardless of authorization -- they can only act within a pairing that already required an authorized relay-connect to establish", async () => {
    const hubOnFrame = vi.fn(async (): Promise<void> => Promise.resolve());
    const connection = fakeConnection();
    const gated = createGatedRelayFrameHandler({
      onFrame: hubOnFrame,
      isAuthorized: () => false,
    });

    const relayData: Frame = { type: "relay-data", payload: new Uint8Array() };
    await gated(connection, relayData);

    expect(hubOnFrame).toHaveBeenCalledWith(connection, relayData);
  });
});
