import { describe, expect, it } from "vitest";
import { decode } from "cbor2";
import type {
  DeviceId,
  Frame,
} from "@exadev/wire-mesh-core/generated/protocol";
import type { Connection } from "@exadev/wire-mesh-core/ports/transport";
import { createRelayHub } from "@exadev/wire-mesh-core/domain/relay-hub";
import {
  messageFromFrame,
  wrapWebSocket,
} from "../src/adapters/websocket-transport.js";
import { bytesFromHex, deviceIdFromFillHex } from "./hex.js";
import { FakeWebSocket } from "./fake-web-socket.js";

const deviceA = deviceIdFromFillHex("11");
const deviceB = deviceIdFromFillHex("22");
const relayPayload = bytesFromHex("deadbeef");
const CBOR_BREAK_BYTE = 0xff; // the CBOR break byte on its own: undecodable, the hostile-input case

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

describe("createRelayHub over the real wrapWebSocket adapter", () => {
  function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  function decodeSent(ws: FakeWebSocket): unknown[] {
    return ws.sent.map((buffer) => decode(new Uint8Array(buffer)));
  }

  it("gossip, relay-connect and relay-data flow end to end through real WebSocket message encoding", async () => {
    const hub = createRelayHub();
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    const a = wrapWebSocket(wsA as unknown as WebSocket);
    const b = wrapWebSocket(wsB as unknown as WebSocket);
    const handling = [hub.handleConnection(a), hub.handleConnection(b)];

    wsA.emitMessage(arrayBuffer(messageFromFrame(gossipFor(deviceA))));
    wsB.emitMessage(arrayBuffer(messageFromFrame(gossipFor(deviceB))));
    await tick();
    wsA.emitMessage(
      arrayBuffer(
        messageFromFrame({ type: "relay-connect", "target-device": deviceB }),
      ),
    );
    await tick();

    expect(decodeSent(wsB)).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    wsA.emitMessage(
      arrayBuffer(
        messageFromFrame({ type: "relay-data", payload: relayPayload }),
      ),
    );
    wsB.emitMessage(
      arrayBuffer(
        messageFromFrame({ type: "relay-data", payload: relayPayload }),
      ),
    );
    await tick();

    expect(decodeSent(wsB)).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
      { type: "relay-data", payload: relayPayload },
    ]);
    expect(decodeSent(wsA)).toEqual([
      { type: "relay-data", payload: relayPayload },
    ]);

    await Promise.all([a.close(), b.close()]);
    await Promise.all(handling);
  });

  it("undecodable bytes from one client close only that connection: the hub and the other peer keep working", async () => {
    const hub = createRelayHub();
    const wsA = new FakeWebSocket();
    const b = new FakeConnection();
    const a = wrapWebSocket(wsA as unknown as WebSocket);
    const aHandling = hub.handleConnection(a);
    const bHandling = hub.handleConnection(b.connection);

    wsA.emitMessage(arrayBuffer(messageFromFrame(gossipFor(deviceA))));
    b.push(gossipFor(deviceB));
    await tick();

    // hostile bytes on a's socket: its receive iteration rejects, the hub treats it as disconnect, nothing throws
    wsA.emitMessage(arrayBuffer(Uint8Array.from([CBOR_BREAK_BYTE])));
    await tick();
    await aHandling;

    expect(wsA.closed).toBe(true);

    // b can still be dialed by a fresh peer
    const wsC = new FakeWebSocket();
    const c = wrapWebSocket(wsC as unknown as WebSocket);
    const cHandling = hub.handleConnection(c);
    wsC.emitMessage(arrayBuffer(messageFromFrame(gossipFor(deviceA))));
    await tick();
    wsC.emitMessage(
      arrayBuffer(
        messageFromFrame({ type: "relay-connect", "target-device": deviceB }),
      ),
    );
    await tick();
    expect(b.sent).toEqual([
      { type: "relay-inbound", "source-device": deviceA },
    ]);

    await c.close();
    await cHandling;
    await b.end();
    await bHandling;
  });
});
