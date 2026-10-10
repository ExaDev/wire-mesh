// The secure channels a MeshSession holds with the devices it reaches through a relay (spec/secure-channel.cddl), one per peer, and the state machine that opens them. secure-channel.ts is the crypto; this decides when to start a handshake, whose hello completes which, and which channel a received frame belongs to. Kept out of mesh-session.ts, which only says how a hello reaches the wire and what to do with a frame once it has been opened.

import type {
  DeviceId,
  Frame,
  SecureDataFrame,
  SecureHelloFrame,
} from "../generated/protocol.js";
import type { IdentityPort } from "../ports/identity.js";
import { deviceIdToHex } from "./device-id.js";
import {
  beginHandshake,
  establishChannel,
  verifyHello,
  type PendingHandshake,
  type SecureChannel,
} from "./secure-channel.js";

/** Where the handshake with one peer stands. A peer is awaiting from the moment this side starts one, whichever side spoke first, and established once both hellos have been exchanged. */
type ChannelState =
  | {
      readonly status: "awaiting";
      readonly pending: Promise<PendingHandshake>;
      /** Settles with the channel once established, or rejects if the handshake is abandoned. */
      readonly settle: PromiseWithResolvers<SecureChannel>;
    }
  | { readonly status: "established"; readonly channel: SecureChannel };

type Awaiting = Extract<ChannelState, { status: "awaiting" }>;

/** A frame that opened under a peer's channel, with the peer that channel authenticated. */
export interface OpenedFrame {
  readonly frame: Frame;
  readonly from: DeviceId;
}

export interface RelayChannels {
  /** The channel with peer, starting a handshake when there is none. Resolves once both hellos have been exchanged. */
  ensure: (peer: DeviceId) => Promise<SecureChannel>;
  /** Handles a hello received through a relay pairing: verifies it, answers with this side's own unless one is already outstanding for that peer, and completes the handshake. A hello that does not verify is dropped, since there is nobody to tell. */
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
): RelayChannels {
  const channels = new Map<string, ChannelState>();

  /** Registers the peer as awaiting at once, so a hello arriving meanwhile completes this handshake instead of starting a second, then sends this side's hello. */
  function start(peer: DeviceId): Awaiting {
    const key = deviceIdToHex(peer);
    const settle = Promise.withResolvers<SecureChannel>();
    const pending = beginHandshake(identity, peer);
    const entry: Awaiting = { status: "awaiting", pending, settle };
    channels.set(key, entry);
    void pending
      .then(async ({ hello }) => sendHello(peer, hello))
      .catch((error: unknown) => {
        settle.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
        if (channels.get(key) === entry) {
          channels.delete(key);
        }
      });

    return entry;
  }

  return {
    ensure: async (peer) => {
      const existing = channels.get(deviceIdToHex(peer));
      if (existing?.status === "established") {
        return existing.channel;
      }

      return (existing ?? start(peer)).settle.promise;
    },
    applyHello: async (hello) => {
      const verdict = await verifyHello(identity, hello);
      if (!verdict.ok) {
        return;
      }
      const key = deviceIdToHex(verdict.peer.deviceId);
      const current = channels.get(key);
      const entry =
        current?.status === "awaiting" ? current : start(verdict.peer.deviceId);
      const channel = await establishChannel(
        identity,
        await entry.pending,
        hello,
        verdict.peer,
      );
      if (channel === undefined) {
        entry.settle.reject(
          new Error("the peer sent an unusable ephemeral key"),
        );
        if (channels.get(key) === entry) {
          channels.delete(key);
        }

        return;
      }
      channels.set(key, { status: "established", channel });
      entry.settle.resolve(channel);
    },
    open: async (data, claimedFrom) => {
      if (claimedFrom === undefined) {
        return undefined;
      }
      const entry = channels.get(deviceIdToHex(claimedFrom));
      if (entry?.status !== "established") {
        return undefined;
      }
      const frame = await entry.channel.open(data);

      return frame === undefined
        ? undefined
        : { frame, from: entry.channel.peer.deviceId };
    },
    reset: (reason) => {
      for (const entry of channels.values()) {
        if (entry.status === "awaiting") {
          entry.settle.reject(new Error(reason));
        }
      }
      channels.clear();
    },
    forget: (peer) => {
      const key = deviceIdToHex(peer);
      const entry = channels.get(key);
      if (entry?.status === "awaiting") {
        entry.settle.reject(new Error("the relay pairing was lost"));
      }
      channels.delete(key);
    },
  };
}
