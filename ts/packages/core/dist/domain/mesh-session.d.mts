import { A as ManageCommand, M as ManageError, N as ManageOk, S as Frame, i as CapabilityToken, q as ProtocolVersion, r as CapabilityScope, v as DeviceId, z as PeerAdvert } from "../protocol-DZyNTfIN.mjs";
import { IdentityPort } from "../ports/identity.mjs";
import { Clock } from "../ports/clock.mjs";
import { Connection, Transport } from "../ports/transport.mjs";
//#region src/domain/mesh-session.d.ts
/** How long to wait for the node's handshake before calling it unanswered. A relay-only node never sends one; that is a state to display, not an error. */
export declare const HANDSHAKE_TIMEOUT_MS = 3000;
export type ConnectionState = {
  status: "idle";
} | {
  status: "connecting";
  address: string;
} | {
  status: "connected";
  address: string;
  handshake: HandshakeStatus;
} | {
  status: "reconnecting";
  address: string;
  attempt: number;
  reason: string;
} | {
  status: "closed";
  address: string;
  reason: string;
};
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
export type HandshakeStatus = {
  status: "pending";
} | {
  status: "negotiated";
  version: ProtocolVersion;
  sharedDomains: string[];
} | {
  status: "unanswered";
} | {
  status: "rejected";
  reason: string;
};
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
  sendManageRequest: (command: ManageCommand, scope: Readonly<CapabilityScope>, targetDevice?: DeviceId) => Promise<ManageOutcome>;
  close: () => Promise<void>;
}
export declare function createMeshSession(transport: Readonly<Transport>, identity: Readonly<IdentityPort>, clock?: Readonly<Clock>, reconnect?: ReconnectPolicy | null): MeshSession;
/** A MeshSession built over a connection that already exists (a Transport's own listen() handed it to onConnection), extended with the one thing a dial-side session can't offer: the device-id of the specific peer at the other end. Unlike createMeshSession, which may end up talking to a relay gossiping about many devices at once, an accepted connection is the agent-comms case -- exactly two peers, directly connected -- so "the peer" is well-defined here in a way it structurally isn't for the dial side. */
export interface AcceptedMeshSession extends MeshSession {
  /** Resolves with the device-id carried by the first peer-advert this connection's remote sends -- the same self-advertisement mechanism createMeshSession's own directory already relies on for every peer, just narrowed to "the one peer this specific connection is with" rather than accumulated into a directory of possibly many. There is no transport-level authentication behind this yet (see wire-mesh#45's own createTlsTransport item): it is only as trustworthy as the remote's own gossip, exactly the same trust level the dial-side directory already has for every entry in it. */
  peerDeviceId: Promise<DeviceId>;
}
export interface AcceptedMeshSessionOptions {
  /** A caller-chosen label for this connection, used only for ConnectionState's own address field -- the Connection/Transport ports expose no remote-address concept an accepted connection could report on its own (see wire-mesh#45). Defaults to a fixed placeholder since most callers have nothing more specific to offer; a transport adapter that does know the remote's address should pass it here. */
  label?: string;
  clock?: Readonly<Clock>;
}
/** Wires an already-accepted Connection up as a full MeshSession, mirroring exactly what createMeshSession's own dial path does once a connection exists (send handshake, send self-advert, negotiate, consume frames) -- the wire-mesh#45 prerequisite agent-comms needs, since its peers both listen and dial rather than only ever dialing the way web-console's own console UI does. Reconnect does not apply here: if this connection drops, only the remote redialing and being accepted again produces a new connection, and therefore a new session -- there is nothing on this side to retry. */
export declare function acceptMeshSession(connection: Readonly<Connection>, identity: Readonly<IdentityPort>, localDomains: readonly string[], options?: Readonly<AcceptedMeshSessionOptions>): Promise<AcceptedMeshSession>;
//#endregion