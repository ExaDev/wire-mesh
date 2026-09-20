import { describe, expect, it, vi } from "vitest";
import { decode } from "cbor2";
import type { Frame } from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import { createRelayHub } from "wire-mesh-core/domain/relay-hub";
import {
  messageFromFrame,
  wrapWebSocket,
} from "../src/adapters/websocket-transport.js";
import { bytesFromHex } from "./hex.js";
import { FakeWebSocket } from "./fake-web-socket.js";
import { createTestPeer, hubVerifier } from "./signed-peers.js";

const relayPayload = bytesFromHex("deadbeef");
const CBOR_BREAK_BYTE = 0xff; // the CBOR break byte on its own: undecodable, the hostile-input case

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
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const wsA = new FakeWebSocket();
    const wsB = new FakeWebSocket();
    const a = wrapWebSocket(wsA as unknown as WebSocket);
    const b = wrapWebSocket(wsB as unknown as WebSocket);
    const handling = [hub.handleConnection(a), hub.handleConnection(b)];

    // Each step waits for its visible effect before the next frame goes in: the hub verifies an advert's signature before registering it, which completes on a later macrotask than the message that carried it, so a relay-connect sent straight after b's gossip could reach the hub before b is known.
    wsA.emitMessage(arrayBuffer(messageFromFrame(peerA.gossip)));
    await vi.waitFor(() => {
      expect(decodeSent(wsB)).toEqual([peerA.gossip]);
    });
    wsB.emitMessage(arrayBuffer(messageFromFrame(peerB.gossip)));
    await vi.waitFor(() => {
      expect(decodeSent(wsA)).toEqual([peerB.gossip]);
      expect(decodeSent(wsB)).toEqual([peerA.gossip, peerA.gossip]);
    });
    wsA.emitMessage(
      arrayBuffer(
        messageFromFrame({
          type: "relay-connect",
          "target-device": peerB.device,
        }),
      ),
    );

    // wsB also received a's gossip forwarded, then its own catch-up (a is the only other known device), before the relay-inbound -- see wire-mesh-core's relay-hub.test.ts for this behaviour in isolation.
    await vi.waitFor(() => {
      expect(decodeSent(wsB)).toEqual([
        peerA.gossip,
        peerA.gossip,
        { type: "relay-inbound", "source-device": peerA.device },
      ]);
    });

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

    await vi.waitFor(() => {
      expect(decodeSent(wsB)).toEqual([
        peerA.gossip,
        peerA.gossip,
        { type: "relay-inbound", "source-device": peerA.device },
        {
          type: "relay-data",
          payload: relayPayload,
          "from-device": peerA.device,
        },
      ]);
      expect(decodeSent(wsA)).toEqual([
        peerB.gossip,
        {
          type: "relay-data",
          payload: relayPayload,
          "from-device": peerB.device,
        },
      ]);
    });

    await Promise.all([a.close(), b.close()]);
    await Promise.all(handling);
  });

  it("undecodable bytes from one client close only that connection: the hub and the other peer keep working", async () => {
    const hub = createRelayHub({ identity: hubVerifier });
    const peerA = await createTestPeer();
    const peerB = await createTestPeer();
    const wsA = new FakeWebSocket();
    const b = new FakeConnection();
    const a = wrapWebSocket(wsA as unknown as WebSocket);
    const aHandling = hub.handleConnection(a);
    const bHandling = hub.handleConnection(b.connection);

    wsA.emitMessage(arrayBuffer(messageFromFrame(peerA.gossip)));
    await vi.waitFor(() => {
      expect(b.sent).toEqual([peerA.gossip]);
    });
    b.push(peerB.gossip);
    await vi.waitFor(() => {
      expect(decodeSent(wsA)).toEqual([peerB.gossip]);
      expect(b.sent).toEqual([peerA.gossip, peerA.gossip]);
    });

    // hostile bytes on a's socket: its receive iteration rejects, the hub treats it as disconnect, nothing throws
    wsA.emitMessage(arrayBuffer(Uint8Array.from([CBOR_BREAK_BYTE])));
    await aHandling;

    expect(wsA.closed).toBe(true);

    // b can still be dialed by a fresh peer
    const wsC = new FakeWebSocket();
    const c = wrapWebSocket(wsC as unknown as WebSocket);
    const cHandling = hub.handleConnection(c);
    wsC.emitMessage(arrayBuffer(messageFromFrame(peerA.gossip)));
    await vi.waitFor(() => {
      expect(b.sent).toEqual([peerA.gossip, peerA.gossip, peerA.gossip]);
    });
    wsC.emitMessage(
      arrayBuffer(
        messageFromFrame({
          type: "relay-connect",
          "target-device": peerB.device,
        }),
      ),
    );
    // b's gossip forward from a, its own catch-up, and c's re-gossip of a's advert (forwarded now that c has taken over the device-id a's disconnect freed up) all precede the relay-inbound.
    await vi.waitFor(() => {
      expect(b.sent).toEqual([
        peerA.gossip,
        peerA.gossip,
        peerA.gossip,
        { type: "relay-inbound", "source-device": peerA.device },
      ]);
    });

    await c.close();
    await cHandling;
    await b.end();
    await bHandling;
  });
});
