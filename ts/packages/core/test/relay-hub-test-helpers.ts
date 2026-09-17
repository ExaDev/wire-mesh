// Shared fixtures for relay-hub.unit.test.ts and relay-hub-multiplexing.unit.test.ts -- split out under this repo's max-lines cap the same way relay-hub-multiplexing.unit.test.ts's own multi-pairing/to-device coverage was split from the general single-pairing hub behaviour it grew alongside.

import type { DeviceId, Frame, PeerAdvert } from "../src/generated/protocol.js";
import type { Connection } from "../src/ports/transport.js";

/** One macrotask turn, letting the hub drain frames already queued on its connections. */
export async function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** An in-memory Connection driving the hub through the port contract: queued inbound frames the test pushes, and a record of everything the hub sends back. */
export class FakeConnection {
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

export function peerAdvertFor(device: DeviceId): PeerAdvert {
  return {
    device,
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": 1861833600,
  };
}

export function gossipFor(device: DeviceId): Frame {
  return { type: "gossip", peers: [peerAdvertFor(device)] };
}

/** A gossip-frame bundling several peer-adverts at once -- the exact shape relay-hub's own catch-up mechanism sends back to a gossiping connection, listing every other currently-known device in one frame rather than one frame per device. */
export function gossipForMany(...devices: readonly DeviceId[]): Frame {
  return { type: "gossip", peers: devices.map(peerAdvertFor) };
}
