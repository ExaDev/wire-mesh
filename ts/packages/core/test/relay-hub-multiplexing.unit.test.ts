// relay-hub's own multi-pairing coverage: a connection holding several concurrent relay pairings at once, and the to-device addressing that disambiguates which pairing (and, per wire-mesh#170's gateway-forwarding use, which of the receiver's own several locally-fronted devices) a given relay-data frame belongs to. Split out of relay-hub.unit.test.ts under this repo's max-lines cap once the receiver-side to-device echo-through (wire-mesh#170) pushed the combined file over it.

import { describe, expect, it } from "vitest";
import { bytesFromHex } from "./hex.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import type { Frame, PeerAdvert } from "../src/generated/protocol.js";
import {
  FakeConnection,
  createTestPeer,
  gossipFor,
  gossipForMany,
  hubVerifier,
  settle,
  type TestPeer,
} from "./relay-hub-test-helpers.js";

const relayPayload = bytesFromHex("deadbeef");

/** A fixture peer together with the connection that gossips it. */
interface Member {
  readonly peer: TestPeer;
  readonly connection: FakeConnection;
}

/** Gossips each member's advert in the order given, settling after each so every advert has been verified and applied before the next reaches the hub. The hub verifies before it registers, so simultaneous pushes would race and leave the registration order, and with it every catch-up frame, undetermined. */
async function gossipInOrder(members: readonly Member[]): Promise<void> {
  const connections = members.map((member) => member.connection);
  for (const member of members) {
    member.connection.push(member.peer.gossip);
    await settle(...connections);
  }
}

/**
 * The gossip frames a member is sent while gossipInOrder runs: the forwarded advert of each member that gossips before it, then its own catch-up (one frame bundling all of those) when any did, then the forwarded advert of each member that gossips after it. Its own advert is never sent back to it.
 */
function gossipReceivedBy(
  own: Readonly<PeerAdvert>,
  adverts: readonly PeerAdvert[],
): Frame[] {
  const index = adverts.indexOf(own);
  const before = adverts.slice(0, index);
  const after = adverts.slice(index + 1);
  return [
    ...before.map((advert) => gossipFor(advert)),
    ...(before.length > 0 ? [gossipForMany(...before)] : []),
    ...after.map((advert) => gossipFor(advert)),
  ];
}

describe("createRelayHub -- multiplexed pairings and to-device addressing", () => {
  it("a second relay-connect from the same initiator ADDS a pairing rather than replacing the first -- both stay live and route independently", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const peerC = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    const everyone = [a, b, c];
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(c.connection),
    ];
    const adverts = [peerA.advert, peerB.advert, peerC.advert];

    await gossipInOrder([
      { peer: peerA, connection: a },
      { peer: peerB, connection: b },
      { peer: peerC, connection: c },
    ]);

    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(...everyone);
    a.push({ type: "relay-connect", "target-device": peerC.device });
    await settle(...everyone);

    // b and c each also received the other two connections' gossip forwarded to them (own device excluded) and their own combined catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
    ]);
    expect(c.sent).toEqual([
      ...gossipReceivedBy(peerC.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
    ]);

    // b's relay-data (single pairing on b's own side) still reaches a -- the b<->a pairing was never torn down
    b.push({ type: "relay-data", payload: relayPayload });
    await settle(...everyone);
    expect(a.sent).toEqual([
      ...gossipReceivedBy(peerA.advert, adverts),
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
      },
    ]);

    // c's relay-data reaches a too, correctly attributed and not mixed up with b's
    c.push({ type: "relay-data", payload: relayPayload });
    await settle(...everyone);
    expect(a.sent).toEqual([
      ...gossipReceivedBy(peerA.advert, adverts),
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
      },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerC.device,
      },
    ]);

    // a, holding two pairings, addresses each explicitly via to-device and both routes work independently
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerB.device,
    });
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerC.device,
    });
    await settle(...everyone);
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
        "to-device": peerB.device,
      },
    ]);
    expect(c.sent).toEqual([
      ...gossipReceivedBy(peerC.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
        "to-device": peerC.device,
      },
    ]);

    await Promise.all([a.end(), b.end(), c.end()]);
    await Promise.all(handling);
  });

  it("an initiator that was already a target keeps both pairings live when it connects out", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerX = await createTestPeer();
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const x = new FakeConnection();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const everyone = [x, a, b];
    const handling = [
      hub.handleConnection(x.connection),
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];
    const adverts = [peerX.advert, peerA.advert, peerB.advert];

    await gossipInOrder([
      { peer: peerX, connection: x },
      { peer: peerA, connection: a },
      { peer: peerB, connection: b },
    ]);

    // x dials a: a becomes the target of x -> a
    x.push({ type: "relay-connect", "target-device": peerA.device });
    await settle(...everyone);
    // a also received x's and b's gossip forwarded to it and its own catch-up, before the relay-inbound.
    expect(a.sent).toEqual([
      ...gossipReceivedBy(peerA.advert, adverts),
      { type: "relay-inbound", "source-device": peerX.device },
    ]);

    // a now also initiates its own pipe to b -- the x <-> a pairing stays live alongside the new a <-> b one
    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(...everyone);
    // b also received x's and a's gossip forwarded to it and its own catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
    ]);

    // x's data (x holds one pairing, no to-device needed) still reaches a
    x.push({ type: "relay-data", payload: relayPayload });
    await settle(...everyone);
    expect(a.sent).toEqual([
      ...gossipReceivedBy(peerA.advert, adverts),
      { type: "relay-inbound", "source-device": peerX.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerX.device,
      },
    ]);

    // a, now holding two pairings, must address b explicitly
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerB.device,
    });
    b.push({ type: "relay-data", payload: relayPayload });
    await settle(...everyone);
    expect(a.sent).toEqual([
      ...gossipReceivedBy(peerA.advert, adverts),
      { type: "relay-inbound", "source-device": peerX.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerX.device,
      },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
      },
    ]);
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
        "to-device": peerB.device,
      },
    ]);

    await Promise.all([x.end(), a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("a target that was already an initiator keeps both pairings live when dialed", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const peerY = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const y = new FakeConnection();
    const everyone = [a, b, y];
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(y.connection),
    ];
    const adverts = [peerA.advert, peerB.advert, peerY.advert];

    await gossipInOrder([
      { peer: peerA, connection: a },
      { peer: peerB, connection: b },
      { peer: peerY, connection: y },
    ]);

    // b dials y: b becomes the initiator of b -> y
    b.push({ type: "relay-connect", "target-device": peerY.device });
    await settle(...everyone);
    // y also received a's and b's gossip forwarded to it and its own catch-up, before the relay-inbound.
    expect(y.sent).toEqual([
      ...gossipReceivedBy(peerY.advert, adverts),
      { type: "relay-inbound", "source-device": peerB.device },
    ]);

    // a now dials b -- the b <-> y pairing stays live alongside the new a <-> b one
    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(...everyone);
    // b also received a's and y's gossip forwarded to it and its own catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
    ]);

    // y's data (single pairing on y's own side) still reaches b
    y.push({ type: "relay-data", payload: relayPayload });
    await settle(...everyone);
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerY.device,
      },
    ]);

    // b, now holding two pairings, must address a explicitly
    a.push({ type: "relay-data", payload: relayPayload });
    b.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerA.device,
    });
    await settle(...everyone);
    expect(a.sent).toEqual([
      ...gossipReceivedBy(peerA.advert, adverts),
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
        "to-device": peerA.device,
      },
    ]);
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerY.device,
      },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
      },
    ]);

    await Promise.all([a.end(), b.end(), y.end()]);
    await Promise.all(handling);
  });

  it("one initiator fans out to three targets over the same relay, each attributed correctly in both directions", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const peerC = await createTestPeer();
    const peerD = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    const d = new FakeConnection();
    const everyone = [a, b, c, d];
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(c.connection),
      hub.handleConnection(d.connection),
    ];
    const adverts = [peerA.advert, peerB.advert, peerC.advert, peerD.advert];

    await gossipInOrder([
      { peer: peerA, connection: a },
      { peer: peerB, connection: b },
      { peer: peerC, connection: c },
      { peer: peerD, connection: d },
    ]);

    a.push({ type: "relay-connect", "target-device": peerB.device });
    a.push({ type: "relay-connect", "target-device": peerC.device });
    a.push({ type: "relay-connect", "target-device": peerD.device });
    await settle(...everyone);

    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerB.device,
    });
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerC.device,
    });
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerD.device,
    });
    b.push({ type: "relay-data", payload: relayPayload });
    c.push({ type: "relay-data", payload: relayPayload });
    d.push({ type: "relay-data", payload: relayPayload });
    await settle(...everyone);

    // Each target also received the other targets' (and a's) gossip forwarded to it, own device excluded, and its own combined catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      ...gossipReceivedBy(peerB.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
        "to-device": peerB.device,
      },
    ]);
    expect(c.sent).toEqual([
      ...gossipReceivedBy(peerC.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
        "to-device": peerC.device,
      },
    ]);
    expect(d.sent).toEqual([
      ...gossipReceivedBy(peerD.advert, adverts),
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
        "to-device": peerD.device,
      },
    ]);
    expect(a.sent).toEqual([
      ...gossipReceivedBy(peerA.advert, adverts),
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
      },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerC.device,
      },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerD.device,
      },
    ]);

    await Promise.all([a.end(), b.end(), c.end(), d.end()]);
    await Promise.all(handling);
  });
});
