import { describe, expect, it } from "vitest";
import type { Frame } from "../src/generated/protocol.js";
import type { Connection } from "../src/ports/transport.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import { deviceIdFromFillHex, bytesFromHex } from "./hex.js";
import {
  FakeConnection,
  gossipFor,
  gossipForMany,
  tick,
} from "./relay-hub-test-helpers.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");
const relayPayload = bytesFromHex("deadbeef");
const orphanPayload = bytesFromHex("aa");

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

  it("echoes the sender's own explicit to-device onward to the receiver, not just from-device -- a receiving connection fronting more than one locally-addressable device (a gateway) needs this to disambiguate which of its own devices a frame was actually meant for, since the hub's routing use of to-device on the way in otherwise leaves no trace once the frame reaches the other side", async () => {
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
    a.push({ type: "relay-connect", "target-device": deviceB });
    await tick();
    a.push({ type: "relay-data", payload: relayPayload, "to-device": deviceB });
    await tick();

    expect(b.sent).toEqual([
      gossipFor(deviceA),
      gossipFor(deviceA),
      { type: "relay-inbound", "source-device": deviceA },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceA,
        "to-device": deviceB,
      },
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

  it("ignores relay-data from a connection with no pairing, and drops unrelated frames -- ping excepted, which gets its own pong (see relay-hub-ping-pong.unit.test.ts)", async () => {
    const hub = createRelayHub();
    const a = new FakeConnection();
    const handling = hub.handleConnection(a.connection);

    a.push(gossipFor(deviceA));
    a.push({ type: "relay-data", payload: orphanPayload });
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

  describe("registerConnection/onFrame/onDisconnect (wire-mesh#102)", () => {
    it("forwards gossip between two connections driven manually via onFrame, identically to handleConnection's own loop", async () => {
      const hub = createRelayHub();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const aConn = a.connection;
      const bConn = b.connection;
      hub.registerConnection(aConn);
      hub.registerConnection(bConn);

      await hub.onFrame(aConn, gossipFor(deviceA));
      await hub.onFrame(bConn, gossipFor(deviceB));

      // a's own gossip forwards to b (nothing else known yet, so no catch-up to a); b's own gossip forwards to a, and b's own catch-up (devices other than b, i.e. A) replays right after -- the same two-frame shape "forgets a device"/"bundles every other" already exercise via handleConnection's own loop.
      expect(a.sent).toEqual([gossipFor(deviceB)]);
      expect(b.sent).toEqual([gossipFor(deviceA), gossipFor(deviceA)]);
    });

    it("pairs a relay-connect initiator with a target across two manually-driven connections", async () => {
      const hub = createRelayHub();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const aConn = a.connection;
      const bConn = b.connection;
      hub.registerConnection(aConn);
      hub.registerConnection(bConn);
      await hub.onFrame(aConn, gossipFor(deviceA));
      await hub.onFrame(bConn, gossipFor(deviceB));

      await hub.onFrame(aConn, {
        type: "relay-connect",
        "target-device": deviceB,
      });

      expect(b.sent).toContainEqual({
        type: "relay-inbound",
        "source-device": deviceA,
      });
    });

    it("onDisconnect cleans up registry state the same way handleConnection's own finally block does, so a later relay-connect to the disconnected device is ignored", async () => {
      const hub = createRelayHub();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const aConn = a.connection;
      const bConn = b.connection;
      hub.registerConnection(aConn);
      hub.registerConnection(bConn);
      await hub.onFrame(bConn, gossipFor(deviceB));
      await hub.onFrame(aConn, gossipFor(deviceA));
      const sentToABeforeDisconnect = [...a.sent];

      hub.onDisconnect(bConn);

      await hub.onFrame(aConn, {
        type: "relay-connect",
        "target-device": deviceB,
      });

      // b's own registration is gone: the unresolved relay-connect sends nothing further to a beyond whatever it had already received before the disconnect.
      expect(a.sent).toEqual(sentToABeforeDisconnect);
    });

    it("handleConnection itself is unchanged: it still registers, consumes, and cleans up exactly as before, now expressed as registerConnection + a loop over onFrame + onDisconnect internally", async () => {
      const hub = createRelayHub();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const handling = [
        hub.handleConnection(a.connection),
        hub.handleConnection(b.connection),
      ];
      a.push(gossipFor(deviceA));
      await tick();
      b.push(gossipFor(deviceB));
      await tick();

      expect(a.sent).toEqual([gossipFor(deviceB)]);
      expect(b.sent).toEqual([gossipFor(deviceA), gossipFor(deviceA)]);
      await Promise.all([a.end(), b.end()]);
      await Promise.all(handling);
    });
  });
});
