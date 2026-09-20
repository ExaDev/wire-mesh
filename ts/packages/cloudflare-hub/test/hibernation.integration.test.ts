// Eviction, as the runtime performs it: the Durable Object instance is discarded while its sockets stay open and attached, and a later message runs the constructor again on a brand-new instance. These tests reproduce that by building a second hub over the same socket objects, with whatever each one is carrying as its attachment, which is exactly the pair of things the runtime preserves. A pairing established before the eviction has to keep relaying afterwards, because a client whose socket never closed has no way to know an eviction happened and no reason to re-establish anything.

import { describe, expect, it } from "vitest";
import { decode } from "cbor2";
import type {
  DeviceId,
  Frame,
  PeerAdvert,
} from "wire-mesh-core/generated/protocol";
import {
  createHibernatingRelayHub,
  type HibernatingRelayHub,
  type HubSocket,
} from "../src/hibernating-hub.js";
import { messageFromFrame } from "../src/adapters/websocket-transport.js";
import { bytesFromHex, deviceIdFromFillHex } from "./hex.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");
const deviceC = deviceIdFromFillHex("33");
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

/** The runtime discarding this instance and building the next one: same sockets, same attachments, no in-memory state at all. */
function evict(sockets: readonly FakeHubSocket[]): HibernatingRelayHub {
  return createHibernatingRelayHub(() => sockets);
}

/** Two clients connected, gossiping, and paired by a relay-connect, on a hub that is about to be evicted. */
async function pairedHub(
  a: FakeHubSocket,
  b: FakeHubSocket,
): Promise<HibernatingRelayHub> {
  const hub = evict([a, b]);
  hub.accept(a);
  hub.accept(b);
  await hub.message(a, arrayBufferFor(gossipFor(deviceA)));
  await hub.message(b, arrayBufferFor(gossipFor(deviceB)));
  await hub.message(
    a,
    arrayBufferFor({ type: "relay-connect", "target-device": deviceB }),
  );
  return hub;
}

describe("a relay pairing across a Durable Object eviction", () => {
  it("relays a response sent after the instance that established the pairing was evicted", async () => {
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    await pairedHub(a, b);

    const woken = evict([a, b]);
    a.sent.length = 0;
    b.sent.length = 0;
    await woken.message(
      b,
      arrayBufferFor({
        type: "relay-data",
        payload: relayPayload,
        "to-device": deviceA,
      }),
    );

    expect(a.frames()).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceB,
        "to-device": deviceA,
      },
    ]);
  });

  it("relays in both directions, and keeps relaying across a second eviction", async () => {
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    await pairedHub(a, b);

    const first = evict([a, b]);
    a.sent.length = 0;
    b.sent.length = 0;
    await first.message(
      a,
      arrayBufferFor({ type: "relay-data", payload: relayPayload }),
    );
    expect(b.frames()).toEqual([
      { type: "relay-data", payload: relayPayload, "from-device": deviceA },
    ]);

    const second = evict([a, b]);
    a.sent.length = 0;
    b.sent.length = 0;
    await second.message(
      b,
      arrayBufferFor({ type: "relay-data", payload: relayPayload }),
    );
    expect(a.frames()).toEqual([
      { type: "relay-data", payload: relayPayload, "from-device": deviceB },
    ]);
  });

  it("answers a relay-connect naming a device an evicted instance registered", async () => {
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    const hub = evict([a, b]);
    hub.accept(a);
    hub.accept(b);
    await hub.message(a, arrayBufferFor(gossipFor(deviceA)));
    await hub.message(b, arrayBufferFor(gossipFor(deviceB)));

    const woken = evict([a, b]);
    b.sent.length = 0;
    await woken.message(
      a,
      arrayBufferFor({ type: "relay-connect", "target-device": deviceB }),
    );

    expect(b.frames()).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);
  });

  it("forgets a pairing whose peer closed while no instance was running", async () => {
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    await pairedHub(a, b);

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
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    const c = new FakeHubSocket();
    const hub = evict([a, b, c]);
    for (const socket of [a, b, c]) {
      hub.accept(socket);
    }
    await hub.message(a, arrayBufferFor(gossipFor(deviceA)));
    await hub.message(b, arrayBufferFor(gossipFor(deviceB)));
    await hub.message(c, arrayBufferFor(gossipFor(deviceC)));
    await hub.message(
      a,
      arrayBufferFor({ type: "relay-connect", "target-device": deviceB }),
    );
    await hub.message(
      c,
      arrayBufferFor({ type: "relay-connect", "target-device": deviceB }),
    );

    const woken = evict([a, b, c]);
    a.sent.length = 0;
    c.sent.length = 0;
    await woken.message(
      b,
      arrayBufferFor({
        type: "relay-data",
        payload: relayPayload,
        "to-device": deviceC,
      }),
    );

    expect(a.frames()).toEqual([]);
    expect(c.frames()).toEqual([
      {
        type: "relay-data",
        payload: relayPayload,
        "from-device": deviceB,
        "to-device": deviceC,
      },
    ]);
  });

  it("updates the surviving side's attachment when its peer closes", async () => {
    const a = new FakeHubSocket();
    const b = new FakeHubSocket();
    const hub = await pairedHub(a, b);

    expect(a.deserializeAttachment()).toEqual({
      device: deviceA,
      adverts: [peerAdvertFor(deviceA)],
      pairedDevices: [deviceB],
      mostRecentDevice: deviceB,
    });

    hub.forget(b);

    expect(a.deserializeAttachment()).toEqual({
      device: deviceA,
      adverts: [peerAdvertFor(deviceA)],
      pairedDevices: [],
    });
  });
});
