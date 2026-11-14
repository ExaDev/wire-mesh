// A scripted relay between two or more endpoints that each hold their own secure channels (spec/secure-channel.cddl), for tests of the handshake rules. Every hello and every sealed frame is queued rather than delivered, so a test delivers them in any order, any number of times, or never, and counts the hellos each side sent. An endpoint is either the current implementation or a model of the previous release's rule, which answers any hello whose key differs from its current one and replaces its channel as soon as it has completed one.

import { afterEach, beforeEach, vi } from "vitest";
import type {
  DeviceId,
  Frame,
  SecureDataFrame,
  SecureHelloFrame,
} from "../src/generated/protocol.js";
import type { Clock } from "../src/ports/clock.js";
import type { IdentityPort } from "../src/ports/identity.js";
import { deviceIdToHex } from "../src/domain/device-id.js";
import {
  createRelayChannels,
  type FaultContext,
  type OpenedFrame,
  type SealPurpose,
} from "../src/domain/relay-channels.js";
import {
  beginHandshake,
  establishChannelFrom,
  verifyHello,
  type PendingHandshake,
  type SecureChannel,
} from "../src/domain/secure-channel.js";
import { generateEd25519Identity } from "./tokens-fixtures.js";

const TICK_MS = 0;
const FLUSH_TICKS = 4;
const PUMP_ROUNDS = 30;
const TAKE_INTERVAL_MS = 1;
const TAKE_TIMEOUT_MS = 5_000;

/** A clock that only moves when a test moves it. */
export class ManualClock implements Clock {
  private time = 0;

  now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

/** What an endpoint offers the relay: the same three operations a session uses. */
interface Endpoint {
  seal: (
    peer: DeviceId,
    frame: Frame,
    purpose: SealPurpose,
  ) => Promise<readonly SecureDataFrame[]>;
  applyHello: (
    hello: Readonly<SecureHelloFrame>,
    from: DeviceId | undefined,
  ) => Promise<void>;
  open: (
    data: Readonly<SecureDataFrame>,
    from: DeviceId | undefined,
  ) => Promise<OpenedFrame | undefined>;
  forget: (peer: DeviceId) => void;
}

export interface HelloRecord {
  readonly kind: "hello";
  readonly from: Node;
  /** Absent when the hello was addressed to a device the relay holds no node for. */
  readonly to: Node | undefined;
  readonly hello: SecureHelloFrame;
}

export interface DataRecord {
  readonly kind: "data";
  readonly from: Node;
  readonly to: Node;
  readonly data: SecureDataFrame;
}

async function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, TICK_MS);
  });
}

/** Lets everything that can settle without a timer settle. */
export async function flush(ticks = FLUSH_TICKS): Promise<void> {
  if (ticks > 0) {
    await tick();
    await flush(ticks - 1);
  }
}

/** The model of the previous release's channel handling: a hello whose key is not the current channel's is answered, unless this side's own hello is already out, and the channel it completes replaces the current one at once. */
class ReleasedChannels implements Endpoint {
  private channel:
    { channel: SecureChannel; remoteKey: Uint8Array } | undefined;

  private pending: PendingHandshake | undefined;

  private waiting: PromiseWithResolvers<SecureChannel> | undefined;

  constructor(
    private readonly identity: Readonly<IdentityPort>,
    private readonly sendHello: (
      peer: DeviceId,
      hello: SecureHelloFrame,
    ) => Promise<void>,
  ) {}

  private async start(peer: DeviceId): Promise<void> {
    const mine = await beginHandshake(this.identity, peer);
    this.pending = mine;
    this.waiting ??= Promise.withResolvers<SecureChannel>();
    await this.sendHello(peer, mine.hello);
  }

  async seal(
    peer: DeviceId,
    frame: Frame,
  ): Promise<readonly SecureDataFrame[]> {
    if (this.channel === undefined) {
      if (this.pending === undefined) {
        await this.start(peer);
      }
      await this.waiting?.promise;
    }

    if (this.channel === undefined) {
      throw new Error("no channel");
    }

    return [await this.channel.channel.seal(frame)];
  }

  forget(): void {
    this.channel = undefined;
    this.pending = undefined;
  }

  async applyHello(hello: Readonly<SecureHelloFrame>): Promise<void> {
    const verdict = await verifyHello(this.identity, hello);
    if (!verdict.ok) {
      return;
    }
    const key = hello["ephemeral-key"];
    if (this.channel?.remoteKey.every((byte, i) => byte === key[i]) === true) {
      return;
    }
    if (this.pending === undefined) {
      await this.start(verdict.peer.deviceId);
    }
    const mine = this.pending;
    if (mine === undefined) {
      return;
    }
    const channel = await establishChannelFrom(this.identity, {
      pending: mine,
      remote: hello,
      peer: verdict.peer,
    });
    if (channel === undefined) {
      return;
    }
    this.channel = { channel, remoteKey: key };
    this.pending = undefined;
    this.waiting?.resolve(channel);
    this.waiting = undefined;
  }

  async open(
    data: Readonly<SecureDataFrame>,
  ): Promise<OpenedFrame | undefined> {
    const frame = await this.channel?.channel.open(data);

    return frame === undefined || this.channel === undefined
      ? undefined
      : { frame, from: this.channel.channel.peer.deviceId };
  }
}

export interface NodeOptions {
  readonly kind?: "current" | "released";
  readonly identity?: IdentityPort;
  readonly firstSendCounter?: number;
  readonly onFault?: (
    error: unknown,
    context: FaultContext,
  ) => void | Promise<void>;
  readonly newHandshake?: (peer: DeviceId) => Promise<PendingHandshake>;
}

/** One party: its identity, its endpoint, and the hellos it has sent. */
export class Node {
  readonly hellosSent: HelloRecord[] = [];

  /** Makes this node's sends of its own hello fail, as a link that stopped accepting writes does. */
  failSends = false;

  /** Makes this node's signing fail. */
  failSigning = false;

  readonly identity: IdentityPort;

  private readonly endpoint: Endpoint;

  constructor(
    readonly name: string,
    readonly relay: TestRelay,
    base: IdentityPort,
    options: NodeOptions,
  ) {
    this.identity = {
      ...base,
      sign: async (data) =>
        this.failSigning
          ? Promise.reject(new Error("the key is locked"))
          : base.sign(data),
    };
    const sendHello = async (
      peer: DeviceId,
      hello: SecureHelloFrame,
    ): Promise<void> => {
      if (this.failSends) {
        throw new Error("the link stopped accepting writes");
      }
      const record: HelloRecord = {
        kind: "hello",
        from: this,
        to: relay.nodeFor(peer),
        hello,
      };
      this.hellosSent.push(record);
      relay.queue.push(record);

      return Promise.resolve();
    };
    this.endpoint =
      options.kind === "released"
        ? new ReleasedChannels(this.identity, sendHello)
        : createRelayChannels(this.identity, sendHello, relay.clock, {
            ...(options.firstSendCounter === undefined
              ? {}
              : { firstSendCounter: options.firstSendCounter }),
            ...(options.onFault === undefined
              ? {}
              : { onFault: options.onFault }),
            ...(options.newHandshake === undefined
              ? {}
              : { newHandshake: options.newHandshake }),
          });
  }

  get deviceId(): DeviceId {
    return this.identity.deviceId;
  }

  /** Seals a frame for `to`, delivering the hellos that makes needed until it has resolved, and returns the sealed frames without delivering them. */
  async send(
    to: Node,
    frame: Frame,
    purpose: SealPurpose = "request",
  ): Promise<DataRecord[]> {
    let done = false;
    const sealing = this.endpoint
      .seal(to.deviceId, frame, purpose)
      .finally(() => {
        done = true;
      });
    void sealing.catch(() => undefined);
    await this.relay.pumpUntil(() => done);

    return (await sealing).map((data) => ({
      kind: "data",
      from: this,
      to,
      data,
    }));
  }

  /** Starts sealing without delivering anything, so a test decides the order hellos arrive in. */
  async beginSend(
    to: Node,
    frame: Frame,
    purpose: SealPurpose = "request",
  ): Promise<readonly DataRecord[]> {
    const sealing = this.endpoint
      .seal(to.deviceId, frame, purpose)
      .then((sealed) =>
        sealed.map((data): DataRecord => ({
          kind: "data",
          from: this,
          to,
          data,
        })),
      );
    void sealing.catch(() => undefined);

    return sealing;
  }

  forget(peer: Node): void {
    this.endpoint.forget(peer.deviceId);
  }

  /** Delivers a hello to this node as the relay would, stamped with the sender's device-id unless told otherwise. */
  async receiveHello(
    hello: SecureHelloFrame,
    from: DeviceId | undefined,
  ): Promise<void> {
    await this.endpoint.applyHello(hello, from);
  }

  async receiveData(record: DataRecord): Promise<OpenedFrame | undefined> {
    return this.endpoint.open(record.data, record.from.deviceId);
  }

  async open(
    data: SecureDataFrame,
    from: DeviceId | undefined,
  ): Promise<OpenedFrame | undefined> {
    return this.endpoint.open(data, from);
  }
}

export class TestRelay {
  readonly clock = new ManualClock();

  readonly queue: HelloRecord[] = [];

  private readonly nodes = new Map<string, Node>();

  async node(name: string, options: NodeOptions = {}): Promise<Node> {
    const node = new Node(
      name,
      this,
      options.identity ?? (await generateEd25519Identity()),
      options,
    );
    this.nodes.set(deviceIdToHex(node.deviceId), node);

    return node;
  }

  /** A node that takes over the identity of `old` with nothing remembered, as a restarted process does. */
  async restart(old: Node, options: NodeOptions = {}): Promise<Node> {
    return this.node(old.name, { ...options, identity: old.identity });
  }

  nodeFor(device: DeviceId): Node | undefined {
    return this.nodes.get(deviceIdToHex(device));
  }

  /** Waits until `count` hellos are queued, then removes and returns them without delivering any. */
  async take(count = 1): Promise<HelloRecord[]> {
    await vi.waitFor(
      () => {
        if (this.queue.length < count) {
          throw new Error("the hellos have not been sent yet");
        }
      },
      { interval: TAKE_INTERVAL_MS, timeout: TAKE_TIMEOUT_MS },
    );

    return this.queue.splice(0, count);
  }

  /** Delivers one queued hello to its addressee, as stamped by the relay. */
  async deliver(record: HelloRecord): Promise<void> {
    await record.to?.receiveHello(record.hello, record.from.deviceId);
    await flush();
  }

  /** Delivers every queued hello in the order sent, including those that delivery itself queues, until none is left. */
  async pump(rounds = PUMP_ROUNDS): Promise<void> {
    const next = this.queue.shift();
    if (next !== undefined && rounds > 0) {
      await this.deliver(next);
      await this.pump(rounds - 1);
    }
  }

  async pumpUntil(done: () => boolean, rounds = PUMP_ROUNDS): Promise<void> {
    await flush();
    if (!done() && rounds > 0) {
      await this.pump();
      await this.pumpUntil(done, rounds - 1);
    }
  }
}

/** Two nodes that have exchanged a request and its reply, so each holds a confirmed channel. */
export async function establish(a: Node, b: Node): Promise<void> {
  const request = await a.send(b, { type: "ping" });
  await Promise.all(request.map(async (record) => b.receiveData(record)));
  const reply = await b.send(a, { type: "pong" }, "reply");
  await Promise.all(reply.map(async (record) => a.receiveData(record)));
}

/** A hello from `from` to `to` that nobody has seen, with the channel state it would start discarded. */
export async function freshHello(
  from: IdentityPort,
  to: Node,
): Promise<SecureHelloFrame> {
  return (await beginHandshake(from, to.deviceId)).hello;
}

/** Records every rejection nobody handled, for the test to assert empty. */
export function useUnhandledRecorder(): () => readonly unknown[] {
  let reasons: unknown[] = [];
  const record = (reason: unknown): void => {
    reasons.push(reason);
  };
  beforeEach(() => {
    reasons = [];
    process.on("unhandledRejection", record);
  });
  afterEach(() => {
    process.off("unhandledRejection", record);
  });

  return () => reasons;
}
