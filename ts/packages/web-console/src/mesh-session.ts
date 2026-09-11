// DOM-free connection session: everything the console does once "Connect" is clicked, kept free of browser APIs so it is unit-testable against a fake Transport. Owns the client side of the handshake exchange (send ours, negotiate against theirs, with an explicit unanswered state rather than hanging forever -- a relay-only node like the hub legitimately never answers a handshake), the peer directory assembled from received gossip frames, and the frame feed the UI renders.

import {
  type CapabilityScope,
  type CapabilityToken,
  type DeviceId,
  type Frame,
  type GossipFrame,
  type HandshakeFrame,
  type ManageCommand,
  type ManageError,
  type ManageOk,
  type ManageRequestFrame,
  type ManageResponseFrame,
  type PeerAdvert,
  type ProtocolVersion,
} from "@exadev/wire-mesh-core/generated/protocol";
import {
  SUPPORTED_PROTOCOL_VERSION,
  negotiate,
} from "@exadev/wire-mesh-core/domain/handshake";
import type { Clock } from "@exadev/wire-mesh-core/ports/clock";
import type { IdentityPort } from "@exadev/wire-mesh-core/ports/identity";
import type {
  Connection,
  Transport,
} from "@exadev/wire-mesh-core/ports/transport";
import { messageFromFrame, tryDecodeFrame } from "./adapters/frame-codec.js";

const MS_PER_SECOND = 1000;

/** How long to wait for the node's handshake before calling it unanswered. A relay-only node never sends one; that is a state to display, not an error. */
export const HANDSHAKE_TIMEOUT_MS = 3_000;

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; address: string }
  | { status: "connected"; address: string; handshake: HandshakeStatus }
  | { status: "reconnecting"; address: string; attempt: number; reason: string }
  | { status: "closed"; address: string; reason: string };

/** Opt-in retry behaviour for a session's own reconnect attempts. Left at its default `null` in createMeshSession, a disconnect always falls straight to `"closed"` -- today's exact behaviour, unchanged unless a caller opts in. */
export interface ReconnectPolicy {
  maxAttempts: number;
  /** Backoff before attempt N (1-indexed), in milliseconds. */
  delayMs: (attempt: number) => number;
}

/** The union `manage-response-frame.outcome` actually carries -- no dedicated generated type name exists for it. */
export type ManageOutcome = ManageOk | ManageError;

/** One `manage-request` this session received from its peer, surfaced for the caller to act on and answer. */
export interface IncomingManageRequest {
  requestId: number;
  command: ManageCommand;
  scope: CapabilityScope;
  token?: CapabilityToken;
  /** The device-id of the peer this request was relayed on behalf of, present only when the request arrived wrapped in a relay-data frame rather than directly over this session's own connection. A caller that needs to address a further request back to the same peer (one not sent via respond(), which already routes back correctly on its own) passes this as sendManageRequest's targetDevice. */
  fromDevice?: DeviceId;
  respond: (outcome: ManageOutcome) => Promise<void>;
}

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
  /** Every `manage-request` received from the peer, in arrival order. */
  readonly incomingManageRequests: AsyncIterable<IncomingManageRequest>;
  connect: (address: string, localDomains: readonly string[]) => Promise<void>;
  sendPing: () => Promise<void>;
  /** Attaches this token to every `manage-request` sent from now on. */
  setToken: (token: CapabilityToken) => void;
  /** Sends a manage-request and resolves with the matching manage-response's outcome, correlated by request-id. When targetDevice is given, the request is routed to that specific peer via an established relay-connect pairing (wrapped as relay-data) rather than sent directly over this session's own Connection -- relay-hub deliberately drops manage-request/manage-response frames sent to it directly, since routing between two connected peers is not the relay role's business, so a specific peer reachable only through a relay hub can only be addressed this way. Absent, this sends directly over the Connection exactly as before. */
  sendManageRequest: (
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
    targetDevice?: DeviceId,
  ) => Promise<ManageOutcome>;
  close: () => Promise<void>;
}

function localHandshake(domains: readonly string[]): HandshakeFrame {
  return {
    type: "handshake",
    version: SUPPORTED_PROTOCOL_VERSION,
    domains: [...domains],
  };
}

export function createMeshSession(
  transport: Readonly<Transport>,
  identity: Readonly<IdentityPort>,
  clock: Readonly<Clock> = { now: () => Date.now() },
  reconnect: ReconnectPolicy | null = null,
): MeshSession {
  let connection: Connection | null = null;
  let state: ConnectionState = { status: "idle" };
  let handshake: HandshakeStatus = { status: "pending" };
  const directory = new Map<string, DirectoryEntry>();
  const frameLog: FrameLogEntry[] = [];
  let feedCancelled = false;
  const eventWaiters: ((event: SessionEvent) => void)[] = [];
  const eventBacklog: SessionEvent[] = [];
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let currentToken: CapabilityToken | null = null;
  let nextRequestId = 0;
  // The device-id this session's relay-hub connection is currently paired with, in either role: set when this session sends its own relay-connect (initiator role), or when it receives a relay-inbound naming who is now paired with it (target role). relay-hub pairs at most one device per connection at a time -- a fresh relay-connect re-pairs totally -- so a single field is enough to track it, in whichever role this session is currently playing.
  let relayPeerDevice: DeviceId | null = null;
  const pendingManageRequests = new Map<
    number,
    {
      resolve: (outcome: ManageOutcome) => void;
      reject: (error: Error) => void;
    }
  >();
  const incomingWaiters: ((request: IncomingManageRequest) => void)[] = [];
  const incomingBacklog: IncomingManageRequest[] = [];

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

  function emitIncomingManageRequest(request: IncomingManageRequest): void {
    const waiter = incomingWaiters.shift();
    if (waiter) {
      waiter(request);
    } else {
      incomingBacklog.push(request);
    }
  }

  function rejectPendingManageRequests(reason: string): void {
    for (const pending of pendingManageRequests.values()) {
      pending.reject(new Error(reason));
    }
    pendingManageRequests.clear();
  }

  function buildManageRequest(
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
  ): ManageRequestFrame {
    const requestId = nextRequestId;
    nextRequestId += 1;
    return {
      type: "manage-request",
      "request-id": requestId,
      command,
      scope,
      ...(currentToken !== null ? { token: currentToken } : {}),
    };
  }

  /** Sends a frame, wrapping it as relay-data first when viaRelay is set -- the single choke point every outbound manage-request/manage-response passes through, so a consumer of sendManageRequest/respond never needs its own relay-wrapping logic. */
  async function transmit(frame: Frame, viaRelay: boolean): Promise<void> {
    if (connection === null) {
      throw new Error("not connected");
    }
    if (viaRelay) {
      const relayFrame: Frame = {
        type: "relay-data",
        payload: messageFromFrame(frame),
      };
      await connection.send(relayFrame);
      return;
    }
    await connection.send(frame);
  }

  function applyManageResponse(frame: ManageResponseFrame): void {
    const requestId = frame["request-id"];
    const pending = pendingManageRequests.get(requestId);
    if (pending !== undefined) {
      pendingManageRequests.delete(requestId);
      pending.resolve(frame.outcome);
    }
  }

  function applyManageRequest(
    frame: ManageRequestFrame,
    viaRelay: boolean,
  ): void {
    const requestId = frame["request-id"];
    const fromDevice =
      viaRelay && relayPeerDevice !== null ? relayPeerDevice : undefined;
    const incoming: IncomingManageRequest = {
      requestId,
      command: frame.command,
      scope: frame.scope,
      ...(frame.token !== undefined ? { token: frame.token } : {}),
      ...(fromDevice !== undefined ? { fromDevice } : {}),
      respond: async (outcome: ManageOutcome): Promise<void> => {
        const response: ManageResponseFrame = {
          type: "manage-response",
          "request-id": requestId,
          outcome,
        };
        frameLog.push({ direction: "sent", frame: response });
        await transmit(response, viaRelay);
        emit();
      },
    };
    emitIncomingManageRequest(incoming);
  }

  function applyFrame(frame: Frame): void {
    if (frame.type === "relay-data") {
      // relay-data's payload is an opaque byte-pipe relay-hub forwards blindly between an established pairing, never interpreting it -- so a manage-request/manage-response addressed to a peer only reachable through a relay hub rides inside it (relay-hub itself drops those frame kinds when sent to it directly). A payload that doesn't decode as one of those two frame kinds is left as ordinary opaque relay-data: nothing else in this package currently sends or expects it, but this path must not assume it is the only future user of relay-data.
      const inner = tryDecodeFrame(frame.payload);
      if (
        inner !== null &&
        (inner.type === "manage-request" || inner.type === "manage-response")
      ) {
        frameLog.push({ direction: "received", frame: inner });
        if (inner.type === "manage-response") {
          applyManageResponse(inner);
        } else {
          applyManageRequest(inner, true);
        }
        return;
      }
      frameLog.push({ direction: "received", frame });
      return;
    }
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
    } else if (frame.type === "relay-inbound") {
      // The target-role side of a relay-connect pairing learns who dialed it only via this frame -- there is no ack frame for relay-connect itself, so an initiator simply proceeds to relay-data right after sending it.
      relayPeerDevice = frame["source-device"];
    } else if (frame.type === "manage-response") {
      applyManageResponse(frame);
    } else if (frame.type === "manage-request") {
      applyManageRequest(frame, false);
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

  /** Establishes a relay-connect pairing to targetDevice if this session isn't already paired with it -- a no-op when it already is, whether that pairing was established by this session's own prior relay-connect (initiator role) or learned from an incoming relay-inbound (target role, replying back to whoever dialed it). relay-connect has no ack frame: the initiator proceeds to relay-data right after sending it. */
  async function ensureRelayPairing(targetDevice: DeviceId): Promise<void> {
    if (connection === null) {
      throw new Error("not connected");
    }
    if (
      relayPeerDevice !== null &&
      deviceKey(relayPeerDevice) === deviceKey(targetDevice)
    ) {
      return;
    }
    const relayConnect: Frame = {
      type: "relay-connect",
      "target-device": targetDevice,
    };
    frameLog.push({ direction: "sent", frame: relayConnect });
    await connection.send(relayConnect);
    relayPeerDevice = targetDevice;
    emit();
  }

  // The local handshake actually sent on connect, kept for negotiating against the remote's answer.
  let localHandshakeSent: HandshakeFrame = localHandshake([]);

  function applyRemoteHandshake(remote: HandshakeFrame): void {
    if (handshake.status !== "pending") {
      return;
    }
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
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

  function handleDisconnect(
    reason: string,
    address: string,
    localDomains: readonly string[],
  ): void {
    if (feedCancelled) {
      return;
    }
    rejectPendingManageRequests("disconnected before a response arrived");
    if (reconnect !== null && attempt < reconnect.maxAttempts) {
      attempt += 1;
      const currentAttempt = attempt;
      state = {
        status: "reconnecting",
        address,
        attempt: currentAttempt,
        reason,
      };
      emit();
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        doConnect(address, localDomains).catch((error: unknown) => {
          handleDisconnect(
            error instanceof Error ? error.message : String(error),
            address,
            localDomains,
          );
        });
      }, reconnect.delayMs(currentAttempt));
      return;
    }
    state = { status: "closed", address, reason };
    emit();
  }

  async function consume(
    link: Readonly<Connection>,
    address: string,
    localDomains: readonly string[],
  ): Promise<void> {
    for await (const frame of link.receive()) {
      if (feedCancelled) {
        return;
      }
      applyFrame(frame);
      emit();
    }
    if (state.status === "connected") {
      handleDisconnect("node closed the connection", address, localDomains);
    }
  }

  async function doConnect(
    address: string,
    localDomains: readonly string[],
  ): Promise<void> {
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    state = { status: "connecting", address };
    emit();
    connection = await transport.connect(address);
    if (feedCancelled) {
      await connection.close();
      return;
    }
    localHandshakeSent = localHandshake(localDomains);
    handshake = { status: "pending" };
    state = { status: "connected", address, handshake };
    frameLog.push({ direction: "sent", frame: localHandshakeSent });
    await connection.send(localHandshakeSent);
    emit();
    // Self-advertisement: empty addresses is correct, not a stopgap -- relay-hub's registry looks peers up by device-id from gossip, never by address, so an honest advert with no reachable address is all a browser client (which cannot accept inbound connections) can ever offer.
    const selfAdvert: GossipFrame = {
      type: "gossip",
      peers: [
        {
          device: identity.deviceId,
          addresses: [],
          "snapshot-seconds": Math.floor(clock.now() / MS_PER_SECOND),
        },
      ],
    };
    frameLog.push({ direction: "sent", frame: selfAdvert });
    await connection.send(selfAdvert);
    emit();
    handshakeTimer = setTimeout(() => {
      handshakeTimer = null;
      if (handshake.status === "pending") {
        handshake = { status: "unanswered" };
        if (state.status === "connected") {
          state = { ...state, handshake };
        }
        emit();
      }
    }, HANDSHAKE_TIMEOUT_MS);
    const consuming = consume(connection, address, localDomains);
    void consuming.catch((error: unknown) => {
      if (state.status === "connected") {
        handleDisconnect(
          error instanceof Error ? error.message : String(error),
          address,
          localDomains,
        );
      }
    });
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
    incomingManageRequests: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<IncomingManageRequest>> =>
            new Promise((resolve) => {
              const backlogRequest = incomingBacklog.shift();
              if (backlogRequest) {
                resolve({ value: backlogRequest, done: false });
              } else {
                incomingWaiters.push((request) => {
                  resolve({ value: request, done: false });
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
      attempt = 0;
      await doConnect(address, localDomains);
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
    setToken(token: CapabilityToken): void {
      currentToken = token;
    },
    async sendManageRequest(
      command: ManageCommand,
      scope: Readonly<CapabilityScope>,
      targetDevice?: DeviceId,
    ): Promise<ManageOutcome> {
      if (connection === null || state.status !== "connected") {
        throw new Error("not connected");
      }
      if (targetDevice !== undefined) {
        await ensureRelayPairing(targetDevice);
      }
      const frame = buildManageRequest(command, scope);
      const outcome = new Promise<ManageOutcome>((resolve, reject) => {
        pendingManageRequests.set(frame["request-id"], { resolve, reject });
      });
      frameLog.push({ direction: "sent", frame });
      await transmit(frame, targetDevice !== undefined);
      emit();
      return outcome;
    },
    async close(): Promise<void> {
      feedCancelled = true;
      if (handshakeTimer !== null) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectPendingManageRequests(
        "connection closed before a response arrived",
      );
      if (connection !== null) {
        await connection.close();
      }
      if (
        state.status === "connected" ||
        state.status === "connecting" ||
        state.status === "reconnecting"
      ) {
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
