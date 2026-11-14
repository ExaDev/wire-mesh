/* The secure channels a MeshSession holds with the devices it reaches through a relay (spec/secure-channel.cddl), one entry per peer, and the state machine that opens them. secure-channel.ts is the crypto; this decides when to start a handshake, whose hello completes which, when a new channel replaces the current one, and which channel a received frame belongs to. Kept out of mesh-session.ts, which only says how a hello reaches the wire and what to do with a frame once it has been opened.

   A hello never replaces a channel by itself. It builds a candidate beside the current channel, and the candidate takes over only once a frame from the peer opens under it, which only a holder of the candidate's other ephemeral secret can produce. A side that has a handshake of its own outstanding with a peer completes a received hello against it instead of answering, so two sides that both hold channels never answer each other without end. */

import type {
  DeviceId,
  Frame,
  SecureDataFrame,
  SecureHelloFrame,
} from "../generated/protocol.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import { deviceIdToHex } from "./device-id.js";
import { ChannelExhaustedError } from "./channel-exhausted-error.js";
import { bytesEqual } from "./token-scope.js";
import {
  assertFirstSendCounter,
  beginHandshake,
  establishChannelFrom,
  isUsableEphemeralKey,
  verifyHello,
  type OpenOutcome,
  type PendingHandshake,
  type SecureChannel,
  type SecureChannelPeer,
} from "./secure-channel.js";

/** How long a peer may take to answer a hello, and the window every other rule here is measured in: a handshake is outstanding for this long, a replaced channel may still open frames that were in flight for this long, and an entry younger than this is never reused. Whoever holds a hello for longer than this gains nothing, since the handshake it belongs to is over. */
export const HANDSHAKE_WINDOW_MS = 3_000;

/** The most channels one handshake builds. An honest handshake yields one fresh hello for this side's ephemeral key. A second arises in exactly one honest case: the peer restarted while this side's hello was in flight and its new hello also arrived. A third is never honest, so beyond this a hello is dropped. */
export const CANDIDATES_PER_HANDSHAKE = 2;

/** The most handshakes this side leaves pending for its own sends at once. A local resource budget: peers cannot reach it, only what the local application sends to. Past it the oldest pending handshake is dropped and whoever awaits it is told. */
export const MAX_PENDING_HANDSHAKES = 256;

/** The most entries held for peers this side never sent anything to. A memory and CPU budget for peers this side did not choose; no safety property depends on its value, since peers this side chose are outside it. Each entry is at most one established channel, one replaced channel, one handshake and CANDIDATES_PER_HANDSHAKE candidates. It also caps the answers to such peers per handshake window, because an entry younger than the window is never reused, and the reports passed to `onFault` per window. */
export const MAX_UNSOLICITED_PEERS = 64;

/** What a sealed frame is for: a "request" is this side choosing to talk to the peer, a "reply" answers a frame that peer sent and does not make the peer chosen. */
export type SealPurpose = "request" | "reply";

/** A frame that opened under a peer's channel, with the peer that channel authenticated. */
export interface OpenedFrame {
  readonly frame: Frame;
  readonly from: DeviceId;
}

/** What `onFault` is told besides the error. */
export interface FaultContext {
  /** The peer the failing hello or send was for, when it is known by then. */
  readonly peer: DeviceId | undefined;
  /** How many reports for this peer were withheld since the last one: at most one report per peer is made per handshake window. */
  readonly suppressed: number;
}

export interface RelayChannels {
  /** Seals one frame for peer, starting a handshake when there is no channel and none is outstanding. Resolves with one sealed frame, or with one per candidate channel while this side has no established channel and holds several, which the peer opens at most one of. A "request" marks the peer chosen. */
  seal: (
    peer: DeviceId,
    frame: Frame,
    purpose: SealPurpose,
  ) => Promise<readonly SecureDataFrame[]>;
  /** Handles a hello received through a relay pairing, `claimedFrom` being the `from-device` the relay stamped. The hello is dropped, changing nothing and sending nothing, unless the device-id its identity-key hashes to is `claimedFrom`, its signature verifies, its ephemeral key is usable and is not one this side already holds for that peer. Otherwise it is completed against this side's own outstanding handshake with that peer, or, when there is none, answered with a hello of this side's own. Either way it yields a candidate beside any current channel; nothing is replaced until a frame opens under the candidate. Nothing that happens while handling a hello rejects the returned promise or reaches the peer: a failure of this side is reported to `onFault` and abandons only the handshake it was part of. */
  applyHello: (
    hello: Readonly<SecureHelloFrame>,
    claimedFrom: DeviceId | undefined,
  ) => Promise<void>;
  /** Opens sealed data received through a relay pairing. `claimedFrom` is the `from-device` the relay stamped, which only picks the entry to try; the result is undefined unless the frame opens under one of that entry's channels, and names the peer that channel authenticated. A frame that opens under a candidate makes it the current channel. */
  open: (
    data: Readonly<SecureDataFrame>,
    claimedFrom: DeviceId | undefined,
  ) => Promise<OpenedFrame | undefined>;
  /** Forgets every peer, abandoning handshakes still waiting: channels are tied to the connection they were set up on. */
  reset: (reason: string) => void;
  /** Forgets one peer, so the next request to it starts afresh. */
  forget: (peer: DeviceId) => void;
}

/** A channel built from this side's own handshake and one remote hello, with that hello's ephemeral key. */
interface Candidate {
  readonly channel: SecureChannel;
  readonly remoteKey: Uint8Array;
}

/** This side's own hello to one peer, from the moment it is begun until a candidate is confirmed or the window passes. */
interface Handshake {
  readonly mine: Promise<PendingHandshake>;
  /** "initiated" by a local send, "answered" for a received hello. */
  readonly origin: "initiated" | "answered";
  readonly sentAt: number;
  readonly cands: Candidate[];
  /** Settles once the hello has gone out, and rejects if it could not be signed or sent. Observed from creation. */
  readonly sent: PromiseWithResolvers<undefined>;
  /** Set when the window passed with nothing from the peer, so the handshake no longer suppresses answers. */
  expired: boolean;
}

interface Current {
  readonly channel: SecureChannel;
  readonly remoteKey: Uint8Array;
  confirmed: boolean;
}

interface Replaced {
  readonly channel: SecureChannel;
  readonly remoteKey: Uint8Array;
  readonly until: number;
}

/** Everything held for one peer. The fields only change through the methods, so each transition has one place. */
class PeerChannels {
  chosen = false;

  lastUsed: number;

  /** The current channel: sealing goes through it and only it. */
  current: Current | undefined;

  /** The channel the current one replaced, which may still open frames that were in flight but never seals. */
  replaced: Replaced | undefined;

  hs: Handshake | undefined;

  /** The candidates of a handshake that ended without confirming either of two, which together serve as the channel until a frame opens under one. */
  pool: Candidate[] = [];

  private waiters: PromiseWithResolvers<undefined> | undefined;

  private opening: Promise<unknown> = Promise.resolve();

  constructor(
    readonly peer: DeviceId,
    now: number,
  ) {
    this.lastUsed = now;
  }

  get key(): string {
    return deviceIdToHex(this.peer);
  }

  touch(now: number): void {
    this.lastUsed = now;
  }

  choose(): void {
    this.chosen = true;
  }

  /** True when `key` is the remote ephemeral key of anything held for the peer. */
  holdsKey(key: Uint8Array): boolean {
    return [
      this.current?.remoteKey,
      this.replaced?.remoteKey,
      ...(this.hs?.cands ?? []).map((cand) => cand.remoteKey),
      ...this.pool.map((cand) => cand.remoteKey),
    ].some((held) => held !== undefined && bytesEqual(held, key));
  }

  /** Whether this side's handshake with the peer is outstanding: sent less than a window ago, and neither confirmed nor ended. */
  outstanding(now: number): boolean {
    return (
      this.hs !== undefined &&
      !this.hs.expired &&
      now < this.hs.sentAt + HANDSHAKE_WINDOW_MS
    );
  }

  /** Applies whatever the passing of time has ended: the replaced channel after its window, and a handshake after its window. Checked on every event, so no timer is needed. */
  expire(now: number): void {
    if (this.replaced !== undefined && now >= this.replaced.until) {
      this.replaced = undefined;
    }
    const { hs } = this;
    if (
      hs === undefined ||
      hs.expired ||
      now < hs.sentAt + HANDSHAKE_WINDOW_MS
    ) {
      return;
    }
    const [only, ...rest] = hs.cands;
    if (this.current !== undefined) {
      // Nothing confirmed a candidate: the current channel stays.
      this.hs = undefined;
    } else if (only === undefined) {
      hs.expired = true;
    } else if (rest.length === 0) {
      this.current = { ...only, confirmed: false };
      this.hs = undefined;
    } else {
      this.pool = hs.cands;
      this.hs = undefined;
    }
  }

  /** The candidates a received frame is tried against, in order. */
  candidates(): readonly Candidate[] {
    return [...(this.hs?.cands ?? []), ...this.pool];
  }

  begin(hs: Handshake): void {
    this.hs = hs;
  }

  /** Ends `hs` if it is still this peer's handshake. */
  end(hs: Handshake): boolean {
    if (this.hs !== hs) {
      return false;
    }
    this.hs = undefined;

    return true;
  }

  confirmCurrent(): void {
    if (this.current !== undefined) {
      this.current.confirmed = true;
    }
  }

  /** A frame opened under `cand`: it becomes the current channel, the channel it replaces may open in-flight frames for a window, and every other candidate goes. */
  confirm(cand: Candidate, now: number): void {
    if (this.current !== undefined) {
      this.replaced = {
        channel: this.current.channel,
        remoteKey: this.current.remoteKey,
        until: now + HANDSHAKE_WINDOW_MS,
      };
    }
    this.current = { ...cand, confirmed: true };
    this.hs = undefined;
    this.pool = [];
  }

  /** Forgets the current channel when it is the one that is spent. */
  clearCurrent(channel: SecureChannel): void {
    if (this.current?.channel === channel) {
      this.current = undefined;
    }
  }

  isEmpty(): boolean {
    return (
      this.current === undefined &&
      this.replaced === undefined &&
      this.hs === undefined &&
      this.pool.length === 0
    );
  }

  /** Resolves once some candidate exists. */
  async waitForChannel(): Promise<undefined> {
    this.waiters ??= (() => {
      const waiting = Promise.withResolvers<undefined>();
      void waiting.promise.catch(() => undefined);

      return waiting;
    })();

    return this.waiters.promise;
  }

  releaseWaiters(): void {
    this.waiters?.resolve(undefined);
    this.waiters = undefined;
  }

  rejectWaiters(error: Error): void {
    this.waiters?.reject(error);
    this.waiters = undefined;
  }

  /** Runs `task` after every earlier one for this peer: two frames opening at once must not both be tried before either has settled what it confirms. */
  async serialise<T>(task: () => Promise<T>): Promise<T> {
    const run = this.opening.then(task);
    this.opening = run.catch(() => undefined);

    return run;
  }
}

function authentic(outcome: OpenOutcome): boolean {
  // An authentic frame whose plaintext is not a frame still proves the sender holds the keys.
  return outcome.ok || outcome.reason === "undecodable";
}

async function openFirst(
  cands: readonly Candidate[],
  data: Readonly<SecureDataFrame>,
): Promise<{ cand: Candidate; outcome: OpenOutcome } | undefined> {
  const [first, ...rest] = cands;
  if (first === undefined) {
    return undefined;
  }
  const outcome = await first.channel.openOutcome(data);

  return authentic(outcome) ? { cand: first, outcome } : openFirst(rest, data);
}

export function createRelayChannels(
  identity: Readonly<IdentityPort>,
  /** Puts a hello on the wire for peer. Rejects when there is no connection to put it on. */
  sendHello: (peer: DeviceId, hello: SecureHelloFrame) => Promise<void>,
  clock: Readonly<Clock>,
  options: Readonly<{
    /** Where each channel's send counter starts: only for tests that must reach the counter's bound, see establishChannelFrom. */
    firstSendCounter?: number;
    /** Told of a failure that is local to this side and is not the peer's doing, while handling a hello or sending this side's own: an identity port that failed to check or sign, a hello that could not be sent, a channel that could not be established. At most one report is made per peer per handshake window, with the number withheld since the last in the context, and at most MAX_UNSOLICITED_PEERS across all peers, so it must be cheap rather than rate limited by its owner. If it throws, or returns a promise that rejects, that is reported once per window to the console and swallowed. The hello is dropped and nothing is sent to the peer. */
    onFault?:
      | ((error: unknown, context: FaultContext) => void | Promise<void>)
      | undefined;
    /** Test-only: supplies each new handshake's ephemeral key pair and nonce, so a scenario is deterministic. */
    newHandshake?: (peer: DeviceId) => Promise<PendingHandshake>;
  }> = {},
): RelayChannels {
  if (options.firstSendCounter !== undefined) {
    assertFirstSendCounter(options.firstSendCounter);
  }
  const newHandshake =
    options.newHandshake ??
    (async (peer: DeviceId): Promise<PendingHandshake> =>
      beginHandshake(identity, peer));
  const peers = new Map<string, PeerChannels>();

  // Fault reporting: one report per peer per window, with the count withheld; the state of a peer that no longer has an entry is kept in a small table of its own.
  const faultWindows = new Map<string, { start: number; suppressed: number }>();
  let reports = { start: Number.NEGATIVE_INFINITY, count: 0 };
  let lastConsoleReport = Number.NEGATIVE_INFINITY;

  function reportToConsole(faultError: unknown): void {
    const now = clock.now();
    if (now - lastConsoleReport < HANDSHAKE_WINDOW_MS) {
      return;
    }
    lastConsoleReport = now;
    console.error("the local fault callback failed", faultError);
  }

  /** Tells the owner of a failure that is local to this side. The callback is the owner's code: its own failure, thrown or as a rejected promise it returns, must not end the session or go unobserved, so it is reported to the console and swallowed. */
  function reportFault(error: unknown, peer: DeviceId | undefined): void {
    const now = clock.now();
    const id = peer === undefined ? "" : deviceIdToHex(peer);
    const held = faultWindows.get(id);
    const overall =
      now - reports.start < HANDSHAKE_WINDOW_MS
        ? reports
        : { start: now, count: 0 };
    reports = overall;
    if (
      (held !== undefined && now - held.start < HANDSHAKE_WINDOW_MS) ||
      overall.count >= MAX_UNSOLICITED_PEERS
    ) {
      faultWindows.set(id, {
        start: held?.start ?? Number.NEGATIVE_INFINITY,
        suppressed: (held?.suppressed ?? 0) + 1,
      });

      return;
    }
    reports = { start: overall.start, count: overall.count + 1 };
    faultWindows.delete(id);
    faultWindows.set(id, { start: now, suppressed: 0 });
    const [oldest] = faultWindows.keys();
    if (faultWindows.size > MAX_UNSOLICITED_PEERS && oldest !== undefined) {
      faultWindows.delete(oldest);
    }
    try {
      const result: unknown = options.onFault?.(error, {
        peer,
        suppressed: held?.suppressed ?? 0,
      });
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result &&
        typeof result.then === "function"
      ) {
        void Promise.resolve(result).catch(reportToConsole);
      }
    } catch (faultError) {
      reportToConsole(faultError);
    }
  }

  function prune(entry: PeerChannels): void {
    if (entry.isEmpty() && !entry.chosen && peers.get(entry.key) === entry) {
      peers.delete(entry.key);
    }
  }

  /** Ends this side's handshake `hs` with the peer, leaving every channel as it is, and tells whoever waits for a channel when there is none to wait for. */
  function dropHandshake(
    entry: PeerChannels,
    hs: Handshake,
    error: unknown,
  ): void {
    if (!entry.end(hs)) {
      return;
    }
    const failure = error instanceof Error ? error : new Error(String(error));
    hs.sent.reject(failure);
    if (entry.current === undefined && entry.pool.length === 0) {
      entry.rejectWaiters(failure);
    }
    prune(entry);
  }

  /** Drops every handshake that is waiting for its first answer beyond MAX_PENDING_HANDSHAKES, oldest first. */
  function enforcePendingBound(keep: PeerChannels): void {
    const pending = [...peers.values()].filter(
      (entry) =>
        entry.hs?.origin === "initiated" &&
        entry.hs.cands.length === 0 &&
        entry.current === undefined,
    );
    const excess = pending
      .filter((entry) => entry !== keep)
      .sort((a, b) => (a.hs?.sentAt ?? 0) - (b.hs?.sentAt ?? 0))
      .slice(0, Math.max(0, pending.length - MAX_PENDING_HANDSHAKES));
    for (const entry of excess) {
      if (entry.hs !== undefined) {
        dropHandshake(
          entry,
          entry.hs,
          new Error("the handshake was dropped to make room for others"),
        );
      }
    }
  }

  /** Begins this side's own hello to the entry's peer and registers it at once, so a hello arriving meanwhile completes it instead of starting another. */
  function beginOwn(
    entry: PeerChannels,
    origin: Handshake["origin"],
  ): Handshake {
    const mine = newHandshake(entry.peer);
    const hs: Handshake = {
      mine,
      origin,
      sentAt: clock.now(),
      cands: [],
      sent: Promise.withResolvers<undefined>(),
      expired: false,
    };
    // Observed from the start: whoever awaits it sees the rejection through their own handler, and one that does not must not leave it unhandled.
    void hs.sent.promise.catch(() => undefined);
    entry.begin(hs);
    void mine.then(
      async ({ hello }) => {
        try {
          await sendHello(entry.peer, hello);
        } catch (error) {
          dropHandshake(entry, hs, error);
          if (origin === "answered") {
            reportFault(error, entry.peer);
          }

          return;
        }
        hs.sent.resolve(undefined);
      },
      // Signing failed. A received hello being handled sees the same rejection through `hs.mine` and reports it.
      (error: unknown) => {
        dropHandshake(entry, hs, error);
      },
    );

    return hs;
  }

  /** Builds the channel `hello` makes with this side's handshake `hs`, and holds it as a candidate. */
  async function addCandidate(
    entry: PeerChannels,
    hs: Handshake,
    hello: Readonly<SecureHelloFrame>,
    peer: SecureChannelPeer,
  ): Promise<void> {
    const pending = await hs.mine;
    const channel = await establishChannelFrom(identity, {
      pending,
      remote: hello,
      peer,
      ...(options.firstSendCounter === undefined
        ? {}
        : { firstSendCounter: options.firstSendCounter }),
    });
    if (
      channel === undefined ||
      entry.hs !== hs ||
      peers.get(entry.key) !== entry ||
      hs.cands.length >= CANDIDATES_PER_HANDSHAKE ||
      entry.holdsKey(hello["ephemeral-key"])
    ) {
      return;
    }
    hs.cands.push({ channel, remoteKey: hello["ephemeral-key"] });
    entry.releaseWaiters();
  }

  /** Makes room for a peer this side never sent anything to. An entry is reused only once it is older than the window, so answers cannot outpace the turnover of slots. */
  function reserveUnsolicitedSlot(now: number): boolean {
    const unsolicited = [...peers.values()].filter((entry) => !entry.chosen);
    if (unsolicited.length < MAX_UNSOLICITED_PEERS) {
      return true;
    }
    const [victim] = unsolicited
      .filter((entry) => now - entry.lastUsed >= HANDSHAKE_WINDOW_MS)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    if (victim === undefined) {
      return false;
    }
    discard(victim, new Error("the entry was dropped to make room for others"));

    return true;
  }

  function discard(entry: PeerChannels, error: Error): void {
    peers.delete(entry.key);
    entry.hs?.sent.reject(error);
    entry.rejectWaiters(error);
  }

  async function sealUnder(
    entry: PeerChannels,
    channel: SecureChannel,
    frame: Frame,
  ): Promise<SecureDataFrame> {
    try {
      return await channel.seal(frame);
    } catch (error) {
      // A channel whose send counter is spent can seal nothing more. Forgetting it makes the next send to this peer start a new handshake, with a fresh counter, instead of failing for good.
      if (error instanceof ChannelExhaustedError) {
        entry.clearCurrent(channel);
      }
      throw error;
    }
  }

  async function sealFor(
    entry: PeerChannels,
    frame: Frame,
  ): Promise<readonly SecureDataFrame[]> {
    entry.expire(clock.now());
    entry.touch(clock.now());
    const { current, hs } = entry;
    if (current !== undefined) {
      return [await sealUnder(entry, current.channel, frame)];
    }
    if (entry.pool.length > 0) {
      return Promise.all(
        entry.pool.map(async (cand) => sealUnder(entry, cand.channel, frame)),
      );
    }
    if (hs === undefined) {
      beginOwn(entry, "initiated");
      enforcePendingBound(entry);

      return sealFor(entry, frame);
    }
    if (hs.cands.length > 0) {
      // The hello this side answered with is out before anything is sealed under the channel it makes.
      await hs.sent.promise;

      return Promise.all(
        hs.cands.map(async (cand) => sealUnder(entry, cand.channel, frame)),
      );
    }
    await entry.waitForChannel();

    return sealFor(entry, frame);
  }

  /** Tries a frame against the peer's channels, in order: the current one, then the candidates, then the replaced one while its window lasts. */
  async function openUnder(
    entry: PeerChannels,
    data: Readonly<SecureDataFrame>,
  ): Promise<OpenedFrame | undefined> {
    entry.expire(clock.now());
    const { current } = entry;
    if (current !== undefined) {
      const outcome = await current.channel.openOutcome(data);
      if (authentic(outcome)) {
        entry.confirmCurrent();
        entry.touch(clock.now());

        return outcome.ok
          ? { frame: outcome.frame, from: current.channel.peer.deviceId }
          : undefined;
      }
    }
    const found = await openFirst(entry.candidates(), data);
    if (found !== undefined) {
      if (peers.get(entry.key) !== entry) {
        return undefined;
      }
      // Confirmation: the peer holds the candidate's other secret.
      entry.confirm(found.cand, clock.now());
      entry.touch(clock.now());

      return found.outcome.ok
        ? {
            frame: found.outcome.frame,
            from: found.cand.channel.peer.deviceId,
          }
        : undefined;
    }
    const { replaced } = entry;
    if (replaced !== undefined && clock.now() < replaced.until) {
      const outcome = await replaced.channel.openOutcome(data);

      return outcome.ok
        ? { frame: outcome.frame, from: replaced.channel.peer.deviceId }
        : undefined;
    }

    return undefined;
  }

  async function acceptHello(
    hello: Readonly<SecureHelloFrame>,
    sender: DeviceId,
  ): Promise<void> {
    const key = deviceIdToHex(sender);
    const verdict = await verifyHello(identity, hello);
    if (!verdict.ok || !(await isUsableEphemeralKey(hello["ephemeral-key"]))) {
      return;
    }
    // Everything above waited; what follows decides on the state as it is now.
    const now = clock.now();
    let entry = peers.get(key);
    entry?.expire(now);
    if (entry?.holdsKey(hello["ephemeral-key"]) === true) {
      return;
    }
    if (entry?.hs !== undefined && entry.outstanding(now)) {
      if (entry.hs.cands.length < CANDIDATES_PER_HANDSHAKE) {
        await addCandidate(entry, entry.hs, hello, verdict.peer);
      }

      return;
    }
    if (entry === undefined) {
      if (!reserveUnsolicitedSlot(now)) {
        return;
      }
      entry = new PeerChannels(sender, now);
      peers.set(key, entry);
    }
    const hs = beginOwn(entry, "answered");
    entry.touch(now);
    try {
      await addCandidate(entry, hs, hello, verdict.peer);
    } catch (error) {
      dropHandshake(entry, hs, error);
      throw error;
    }
  }

  return {
    seal: async (peer, frame, purpose) => {
      const key = deviceIdToHex(peer);
      const now = clock.now();
      let entry = peers.get(key);
      if (entry === undefined) {
        if (purpose === "reply" && !reserveUnsolicitedSlot(now)) {
          throw new Error("there is no channel with this peer");
        }
        entry = new PeerChannels(peer, now);
        peers.set(key, entry);
      }
      if (purpose === "request") {
        entry.choose();
      }

      return sealFor(entry, frame);
    },
    applyHello: async (hello, claimedFrom) => {
      let sender: DeviceId | undefined;
      try {
        if (claimedFrom === undefined) {
          return;
        }
        // The cheapest checks first, and before any signature is verified: the hello must come from the pairing of the device it names, and must not repeat a key already held for that device.
        sender = await identity.deriveDeviceId(
          hello["identity-key"]["public-key"],
        );
        if (!bytesEqual(sender, claimedFrom)) {
          return;
        }
        const held = peers.get(deviceIdToHex(sender));
        held?.expire(clock.now());
        if (held?.holdsKey(hello["ephemeral-key"]) === true) {
          return;
        }
        await acceptHello(hello, sender);
      } catch (error) {
        reportFault(error, sender);
      }
    },
    open: async (data, claimedFrom) => {
      if (claimedFrom === undefined) {
        return undefined;
      }
      const entry = peers.get(deviceIdToHex(claimedFrom));
      if (entry === undefined) {
        return undefined;
      }

      return entry.serialise(async () => openUnder(entry, data));
    },
    reset: (reason) => {
      for (const entry of [...peers.values()]) {
        discard(entry, new Error(reason));
      }
    },
    forget: (peer) => {
      const entry = peers.get(deviceIdToHex(peer));
      if (entry !== undefined) {
        discard(entry, new Error("the relay pairing was lost"));
      }
    },
  };
}
