// DOM-free connection session: everything the console does once "Connect" is clicked, kept free of browser APIs so it is unit-testable against a fake Transport. Owns the client side of the handshake exchange (send ours, negotiate against theirs, with an explicit unanswered state rather than hanging forever -- a relay-only node like the hub legitimately never answers a handshake), the peer directory assembled from received gossip frames, and the frame feed the UI renders.

import {
  type DeviceId,
  type Frame,
  type HandshakeFrame,
  type PeerAdvert,
  type ProtocolVersion,
} from "@exadev/wire-mesh-core/generated/protocol";
import {
  SUPPORTED_PROTOCOL_VERSION,
  negotiate,
} from "@exadev/wire-mesh-core/domain/handshake";
import type {
  Connection,
  Transport,
} from "@exadev/wire-mesh-core/ports/transport";

/** How long to wait for the node's handshake before calling it unanswered. A relay-only node never sends one; that is a state to display, not an error. */
export const HANDSHAKE_TIMEOUT_MS = 3_000;

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; address: string }
  | { status: "connected"; address: string; handshake: HandshakeStatus }
  | { status: "closed"; address: string; reason: string };

export type HandshakeStatus =
  | { status: "pending" }
  | { status: "negotiated"; version: ProtocolVersion; sharedDomains: string[] }
  | { status: "unanswered" }
  | { status: "rejected"; reason: string };

export interface SessionEvent {
  state: ConnectionState;
  /** The peer directory as of this event: latest peer-advert per device-id, in first-heard order. */
  directory: readonly DirectoryEntry[];
  /** Every frame that crossed the connection, sent or received, in order. */
  frameLog: readonly FrameLogEntry[];
}

export interface DirectoryEntry {
  device: DeviceId;
  advert: PeerAdvert;
}

export interface FrameLogEntry {
  direction: "sent" | "received";
  frame: Frame;
}

export interface MeshSession {
  readonly events: AsyncIterable<SessionEvent>;
  connect: (address: string, localDomains: readonly string[]) => Promise<void>;
  sendPing: () => Promise<void>;
  close: () => Promise<void>;
}

function localHandshake(domains: readonly string[]): HandshakeFrame {
  return {
    type: "handshake",
    version: SUPPORTED_PROTOCOL_VERSION,
    domains: [...domains],
  };
}

export function createMeshSession(transport: Readonly<Transport>): MeshSession {
  let connection: Connection | null = null;
  let state: ConnectionState = { status: "idle" };
  let handshake: HandshakeStatus = { status: "pending" };
  const directory = new Map<string, DirectoryEntry>();
  const frameLog: FrameLogEntry[] = [];
  let feedCancelled = false;
  const eventWaiters: ((event: SessionEvent) => void)[] = [];
  const eventBacklog: SessionEvent[] = [];

  function snapshot(): SessionEvent {
    return {
      state,
      directory: [...directory.values()],
      frameLog: [...frameLog],
    };
  }

  function emit(): void {
    const event = snapshot();
    const waiter = eventWaiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      eventBacklog.push(event);
    }
  }

  function applyFrame(frame: Frame): void {
    frameLog.push({ direction: "received", frame });
    if (frame.type === "handshake") {
      applyRemoteHandshake(frame);
    } else if (frame.type === "gossip") {
      for (const advert of frame.peers) {
        // Latest advert per device wins, order preserved by first insertion -- a re-advert updates in place.
        directory.set(deviceKey(advert.device), {
          device: advert.device,
          advert,
        });
      }
    }
  }

  const HEX_RADIX = 16;

  function deviceKey(device: DeviceId): string {
    // Map key for a device-id: byte-exact hex rather than any coercions that would collide distinct ids.
    let key = "";
    for (const byte of device) {
      key += byte.toString(HEX_RADIX).padStart(2, "0");
    }
    return key;
  }

  // The local handshake actually sent on connect, kept for negotiating against the remote's answer.
  let localHandshakeSent: HandshakeFrame = localHandshake([]);

  function applyRemoteHandshake(remote: HandshakeFrame): void {
    if (handshake.status !== "pending") {
      return;
    }
    const result = negotiate(localHandshakeSent, remote);
    handshake = result.ok
      ? {
          status: "negotiated",
          version: result.version,
          sharedDomains: result.sharedDomains,
        }
      : { status: "rejected", reason: "no shared domains or version" };
    if (state.status === "connected") {
      state = { ...state, handshake };
    }
  }

  async function consume(link: Readonly<Connection>): Promise<void> {
    for await (const frame of link.receive()) {
      if (feedCancelled) {
        return;
      }
      applyFrame(frame);
      emit();
    }
    if (state.status === "connected") {
      state = {
        status: "closed",
        address: state.address,
        reason: "node closed the connection",
      };
      emit();
    }
  }

  return {
    events: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<SessionEvent>> =>
            new Promise((resolve) => {
              const backlogEvent = eventBacklog.shift();
              if (backlogEvent) {
                resolve({ value: backlogEvent, done: false });
              } else {
                eventWaiters.push((event) => {
                  resolve({ value: event, done: false });
                });
              }
            }),
        };
      },
    },
    async connect(address, localDomains): Promise<void> {
      if (connection !== null) {
        throw new Error(
          "a session connects once; create a new one to reconnect",
        );
      }
      state = { status: "connecting", address };
      emit();
      connection = await transport.connect(address);
      localHandshakeSent = localHandshake(localDomains);
      handshake = { status: "pending" };
      state = { status: "connected", address, handshake };
      frameLog.push({ direction: "sent", frame: localHandshakeSent });
      await connection.send(localHandshakeSent);
      emit();
      setTimeout(() => {
        if (handshake.status === "pending") {
          handshake = { status: "unanswered" };
          if (state.status === "connected") {
            state = { ...state, handshake };
          }
          emit();
        }
      }, HANDSHAKE_TIMEOUT_MS);
      const consuming = consume(connection);
      void consuming.catch((error: unknown) => {
        if (state.status === "connected") {
          state = {
            status: "closed",
            address: state.address,
            reason: error instanceof Error ? error.message : String(error),
          };
          emit();
        }
      });
    },
    async sendPing(): Promise<void> {
      if (connection === null || state.status !== "connected") {
        throw new Error("not connected");
      }
      const ping: Frame = { type: "ping" };
      frameLog.push({ direction: "sent", frame: ping });
      await connection.send(ping);
      emit();
    },
    async close(): Promise<void> {
      feedCancelled = true;
      if (connection !== null) {
        await connection.close();
      }
      if (state.status === "connected" || state.status === "connecting") {
        state = {
          status: "closed",
          address: state.address,
          reason: "closed by you",
        };
      }
      emit();
    },
  };
}
