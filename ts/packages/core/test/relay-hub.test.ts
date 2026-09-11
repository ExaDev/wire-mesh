import { describe, expect, it } from "vitest";
import type { DeviceId, Frame } from "../src/generated/protocol.js";
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
  private closed = false;
  private readonly wakeWaiters: (() => void)[] = [];

  get connection(): Readonly<Connection> {
    return {
      send: async (frame: Frame): Promise<void> => {
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

function gossipFor(device: DeviceId): Frame {
  return {
    type: "gossip",
    peers: [
      {
        device,
        addresses: ["203.0.113.5:4433"],
        "snapshot-seconds": 1861833600,
      },
    ],
  };
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

    expect(b.sent).toEqual([
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

    // b received relay-inbound (from the connect) then a's relay-data; a received b's relay-data
    expect(b.sent[0]).toEqual({
      type: "relay-inbound",
      "source-device": deviceA,
    });
    expect(b.sent[1]).toEqual({
      type: "relay-data",
      payload: relayPayload,
      "from-device": deviceA,
    });
    expect(a.sent).toEqual([
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
    expect(a.sent).toEqual([]);
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

    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
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

    expect(fresh.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);
    expect(old.sent).toEqual([]);
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

    // b's connection paired and was notified before a's stream rejected mid-flight
    expect(b.sent).toEqual([
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
    expect(a.sent).toEqual([]);
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

    expect(b.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);
    expect(c.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    // b's relay-data (single pairing on b's own side) still reaches a -- the b<->a pairing was never torn down
    b.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(a.sent).toEqual([
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
    ]);

    // c's relay-data reaches a too, correctly attributed and not mixed up with b's
    c.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(a.sent).toEqual([
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
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
    ]);
    expect(c.sent).toEqual([
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
    expect(a.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceX },
    ]);

    // a now also initiates its own pipe to b -- the x <-> a pairing stays live alongside the new a <-> b one
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();
    expect(b.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    // x's data (x holds one pairing, no to-device needed) still reaches a
    x.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(a.sent).toEqual([
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
      { type: "relay-inbound", "source-device": deviceX },
      { type: "relay-data", payload: relayPayload, "from-device": deviceX },
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
    ]);
    expect(b.sent).toEqual([
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
    expect(y.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceB },
    ]);

    // a now dials b -- the b <-> y pairing stays live alongside the new a <-> b one
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();
    expect(b.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    // y's data (single pairing on y's own side) still reaches b
    y.push({ type: "relay-data", payload: relayPayload });
    await tick();
    expect(b.sent).toEqual([
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
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
    ]);
    expect(b.sent).toEqual([
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

    for (const target of [b, c, d]) {
      expect(target.sent).toEqual([
        { type: "relay-inbound", "source-device": deviceA },
        {
          type: "relay-data",
          payload: relayPayload,
          "from-device": deviceA,
        },
      ]);
    }
    expect(a.sent).toEqual([
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
      { type: "relay-data", payload: relayPayload, "from-device": deviceC },
      { type: "relay-data", payload: relayPayload, "from-device": deviceD },
    ]);

    await Promise.all([a.end(), b.end(), c.end(), d.end()]);
    await Promise.all(handling);
  });
});
