import type { Frame } from "../src/generated/protocol.js";
import type { Clock } from "../src/ports/clock.js";
import type { IdentityPort } from "../src/ports/identity.js";
import type {
  Connection,
  Listener,
  Transport,
} from "../src/ports/transport.js";
import type { createMeshSession } from "../src/domain/mesh-session.js";
import { deviceIdFromFillHex } from "./hex.js";

export const deviceA = deviceIdFromFillHex("11");
export const deviceB = deviceIdFromFillHex("22");
export const deviceC = deviceIdFromFillHex("33");

export const testIdentityDeviceId = deviceIdFromFillHex("ee");
export const testIdentity: IdentityPort = {
  deviceId: testIdentityDeviceId,
  identityKey: { alg: -7, "public-key": new Uint8Array() },
  sign: async () => Promise.resolve(new Uint8Array()),
  verify: async () => Promise.resolve(true),
  deriveDeviceId: async () => Promise.resolve(testIdentityDeviceId),
};
export const MS_PER_SECOND = 1000;
export const TEST_CLOCK_NOW_MS = 1_700_000_000_000;
export const testClock: Clock = { now: () => TEST_CLOCK_NOW_MS };

// Event-stream positions: connect() emits connecting + connected, then a self-advert-sent tick, then one event per pushed frame, timeout, or failure.
export const EVENTS_THROUGH_REMOTE_HANDSHAKE = 4;
export const EVENTS_THROUGH_TIMEOUT = 4;
export const EVENTS_THROUGH_THREE_GOSSIPS = 6;
export const EVENTS_THROUGH_PING_ROUND_TRIP = 5;
export const EVENTS_THROUGH_FAILURE = 4;
export const SNAPSHOT_FIRST = 100;
export const SNAPSHOT_SECOND = 200;
export const SNAPSHOT_UPDATED = 300;

// Reconnect-flow event-stream positions: each reconnect round emits connecting + connected(pending) + self-advert-sent, then either a further reconnecting (retrying) or closed (attempts exhausted) event.
export const RECONNECT_DELAY_MS = 100;
export const RECONNECT_MAX_ATTEMPTS = 2;
export const EVENTS_THROUGH_FIRST_RECONNECT = 4;
export const EVENTS_PER_RECONNECT_ROUND = 4;
export const EVENTS_THROUGH_STALE_TIMER_REGRESSION = 8;

// capability-tokens/manage-request plumbing: arbitrary distinct signature/request-id byte values, and the manage-request's own reply-timeout duration.
export const TEST_TOKEN_SIGNATURE_BYTE = 3;
export const TEST_INCOMING_REQUEST_ID = 7;
export const OVERRIDE_TOKEN_BYTE = 9;
export const MANAGE_REQUEST_TIMEOUT_MS = 5000;

/** An in-memory Connection the test drives: pushes arrive on the receive iteration, sends are recorded. */
export class FakeConnection {
  sent: Frame[] = [];
  private readonly inbound: Frame[] = [];
  private ended = false;
  private failure: Error | null = null;

  get connection(): Readonly<Connection> {
    return {
      send: async (frame: Frame): Promise<void> => {
        this.sent.push(frame);
        return Promise.resolve();
      },
      receive: () => this.stream(),
      close: async (): Promise<void> => {
        this.ended = true;
        this.wake();
        return Promise.resolve();
      },
    };
  }

  /** True once this connection's own close() has actually been invoked -- lets a test assert that a caller closed the link, distinct from the link merely ending its receive stream on its own (see endStream). */
  get isClosed(): boolean {
    return this.ended;
  }

  /** Ends the receive stream as if the remote hung up cleanly, without going through this side's own close() -- unlike close(), this leaves the session's own state untouched so a test can observe how the session itself reacts to a graceful remote end. */
  endStream(): void {
    this.ended = true;
    this.wake();
  }

  push(frame: Frame): void {
    this.inbound.push(frame);
    this.wake();
  }

  fail(error: Error): void {
    this.failure = error;
    this.wake();
  }

  private readonly wakeWaiters: (() => void)[] = [];

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
    for (;;) {
      const next = this.inbound.shift();
      if (next !== undefined) {
        return { value: next, done: false };
      }
      if (this.failure !== null) {
        throw this.failure;
      }
      if (this.ended) {
        return { value: undefined, done: true };
      }
      await new Promise<void>((resolve) => {
        this.wakeWaiters.push(resolve);
      });
    }
  }
}

export function fakeTransport(): {
  transport: Transport;
  connection: FakeConnection;
} {
  const connection = new FakeConnection();
  const transport: Transport = {
    connect: async (address: string): Promise<Connection> => {
      if (address !== "ws://node") {
        return Promise.reject(new Error(`connect to ${address} failed`));
      }
      return Promise.resolve(connection.connection);
    },
    listen: async (): Promise<Listener> =>
      Promise.reject(new Error("client-only transport")),
  };
  return { transport, connection };
}

/** A transport that hands out a fresh FakeConnection on every connect() call, so one attempt's failure doesn't leak into the next -- unlike fakeTransport()'s single shared connection, which stays broken forever once failed. */
export function multiConnectionTransport(): {
  transport: Transport;
  connections: FakeConnection[];
} {
  const connections: FakeConnection[] = [];
  const transport: Transport = {
    connect: async (address: string): Promise<Connection> => {
      if (address !== "ws://node") {
        return Promise.reject(new Error(`connect to ${address} failed`));
      }
      const next = new FakeConnection();
      connections.push(next);
      return Promise.resolve(next.connection);
    },
    listen: async (): Promise<Listener> =>
      Promise.reject(new Error("client-only transport")),
  };
  return { transport, connections };
}

/** Narrows an IteratorResult to its yielded value, failing the test outright if the iterator has actually ended -- none of this file's own async iterators ever end, so a done:true result always indicates a broken assumption in the test itself, never legitimate data. */
export function yielded<T>(result: IteratorResult<T>): T {
  if (result.done === true) {
    throw new Error("expected the iterator to yield a value, got done: true");
  }
  return result.value;
}

export const TIMEOUT_MARKER = "timeout" as const;
export const SHORT_WAIT_MS = 20;

/** Races a promise against a short real-time wait, resolving to TIMEOUT_MARKER if the promise hasn't settled yet -- used to prove a promise genuinely settled *now*, from the action just taken, rather than merely settling *eventually* by some unrelated later event (e.g. a trailing session.close() emitting one final event that would otherwise silently satisfy an unconsumed waiter and mask a missing emit() call). */
export async function withinShortWait<T>(
  promise: Readonly<Promise<T>>,
): Promise<T | typeof TIMEOUT_MARKER> {
  return Promise.race([
    promise,
    new Promise<typeof TIMEOUT_MARKER>((resolve) => {
      setTimeout(() => {
        resolve(TIMEOUT_MARKER);
      }, SHORT_WAIT_MS);
    }),
  ]);
}

/** Resolves after the session has emitted at least `count` events, returning the latest. */
export async function nthEvent(
  session: ReturnType<typeof createMeshSession>,
  count: number,
): Promise<unknown> {
  const iterator = session.events[Symbol.asyncIterator]();
  let last: unknown = null;
  for (let i = 0; i < count; i++) {
    const result = await iterator.next();
    last = result.value;
  }
  return last;
}

export function gossipFor(
  device: Uint8Array<ArrayBuffer>,
  seconds = 1861833600,
): Frame {
  return {
    type: "gossip",
    peers: [
      { device, addresses: ["203.0.113.5:4433"], "snapshot-seconds": seconds },
    ],
  };
}
