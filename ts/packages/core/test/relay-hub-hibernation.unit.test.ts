// Surviving the hub instance: a host that is torn down while its connections stay open (the Cloudflare hub's hibernating Durable Object) has to carry each connection's relay state across the gap itself. These tests drive that path directly: establish state on one hub, export it, then hand it plus the same Connection objects to a second hub that has never seen either, exactly what the runtime does when it evicts a Durable Object and later re-runs its constructor with the sockets still attached.

import { describe, expect, it } from "vitest";
import type { Connection } from "../src/ports/transport.js";
import {
  createRelayHub,
  type RelayConnectionRestore,
  type RelayHub,
} from "../src/domain/relay-hub.js";
import { bytesFromHex } from "./hex.js";
import {
  FIXTURE_SNAPSHOT_SECONDS,
  FakeConnection,
  createTestPeer,
  hubVerifier,
  peerAdvertFor,
  type TestPeer,
} from "./relay-hub-test-helpers.js";

/** One second after the fixture snapshot: the smallest advert that strictly supersedes a fixture peer's own, since a takeover by a different connection needs a strictly greater snapshot-seconds. */
const NEWER_SNAPSHOT_SECONDS = FIXTURE_SNAPSHOT_SECONDS + 1;
const relayPayload = bytesFromHex("deadbeef");

/** Establishes the production pairing shape on a hub: both sides gossip, then a dials b. Returns the stable Connection objects, since FakeConnection's own getter hands back a fresh object on every access. */
async function pairOver(
  hub: Readonly<RelayHub>,
  a: FakeConnection,
  peerA: TestPeer,
  b: FakeConnection,
  peerB: TestPeer,
): Promise<{ aConnection: Connection; bConnection: Connection }> {
  const aConnection = a.connection;
  const bConnection = b.connection;
  hub.registerConnection(aConnection);
  hub.registerConnection(bConnection);
  await hub.onFrame(aConnection, peerA.gossip);
  await hub.onFrame(bConnection, peerB.gossip);
  await hub.onFrame(aConnection, {
    type: "relay-connect",
    "target-device": peerB.device,
  });
  return { aConnection, bConnection };
}

/** What a host does on wake: a hub that has never seen these connections, handed the state the previous instance exported for each. */
function wokenHubOver(
  entries: readonly RelayConnectionRestore[],
): ReturnType<typeof createRelayHub> {
  const hub = createRelayHub({ identity: hubVerifier });
  hub.restoreConnections(entries);
  return hub;
}

function restoreEntryFor(
  hub: Readonly<RelayHub>,
  connection: Connection,
): RelayConnectionRestore {
  const state = hub.exportConnection(connection);
  if (state === undefined) {
    throw new Error("connection has no exportable relay state");
  }
  return { connection, state };
}

describe("relay state across a hub instance being torn down", () => {
  it("delivers relay-data on a pairing established before the instance was replaced", async () => {
    const established = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const { aConnection, bConnection } = await pairOver(
      established,
      a,
      peerA,
      b,
      peerB,
    );

    const woken = wokenHubOver([
      restoreEntryFor(established, aConnection),
      restoreEntryFor(established, bConnection),
    ]);
    a.sent.length = 0;
    b.sent.length = 0;

    await woken.onFrame(bConnection, {
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerA.device,
    });

    expect(a.sent).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
        "to-device": peerA.device,
      },
    ]);
  });

  it("routes an unaddressed relay-data frame to the restored most recent pairing", async () => {
    const established = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const peerC = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    const aConnection = a.connection;
    const bConnection = b.connection;
    const cConnection = c.connection;
    for (const connection of [aConnection, bConnection, cConnection]) {
      established.registerConnection(connection);
    }
    await established.onFrame(aConnection, peerA.gossip);
    await established.onFrame(bConnection, peerB.gossip);
    await established.onFrame(cConnection, peerC.gossip);
    await established.onFrame(aConnection, {
      type: "relay-connect",
      "target-device": peerB.device,
    });
    await established.onFrame(aConnection, {
      type: "relay-connect",
      "target-device": peerC.device,
    });

    const woken = wokenHubOver([
      restoreEntryFor(established, aConnection),
      restoreEntryFor(established, bConnection),
      restoreEntryFor(established, cConnection),
    ]);
    b.sent.length = 0;
    c.sent.length = 0;

    await woken.onFrame(aConnection, {
      type: "relay-data",
      payload: relayPayload,
    });

    expect(b.sent).toEqual([]);
    expect(c.sent).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
      },
    ]);
  });

  it("answers a relay-connect naming a device restored from an earlier instance's directory", async () => {
    const established = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const aConnection = a.connection;
    const bConnection = b.connection;
    established.registerConnection(aConnection);
    established.registerConnection(bConnection);
    await established.onFrame(aConnection, peerA.gossip);
    await established.onFrame(bConnection, peerB.gossip);

    const woken = wokenHubOver([
      restoreEntryFor(established, aConnection),
      restoreEntryFor(established, bConnection),
    ]);
    b.sent.length = 0;

    await woken.onFrame(aConnection, {
      type: "relay-connect",
      "target-device": peerB.device,
    });

    expect(b.sent).toEqual([
      { type: "relay-inbound", "source-device": peerA.device },
    ]);
  });

  it("drops a pairing whose peer did not survive, rather than restoring half of it", async () => {
    const established = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const { aConnection } = await pairOver(established, a, peerA, b, peerB);

    const woken = wokenHubOver([restoreEntryFor(established, aConnection)]);
    a.sent.length = 0;
    b.sent.length = 0;

    await woken.onFrame(aConnection, {
      type: "relay-data",
      payload: relayPayload,
    });

    expect(b.sent).toEqual([]);
  });

  it("exports nothing for a connection that has not gossiped an advert", () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const connection = new FakeConnection().connection;
    hub.registerConnection(connection);

    expect(hub.exportConnection(connection)).toBeUndefined();
  });

  it("exports the device, its adverts and its pairings once both are established", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const { aConnection } = await pairOver(hub, a, peerA, b, peerB);

    expect(hub.exportConnection(aConnection)).toEqual({
      device: peerA.device,
      adverts: [peerA.advert],
      pairedDevices: [peerB.device],
      mostRecentDevice: peerB.device,
    });
  });
});

describe("onConnectionStateChanged", () => {
  it("reports both sides of a new pairing and every peer of a departing connection", async () => {
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const changed: Connection[] = [];
    const hub = createRelayHub({
      identity: hubVerifier,
      onConnectionStateChanged: (connection) => {
        changed.push(connection);
      },
    });
    const a = new FakeConnection();
    const b = new FakeConnection();
    const { aConnection, bConnection } = await pairOver(
      hub,
      a,
      peerA,
      b,
      peerB,
    );

    // Two gossip frames, then the relay-connect reporting the initiator and the target.
    expect(changed).toEqual([
      aConnection,
      bConnection,
      aConnection,
      bConnection,
    ]);

    changed.length = 0;
    hub.onDisconnect(aConnection);

    expect(changed).toEqual([bConnection]);
    expect(hub.exportConnection(bConnection)).toEqual({
      device: peerB.device,
      adverts: [peerB.advert],
      pairedDevices: [],
    });
  });

  it("reports the connection an advert is taken away from as well as the one claiming it", async () => {
    const peerA = await createTestPeer();
    const newerAdvertA = await peerAdvertFor(
      peerA.identity,
      NEWER_SNAPSHOT_SECONDS,
    );
    const changed: Connection[] = [];
    const hub = createRelayHub({
      identity: hubVerifier,
      onConnectionStateChanged: (connection) => {
        changed.push(connection);
      },
    });
    const first = new FakeConnection().connection;
    const second = new FakeConnection().connection;
    hub.registerConnection(first);
    hub.registerConnection(second);
    await hub.onFrame(first, peerA.gossip);

    changed.length = 0;
    await hub.onFrame(second, { type: "gossip", peers: [newerAdvertA] });

    expect(changed).toEqual([second, first]);
    expect(hub.exportConnection(first)).toEqual({
      device: peerA.device,
      adverts: [],
      pairedDevices: [],
    });
  });
});
