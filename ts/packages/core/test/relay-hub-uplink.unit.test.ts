// Two hubs joined by an uplink (wire-mesh#311): a client behind the gateway hub and a device on the upstream hub reach each other through relay-connect and relay-data, each end seeing the other's own device-id and never the gateway's.

import { describe, expect, it } from "vitest";
import { createRelayHub, type RelayHub } from "../src/domain/relay-hub.js";
import type { Frame } from "../src/generated/protocol.js";
import { bytesFromHex } from "./hex.js";
import {
  FakeConnection,
  createTestPeer,
  hubVerifier,
  linkedConnections,
  settle,
  type LinkedConnections,
  type TestPeer,
} from "./relay-hub-test-helpers.js";

const toUpstream = bytesFromHex("c0ffee");
const toGateway = bytesFromHex("facade");

interface Topology {
  readonly gateway: RelayHub;
  readonly upstream: RelayHub;
  readonly link: LinkedConnections;
  readonly behind: TestPeer;
  readonly behindConnection: FakeConnection;
  readonly beyond: TestPeer;
  readonly beyondConnection: FakeConnection;
  readonly everyone: readonly FakeConnection[];
  readonly handling: readonly Promise<void>[];
}

/** One client on each hub, both gossiped and fully propagated across the uplink. */
async function topology(): Promise<Topology> {
  const gateway = createRelayHub({ identity: hubVerifier });
  const upstream = createRelayHub({ identity: hubVerifier });
  const link = linkedConnections();
  const behind = await createTestPeer();
  const beyond = await createTestPeer();
  const behindConnection = new FakeConnection();
  const beyondConnection = new FakeConnection();
  const everyone = [
    link.gateway,
    link.upstream,
    behindConnection,
    beyondConnection,
  ];
  const handling = [
    gateway.handleUplink(link.gatewayConnection),
    upstream.handleConnection(link.upstreamConnection),
    gateway.handleConnection(behindConnection.connection),
    upstream.handleConnection(beyondConnection.connection),
  ];
  beyondConnection.push(beyond.gossip);
  await settle(...everyone);
  behindConnection.push(behind.gossip);
  await settle(...everyone);

  return {
    gateway,
    upstream,
    link,
    behind,
    behindConnection,
    beyond,
    beyondConnection,
    everyone,
    handling,
  };
}

function relayData(connection: Readonly<FakeConnection>): Frame[] {
  return connection.sent.filter((frame) => frame.type === "relay-data");
}

describe("createRelayHub -- fronting its clients over an uplink", () => {
  it("lets each side see the other's directory entries", async () => {
    const { behind, beyond, behindConnection, beyondConnection } =
      await topology();

    expect(behindConnection.sent).toContainEqual({
      type: "gossip",
      peers: [beyond.advert],
    });
    expect(beyondConnection.sent).toContainEqual({
      type: "gossip",
      peers: [behind.advert],
    });
  });

  it("pairs a client behind the gateway with an upstream device and carries data both ways with true device-ids", async () => {
    const { behind, beyond, behindConnection, beyondConnection, everyone } =
      await topology();

    behindConnection.push({
      type: "relay-connect",
      "target-device": beyond.device,
    });
    await settle(...everyone);
    expect(beyondConnection.sent.at(-1)).toEqual({
      type: "relay-inbound",
      "source-device": behind.device,
      "target-device": beyond.device,
    });

    behindConnection.push({
      type: "relay-data",
      payload: toUpstream,
      "to-device": beyond.device,
    });
    await settle(...everyone);
    expect(relayData(beyondConnection)).toEqual([
      {
        type: "relay-data",
        payload: toUpstream,
        "from-device": behind.device,
        "to-device": beyond.device,
      },
    ]);

    beyondConnection.push({
      type: "relay-data",
      payload: toGateway,
      "to-device": behind.device,
    });
    await settle(...everyone);
    expect(relayData(behindConnection)).toEqual([
      {
        type: "relay-data",
        payload: toGateway,
        "from-device": beyond.device,
        "to-device": behind.device,
      },
    ]);
  });

  it("pairs an upstream device with a client behind the gateway, telling the client which device connected", async () => {
    const { behind, beyond, behindConnection, beyondConnection, everyone } =
      await topology();

    beyondConnection.push({
      type: "relay-connect",
      "target-device": behind.device,
    });
    await settle(...everyone);
    expect(behindConnection.sent.at(-1)).toEqual({
      type: "relay-inbound",
      "source-device": beyond.device,
      "target-device": behind.device,
    });

    beyondConnection.push({
      type: "relay-data",
      payload: toGateway,
      "to-device": behind.device,
    });
    behindConnection.push({
      type: "relay-data",
      payload: toUpstream,
      "to-device": beyond.device,
    });
    await settle(...everyone);
    expect(relayData(behindConnection)).toEqual([
      {
        type: "relay-data",
        payload: toGateway,
        "from-device": beyond.device,
        "to-device": behind.device,
      },
    ]);
    expect(relayData(beyondConnection)).toEqual([
      {
        type: "relay-data",
        payload: toUpstream,
        "from-device": behind.device,
        "to-device": beyond.device,
      },
    ]);
  });

  it("keeps two clients behind the gateway apart when both talk to the same upstream device", async () => {
    const { beyond, behindConnection, beyondConnection, everyone, gateway } =
      await topology();
    const second = await createTestPeer();
    const secondConnection = new FakeConnection();
    void gateway.handleConnection(secondConnection.connection);
    secondConnection.push(second.gossip);
    await settle(...everyone, secondConnection);

    secondConnection.push({
      type: "relay-connect",
      "target-device": beyond.device,
    });
    await settle(...everyone, secondConnection);
    beyondConnection.push({
      type: "relay-data",
      payload: toGateway,
      "to-device": second.device,
    });
    await settle(...everyone, secondConnection);

    expect(relayData(secondConnection)).toHaveLength(1);
    expect(relayData(behindConnection)).toEqual([]);
  });

  it("does not let two hubs re-announce the same adverts to each other without end", async () => {
    const { link, everyone } = await topology();
    const sentOnLink = (): number =>
      link.gateway.sent.length + link.upstream.sent.length;
    const settled = sentOnLink();

    await settle(...everyone);
    await settle(...everyone);

    expect(sentOnLink()).toBe(settled);
  });

  it("announces adverts registered before the uplink attached", async () => {
    const gateway = createRelayHub({ identity: hubVerifier });
    const upstream = createRelayHub({ identity: hubVerifier });
    const link = linkedConnections();
    const early = await createTestPeer();
    const earlyConnection = new FakeConnection();
    void gateway.handleConnection(earlyConnection.connection);
    earlyConnection.push(early.gossip);
    await settle(earlyConnection);

    void upstream.handleConnection(link.upstreamConnection);
    void gateway.handleUplink(link.gatewayConnection);
    await settle(link.gateway, link.upstream, earlyConnection);

    expect(link.gateway.sent).toContainEqual({
      type: "gossip",
      peers: [early.advert],
    });
  });

  it("refuses a second uplink while one is attached, and accepts a new one after the first ends", async () => {
    const { gateway, link, behind, behindConnection, handling } =
      await topology();
    const other = linkedConnections();

    await expect(gateway.handleUplink(other.gatewayConnection)).rejects.toThrow(
      "already has an uplink",
    );

    await link.end();
    await handling[0];
    const replacement = linkedConnections();
    const upstream = createRelayHub({ identity: hubVerifier });
    void upstream.handleConnection(replacement.upstreamConnection);
    const reattached = gateway.handleUplink(replacement.gatewayConnection);
    await settle(replacement.gateway, replacement.upstream, behindConnection);

    expect(replacement.gateway.sent).toContainEqual({
      type: "gossip",
      peers: [behind.advert],
    });
    await replacement.end();
    await reattached;
  });

  it("forgets pairings carried over an uplink once it drops", async () => {
    const { beyond, behindConnection, beyondConnection, everyone, link } =
      await topology();
    behindConnection.push({
      type: "relay-connect",
      "target-device": beyond.device,
    });
    await settle(...everyone);

    await link.end();
    await settle(...everyone);
    const before = relayData(beyondConnection).length;
    const upstreamBefore = link.gateway.sent.length;
    behindConnection.push({
      type: "relay-data",
      payload: toUpstream,
      "to-device": beyond.device,
    });
    await settle(...everyone);

    expect(relayData(beyondConnection)).toHaveLength(before);
    expect(link.gateway.sent).toHaveLength(upstreamBefore);
  });

  it("ignores a relay-inbound from a connection that is not the uplink", async () => {
    const { behind, beyond, behindConnection, beyondConnection, everyone } =
      await topology();
    const before = behindConnection.sent.length;

    beyondConnection.push({
      type: "relay-inbound",
      "source-device": beyond.device,
      "target-device": behind.device,
    });
    await settle(...everyone);

    expect(behindConnection.sent).toHaveLength(before);
  });
});
