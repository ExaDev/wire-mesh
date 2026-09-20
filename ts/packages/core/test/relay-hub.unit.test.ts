import { describe, expect, it } from "vitest";
import type { Frame } from "../src/generated/protocol.js";
import type { Connection } from "../src/ports/transport.js";
import { createRelayHub } from "../src/domain/relay-hub.js";
import { deviceIdFromFillHex, bytesFromHex } from "./hex.js";
import {
  FakeConnection,
  FIXTURE_SNAPSHOT_SECONDS,
  createTestPeer,
  gossipFor,
  gossipForMany,
  hubVerifier,
  peerAdvertFor,
  settle,
} from "./relay-hub-test-helpers.js";

/** One second after the fixture snapshot: the smallest advert that strictly supersedes a fixture peer's own, since a takeover by a different connection needs a strictly greater snapshot-seconds. */
const NEWER_SNAPSHOT_SECONDS = FIXTURE_SNAPSHOT_SECONDS + 1;

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

  /** True when every pushed frame has been consumed and the hub loop is parked waiting for the next one, or the stream has already ended by rejection. */
  get idle(): boolean {
    return (
      this.inbound.length === 0 &&
      (this.rejection !== null || this.wakeWaiters.length > 0)
    );
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
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    // Settled between the frames: each advert is verified before it registers, so a's relay-connect naming b only resolves once b's advert has been fully applied.
    a.push(peerA.gossip);
    await settle(a, b);
    b.push(peerB.gossip);
    await settle(a, b);
    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(a, b);

    // b also receives a's gossip forwarded to it, then a catch-up frame triggered by b's own gossip (the only other known device at that point is a's, so it's a single-peer catch-up) before the relay-inbound (see the dedicated gossip-forwarding tests below for that behaviour in isolation).
    expect(b.sent).toEqual([
      peerA.gossip,
      peerA.gossip,
      { type: "relay-inbound", "source-device": peerA.device },
    ]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("forwards relay-data in both directions within a pairing", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    // Settled between the setup frames and the data frames: all frames land in the fakes' queues synchronously, and without settling one connection can drain its whole queue (including relay-data) before the other's relay-connect has created the pairing, or before an advert has finished verifying, an ordering a real transport with per-frame network latency never produces.
    a.push(peerA.gossip);
    await settle(a, b);
    b.push(peerB.gossip);
    await settle(a, b);
    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(a, b);
    a.push({ type: "relay-data", payload: relayPayload });
    b.push({ type: "relay-data", payload: relayPayload });
    await settle(a, b);

    // b received a's gossip forwarded, then its own catch-up (a is the only other known device), then relay-inbound (from the connect), then a's relay-data; a received b's gossip forwarded, then b's relay-data. a gossiped first, so nothing was known to catch a up with.
    expect(b.sent).toEqual([
      peerA.gossip,
      peerA.gossip,
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
      },
    ]);
    expect(a.sent).toEqual([
      peerB.gossip,
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
      },
    ]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("echoes the sender's own explicit to-device onward to the receiver, not just from-device -- a receiving connection fronting more than one locally-addressable device (a gateway) needs this to disambiguate which of its own devices a frame was actually meant for, since the hub's routing use of to-device on the way in otherwise leaves no trace once the frame reaches the other side", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    a.push(peerA.gossip);
    await settle(a, b);
    b.push(peerB.gossip);
    await settle(a, b);
    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(a, b);
    a.push({
      type: "relay-data",
      payload: relayPayload,
      "to-device": peerB.device,
    });
    await settle(a, b);

    expect(b.sent).toEqual([
      peerA.gossip,
      peerA.gossip,
      { type: "relay-inbound", "source-device": peerA.device },
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
        "to-device": peerB.device,
      },
    ]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("ignores a relay-connect for a device not registered on this hub", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    b.push(peerB.gossip);
    const unknown = deviceIdFromFillHex("33");
    a.push({ type: "relay-connect", "target-device": unknown });
    await settle(a, b);

    expect(b.sent).toEqual([]);
    // a still receives b's gossip forwarded to it -- unrelated to the unresolved relay-connect, which sends nothing.
    expect(a.sent).toEqual([peerB.gossip]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("ignores relay-data from a connection with no pairing, and drops unrelated frames -- ping excepted, which gets its own pong (see relay-hub-ping-pong.unit.test.ts)", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const a = new FakeConnection();
    const handling = hub.handleConnection(a.connection);

    a.push(peerA.gossip);
    a.push({ type: "relay-data", payload: orphanPayload });
    a.push({ type: "handshake", version: 1, domains: ["core/data"] });
    await settle(a);

    expect(a.sent).toEqual([]);
    await a.end();
    await handling;
  });

  it("forgets a device when its connection ends, so later relay-connects to it are ignored", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const bHandling = hub.handleConnection(b.connection);
    const aHandling = hub.handleConnection(a.connection);
    b.push(peerB.gossip);
    await settle(a, b);
    a.push(peerA.gossip);
    await settle(a, b);

    // b goes away
    await b.end();
    await bHandling;

    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(a);

    // b's gossip reached a forwarded; a's gossip reached b forwarded, and a's own catch-up then replayed b's advert to a. The unresolved relay-connect (b's registration is now gone) sends nothing further to either.
    expect(a.sent).toEqual([peerB.gossip, peerB.gossip]);
    expect(b.sent).toEqual([peerA.gossip]);
    await a.end();
    await aHandling;
  });

  it("a newer gossip for the same device moves the mapping to the newer connection", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const old = new FakeConnection();
    const fresh = new FakeConnection();
    const dialer = new FakeConnection();
    const handling = [
      hub.handleConnection(old.connection),
      hub.handleConnection(fresh.connection),
      hub.handleConnection(dialer.connection),
    ];
    const newerAdvertB = await peerAdvertFor(
      peerB.identity,
      NEWER_SNAPSHOT_SECONDS,
    );
    const newerB = gossipFor(newerAdvertB);

    // Settled between the steps because a takeover is order-dependent: the newer advert must reach the hub after the one it supersedes, and the dialer's relay-connect after the takeover has landed.
    const everyone = [old, fresh, dialer];
    old.push(peerB.gossip);
    await settle(...everyone);
    fresh.push(newerB);
    await settle(...everyone);
    dialer.push(peerA.gossip);
    await settle(...everyone);
    dialer.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(...everyone);

    // fresh's advert for B is strictly newer, so B's registration moves from old to fresh. old was sent fresh's advert and then A's, and never a relay-inbound; fresh was sent old's original advert, then A's, then the relay-inbound naming the dialer. Neither gets a catch-up frame: old gossiped before anything else was known, and fresh's takeover left no device registered to any other connection.
    expect(fresh.sent).toEqual([
      peerB.gossip,
      peerA.gossip,
      { type: "relay-inbound", "source-device": peerA.device },
    ]);
    expect(old.sent).toEqual([newerB, peerA.gossip]);
    // The dialer's catch-up carries B's newer advert, the one now registered to fresh, not the one old originally gossiped.
    expect(dialer.sent).toEqual([
      peerB.gossip,
      newerB,
      gossipForMany(newerAdvertB),
    ]);
    await Promise.all([old.end(), fresh.end(), dialer.end()]);
    await Promise.all(handling);
  });

  it("a rejecting receive iteration is treated as disconnect: state is cleaned up and later relay-connects to the device are ignored", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const b = new FakeConnection();
    const a = new RejectingAfterFramesConnection();
    const bHandling = hub.handleConnection(b.connection);
    const aHandling = hub.handleConnection(a.connection);
    b.push(peerB.gossip);
    await settle(a, b);
    a.push(peerA.gossip);
    await settle(a, b);
    a.push({ type: "relay-connect", "target-device": peerB.device });
    await settle(a, b);

    // b received a's gossip forwarded to it, then the relay-connect paired and notified it.
    expect(b.sent).toEqual([
      peerA.gossip,
      { type: "relay-inbound", "source-device": peerA.device },
    ]);

    a.rejectNow();
    await aHandling;

    // a's registration is gone even though its stream ended by rejection, not clean closure: a third party dialing a is now ignored. c gossips a genuine advert of its own, so the relay-connect below is ignored because of a's absence and not because c never identified itself.
    const peerC = await createTestPeer();
    const c = new FakeConnection();
    const cHandling = hub.handleConnection(c.connection);
    c.push(peerC.gossip);
    await settle(b, c);
    c.push({ type: "relay-connect", "target-device": peerA.device });
    await settle(b, c);
    // a's two entries are b's original gossip forwarded to it, plus a's own catch-up, both from the initial exchange; a's own connection is torn down before c ever gossips, so c's gossip never reaches it.
    expect(a.sent).toEqual([peerB.gossip, peerB.gossip]);
    await c.end();
    await cHandling;
    await b.end();
    await bHandling;
  });

  it("forwards a received gossip-frame, unmodified, to every other currently-connected client but not back to the sender", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const c = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
      hub.handleConnection(c.connection),
    ];

    const advert = peerA.gossip;
    a.push(advert);
    await settle(a, b, c);

    expect(b.sent).toEqual([advert]);
    expect(c.sent).toEqual([advert]);
    expect(a.sent).toEqual([]);
    await Promise.all([a.end(), b.end(), c.end()]);
    await Promise.all(handling);
  });

  it("forwards gossip to a connection that has not itself gossiped a device yet", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const a = new FakeConnection();
    const silent = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(silent.connection),
    ];

    const advert = peerA.gossip;
    a.push(advert);
    await settle(a, silent);

    expect(silent.sent).toEqual([advert]);
    await Promise.all([a.end(), silent.end()]);
    await Promise.all(handling);
  });

  it("forwards every gossip frame unconditionally -- no dedup suppresses a repeated advert from the same sender, since a later snapshot-seconds/addresses value must always keep propagating", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    const advert = peerA.gossip;
    a.push(advert);
    a.push(advert);
    await settle(a, b);

    expect(b.sent).toEqual([advert, advert]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all(handling);
  });

  it("a fan-out send failing for one peer does not stop the gossip frame reaching the others, and does not tear down the sender's own connection handling", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const dead = new FakeConnection();
    const alive = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(dead.connection),
      hub.handleConnection(alive.connection),
    ];

    dead.sendRejection = new Error("simulated dead peer connection");

    const advert = peerA.gossip;
    a.push(advert);
    await settle(a, dead, alive);

    expect(alive.sent).toEqual([advert]);

    // The sender's own handleConnection is still live: a later frame from a is still processed.
    const second = peerB.gossip;
    a.push(second);
    await settle(a, dead, alive);
    expect(alive.sent).toEqual([advert, second]);

    await Promise.all([a.end(), dead.end(), alive.end()]);
    await Promise.all(handling);
  });

  it("catches up a connection that joins the hub after another has already gossiped and settled -- forwarding alone would miss this, since a client gossips its own self-advert exactly once, at connect time, and never repeats it", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeConnection();
    const aHandling = hub.handleConnection(a.connection);

    // a gossips and fully settles before b even connects to the hub -- forwarding alone could never reach b, since a's advert is never re-sent and b's connection didn't exist yet to receive the forward.
    a.push(peerA.gossip);
    await settle(a);

    const b = new FakeConnection();
    const bHandling = hub.handleConnection(b.connection);
    b.push(peerB.gossip);
    await settle(a, b);

    // b's own catch-up, triggered by its own gossip, delivers a's advert even though a never gossiped again.
    expect(b.sent).toEqual([peerA.gossip]);
    await Promise.all([a.end(), b.end()]);
    await Promise.all([aHandling, bHandling]);
  });

  it("bundles every other already-known device into a single catch-up frame when the gossiping connection joins after they're already known, excluding its own device", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const peerC = await createTestPeer();
    const a = new FakeConnection();
    const b = new FakeConnection();
    const handling = [
      hub.handleConnection(a.connection),
      hub.handleConnection(b.connection),
    ];

    a.push(peerA.gossip);
    await settle(a, b);
    b.push(peerB.gossip);
    await settle(a, b);

    const c = new FakeConnection();
    const cHandling = hub.handleConnection(c.connection);
    c.push(peerC.gossip);
    await settle(a, b, c);

    // c's catch-up bundles both already-known devices into one frame, never c's own.
    expect(c.sent).toEqual([gossipForMany(peerA.advert, peerB.advert)]);
    await Promise.all([a.end(), b.end(), c.end()]);
    await Promise.all([...handling, cHandling]);
  });

  describe("registerConnection/onFrame/onDisconnect (wire-mesh#102)", () => {
    it("forwards gossip between two connections driven manually via onFrame, identically to handleConnection's own loop", async () => {
      const hub = createRelayHub({ identity: hubVerifier });
      const peerA = await createTestPeer();
      const peerB = await createTestPeer();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const aConn = a.connection;
      const bConn = b.connection;
      hub.registerConnection(aConn);
      hub.registerConnection(bConn);

      await hub.onFrame(aConn, peerA.gossip);
      await hub.onFrame(bConn, peerB.gossip);

      // a's own gossip forwards to b (nothing else known yet, so no catch-up to a); b's own gossip forwards to a, and b's own catch-up (devices other than b, i.e. A) replays right after -- the same two-frame shape "forgets a device"/"bundles every other" already exercise via handleConnection's own loop.
      expect(a.sent).toEqual([peerB.gossip]);
      expect(b.sent).toEqual([peerA.gossip, peerA.gossip]);
    });

    it("pairs a relay-connect initiator with a target across two manually-driven connections", async () => {
      const hub = createRelayHub({ identity: hubVerifier });
      const peerA = await createTestPeer();
      const peerB = await createTestPeer();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const aConn = a.connection;
      const bConn = b.connection;
      hub.registerConnection(aConn);
      hub.registerConnection(bConn);
      await hub.onFrame(aConn, peerA.gossip);
      await hub.onFrame(bConn, peerB.gossip);

      await hub.onFrame(aConn, {
        type: "relay-connect",
        "target-device": peerB.device,
      });

      expect(b.sent).toContainEqual({
        type: "relay-inbound",
        "source-device": peerA.device,
      });
    });

    it("onDisconnect cleans up registry state the same way handleConnection's own finally block does, so a later relay-connect to the disconnected device is ignored", async () => {
      const hub = createRelayHub({ identity: hubVerifier });
      const peerA = await createTestPeer();
      const peerB = await createTestPeer();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const aConn = a.connection;
      const bConn = b.connection;
      hub.registerConnection(aConn);
      hub.registerConnection(bConn);
      await hub.onFrame(bConn, peerB.gossip);
      await hub.onFrame(aConn, peerA.gossip);
      const sentToABeforeDisconnect = [...a.sent];

      hub.onDisconnect(bConn);

      await hub.onFrame(aConn, {
        type: "relay-connect",
        "target-device": peerB.device,
      });

      // b's own registration is gone: the unresolved relay-connect sends nothing further to a beyond whatever it had already received before the disconnect.
      expect(a.sent).toEqual(sentToABeforeDisconnect);
    });

    it("handleConnection itself is unchanged: it still registers, consumes, and cleans up exactly as before, now expressed as registerConnection + a loop over onFrame + onDisconnect internally", async () => {
      const hub = createRelayHub({ identity: hubVerifier });
      const peerA = await createTestPeer();
      const peerB = await createTestPeer();
      const a = new FakeConnection();
      const b = new FakeConnection();
      const handling = [
        hub.handleConnection(a.connection),
        hub.handleConnection(b.connection),
      ];
      a.push(peerA.gossip);
      await settle(a, b);
      b.push(peerB.gossip);
      await settle(a, b);

      expect(a.sent).toEqual([peerB.gossip]);
      expect(b.sent).toEqual([peerA.gossip, peerA.gossip]);
      await Promise.all([a.end(), b.end()]);
      await Promise.all(handling);
    });
  });
});
