// Shared fixtures for relay-hub.unit.test.ts and relay-hub-multiplexing.unit.test.ts -- split out under this repo's max-lines cap the same way relay-hub-multiplexing.unit.test.ts's own multi-pairing/to-device coverage was split from the general single-pairing hub behaviour it grew alongside.
//
// Every fixture peer holds a real Ed25519 identity rather than a device-id invented from filler bytes: the hub verifies each advert's signature against the key the advert carries (wire-mesh#225), so an advert naming an id no keypair produced can never be registered, and a test built on one would exercise only the rejection path.

import {
  deriveDeviceId,
  verifyWithPublicKey,
} from "../src/adapters/node-identity.js";
import {
  signPeerAdvert,
  type PeerAdvertVerifier,
} from "../src/domain/peer-advert.js";
import type { DeviceId, Frame, PeerAdvert } from "../src/generated/protocol.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type { Connection } from "../src/ports/transport.js";
import { generateEd25519Identity, LOW_BYTE_MASK } from "./tokens-fixtures.js";

/** The verification half of core's Node identity adapter, which is all createRelayHub asks for: an advert is self-certifying, so a hub needs no signing identity of its own. */
export const hubVerifier: PeerAdvertVerifier = {
  verify: verifyWithPublicKey,
  deriveDeviceId,
};

/** The snapshot second every fixture advert carries unless a test is specifically about freshness, so two peers' adverts differ only in who signed them. */
export const FIXTURE_SNAPSHOT_SECONDS = 1861833600;

/** One macrotask turn, letting the hub drain frames already queued on its connections. */
export async function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** Anything settle can wait on: a connection whose hub-side frame loop can report having nothing left to do. */
export interface Idleable {
  readonly idle: boolean;
}

/**
 * Yields until every given connection's hub loop has consumed all the frames pushed to it and finished handling them, including every send that handling triggered on other connections.
 *
 * tick() alone no longer suffices for a test that pushes gossip: the hub verifies each advert's signature before acting on it (wire-mesh#225), and a signature check completes on a later macrotask than the one the frame was pushed on, so a fixed number of turns is a race. Waiting on the loops themselves is deterministic, and is also how a test orders two connections' frames: settling between two pushes guarantees the first has been fully applied before the second reaches the hub.
 */
export async function settle(
  ...connections: readonly Readonly<Idleable>[]
): Promise<void> {
  do {
    await tick();
  } while (!connections.every((connection) => connection.idle));
}

/** An in-memory Connection driving the hub through the port contract: queued inbound frames the test pushes, and a record of everything the hub sends back. */
export class FakeConnection {
  inbound: Frame[] = [];
  sent: Frame[] = [];
  /** When set, every subsequent send() rejects with this error instead of recording the frame -- simulates a peer whose own connection has died from the hub's perspective, without needing a second connection class. */
  sendRejection: Error | null = null;
  private closed = false;
  private readonly wakeWaiters: (() => void)[] = [];

  /** True when every frame pushed so far has been consumed by the hub loop and its handling has finished: the loop is parked waiting for the next frame (or the stream has ended), so nothing is still in flight on this connection's behalf. */
  get idle(): boolean {
    return (
      this.inbound.length === 0 && (this.closed || this.wakeWaiters.length > 0)
    );
  }

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

/** A real identity paired with the advert and single-peer gossip frame the hub will actually accept for it, so a test can name a peer once and reuse both. */
export interface TestPeer {
  readonly identity: IdentityPort;
  readonly device: DeviceId;
  readonly advert: PeerAdvert;
  readonly gossip: Frame;
}

/** Signs one advert for an identity. Separate from createTestPeer so a freshness test can produce a second, later-stamped advert for a peer it already has. */
export async function peerAdvertFor(
  identity: Readonly<IdentityPort>,
  snapshotSeconds: number = FIXTURE_SNAPSHOT_SECONDS,
): Promise<PeerAdvert> {
  return signPeerAdvert(identity, {
    device: identity.deviceId,
    addresses: ["203.0.113.5:4433"],
    "snapshot-seconds": snapshotSeconds,
    "identity-key": identity.identityKey,
  });
}

/** Mints a fresh identity and the signed advert the hub accepts for it. Ed25519 rather than P-256 so a re-signed advert for the same content is byte-identical, which keeps a test that compares two gossip frames comparing what it means to. */
export async function createTestPeer(
  snapshotSeconds: number = FIXTURE_SNAPSHOT_SECONDS,
): Promise<TestPeer> {
  const identity = await generateEd25519Identity();
  const advert = await peerAdvertFor(identity, snapshotSeconds);
  return {
    identity,
    device: identity.deviceId,
    advert,
    gossip: { type: "gossip", peers: [advert] },
  };
}

export function gossipFor(advert: Readonly<PeerAdvert>): Frame {
  return { type: "gossip", peers: [advert] };
}

/** Corrupts an advert's signature while leaving everything the signature covers untouched: what an attacker forging an advert for a device whose key it does not hold is actually reduced to, since altering any covered field breaks the signature just the same. */
export function withBrokenSignature(advert: Readonly<PeerAdvert>): PeerAdvert {
  const signature = Uint8Array.from(advert.signature);
  const firstByte = signature.at(0);
  if (firstByte === undefined) {
    throw new Error("test setup: signature has no bytes to corrupt");
  }
  signature[0] = firstByte ^ LOW_BYTE_MASK;
  return { ...advert, signature };
}

/** A gossip-frame bundling several peer-adverts at once -- the exact shape relay-hub's own catch-up mechanism sends back to a gossiping connection, listing every other currently-known device in one frame rather than one frame per device. */
export function gossipForMany(...adverts: readonly PeerAdvert[]): Frame {
  return { type: "gossip", peers: [...adverts] };
}
