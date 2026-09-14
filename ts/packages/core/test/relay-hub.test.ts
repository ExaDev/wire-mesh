import { describe, expect, it } from "vitest";
import type { DeviceId, Frame, PeerAdvert } from "../src/generated/protocol.js";
import type { Connection } from "../src/ports/transport.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import { deviceIdFromFillHex, bytesFromHex } from "./hex.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");
const relayPayload = bytesFromHex("deadbeef");
const orphanPayload = bytesFromHex("aa");

/** One macrotask turn, letting the hub drain frames already queued on its connections. */
async function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** An in-memory Connection driving the hub through the port contract: queued inbound frames the test pushes, and a record of everything the hub sends back. */
class FakeConnection {
  inbound: Frame[] = [];
  sent: Frame[] = [];
  /** When set, every subsequent send() rejects with this error instead of recording the frame -- simulates a peer whose own connection has died from the hub's perspective, without needing a second connection class. */
  sendRejection: Error | null = null;
  private closed = false;
  private readonly wakeWaiters: (() => void)[] = [];

  get connection(): Readonly<Connection> {
    return {
      send: async (frame: Frame): Promise<void> => {
        if (this.sendRejection) {
          throw this.sendRejection;
        }
        this.sent.push(frame);
        return Promise.resolve();
      },
      receive: () => this.stream(),
      close: async (): Promise<void> => {
        this.closed = true;
        this.wake();
        return Promise.resolve();
      },
    };
  }

  push(frame: Frame): void {
    this.inbound.push(frame);
    this.wake();
  }

  /** Ends the inbound stream (simulating disconnect) while leaving sent readable. */
  async end(): Promise<void> {
    this.closed = true;
    this.wake();
    return Promise.resolve();
  }

  private wake(): void {
    for (const wake of this.wakeWaiters.splice(0)) {
      wake();
    }
  }

  private stream(): AsyncIterable<Frame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Frame>> => this.nextFrame(),
      }),
    };
  }

  private async nextFrame(): Promise<IteratorResult<Frame>> {
    return this.drain();
  }

  private async drain(): Promise<IteratorResult<Frame>> {
    for (;;) {
      const next = this.inbound.shift();
      if (next !== undefined) {
        return { value: next, done: false };
      }
      if (this.closed) {
        return { value: undefined, done: true };
      }
      await new Promise<void>((resolve) => {
        this.wakeWaiters.push(resolve);
      });
    }
  }
}

function peerAdvertFor(device: DeviceId): PeerAdvert {
  return {
    device,
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": 1861833600,
  };
}

function gossipFor(device: DeviceId): Frame {
  return { type: "gossip", peers: [peerAdvertFor(device)] };
}

/** A gossip-frame bundling several peer-adverts at once -- the exact shape relay-hub's own catch-up mechanism sends back to a gossiping connection, listing every other currently-known device in one frame rather than one frame per device. */
function gossipForMany(...devices: readonly DeviceId[]): Frame {
  return { type: "gossip", peers: devices.map(peerAdvertFor) };
}

/** A Connection whose receive() stream delivers pushed frames until rejectNow(), then rejects -- the mid-stream hostile-input failure the real adapter produces for undecodable bytes. */
class RejectingAfterFramesConnection {
  inbound: Frame[] = [];
  sent: Frame[] = [];
  private rejection: Error | null = null;
  private readonly wakeWaiters: (() => void)[] = [];

  get connection(): Readonly<Connection> {
    return {
      send: async (frame: Frame): Promise<void> => {
        this.sent.push(frame);
        return Promise.resolve();
      },
      receive: () => this.stream(),
      close: async (): Promise<void> => Promise.resolve(),
    };
  }

  push(frame: Frame): void {
    this.inbound.push(frame);
    for (const wake of this.wakeWaiters.splice(0)) wake();
  }

  rejectNow(): void {
    this.rejection = new Error("simulated undecodable bytes");
    for (const wake of this.wakeWaiters.splice(0)) wake();
  }

  private stream(): AsyncIterable<Frame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<Frame>> => this.nextFrame(),
      }),
    };
  }

  private async nextFrame(): Promise<IteratorResult<Frame>> {
    return this.step();
  }

  private async step(): Promise<IteratorResult<Frame>> {
    for (;;) {
      const next = this.inbound.shift();
      if (next !== undefined) {
        return { value: next, done: false };
      }
      if (this.rejection !== null) {
        throw this.rejection;
      }
      await new Promise<void>((resolve) => {
        this.wakeWaiters.push(resolve);
      });
    }
  }
}

describe("createRelayHub", () => {
  it("pairs a relay-connect initiator with the target and notifies the target with the initiator's gossiped device-id", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    a.push(gossipFor(deviceA));
    b.push(gossipFor(deviceB));
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();

    // b also receives a's gossip forwarded to it, then a catch-up frame triggered by b's own gossip (the only other known device at that point is a's, so it's a single-peer catch-up) before the relay-inbound (see the dedicated gossip-forwarding tests below for that behaviour in isolation).
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceA),
      { type: "relay-inbound", "source-device": deviceA },
    ]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("forwards relay-data in both directions within a pairing", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    // Ticks between the setup frames and the data frames: all frames land in the fakes' queues synchronously, and without them one connection can drain its whole queue (including relay-data) before the other's relay-connect has created the pairing -- an ordering a real transport, with per-frame network latency, never produces.
    a.push(gossipFor(deviceA));
    b.push(gossipFor(deviceB));
    await tick();
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();
    a.push({ type: "relay-data", payload: relayPayload });
    b.push({ type: "relay-data", payload: relayPayload });
    await tick();

    // b received a's gossip forwarded, then its own catch-up (a is the only other known device), then relay-inbound (from the connect), then a's relay-data; a received the mirror image from b's gossip.
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceA),
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
    ]);
    expect(a.sent).toEqual([
      gossipFor(deviceB),
      gossipFor(deviceB),
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
    ]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("ignores a relay-connect for a device not registered on this hub", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    b.push(gossipFor(deviceB));
    const unknown = deviceIdFromFillHex("33");
    a.push({ type: "relay-connect", "target-device": unknown });
    await tick();

    expect(b.sent).toEqual([]);
    // a still receives b's gossip forwarded to it -- unrelated to the unresolved relay-connect, which sends nothing.
    expect(a.sent).toEqual([gossipFor(deviceB)]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("ignores relay-data from a connection with no pairing, and drops unrelated frames", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const handling = hub.handleConnection(a.connection);

    a.push(gossipFor(deviceA));
    a.push({ type: "relay-data", payload: orphanPayload });
    a.push({ type: "ping" });
    a.push({ type: "handshake", version: 1, domains: ["core/data"] });
    await tick();

    expect(a.sent).toEqual([]);
    await a.end();
    await handling;
  });

  it("forgets a device when its connection ends, so later relay-connects to it are ignored", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const bHandling = hub.handleConnection(b.connection);
    b.push(gossipFor(deviceB));

    const aHandling = hub.handleConnection(a.connection);
    a.push(gossipFor(deviceA));
    await tick();

    // b goes away
    await b.end();
    await bHandling;

    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();

    // Each side also received the other's gossip forwarded to it, plus its own single-peer catch-up, before b disconnected; the unresolved relay-connect (b's registration is now gone) sends nothing further to either.
    expect(a.sent).toEqual([gossipFor(deviceB), gossipFor(deviceB)]);
    expect(b.sent).toEqual([gossipFor(deviceA), gossipFor(deviceA)]);
    await a.end();
    await aHandling;
  });

  it("a newer gossip for the same device moves the mapping to the newer connection", async () => {
    const hub = createRelayHub();
    const old = new FakeConnection();
    const fresh = new FakeConnection();
    const dialer = new FakeConnection();
    const handling = [
      hub.handleConnection(old.connection),
      hub.handleConnection(fresh.connection),
      hub.handleConnection(dialer.connection),
    ];

    old.push(gossipFor(deviceB));
    fresh.push(gossipFor(deviceB));
    dialer.push(gossipFor(deviceA));
    dialer.push({ type: "relay-connect", "target-device": deviceB });
    await tick();

    // fresh and old each also receive each other's and the dialer's gossip forwarded to them, plus their own catch-up. fresh's own catch-up excludes deviceB (fresh's own re-gossip already re-registered it to itself by the time the catch-up is built), leaving only deviceA; old's catch-up runs after both fresh's and dialer's registrations have landed, so it combines both -- deviceB now pointing at fresh, not old itself.
    expect(fresh.sent).toEqual([
      gossipFor(deviceB),
      gossipFor(deviceA),
      gossipFor(deviceA),
      { type: "relay-inbound", "source-device": deviceA },
    ]);
    expect(old.sent).toEqual([
      gossipFor(deviceB),
      gossipFor(deviceA),
      gossipForMany(deviceB, deviceA),
    ]);
    await Promise.all([old.end(), fresh.end(), dialer.end()]);
    await Promise.all(handling);
  });

  it("a rejecting receive iteration is treated as disconnect: state is cleaned up and later relay-connects to the device are ignored", async () => {
    const hub = createRelayHub();
    const b = new FakeConnection();
    const a = new RejectingAfterFramesConnection();
    const bHandling = hub.handleConnection(b.connection);
    b.push(gossipFor(deviceB));

    const aHandling = hub.handleConnection(a.connection);
    a.push(gossipFor(deviceA));
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();

    // b also received a's gossip forwarded to it, then its own catch-up (a is the only other known device), before the relay-connect paired and notified it.
    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceA),
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    a.rejectNow();
    await aHandling;

    // a's registration is gone even though its stream ended by rejection, not clean closure: a third party dialing a is now ignored
    const c = new FakeConnection();
    const cHandling = hub.handleConnection(c.connection);
    c.push(gossipFor(deviceB));
    await tick();
    c.push({ type: "relay-connect", "target-device": deviceA });
    await tick();
    // a's two entries are b's original gossip forwarded to it, plus a's own catch-up, both from the initial exchange (both connections were already registered by then); a's own connection is torn down before c ever gossips, so c's re-gossip of deviceB never reaches it.
    expect(a.sent).toEqual([gossipFor(deviceB), gossipFor(deviceB)]);
    await c.end();
    await cHandling;
    await b.end();
    await bHandling;
  });

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
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
    ]);
    expect(c.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipForMany(deviceA, deviceB),
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
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
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
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
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
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
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
    ]);
    expect(c.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipFor(deviceD),
      gossipForMany(deviceA, deviceB, deviceD),
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
    ]);
    expect(d.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceB),
      gossipFor(deviceC),
      gossipForMany(deviceA, deviceB, deviceC),
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
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

  it("forwards a received gossip-frame, unmodified, to every other currently-connected client but not back to the sender", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(c.connection),
    ];

    const advert = gossipFor(deviceA);
    a.push(advert);
    await tick();

    expect(b.sent).toEqual([advert]);
    expect(c.sent).toEqual([advert]);
    expect(a.sent).toEqual([]);
    await Promise.all([a.end(), b.end(), c.end()]);
    await Promise.all(handling);
  });

  it("forwards gossip to a connection that has not itself gossiped a device yet", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const silent = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(silent.connection),
    ];

    const advert = gossipFor(deviceA);
    a.push(advert);
    await tick();

    expect(silent.sent).toEqual([advert]);
    await Promise.all([a.end(), silent.end()]);
    await Promise.all(handling);
  });

  it("forwards every gossip frame unconditionally -- no dedup suppresses a repeated advert from the same sender, since a later snapshot-seconds/addresses value must always keep propagating", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    const advert = gossipFor(deviceA);
    a.push(advert);
    a.push(advert);
    await tick();

    expect(b.sent).toEqual([advert, advert]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("a fan-out send failing for one peer does not stop the gossip frame reaching the others, and does not tear down the sender's own connection handling", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const dead = new FakeConnection();
    const alive = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(dead.connection),
      hub.handleConnection(alive.connection),
    ];

    dead.sendRejection = new Error("simulated dead peer connection");

    const advert = gossipFor(deviceA);
    a.push(advert);
    await tick();

    expect(alive.sent).toEqual([advert]);

    // The sender's own handleConnection is still live: a later frame from a is still processed.
    const second = gossipFor(deviceB);
    a.push(second);
    await tick();
    expect(alive.sent).toEqual([advert, second]);

    await Promise.all([a.end(), dead.end(), alive.end()]);
    await Promise.all(handling);
  });

  it("catches up a connection that joins the hub after another has already gossiped and settled -- forwarding alone would miss this, since a client gossips its own self-advert exactly once, at connect time, and never repeats it", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const aHandling = hub.handleConnection(a.connection);

    // a gossips and fully settles before b even connects to the hub -- forwarding alone could never reach b, since a's advert is never re-sent and b's connection didn't exist yet to receive the forward.
    a.push(gossipFor(deviceA));
    await tick();

    const b = new FakeConnection();
    const bHandling = hub.handleConnection(b.connection);
    b.push(gossipFor(deviceB));
    await tick();

    // b's own catch-up, triggered by its own gossip, delivers a's advert even though a never gossiped again.
    expect(b.sent).toEqual([gossipFor(deviceA)]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all([aHandling, bHandling]);
  });

  it("bundles every other already-known device into a single catch-up frame when the gossiping connection joins after they're already known, excluding its own device", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    a.push(gossipFor(deviceA));
    b.push(gossipFor(deviceB));
    await tick();

    const c = new FakeConnection();
    const deviceC = deviceIdFromFillHex("44");
    const cHandling = hub.handleConnection(c.connection);
    c.push(gossipFor(deviceC));
    await tick();

    // c's catch-up bundles both already-known devices into one frame, never c's own.
    expect(c.sent).toEqual([gossipForMany(deviceA, deviceB)]);
    await Promise.all([a.end(), b.end(), c.end()]);
    await Promise.all([...handling, cHandling]);
  });
});
