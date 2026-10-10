// A connection that fronts several devices (wire-mesh#311): the upstream hub's side of a gateway. Every claim a fronting connection makes about which device it acts for (relay-connect's source-device, relay-data's from-device) is honoured only for a device registered to that connection, and a relay-inbound names which of its devices was paired.

import { describe, expect, it } from "vitest";
import { createRelayHub } from "../src/domain/relay-hub.js";
import { bytesFromHex } from "./hex.js";
import {
  FakeConnection,
  createTestPeer,
  gossipForMany,
  hubVerifier,
  settle,
} from "./relay-hub-test-helpers.js";

const payload = bytesFromHex("deadbeef");

/** A hub with a gateway connection fronting two devices and one ordinary client, all settled. */
async function fixture() {
  const hub = createRelayHub({ identity: hubVerifier });
  const front1 = await createTestPeer();
  const front2 = await createTestPeer();
  const client = await createTestPeer();
  const gateway = new FakeConnection();
  const caller = new FakeConnection();
  const handling = [
    hub.handleConnection(gateway.connection),
    hub.handleConnection(caller.connection),
  ];
  gateway.push(gossipForMany(front1.advert, front2.advert));
  await settle(gateway, caller);
  caller.push(client.gossip);
  await settle(gateway, caller);
  const everyone = [gateway, caller];

  return { hub, front1, front2, client, gateway, caller, handling, everyone };
}

function relayDataSentTo(connection: Readonly<FakeConnection>) {
  return connection.sent.filter((frame) => frame.type === "relay-data");
}

describe("createRelayHub -- a connection fronting several devices", () => {
  it("tells a fronting connection which of its devices a relay-connect paired", async () => {
    const { front2, client, gateway, caller, everyone } = await fixture();

    caller.push({ type: "relay-connect", "target-device": front2.device });
    await settle(...everyone);

    expect(gateway.sent.at(-1)).toEqual({
      type: "relay-inbound",
      "source-device": client.device,
      "target-device": front2.device,
    });
  });

  it("attributes a fronted device's relay-connect to that device, not to the connection's own", async () => {
    const { front2, client, gateway, caller, everyone } = await fixture();

    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": front2.device,
    });
    await settle(...everyone);

    expect(caller.sent.at(-1)).toEqual({
      type: "relay-inbound",
      "source-device": front2.device,
      "target-device": client.device,
    });
  });

  it("ignores a relay-connect naming a source device the connection does not front", async () => {
    const { client, gateway, caller, everyone } = await fixture();
    const stranger = await createTestPeer();
    const before = caller.sent.length;

    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": stranger.device,
    });
    await settle(...everyone);

    expect(caller.sent).toHaveLength(before);
  });

  it("stamps relay-data from a fronted device with that device and delivers replies to it", async () => {
    const { front1, front2, client, gateway, caller, everyone } =
      await fixture();
    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": front1.device,
    });
    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": front2.device,
    });
    await settle(...everyone);

    gateway.push({
      type: "relay-data",
      payload,
      "to-device": client.device,
      "from-device": front2.device,
    });
    await settle(...everyone);
    expect(relayDataSentTo(caller)).toEqual([
      {
        type: "relay-data",
        payload,
        "from-device": front2.device,
        "to-device": client.device,
      },
    ]);

    caller.push({
      type: "relay-data",
      payload,
      "to-device": front1.device,
    });
    await settle(...everyone);
    expect(relayDataSentTo(gateway)).toEqual([
      {
        type: "relay-data",
        payload,
        "from-device": client.device,
        "to-device": front1.device,
      },
    ]);
  });

  it("drops relay-data claiming a device the connection does not front", async () => {
    const { front1, client, gateway, caller, everyone } = await fixture();
    const stranger = await createTestPeer();
    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": front1.device,
    });
    await settle(...everyone);

    gateway.push({
      type: "relay-data",
      payload,
      "to-device": client.device,
      "from-device": stranger.device,
    });
    await settle(...everyone);

    expect(relayDataSentTo(caller)).toEqual([]);
  });

  it("drops relay-data from a fronted device that holds no pairing with the one addressed", async () => {
    const { front1, front2, client, gateway, caller, everyone } =
      await fixture();
    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": front1.device,
    });
    await settle(...everyone);

    gateway.push({
      type: "relay-data",
      payload,
      "to-device": client.device,
      "from-device": front2.device,
    });
    await settle(...everyone);

    expect(relayDataSentTo(caller)).toEqual([]);
  });

  it("forgets every pairing a fronting connection held when it disconnects", async () => {
    const { front1, front2, client, gateway, caller, everyone, handling } =
      await fixture();
    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": front1.device,
    });
    gateway.push({
      type: "relay-connect",
      "target-device": client.device,
      "source-device": front2.device,
    });
    await settle(...everyone);

    await gateway.end();
    await settle(...everyone);
    caller.push({ type: "relay-data", payload, "to-device": front1.device });
    caller.push({ type: "relay-data", payload, "to-device": front2.device });
    await settle(...everyone);

    expect(relayDataSentTo(gateway)).toEqual([]);
    await caller.end();
    await Promise.all(handling);
  });
});
