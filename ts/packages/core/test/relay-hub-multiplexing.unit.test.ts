// relay-hub's own multi-pairing coverage: a connection holding several concurrent relay pairings at once, and the to-device addressing that disambiguates which pairing (and, per wire-mesh#170's gateway-forwarding use, which of the receiver's own several locally-fronted devices) a given relay-data frame belongs to. Split out of relay-hub.unit.test.ts under this repo's max-lines cap once the receiver-side to-device echo-through (wire-mesh#170) pushed the combined file over it.

import { describe, expect, it } from "vitest";
import { deviceIdFromFillHex, bytesFromHex } from "./hex.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import {
  FakeConnection,
  gossipFor,
  gossipForMany,
  tick,
} from "./relay-hub-test-helpers.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");
const relayPayload = bytesFromHex("deadbeef");

describe("createRelayHub -- multiplexed pairings and to-device addressing", () => {
  it("a second relay-connect from the same initiator ADDS a pairing rather than replacing the first -- both stay live and route independently", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(c.connection),
    ];

    const deviceC = deviceIdFromFillHex("44");
    a.push(gossipFor(deviceA));
    b.push(gossipFor(deviceB));
    c.push(gossipFor(deviceC));
    await tick();

    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();
    a.push({ type: "relay-connect", "target-device": deviceC });
    await tick();

    // b and c each also received the other two connections' gossip forwarded to them (own device excluded), then their own combined catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceC),
      gossipForMany(deviceA, deviceC),
      { type: "relay-inbound", "source-device": deviceA },
    ]);
    expect(c.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipForMany(deviceA, deviceB),
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    // b's relay-data (single pairing on b's own side) still reaches a -- the b<->a pairing was never torn down
    b.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(a.sent).toEqual([
      gossipFor(deviceB),
      gossipFor(deviceC),
      gossipForMany(deviceB, deviceC),
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
    ]);

    // c's relay-data reaches a too, correctly attributed and not mixed up with b's
    c.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(a.sent).toEqual([
      gossipFor(deviceB),
      gossipFor(deviceC),
      gossipForMany(deviceB, deviceC),
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
      { type: "relay-data", payload: relayPayload, "from-device": deviceC },
    ]);

    // a, holding two pairings, addresses each explicitly via to-device and both routes work independently
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": deviceB,
    });
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": deviceC,
    });
    await tick();
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceC),
      gossipForMany(deviceA, deviceC),
      { type: "relay-inbound", "source-device": deviceA },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceA,
        "to-device": deviceB,
      },
    ]);
    expect(c.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipForMany(deviceA, deviceB),
      { type: "relay-inbound", "source-device": deviceA },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceA,
        "to-device": deviceC,
      },
    ]);

    await Promise.all([a.end(), b.end(), c.end()]);
    await Promise.all(handling);
  });

  it("an initiator that was already a target keeps both pairings live when it connects out", async () => {
    const hub = createRelayHub();
    const x = new FakeConnection();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(x.connection),
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    const deviceX = deviceIdFromFillHex("55");
    x.push(gossipFor(deviceX));
    a.push(gossipFor(deviceA));
    b.push(gossipFor(deviceB));
    await tick();

    // x dials a: a becomes the target of x -> a
    x.push({ type: "relay-connect", "target-device": deviceA });
    await tick();
    // a also received x's and b's gossip forwarded to it, then its own combined catch-up, before the relay-inbound.
    expect(a.sent).toEqual([
      gossipFor(deviceX),
      gossipFor(deviceB),
      gossipForMany(deviceX, deviceB),
      { type: "relay-inbound", "source-device": deviceX },
    ]);

    // a now also initiates its own pipe to b -- the x <-> a pairing stays live alongside the new a <-> b one
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();
    // b also received x's and a's gossip forwarded to it, then its own combined catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      gossipFor(deviceX),
      gossipFor(deviceA),
      gossipForMany(deviceX, deviceA),
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    // x's data (x holds one pairing, no to-device needed) still reaches a
    x.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(a.sent).toEqual([
      gossipFor(deviceX),
      gossipFor(deviceB),
      gossipForMany(deviceX, deviceB),
      { type: "relay-inbound", "source-device": deviceX },
      { type: "relay-data", payload: relayPayload, "from-device": deviceX },
    ]);

    // a, now holding two pairings, must address b explicitly
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": deviceB,
    });
    b.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(a.sent).toEqual([
      gossipFor(deviceX),
      gossipFor(deviceB),
      gossipForMany(deviceX, deviceB),
      { type: "relay-inbound", "source-device": deviceX },
      { type: "relay-data", payload: relayPayload, "from-device": deviceX },
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
    ]);
    expect(b.sent).toEqual([
      gossipFor(deviceX),
      gossipFor(deviceA),
      gossipForMany(deviceX, deviceA),
      { type: "relay-inbound", "source-device": deviceA },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceA,
        "to-device": deviceB,
      },
    ]);

    await Promise.all([x.end(), a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("a target that was already an initiator keeps both pairings live when dialed", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const y = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(y.connection),
    ];

    const deviceY = deviceIdFromFillHex("66");
    a.push(gossipFor(deviceA));
    b.push(gossipFor(deviceB));
    y.push(gossipFor(deviceY));
    await tick();

    // b dials y: b becomes the initiator of b -> y
    b.push({ type: "relay-connect", "target-device": deviceY });
    await tick();
    // y also received a's and b's gossip forwarded to it, then its own combined catch-up, before the relay-inbound.
    expect(y.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipForMany(deviceA, deviceB),
      { type: "relay-inbound", "source-device": deviceB },
    ]);

    // a now dials b -- the b <-> y pairing stays live alongside the new a <-> b one
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();
    // b also received a's and y's gossip forwarded to it, then its own combined catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceY),
      gossipForMany(deviceA, deviceY),
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    // y's data (single pairing on y's own side) still reaches b
    y.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceY),
      gossipForMany(deviceA, deviceY),
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload, "from-device": deviceY },
    ]);

    // b, now holding two pairings, must address a explicitly
    a.push({ type: "relay-data", payload: relayPayload });
    b.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": deviceA,
    });
    await tick();
    expect(a.sent).toEqual([
      gossipFor(deviceB),
      gossipFor(deviceY),
      gossipForMany(deviceB, deviceY),
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceB,
        "to-device": deviceA,
      },
    ]);
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceY),
      gossipForMany(deviceA, deviceY),
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload, "from-device": deviceY },
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
    ]);

    await Promise.all([a.end(), b.end(), y.end()]);
    await Promise.all(handling);
  });

  it("one initiator fans out to three targets over the same relay, each attributed correctly in both directions", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    const d = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(c.connection),
      hub.handleConnection(d.connection),
    ];

    const deviceC = deviceIdFromFillHex("44");
    const deviceD = deviceIdFromFillHex("77");
    a.push(gossipFor(deviceA));
    b.push(gossipFor(deviceB));
    c.push(gossipFor(deviceC));
    d.push(gossipFor(deviceD));
    await tick();

    a.push({ type: "relay-connect", "target-device": deviceB });
    a.push({ type: "relay-connect", "target-device": deviceC });
    a.push({ type: "relay-connect", "target-device": deviceD });
    await tick();

    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": deviceB,
    });
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": deviceC,
    });
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": deviceD,
    });
    b.push({ type: "relay-data", payload: relayPayload });
    c.push({ type: "relay-data", payload: relayPayload });
    d.push({ type: "relay-data", payload: relayPayload });
    await tick();

    // Each target also received the other two targets' (and a's) gossip forwarded to it, own device excluded, then its own combined catch-up, before the relay-inbound.
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceC),
      gossipFor(deviceD),
      gossipForMany(deviceA, deviceC, deviceD),
      { type: "relay-inbound", "source-device": deviceA },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceA,
        "to-device": deviceB,
      },
    ]);
    expect(c.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipFor(deviceD),
      gossipForMany(deviceA, deviceB, deviceD),
      { type: "relay-inbound", "source-device": deviceA },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceA,
        "to-device": deviceC,
      },
    ]);
    expect(d.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipFor(deviceC),
      gossipForMany(deviceA, deviceB, deviceC),
      { type: "relay-inbound", "source-device": deviceA },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceA,
        "to-device": deviceD,
      },
    ]);
    expect(a.sent).toEqual([
      gossipFor(deviceB),
      gossipFor(deviceC),
      gossipFor(deviceD),
      gossipForMany(deviceB, deviceC, deviceD),
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
      { type: "relay-data", payload: relayPayload, "from-device": deviceC },
      { type: "relay-data", payload: relayPayload, "from-device": deviceD },
    ]);

    await Promise.all([a.end(), b.end(), c.end(), d.end()]);
    await Promise.all(handling);
  });
});
