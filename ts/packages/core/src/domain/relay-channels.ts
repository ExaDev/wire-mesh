// The secure channels a MeshSession holds with the devices it reaches through a relay (spec/secure-channel.cddl), one per peer, and the state machine that opens them. secure-channel.ts is the crypto; this decides when to start a handshake, whose hello completes which, and which channel a received frame belongs to. Kept out of mesh-session.ts, which only says how a hello reaches the wire and what to do with a frame once it has been opened.

import { deliverContained } from "./fault-report.js";
import type {
  DeviceId,
  Frame,
  SecureDataFrame,
  SecureHelloFrame,
} from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";
import { deviceIdToHex } from "./device-id.js";
import { ChannelExhaustedError } from "./channel-exhausted-error.js";
import { bytesEqual } from "./token-scope.js";
import {
  assertFirstSendCounter,
  beginHandshake,
  establishChannelFrom,
  verifyHello,
  type PendingHandshake,
  type SecureChannel,
  type SecureChannelPeer,
} from "./secure-channel.js";

/** Where the handshake with one peer stands. A peer is awaiting from the moment this side starts one, whichever side spoke first, and established once both hellos have been exchanged. */
type ChannelState =
  | {
      readonly status: "awaiting";
      readonly pending: Promise<PendingHandshake>;
      /** Settles with the channel once established, or rejects if the handshake is abandoned. A handler is attached when the entry is created, so an entry nothing awaits (one a received hello created) never rejects unobserved. */
      readonly settle: PromiseWithResolvers<SecureChannel>;
      /** The peer this handshake is with. */
      readonly key: string;
      /** Settles once this side's hello has been sent, and rejects if it could not be signed or sent. Observed from creation, like `settle`. */
      readonly sent: PromiseWithResolvers<undefined>;
    }
  | {
      readonly status: "established";
      readonly channel: SecureChannel;
      /** The ephemeral key of the peer's hello that this channel was built from, which a later hello must not repeat. */
      readonly remoteEphemeralKey: Uint8Array;
    };

type Awaiting = Extract<ChannelState, { status: "awaiting" }>;

/** A frame that opened under a peer's channel, with the peer that channel authenticated. */
export interface OpenedFrame {
  readonly frame: Frame;
  readonly from: DeviceId;
}

export interface RelayChannels {
  /** The channel with peer, starting a handshake when there is none. Resolves once both hellos have been exchanged. */
  ensure: (peer: DeviceId) => Promise<SecureChannel>;
  /** Handles a hello received through a relay pairing: verifies it, answers with this side's own unless one is already outstanding for that peer, and completes the handshake. Nothing that happens while handling a hello rejects the returned promise or reaches the peer. A hello that does not verify, and one whose ephemeral key cannot be used, is dropped, since there is nobody to tell. A hello that repeats the ephemeral key the established channel with that peer was built from is dropped too: it names a channel that already exists, so there is nothing to answer. Any failure of this side while handling a hello (the identity port failing to check or sign, the answer failing to send, the channel failing to establish) abandons the handshake it was part of, so a later hello from the same peer starts afresh, and is reported to the `onFault` option. */
  applyHello: (hello: Readonly<SecureHelloFrame>) => Promise<void>;
  /** Opens sealed data received through a relay pairing. `claimedFrom` is the `from-device` the relay stamped, which only picks the channel to try; the result is undefined unless the frame opens under it, and names the peer that channel authenticated. */
  open: (
    data: Readonly<SecureDataFrame>,
    claimedFrom: DeviceId | undefined,
  ) => Promise<OpenedFrame | undefined>;
  /** Forgets every peer, abandoning handshakes still waiting: channels are tied to the connection they were set up on. */
  reset: (reason: string) => void;
  /** Forgets one peer, so the next request to it starts afresh. */
  forget: (peer: DeviceId) => void;
}

export function createRelayChannels(
  identity: Readonly<IdentityPort>,
  /** Puts a hello on the wire for peer. Rejects when there is no connection to put it on. */
  sendHello: (peer: DeviceId, hello: SecureHelloFrame) => Promise<void>,
  options: Readonly<{
    /** Where each channel's send counter starts: only for tests that must reach the counter's bound, see establishChannelFrom. */
    firstSendCounter?: number;
    /** Told of a failure that is local to this side and is not the peer's doing, while handling a hello: an identity port that failed to check or sign, an answer that could not be sent, a channel that could not be established. It runs once per failing hello, so it must be cheap; if it throws, or returns a promise that rejects, that is reported once to the console and swallowed. The hello is dropped and nothing is sent to the peer. */
    onFault?: ((error: unknown) => void | Promise<void>) | undefined;
  }> = {},
): RelayChannels {
  if (options.firstSendCounter !== undefined) {
    assertFirstSendCounter(options.firstSendCounter);
  }
  const channels = new Map<string, ChannelState>();

  /** Tells the owner of a failure that is local to this side. The callback is the owner's code: its own failure, thrown or as a rejected promise it returns, must not end the session or go unobserved, so it goes through the shared containment in fault-report.ts. */
  function reportFault(error: unknown): void {
    deliverContained(async () => options.onFault?.(error), 0);
  }

  /** Abandons a handshake that failed: the entry goes if it is still the one held for the peer, and whoever awaits it is told. */
  function abandon(entry: Awaiting, error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (channels.get(entry.key) === entry) {
      channels.delete(entry.key);
    }
    entry.settle.reject(failure);
    entry.sent.reject(failure);
  }

  /** Starts a handshake with the peer: sends this side's hello, and registers the peer as awaiting at once, so a hello arriving meanwhile completes this handshake instead of starting a second. `answering` is true when a received hello started this, so nobody awaits the outcome and a failure to send is reported to the owner. `track` is false for a handshake answering a hello while a channel with that peer is established: it is not registered, so the established channel stays in place and in use until the new one is up and this side's hello has been sent. A hello that could not be sent leaves no channel behind: the peer would never learn this side's key. */
  function start(
    peer: DeviceId,
    { answering, track }: Readonly<{ answering: boolean; track: boolean }> = {
      answering: false,
      track: true,
    },
  ): Awaiting {
    const key = deviceIdToHex(peer);
    const pending = beginHandshake(identity, peer);
    const entry: Awaiting = {
      status: "awaiting",
      pending,
      settle: Promise.withResolvers<SecureChannel>(),
      key,
      sent: Promise.withResolvers<undefined>(),
    };
    // Observed from the start: a caller that awaits either sees the rejection through its own handler, and one that does not (a received hello created this entry) must not leave it unhandled.
    void entry.settle.promise.catch(() => undefined);
    void entry.sent.promise.catch(() => undefined);
    void pending.then(
      async ({ hello }) => {
        try {
          await sendHello(peer, hello);
        } catch (error) {
          abandon(entry, error);
          // Settled already means the channel is up: take it down again, since the peer never got this side's hello.
          void entry.settle.promise.then(
            (channel) => {
              const held = channels.get(key);
              if (held?.status === "established" && held.channel === channel) {
                channels.delete(key);
              }
            },
            () => undefined,
          );
          if (answering && track) {
            reportFault(error);
          }

          return;
        }
        entry.sent.resolve(undefined);
      },
      // Signing failed. A received hello being handled sees the same rejection through `entry.pending` and reports it.
      (error: unknown) => {
        abandon(entry, error);
      },
    );
    if (track) {
      channels.set(key, entry);
    }

    return entry;
  }

  /** Completes the handshake a verified hello belongs to. Throws on any failure of this side; the caller abandons the handshake. */
  async function complete({
    entry,
    hello,
    peer,
    replaces,
  }: Readonly<{
    entry: Awaiting;
    hello: Readonly<SecureHelloFrame>;
    peer: SecureChannelPeer;
    /** The established channel this one replaces, when the handshake was begun without displacing it. */
    replaces: ChannelState | undefined;
  }>): Promise<void> {
    const { key } = entry;
    const pending = await entry.pending;
    const established = await establishChannelFrom(identity, {
      pending,
      remote: hello,
      peer,
      ...(options.firstSendCounter === undefined
        ? {}
        : { firstSendCounter: options.firstSendCounter }),
    });
    if (established === undefined) {
      // The peer's ephemeral key is unusable: the peer's doing, so nothing is reported.
      abandon(entry, new Error("the peer sent an unusable ephemeral key"));

      return;
    }
    if (replaces !== undefined) {
      // The channel being replaced stays installed and in use until this side's hello is out: a hello that cannot be sent abandons this handshake and leaves it untouched.
      await entry.sent.promise;
    }
    if (channels.get(key) !== (replaces ?? entry)) {
      // The handshake was reset, forgotten or superseded while this hello was being completed; whoever did that has already told its waiters.
      return;
    }
    const channel: SecureChannel = {
      ...established,
      seal: async (frame) => {
        try {
          return await established.seal(frame);
        } catch (error) {
          // A channel whose send counter is spent can seal nothing more. Forgetting it makes the next send to this peer start a new handshake, with a fresh counter, instead of failing for good.
          const held = channels.get(key);
          if (
            error instanceof ChannelExhaustedError &&
            held?.status === "established" &&
            held.channel === channel
          ) {
            channels.delete(key);
          }
          throw error;
        }
      },
    };
    channels.set(key, {
      status: "established",
      channel,
      remoteEphemeralKey: hello["ephemeral-key"],
    });
    entry.settle.resolve(channel);
  }

  return {
    ensure: async (peer) => {
      const key = deviceIdToHex(peer);
      const existing = channels.get(key);
      if (existing?.status === "established") {
        return existing.channel;
      }

      return (existing ?? start(peer)).settle.promise;
    },
    applyHello: async (hello) => {
      let entry: Awaiting | undefined;
      try {
        // verifyHello gives a verdict for every hello whose key the port reports as unusable, and lets any other failure of the port out. Such a failure is this side's, not the peer's: it is caught with the rest below.
        const verdict = await verifyHello(identity, hello);
        if (!verdict.ok) {
          return;
        }
        const key = deviceIdToHex(verdict.peer.deviceId);
        const current = channels.get(key);
        if (
          current?.status === "established" &&
          bytesEqual(current.remoteEphemeralKey, hello["ephemeral-key"])
        ) {
          // The channel was built from this very ephemeral key, so this hello is a repeat: answering it would replace a working channel with one the peer has no reason to expect.
          return;
        }
        const replaces =
          current?.status === "established" ? current : undefined;
        entry =
          current?.status === "awaiting"
            ? current
            : start(verdict.peer.deviceId, {
                answering: true,
                track: replaces === undefined,
              });
        await complete({ entry, hello, peer: verdict.peer, replaces });
      } catch (error) {
        if (entry !== undefined) {
          abandon(entry, error);
        }
        reportFault(error);
      }
    },
    open: async (data, claimedFrom) => {
      if (claimedFrom === undefined) {
        return undefined;
      }
      const key = deviceIdToHex(claimedFrom);
      const entry = channels.get(key);
      if (entry?.status !== "established") {
        return undefined;
      }
      const frame = await entry.channel.open(data);

      return frame === undefined
        ? undefined
        : { frame, from: entry.channel.peer.deviceId };
    },
    reset: (reason) => {
      for (const entry of [...channels.values()]) {
        if (entry.status === "awaiting") {
          abandon(entry, new Error(reason));
        }
      }
      channels.clear();
    },
    forget: (peer) => {
      const key = deviceIdToHex(peer);
      const entry = channels.get(key);
      if (entry?.status === "awaiting") {
        abandon(entry, new Error("the relay pairing was lost"));
      }
      channels.delete(key);
    },
  };
}
