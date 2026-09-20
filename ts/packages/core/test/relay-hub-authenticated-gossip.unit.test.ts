// The hub's side of wire-mesh#225: what an advert has to prove before the hub will register the device it names, forward it to anyone else, or replay it in a catch-up frame. Split from relay-hub.unit.test.ts, which covers the pairing and forwarding behaviour these rules sit in front of, rather than grown into it, under this repo's own max-lines cap.

import { describe, expect, it } from "vitest";
import { createRelayHub } from "../src/domain/relay-hub.js";
import { signPeerAdvert } from "../src/domain/peer-advert.js";
import type { Frame } from "../src/generated/protocol.js";
import { deviceIdFromFillHex } from "./hex.js";
import {
  createTestPeer,
  FakeConnection,
  FIXTURE_SNAPSHOT_SECONDS,
  gossipFor,
  hubVerifier,
  peerAdvertFor,
  settle,
  withBrokenSignature,
  type TestPeer,
} from "./relay-hub-test-helpers.js";

/** One second later than the fixtures' own snapshot, the smallest gap the hub's strictly-newer rule can distinguish. */
const LATER_SNAPSHOT_SECONDS = FIXTURE_SNAPSHOT_SECONDS + 1;

/** Drives one connection through the hub for the lifetime of a test, returning the fake so the test can push frames and read what came back. */
function connect(hub: Readonly<ReturnType<typeof createRelayHub>>): {
  fake: FakeConnection;
  handling: Promise<void>;
} {
  const fake = new FakeConnection();
  return { fake, handling: hub.handleConnection(fake.connection) };
}

describe("createRelayHub: authenticated gossip", () => {
  it("drops an advert naming another device that it cannot sign for, registering and forwarding nothing", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const victim = await createTestPeer();
    const attacker = connect(hub);
    const bystander = connect(hub);

    attacker.fake.push(gossipFor(withBrokenSignature(victim.advert)));
    await settle(attacker.fake, bystander.fake);

    expect(
      bystander.fake.sent,
      "a forged advert must not reach another client",
    ).toEqual([]);

    // The bystander's own gossip is answered with a catch-up frame listing every other known device, so an empty reply is what proves the forgery was never registered either.
    const bystanderPeer = await createTestPeer();
    bystander.fake.push(gossipFor(bystanderPeer.advert));
    await settle(bystander.fake, attacker.fake);

    expect(
      bystander.fake.sent,
      "the hub must know of no device at all after a forged advert",
    ).toEqual([]);

    await Promise.all([attacker.fake.end(), bystander.fake.end()]);
    await Promise.all([attacker.handling, bystander.handling]);
  });

  it("keeps the valid adverts of a frame that also carries a forged one", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const gateway = await createTestPeer();
    const victim = await createTestPeer();
    const sender = connect(hub);
    const listener = connect(hub);

    const mixed: Frame = {
      type: "gossip",
      peers: [gateway.advert, withBrokenSignature(victim.advert)],
    };
    sender.fake.push(mixed);
    await settle(sender.fake, listener.fake);

    expect(
      listener.fake.sent,
      "one forged entry must not cost the frame's genuine ones",
    ).toEqual([gossipFor(gateway.advert)]);

    await Promise.all([sender.fake.end(), listener.fake.end()]);
    await Promise.all([sender.handling, listener.handling]);
  });

  it("registers a genuine advert for a device the gossiping connection does not own, which is how a gateway fronts its local peers", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const gateway = await createTestPeer();
    // Never connects to this hub itself: the gateway is the only path to it, which is exactly the case binding an advert to its arriving connection would break.
    const local = await createTestPeer();
    const gatewayConnection = connect(hub);
    const caller = connect(hub);
    const callerPeer = await createTestPeer();

    gatewayConnection.fake.push({
      type: "gossip",
      peers: [gateway.advert, local.advert],
    });
    await settle(gatewayConnection.fake, caller.fake);
    caller.fake.push(gossipFor(callerPeer.advert));
    await settle(caller.fake, gatewayConnection.fake);
    caller.fake.push({ type: "relay-connect", "target-device": local.device });
    await settle(caller.fake, gatewayConnection.fake);

    expect(
      gatewayConnection.fake.sent.at(-1),
      "the gateway's connection is where a relay-connect for its local peer must land",
    ).toEqual({ type: "relay-inbound", "source-device": callerPeer.device });

    await Promise.all([gatewayConnection.fake.end(), caller.fake.end()]);
    await Promise.all([gatewayConnection.handling, caller.handling]);
  });

  it("does not let a replayed advert move a device's route to the connection replaying it", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const target = await createTestPeer();
    const owner = connect(hub);
    const attacker = connect(hub);
    const attackerPeer = await createTestPeer();
    const caller = connect(hub);
    const callerPeer = await createTestPeer();

    owner.fake.push(gossipFor(target.advert));
    await settle(owner.fake, attacker.fake, caller.fake);
    attacker.fake.push(gossipFor(attackerPeer.advert));
    await settle(attacker.fake, owner.fake, caller.fake);

    // Byte-for-byte the advert the owner sent, which is all a connection that saw it forwarded can produce: altering snapshot-seconds to make it look fresher would break the signature.
    attacker.fake.push(gossipFor(target.advert));
    await settle(attacker.fake, owner.fake, caller.fake);

    caller.fake.push(gossipFor(callerPeer.advert));
    await settle(caller.fake, owner.fake, attacker.fake);
    caller.fake.push({ type: "relay-connect", "target-device": target.device });
    await settle(caller.fake, owner.fake, attacker.fake);

    const inbound: Frame = {
      type: "relay-inbound",
      "source-device": callerPeer.device,
    };
    expect(
      owner.fake.sent,
      "the connection that first advertised the device keeps its route",
    ).toContainEqual(inbound);
    expect(
      attacker.fake.sent,
      "replaying an advert must not draw the device's traffic to the replayer",
    ).not.toContainEqual(inbound);

    await Promise.all([
      owner.fake.end(),
      attacker.fake.end(),
      caller.fake.end(),
    ]);
    await Promise.all([owner.handling, attacker.handling, caller.handling]);
  });

  it("moves a device's route when its own newer advert arrives on a fresh connection", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peer = await createTestPeer();
    const first = connect(hub);
    const second = connect(hub);
    const caller = connect(hub);
    const callerPeer = await createTestPeer();

    first.fake.push(gossipFor(peer.advert));
    await settle(first.fake, second.fake, caller.fake);

    // The same device reconnecting: a genuinely later snapshot, signed again by the device itself, which is what distinguishes a reconnect from the replay above.
    const reconnected = await peerAdvertFor(
      peer.identity,
      LATER_SNAPSHOT_SECONDS,
    );
    second.fake.push(gossipFor(reconnected));
    await settle(second.fake, first.fake, caller.fake);

    caller.fake.push(gossipFor(callerPeer.advert));
    await settle(caller.fake, first.fake, second.fake);
    caller.fake.push({ type: "relay-connect", "target-device": peer.device });
    await settle(caller.fake, first.fake, second.fake);

    const inbound: Frame = {
      type: "relay-inbound",
      "source-device": callerPeer.device,
    };
    expect(
      second.fake.sent,
      "the device's newer advert must move its route to the connection carrying it",
    ).toContainEqual(inbound);
    expect(
      first.fake.sent,
      "the superseded connection must no longer receive the device's traffic",
    ).not.toContainEqual(inbound);

    await Promise.all([first.fake.end(), second.fake.end(), caller.fake.end()]);
    await Promise.all([first.handling, second.handling, caller.handling]);
  });

  it("refreshes a device's own advert from the connection already holding it, even with an unchanged snapshot", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peer = await createTestPeer();
    const owner = connect(hub);
    const listener = connect(hub);

    owner.fake.push(gossipFor(peer.advert));
    await settle(owner.fake, listener.fake);

    // A heartbeat at the same second from the rightful owner: not a replay, and suppressing it would silently stop an address change or a refreshed extension reaching anyone.
    const heartbeat = await signPeerAdvert(peer.identity, {
      device: peer.device,
      addresses: ["198.51.100.2:4433"],
      "snapshot-seconds": FIXTURE_SNAPSHOT_SECONDS,
      "identity-key": peer.identity.identityKey,
    });
    owner.fake.push(gossipFor(heartbeat));
    await settle(owner.fake, listener.fake);

    expect(listener.fake.sent).toEqual([
      gossipFor(peer.advert),
      gossipFor(heartbeat),
    ]);

    await Promise.all([owner.fake.end(), listener.fake.end()]);
    await Promise.all([owner.handling, listener.handling]);
  });

  it("ignores a relay-connect naming a device only a forged advert ever claimed", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const caller = connect(hub);
    const callerPeer: TestPeer = await createTestPeer();
    const unclaimed = deviceIdFromFillHex("99");

    caller.fake.push(gossipFor(callerPeer.advert));
    await settle(caller.fake);
    caller.fake.push({ type: "relay-connect", "target-device": unclaimed });
    await settle(caller.fake);

    expect(caller.fake.sent).toEqual([]);

    await caller.fake.end();
    await caller.handling;
  });
});
