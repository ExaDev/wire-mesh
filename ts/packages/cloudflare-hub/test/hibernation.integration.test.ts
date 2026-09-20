// Eviction, as the runtime performs it: the Durable Object instance is discarded while its sockets stay open and attached, and a later message runs the constructor again on a brand-new instance. These tests reproduce that by building a second hub over the same socket objects, with whatever each one is carrying as its attachment, which is exactly the pair of things the runtime preserves. A pairing established before the eviction has to keep relaying afterwards, because a client whose socket never closed has no way to know an eviction happened and no reason to re-establish anything.

import { describe, expect, it } from "vitest";
import { decode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";
import {
  createHibernatingRelayHub,
  type HibernatingRelayHub,
  type HubSocket,
} from "../src/hibernating-hub.js";
import { messageFromFrame } from "../src/adapters/websocket-transport.js";
import { bytesFromHex } from "./hex.js";
import { createTestPeer, type TestPeer } from "./signed-peers.js";

const relayPayload = bytesFromHex("deadbeef");

/** A hibernating server socket as the runtime presents one: sends are recorded, and the attachment is round-tripped through structuredClone, the same serialisation the runtime applies to it. */
class FakeHubSocket implements HubSocket {
  sent: Uint8Array[] = [];
  closed = false;
  private attachment: unknown = null;

  send(message: Uint8Array<ArrayBuffer>): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }

  /** Everything the hub has sent this socket, decoded back into frames. */
  frames(): unknown[] {
    return this.sent.map((message) => decode(message));
  }
}

function arrayBufferFor(frame: Frame): ArrayBuffer {
  const bytes = messageFromFrame(frame);
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}

/** The runtime discarding this instance and building the next one: same sockets, same attachments, no in-memory state at all. */
function evict(sockets: readonly FakeHubSocket[]): HibernatingRelayHub {
  return createHibernatingRelayHub(() => sockets);
}

/** Two clients connected, gossiping, and paired by a relay-connect, on a hub that is about to be evicted. */
async function pairedHub(
  a: FakeHubSocket,
  peerA: TestPeer,
  b: FakeHubSocket,
  peerB: TestPeer,
): Promise<HibernatingRelayHub> {
  const hub = evict([a, b]);
  hub.accept(a);
  hub.accept(b);
  await hub.message(a, arrayBufferFor(peerA.gossip));
  await hub.message(b, arrayBufferFor(peerB.gossip));
  await hub.message(
    a,
    arrayBufferFor({ type: "relay-connect", "target-device": peerB.device }),
  );
  return hub;
}

describe("a relay pairing across a Durable Object eviction", () => {
  it("relays a response sent after the instance that established the pairing was evicted", async () => {
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    await pairedHub(a, peerA, b, peerB);

    const woken = evict([a, b]);
    a.sent.length = 0;
    b.sent.length = 0;
    await woken.message(
      b,
      arrayBufferFor({
        type: "relay-data",
        payload: relayPayload,
        "to-device": peerA.device,
      }),
    );

    expect(a.frames()).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
        "to-device": peerA.device,
      },
    ]);
  });

  it("relays in both directions, and keeps relaying across a second eviction", async () => {
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    await pairedHub(a, peerA, b, peerB);

    const first = evict([a, b]);
    a.sent.length = 0;
    b.sent.length = 0;
    await first.message(
      a,
      arrayBufferFor({ type: "relay-data", payload: relayPayload }),
    );
    expect(b.frames()).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerA.device,
      },
    ]);

    const second = evict([a, b]);
    a.sent.length = 0;
    b.sent.length = 0;
    await second.message(
      b,
      arrayBufferFor({ type: "relay-data", payload: relayPayload }),
    );
    expect(a.frames()).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
      },
    ]);
  });

  it("answers a relay-connect naming a device an evicted instance registered", async () => {
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    const hub = evict([a, b]);
    hub.accept(a);
    hub.accept(b);
    await hub.message(a, arrayBufferFor(peerA.gossip));
    await hub.message(b, arrayBufferFor(peerB.gossip));

    const woken = evict([a, b]);
    b.sent.length = 0;
    await woken.message(
      a,
      arrayBufferFor({ type: "relay-connect", "target-device": peerB.device }),
    );

    expect(b.frames()).toEqual([
      { type: "relay-inbound", "source-device": peerA.device },
    ]);
  });

  it("forgets a pairing whose peer closed while no instance was running", async () => {
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    await pairedHub(a, peerA, b, peerB);

    const woken = evict([a]);
    a.sent.length = 0;
    b.sent.length = 0;
    await woken.message(
      a,
      arrayBufferFor({ type: "relay-data", payload: relayPayload }),
    );

    expect(b.frames()).toEqual([]);
  });

  it("carries a third client's pairing across the eviction alongside the first", async () => {
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const peerC = await createTestPeer();
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    const c = new FakeHubSocket();
    const hub = evict([a, b, c]);
    for (const socket of [a, b, c]) {
      hub.accept(socket);
    }
    await hub.message(a, arrayBufferFor(peerA.gossip));
    await hub.message(b, arrayBufferFor(peerB.gossip));
    await hub.message(c, arrayBufferFor(peerC.gossip));
    await hub.message(
      a,
      arrayBufferFor({ type: "relay-connect", "target-device": peerB.device }),
    );
    await hub.message(
      c,
      arrayBufferFor({ type: "relay-connect", "target-device": peerB.device }),
    );

    const woken = evict([a, b, c]);
    a.sent.length = 0;
    c.sent.length = 0;
    await woken.message(
      b,
      arrayBufferFor({
        type: "relay-data",
        payload: relayPayload,
        "to-device": peerC.device,
      }),
    );

    expect(a.frames()).toEqual([]);
    expect(c.frames()).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": peerB.device,
        "to-device": peerC.device,
      },
    ]);
  });

  it("updates the surviving side's attachment when its peer closes", async () => {
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    const hub = await pairedHub(a, peerA, b, peerB);

    expect(a.deserializeAttachment()).toEqual({
      device: peerA.device,
      adverts: [peerA.advert],
      pairedDevices: [peerB.device],
      mostRecentDevice: peerB.device,
    });

    hub.forget(b);

    expect(a.deserializeAttachment()).toEqual({
      device: peerA.device,
      adverts: [peerA.advert],
      pairedDevices: [],
    });
  });
});
