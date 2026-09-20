import { describe, expect, it } from "vitest";
import type {
  CapabilityScope,
  ManageCommand,
} from "../src/generated/protocol.js";
import {
  acceptMeshSession,
  createMeshSession,
} from "../src/domain/mesh-session.js";
import {
  FakeConnection,
  deviceA,
  deviceB,
  fakeTransport,
  gossipFor,
  identityB,
  identityC,
  nthEvent,
  testClock,
  testIdentity,
} from "./mesh-session-fixtures.js";

describe("MeshSession.getTopologyPeers", () => {
  const testCommand: ManageCommand = {
    verb: "exec:proc",
    params: { verb: "exec.list" },
  };
  const testScope: CapabilityScope = { kind: "folder" };

  // Events since session start: connecting, connected, self-advert sent.
  const EVENTS_THROUGH_CONNECT = 3;
  // Incremental events one gossip frame received produces on top of EVENTS_THROUGH_CONNECT.
  const EVENTS_PER_GOSSIP = 1;
  // Events an accepted session emits up to and including the one its first received gossip frame produces: connected, self-advert sent, then that frame's own. Counting through the frame rather than taking the first buffered event matters because the session verifies an advert's signature before applying it, so the directory and topology only reflect the frame once its event has fired.
  const EVENTS_THROUGH_ACCEPTED_GOSSIP = 3;
  // Incremental events a fresh-target sendManageRequest produces on top of EVENTS_THROUGH_CONNECT: relay-connect-sent, relay-data-sent.
  const EVENTS_PER_NEW_RELAY_PAIRING = 2;

  it("reports no direct peer and no relay pairings before anything is known", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    expect(session.getTopologyPeers()).toEqual({ direct: [], relayed: [] });
    await session.close();
  });

  it("reports the transport-authenticated peer as its direct connection", async () => {
    const { transport } = fakeTransport(deviceA);
    const session = createMeshSession(transport, testIdentity, testClock);
    await session.connect("ws://node", ["core/management"]);
    expect(session.getTopologyPeers()).toEqual({
      direct: [deviceA],
      relayed: [],
    });
    await session.close();
  });

  it("attributes a relay pairing to the transport-authenticated hub via `via`", async () => {
    const { transport } = fakeTransport(deviceA);
    const session = createMeshSession(transport, testIdentity, testClock);
    const connectDone = nthEvent(session, EVENTS_THROUGH_CONNECT);
    await session.connect("ws://node", ["core/management"]);
    await connectDone;
    const pairingDone = nthEvent(session, EVENTS_PER_NEW_RELAY_PAIRING);
    const pending = session.sendManageRequest(testCommand, testScope, deviceB);
    await pairingDone;

    expect(session.getTopologyPeers()).toEqual({
      direct: [deviceA],
      relayed: [{ device: deviceB, via: deviceA }],
    });
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("omits `via` for a relay pairing held through an anonymous hub with no known device-id", async () => {
    const { transport } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const connectDone = nthEvent(session, EVENTS_THROUGH_CONNECT);
    await session.connect("ws://node", ["core/management"]);
    await connectDone;
    const pairingDone = nthEvent(session, EVENTS_PER_NEW_RELAY_PAIRING);
    const pending = session.sendManageRequest(testCommand, testScope, deviceB);
    await pairingDone;

    expect(session.getTopologyPeers()).toEqual({
      direct: [],
      relayed: [{ device: deviceB }],
    });
    await session.close();
    await expect(pending).rejects.toThrow();
  });

  it("does not treat a gossip-forwarded third-party advert as its own direct peer on the dial side", async () => {
    // Regression test for the exact ambiguity AcceptedMeshSession's own peerDeviceId doc comment flags: a dial-side session may be talking to a relay hub that forwards another device's advert as gossip catch-up before ever advertising an identity of its own (a bare, anonymous RelayHub never does). The "first advert wins" heuristic is only sound for an accepted connection, never here.
    const { transport, connection } = fakeTransport();
    const session = createMeshSession(transport, testIdentity, testClock);
    const connectDone = nthEvent(session, EVENTS_THROUGH_CONNECT);
    await session.connect("ws://node", ["core/management"]);
    await connectDone;
    const gossip = await gossipFor(identityC);
    const gossipDone = nthEvent(session, EVENTS_PER_GOSSIP);
    connection.push(gossip);
    await gossipDone;

    expect(session.getTopologyPeers().direct).toEqual([]);
    await session.close();
  });

  it("reports the accepted connection's own first-advertised device as its direct peer", async () => {
    const fake = new FakeConnection();
    const session = await acceptMeshSession(fake.connection, testIdentity, [
      "core/management",
    ]);
    const gossip = await gossipFor(identityB);
    const gossipDone = nthEvent(session, EVENTS_THROUGH_ACCEPTED_GOSSIP);
    fake.push(gossip);
    await gossipDone;

    expect(session.getTopologyPeers()).toEqual({
      direct: [deviceB],
      relayed: [],
    });
    await session.close();
  });

  it("merges the live topology/peers value into every subsequent sendGossipUpdate, not just the connect-time self-advert", async () => {
    const { transport, connection } = fakeTransport(deviceA);
    const session = createMeshSession(transport, testIdentity, testClock);
    const connectDone = nthEvent(session, EVENTS_THROUGH_CONNECT);
    await session.connect("ws://node", ["core/management"]);
    await connectDone;
    const pairingDone = nthEvent(session, EVENTS_PER_NEW_RELAY_PAIRING);
    const pending = session.sendManageRequest(testCommand, testScope, deviceB);
    await pairingDone;

    await session.sendGossipUpdate();

    const sent = connection.sent.at(-1) as {
      peers: { "topology/peers"?: unknown }[];
    };
    expect(sent.peers[0]?.["topology/peers"]).toEqual({
      direct: [deviceA],
      relayed: [{ device: deviceB, via: deviceA }],
    });
    await session.close();
    await expect(pending).rejects.toThrow();
  });
});
