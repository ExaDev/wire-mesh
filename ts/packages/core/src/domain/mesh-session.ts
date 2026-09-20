// DOM-free connection session: everything the console does once "Connect" is clicked, kept free of browser APIs so it is unit-testable against a fake Transport. Owns the client side of the handshake exchange (send ours, negotiate against theirs, with an explicit unanswered state rather than hanging forever -- a relay-only node like the hub legitimately never answers a handshake), the peer directory assembled from received gossip frames, and the frame feed the UI renders.

import {
  type CapabilityScope,
  type CapabilityToken,
  type DataEntriesFrame,
  type DataHaveFrame,
  type DataRequestFrame,
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
  type RelayDataFrame,
  type RevocationAnnounceFrame,
  type RevocationEntry,
  type TopologyPeers,
} from "../generated/protocol.js";
import { SUPPORTED_PROTOCOL_VERSION, negotiate } from "./handshake.js";
import { deviceIdToHex } from "./device-id.js";
import { createRelayPairings } from "./relay-pairing.js";
import { createAsyncQueue } from "./async-queue.js";
import { createPingRoundTrips } from "./ping-round-trips.js";
import { createTopologySnapshotTracker } from "./topology-snapshot.js";
import {
  TOPOLOGY_PEERS_GOSSIP_KEY,
  validateGossipExtensions,
} from "./gossip-extensions.js";
import { signPeerAdvert, verifyPeerAdvert } from "./peer-advert.js";
import type { Clock } from "../ports/clock.js";
import type { IdentityPort } from "../ports/identity.js";
import type { Connection, Transport } from "../ports/transport.js";
import { tryDecodeFrame, wrapRelayData } from "../adapters/frame-codec.js";
import {
  CORE_VERSION_GOSSIP_KEY,
  OWN_VERSION,
  isVersionGetCommand,
  versionGetOutcome,
} from "./own-version.js";

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
  /** The device-id of the peer this request was relayed on behalf of, read directly from the enclosing relay-data-frame's own `from-device` field (stamped by the hub on every frame it forwards, wire-mesh#30) -- present only when the request arrived wrapped in a relay-data frame that carried one. A caller that needs to address a further request back to the same peer (one not sent via respond(), which already routes back correctly on its own) passes this as sendManageRequest's targetDevice. Never inferred from which relay pairing happens to be most recently established: a connection can hold several concurrent pairings (wire-mesh#30's own multiplexed adjacency map), so only the frame's own per-message addressing can say who actually sent it. */
  fromDevice?: DeviceId;
  /** The device-id this request's relay-data frame was explicitly addressed to, read from its own `to-device` field -- present only when the request arrived relay-wrapped and the frame carried one. A caller fronting more than one locally-addressable device behind a single hub connection (a gateway advertising several local peers through the same relay pairing) uses this to decide whether the request is for this device or should be routed on to a different local peer it also advertises; this session has no such routing logic of its own, since it represents exactly one identity. */
  toDevice?: DeviceId;
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
  /** Every `revocation-entry` received from the peer, in arrival order -- a `revocation-announce` frame's own `entries` array is flattened to one item per entry, since each entry is independently verifiable and independently meaningful regardless of which frame carried it. A consumer typically feeds each one into a RevocationView's own `record`. */
  readonly revocationAnnouncements: AsyncIterable<RevocationEntry>;
  connect: (address: string, localDomains: readonly string[]) => Promise<void>;
  sendPing: () => Promise<void>;
  /** Sends a ping-frame and resolves with the round-trip time in milliseconds once the correlated pong-frame arrives -- FIFO-paired against this call's own ping, since ping-frame carries no correlation id of its own (spec/transport.cddl): the Nth call's own promise resolves against the Nth pong received after it, never matched by any other means. Rejects if the connection closes, or (when timeoutMs is given) if no pong arrives within timeoutMs, rather than resolving a sentinel value the way sendManageRequest's own timeout does -- there is no natural "no answer" value for a bare millisecond count to double as. Unlike sendPing (fire-and-forget, answered by nothing on an ordinary peer connection), this is answered only by a peer that replies to ping with pong -- today, relay-hub's own frame handling (wire-mesh#181) -- so calling this against a connection to a plain peer that never sends pong hangs until timeoutMs (if given) or forever. Exists to isolate the sender-to-hub leg of a relayed path.trace round trip: time this over the same connection a relayed manage-request travelled, then subtract it from path.trace's own end-to-end RTT to recover the hub-to-target leg. */
  sendPingMeasureRtt: (timeoutMs?: number) => Promise<number>;
  /** Attaches this token to every `manage-request` sent from now on. */
  setToken: (token: CapabilityToken) => void;
  /** Announces one or more already-minted revocation-entries to the peer. Sent directly over the connection, never relay-wrapped -- revocation-announce is a gossiped broadcast, not a request addressed to a specific peer, so it has no targetDevice/token parameters the way sendManageRequest does. */
  sendRevocationAnnounce: (
    entries: readonly RevocationEntry[],
  ) => Promise<void>;
  /** Re-sends this side's own self-advert with a fresh snapshot-seconds and, when given, extensions merged onto peer-advert's own open `* tstr => any` tail -- the mechanism a caller uses to keep gossiped presence status (or any other advertised fact) live over a connection's lifetime, since the initial self-advert wireUpConnection sends at connect time is otherwise never repeated. Callers own their own re-advertisement cadence (there is no timer inside MeshSession itself, matching its own DOM-free, fully unit-testable design); a caller not calling this again after connecting is exactly today's existing gossip-once-on-connect behaviour. */
  sendGossipUpdate: (extensions?: Record<string, unknown>) => Promise<void>;
  /** This session's own current topology snapshot -- the identical `topology/peers` value buildSelfAdvert merges into every gossiped self-advert (wire-mesh#180), read back directly rather than only from a possibly-stale gossiped copy elsewhere in the mesh. The live, cache-bust half of the cached-vs-live split `topology.get` itself establishes: a caller answering an incoming topology.get manage-request (see topology.ts's createTopologyGetHandler) calls this to build the response. Synchronous and side-effect-free -- unlike every other method here, it sends nothing and works even before this session has ever connected (an unconnected session simply has no direct peer and no relay pairings yet, both honestly empty). */
  getTopologyPeers: () => TopologyPeers;
  /** Sends one core/data frame (data-have, data-request, or data-entries) directly over this session's own connection, never relay-wrapped -- the transport half of an application's own noticeboard replication policy (data-sync.ts owns what the frames MEAN; this owns getting one onto the wire), the same layering sendRevocationAnnounce already established for its own frame kind. Rejects when not connected, exactly like every other send method here. */
  sendDataFrame: (
    frame: DataHaveFrame | DataRequestFrame | DataEntriesFrame,
  ) => Promise<void>;
  /** Sends a manage-request and resolves with the matching manage-response's outcome, correlated by request-id. When targetDevice is given, the request is routed to that specific peer via an established relay-connect pairing (wrapped as relay-data) rather than sent directly over this session's own Connection -- relay-hub deliberately drops manage-request/manage-response frames sent to it directly, since routing between two connected peers is not the relay role's business, so a specific peer reachable only through a relay hub can only be addressed this way. Absent, this sends directly over the Connection exactly as before. When token is given, it is attached to this one request instead of whatever setToken last set -- a single session routinely needs a different token per request when its peer shares more than one scope with this side (e.g. several core/room memberships over one connection), and a session-global token can only ever be correct for one of them. Absent, this request carries setToken's own session-global token exactly as before. When timeoutMs is given, the returned promise resolves with `{ result: "error", code: "timeout" }` rather than hanging forever if no manage-response arrives in time -- a held-open request (a human approval, a not-yet-online peer) otherwise has no way for the caller to give up on it. Absent, this request waits exactly as before, with no time limit of its own. */
  sendManageRequest: (
    command: ManageCommand,
    scope: Readonly<CapabilityScope>,
    targetDevice?: DeviceId,
    token?: CapabilityToken,
    timeoutMs?: number,
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

interface SessionCore {
  session: MeshSession;
  /** Wires up an already-established connection directly, bypassing dial entirely -- the shared entry point both doConnect (after a successful dial) and acceptMeshSession (given a connection up front) converge on. */
  wireUpConnection: (
    link: Readonly<Connection>,
    address: string,
    localDomains: readonly string[],
  ) => Promise<void>;
}

/**
 * Builds the connection-agnostic session state machine and its public MeshSession surface. dial is null for a session that can never (re)connect on its own -- acceptMeshSession's case, where the one connection it will ever have already exists by construction and reconnect therefore cannot apply (only the remote redialing, and being accepted again, produces a fresh connection). createMeshSession supplies dial as transport.connect so its own connect()/reconnect behaviour is unchanged from before this was factored out.
 */
function createSessionCore(
  identity: Readonly<IdentityPort>,
  clock: Readonly<Clock>,
  reconnect: ReconnectPolicy | null,
  dial: ((address: string) => Promise<Connection>) | null,
  /** Fired for every peer-advert entry as it's applied to the directory, regardless of source -- acceptMeshSession's own peerDeviceId resolution hooks into this rather than consuming the public events iterator itself, which would race with whatever the caller does with that same iterator. */
  onPeerAdvert?: (advert: PeerAdvert) => void,
  /** This node's own directly-reachable "host:port" candidates (wire-mesh#38), advertised in every self-advert this session sends. Empty by default -- correct, not a stopgap, for a caller with nothing to offer (a browser client, which cannot accept inbound connections); a caller that does listen for connections passes its own address(es) here so other peers can attempt a direct connection instead of always falling back to a relay. */
  addresses: readonly string[] = [],
  /** Fired once per frame received on this session's own connection, right alongside (never instead of) applyFrame's own handling (wire-mesh#102) -- the mechanism an "ordinary opted-in node relays for peers it's already talking to" uses: a shared RelayHub instance's own handleFrame, bound to this connection, observes the identical frame stream a session's own manage-request handling already consumes, with no second, competing for-await loop over the same connection.receive(). Awaited in sequence with applyFrame, not fire-and-forget: a thrown error here propagates the same way any other frame-processing failure already does, rather than being silently swallowed. */
  onFrame?: (
    connection: Readonly<Connection>,
    frame: Frame,
  ) => void | Promise<void>,
  /** Fired once this session's own connection.receive() stream ends, regardless of whether the session itself goes on to reconnect with a fresh connection -- the counterpart hook a RelayHub's own forgetConnection needs, since its registry and pairing state is keyed by this exact Connection instance and must be cleaned up when it specifically ends, not when the session as a whole gives up. */
  onSessionEnd?: (connection: Readonly<Connection>) => void,
): SessionCore {
  let connection: Connection | null = null;
  let state: ConnectionState = { status: "idle" };
  let handshake: HandshakeStatus = { status: "pending" };
  const directory = new Map<string, DirectoryEntry>();
  const frameLog: FrameLogEntry[] = [];
  let feedCancelled = false;
  const eventQueue = createAsyncQueue<SessionEvent>();
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let currentToken: CapabilityToken | null = null;
  let nextRequestId = 0;
  // Every device this session's own connection currently holds a relay pairing with, in either role: added when this session sends its own relay-connect (initiator role) or when it receives a relay-inbound naming who is now paired with it (target role). See relay-pairing.ts for why establishing a pairing with a new target never discards an already-established one with a different target, and why this is never consulted for addressing -- only for ensureRelayPairing's own "already paired" check.
  const relayPairings = createRelayPairings();
  // Topology self-advertisement's (wire-mesh#180) own state: tracks the device named by the first peer-advert entry this session ever applies to its directory, for buildSelfAdvert/getTopologyPeers' own use below via topology.compute()'s isAccepted-gated fallback. Only trustworthy for an accepted connection: AcceptedMeshSession's own peerDeviceId doc comment already establishes that an accepted connection is structurally exactly two peers, so its remote's first self-advert really is its own identity. A dial-side session may instead be talking to a relay hub that forwards a *third* device's advert as gossip catch-up before ever sending one of its own (it may have none at all), so this same heuristic would misattribute a merely-relayed device as directly connected for that side.
  const topology = createTopologySnapshotTracker({
    getAuthenticatedPeer: () => connection?.peerDeviceId,
    isAccepted: dial === null,
    getRelayedDevices: () => relayPairings.list(),
  });
  const pendingManageRequests = new Map<
    number,
    {
      resolve: (outcome: ManageOutcome) => void;
      reject: (error: Error) => void;
    }
  >();
  const incomingQueue = createAsyncQueue<IncomingManageRequest>();
  const revocationQueue = createAsyncQueue<RevocationEntry>();
  const pingRoundTrips = createPingRoundTrips();

  function snapshot(): SessionEvent {
    return {
      state,
      directory: [...directory.values()],
      frameLog: [...frameLog],
    };
  }

  function emit(): void {
    eventQueue.push(snapshot());
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
    tokenOverride?: CapabilityToken,
  ): ManageRequestFrame {
    const requestId = nextRequestId;
    nextRequestId += 1;
    const token = tokenOverride ?? currentToken;
    return {
      type: "manage-request",
      "request-id": requestId,
      command,
      scope,
      ...(token !== null ? { token } : {}),
    };
  }

  /** The "not connected" guard every send* method on the public session needs, deduplicated into one place rather than repeated inline at each call site: throws unless there is a live connection AND the session's own state machine agrees it is "connected" (transmit's own connection===null check alone doesn't cover the latter). Returns the connection itself, narrowed non-null, for a caller that needs to send directly on it (sendPing/sendPingMeasureRtt); a caller that only needs the throwing side effect (sendManageRequest and friends, which go through transmit instead) calls this and discards the result. */
  function requireConnectedLink(): Connection {
    if (connection === null || state.status !== "connected") {
      throw new Error("not connected");
    }
    return connection;
  }

  /** Sends a frame, wrapping it as relay-data first when viaRelay is set -- the single choke point every outbound manage-request/manage-response passes through, so a consumer of sendManageRequest/respond never needs its own relay-wrapping logic. When relaying, toDevice is stamped onto the outer relay-data-frame's own `to-device` field so the hub addresses it to the correct pairing directly (wire-mesh#30) rather than falling back to whichever pairing it last saw -- the one case this is omitted is a response to a request that itself arrived with no from-device to echo back, which is left to that same hub fallback exactly as an unaddressed relay-data always has been. */
  async function transmit(
    frame: Frame,
    viaRelay: boolean,
    toDevice?: DeviceId,
  ): Promise<void> {
    if (connection === null) {
      throw new Error("not connected");
    }
    if (viaRelay) {
      await connection.send(wrapRelayData(frame, toDevice));
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

  /** relayFrame is present only for a manage-request that arrived wrapped in relay-data, and is that same outer relay-data-frame -- its own to-device/from-device fields carry whatever addressing it received. See IncomingManageRequest's own fromDevice/toDevice doc comments for what each means and why neither is ever guessed from pairing state. A version.get request (VERSION_GET_VERB) is answered directly, right here, rather than ever reaching incomingManageRequests -- deliberately ungated (version.cddl), so no application needs to remember to register its own handler for it the way every other verb requires. */
  function applyManageRequest(
    frame: ManageRequestFrame,
    relayFrame?: RelayDataFrame,
  ): void {
    const requestId = frame["request-id"];
    const fromDevice = relayFrame?.["from-device"];
    const toDevice = relayFrame?.["to-device"];
    const incoming: IncomingManageRequest = {
      requestId,
      command: frame.command,
      scope: frame.scope,
      ...(frame.token !== undefined ? { token: frame.token } : {}),
      ...(fromDevice !== undefined ? { fromDevice } : {}),
      ...(toDevice !== undefined ? { toDevice } : {}),
      respond: async (outcome: ManageOutcome): Promise<void> => {
        const response: ManageResponseFrame = {
          type: "manage-response",
          "request-id": requestId,
          outcome,
        };
        frameLog.push({ direction: "sent", frame: response });
        await transmit(response, relayFrame !== undefined, fromDevice);
        emit();
      },
    };
    if (isVersionGetCommand(frame.command.params)) {
      void incoming.respond(versionGetOutcome());
      return;
    }
    incomingQueue.push(incoming);
  }

  async function applyFrame(frame: Frame): Promise<void> {
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
          applyManageRequest(inner, frame);
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
        // Verified here, never taken on the sender's word: an advert reaching this session was very often forwarded by a hub or a gateway rather than sent by the device it names, and a hub is a facilitator for the directory rather than an authority over it (wire-mesh#225). An advert that fails is dropped on its own; the frame's remaining entries are unaffected, since one forged entry says nothing about the others.
        if (!(await verifyPeerAdvert(identity, advert))) {
          continue;
        }
        // Latest advert per device wins, order preserved by first insertion -- a re-advert updates in place.
        directory.set(deviceIdToHex(advert.device), {
          device: advert.device,
          advert,
        });
        topology.recordAdvert(advert.device);
        onPeerAdvert?.(advert);
      }
    } else if (frame.type === "relay-inbound") {
      // The target-role side of a relay-connect pairing learns who dialed it only via this frame -- there is no ack frame for relay-connect itself, so an initiator simply proceeds to relay-data right after sending it.
      relayPairings.add(frame["source-device"]);
    } else if (frame.type === "manage-response") {
      applyManageResponse(frame);
    } else if (frame.type === "manage-request") {
      applyManageRequest(frame);
    } else if (frame.type === "pong") {
      pingRoundTrips.resolveOldest(clock.now());
    } else if (frame.type === "revocation-announce") {
      for (const entry of frame.entries) {
        revocationQueue.push(entry);
      }
    }
  }

  /** Establishes a relay-connect pairing to targetDevice if this session isn't already paired with it -- a no-op when it already is, whether that pairing was established by this session's own prior relay-connect (initiator role) or learned from an incoming relay-inbound (target role, replying back to whoever dialed it). Pairing with a new target never tears down an existing pairing with a different one: this connection can hold several simultaneously (wire-mesh#30's own multiplexed adjacency map), so a later request back to an already-paired target must not re-send relay-connect for it. relay-connect has no ack frame: the initiator proceeds to relay-data right after sending it. */
  async function ensureRelayPairing(targetDevice: DeviceId): Promise<void> {
    if (connection === null) {
      throw new Error("not connected");
    }
    if (relayPairings.has(targetDevice)) {
      return;
    }
    const relayConnect: Frame = {
      type: "relay-connect",
      "target-device": targetDevice,
    };
    frameLog.push({ direction: "sent", frame: relayConnect });
    await connection.send(relayConnect);
    relayPairings.add(targetDevice);
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
    pingRoundTrips.rejectAll("disconnected before a pong arrived");
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
      await applyFrame(frame);
      await onFrame?.(link, frame);
      emit();
    }
    onSessionEnd?.(link);
    if (state.status === "connected") {
      handleDisconnect("node closed the connection", address, localDomains);
    }
  }

  /** Builds this side's own self-advert and signs it with this node's own key (wire-mesh#225), which is what makes it usable by a receiver that learned of it through a hub or a gateway rather than directly from here. this node's own directly-reachable addresses (wire-mesh#38) are advertised, or none for a caller with nothing to offer (a browser client, which cannot accept inbound connections) -- either is an honest advert, not a stopgap. extensions merge onto peer-advert's own open `* tstr => any` tail -- the mechanism sendGossipUpdate uses to keep a gossiped fact (presence status, an accept/refuse policy, or any future domain's own) live over the connection's lifetime, and every such key is covered by the signature. Extensions, CORE_VERSION_GOSSIP_KEY, and topology/peers are all spread before the mandatory fields (never after) so a caller-supplied key of the same name can never shadow them on the wire -- validateGossipExtensions already rejects every such collision loudly, but the field order is kept safe in its own right rather than relying solely on the guard staying in sync. topology/peers (wire-mesh#180) is recomputed fresh on every call, the same "always current, never cached" treatment snapshot-seconds already gets, since a session's own connection identity and relay pairings can change between one self-advert and the next. */
  async function buildSelfAdvert(
    extensions?: Record<string, unknown>,
  ): Promise<GossipFrame> {
    if (extensions !== undefined) {
      validateGossipExtensions(extensions);
    }
    const advert = await signPeerAdvert(identity, {
      ...extensions,
      [CORE_VERSION_GOSSIP_KEY]: OWN_VERSION,
      [TOPOLOGY_PEERS_GOSSIP_KEY]: topology.compute(),
      device: identity.deviceId,
      addresses: [...addresses],
      "snapshot-seconds": Math.floor(clock.now() / MS_PER_SECOND),
      "identity-key": identity.identityKey,
    });
    return { type: "gossip", peers: [advert] };
  }

  /** Everything a connection needs once it exists, regardless of whether it was dialled (createMeshSession's own doConnect, below) or handed over already established (acceptMeshSession): send this side's handshake and self-advert, arm the handshake timeout, and start consuming frames. The two entry points differ only in how link itself came to exist and what address means for it -- a real dial target for one, a caller-chosen label for the other, since the Connection/Transport ports expose no remote-address concept of their own for an accepted connection. */
  async function wireUpConnection(
    link: Readonly<Connection>,
    address: string,
    localDomains: readonly string[],
  ): Promise<void> {
    connection = link;
    localHandshakeSent = localHandshake(localDomains);
    handshake = { status: "pending" };
    state = { status: "connected", address, handshake };
    frameLog.push({ direction: "sent", frame: localHandshakeSent });
    await connection.send(localHandshakeSent);
    emit();
    const selfAdvert = await buildSelfAdvert();
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

  async function doConnect(
    address: string,
    localDomains: readonly string[],
  ): Promise<void> {
    if (dial === null) {
      throw new Error(
        "this session is already connected; there is nothing to dial",
      );
    }
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    state = { status: "connecting", address };
    emit();
    const link = await dial(address);
    if (feedCancelled) {
      await link.close();
      return;
    }
    await wireUpConnection(link, address, localDomains);
  }

  return {
    wireUpConnection,
    session: {
      events: eventQueue.stream,
      incomingManageRequests: incomingQueue.stream,
      revocationAnnouncements: revocationQueue.stream,
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
        const link = requireConnectedLink();
        const ping: Frame = { type: "ping" };
        frameLog.push({ direction: "sent", frame: ping });
        await link.send(ping);
        emit();
      },
      async sendPingMeasureRtt(timeoutMs?: number): Promise<number> {
        const link = requireConnectedLink();
        return pingRoundTrips.sendAndAwait(
          clock.now(),
          async () => {
            const ping: Frame = { type: "ping" };
            frameLog.push({ direction: "sent", frame: ping });
            await link.send(ping);
            emit();
          },
          timeoutMs,
        );
      },
      setToken(token: CapabilityToken): void {
        currentToken = token;
      },
      async sendManageRequest(
        command: ManageCommand,
        scope: Readonly<CapabilityScope>,
        targetDevice?: DeviceId,
        token?: CapabilityToken,
        timeoutMs?: number,
      ): Promise<ManageOutcome> {
        requireConnectedLink();
        if (targetDevice !== undefined) {
          await ensureRelayPairing(targetDevice);
        }
        const frame = buildManageRequest(command, scope, token);
        const requestId = frame["request-id"];
        const outcome = new Promise<ManageOutcome>((resolve, reject) => {
          pendingManageRequests.set(requestId, { resolve, reject });
        });
        frameLog.push({ direction: "sent", frame });
        await transmit(frame, targetDevice !== undefined, targetDevice);
        emit();
        if (timeoutMs === undefined) {
          return outcome;
        }
        return Promise.race([
          outcome,
          new Promise<ManageOutcome>((resolve) => {
            setTimeout(() => {
              if (pendingManageRequests.delete(requestId)) {
                // A relay-connect has no acknowledgement and the hub gives no notice when a pairing is lost (the target reconnected, or the hub itself restarted), so this session cannot otherwise tell a live pairing from a dead one. An unanswered relayed request is the only evidence it gets, and keeping the pairing would blackhole every later request to that device for as long as this connection lives, whereas forgetting it costs one extra relay-connect.
                if (targetDevice !== undefined) {
                  relayPairings.remove(targetDevice);
                }
                resolve({ result: "error", code: "timeout" });
              }
            }, timeoutMs);
          }),
        ]);
      },
      async sendRevocationAnnounce(
        entries: readonly RevocationEntry[],
      ): Promise<void> {
        requireConnectedLink();
        const frame: RevocationAnnounceFrame = {
          type: "revocation-announce",
          entries: [...entries],
        };
        frameLog.push({ direction: "sent", frame });
        await transmit(frame, false);
        emit();
      },
      async sendGossipUpdate(
        extensions?: Record<string, unknown>,
      ): Promise<void> {
        requireConnectedLink();
        const frame = await buildSelfAdvert(extensions);
        frameLog.push({ direction: "sent", frame });
        await transmit(frame, false);
        emit();
      },
      getTopologyPeers(): TopologyPeers {
        return topology.compute();
      },
      async sendDataFrame(
        frame: DataHaveFrame | DataRequestFrame | DataEntriesFrame,
      ): Promise<void> {
        requireConnectedLink();
        frameLog.push({ direction: "sent", frame });
        await transmit(frame, false);
        emit();
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
        pingRoundTrips.rejectAll("connection closed before a pong arrived");
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
    },
  };
}

export function createMeshSession(
  transport: Readonly<Transport>,
  identity: Readonly<IdentityPort>,
  clock: Readonly<Clock> = { now: () => Date.now() },
  reconnect: ReconnectPolicy | null = null,
  /** This node's own directly-reachable "host:port" candidates (wire-mesh#38), advertised in this session's self-advert so other peers can attempt a direct connection instead of always falling back to a relay. Omit (or pass none) for a caller with nothing to offer, e.g. a browser client. */
  addresses: readonly string[] = [],
  /** Fired for every peer-advert entry as it's applied to the directory, regardless of source -- the hook a gossip-expansion consumer (wire-mesh#187, gossip-expansion.ts's own createGossipExpansion) uses to observe newly-gossiped peers without becoming a second, competing consumer of this session's own single-reader events stream (each emitted SessionEvent wakes at most one waiter, so a second for-await loop over events would silently steal events from whichever consumer already reads it). Omit for a caller with no use for it, exactly today's behaviour. */
  onPeerAdvert?: (advert: PeerAdvert) => void,
): MeshSession {
  const { session } = createSessionCore(
    identity,
    clock,
    reconnect,
    async (address) => transport.connect(address),
    onPeerAdvert,
    addresses,
  );
  return session;
}

/** A MeshSession built over a connection that already exists (a Transport's own listen() handed it to onConnection), extended with the one thing a dial-side session can't offer: the device-id of the specific peer at the other end. Unlike createMeshSession, which may end up talking to a relay gossiping about many devices at once, an accepted connection is the agent-comms case -- exactly two peers, directly connected -- so "the peer" is well-defined here in a way it structurally isn't for the dial side. */
export interface AcceptedMeshSession extends MeshSession {
  /** Resolves with the device-id carried by the first peer-advert this connection's remote sends -- the same self-advertisement mechanism createMeshSession's own directory already relies on for every peer, just narrowed to "the one peer this specific connection is with" rather than accumulated into a directory of possibly many. There is no transport-level authentication behind this yet (see wire-mesh#45's own createTlsTransport item): it is only as trustworthy as the remote's own gossip, exactly the same trust level the dial-side directory already has for every entry in it. */
  peerDeviceId: Promise<DeviceId>;
}

export interface AcceptedMeshSessionOptions {
  /** A caller-chosen label for this connection, used only for ConnectionState's own address field -- the Connection/Transport ports expose no remote-address concept an accepted connection could report on its own (see wire-mesh#45). Defaults to a fixed placeholder since most callers have nothing more specific to offer; a transport adapter that does know the remote's address should pass it here. */
  label?: string;
  clock?: Readonly<Clock>;
  /** This node's own directly-reachable "host:port" candidates (wire-mesh#38), advertised in this session's self-advert. Omit (or pass none) for a caller with nothing to offer. */
  addresses?: readonly string[];
  /** Observes every frame this session receives, alongside (never instead of) its own manage-request/gossip/handshake handling (wire-mesh#102) -- the integration point an "ordinary opted-in node relays for peers it's already talking to" uses: pass a shared RelayHub instance's own handleFrame, bound to this connection, and it sees the identical frame stream this session's own applyFrame already consumes, with no second for-await loop racing over the same connection.receive(). A dedicated wire-mesh/cloudflare-hub deployment, which never runs a MeshSession at all, is unaffected -- this is additive, opt-in, and irrelevant to that case. */
  onFrame?: (
    connection: Readonly<Connection>,
    frame: Frame,
  ) => void | Promise<void>;
  /** Fired once this session's own connection.receive() stream ends -- the counterpart a RelayHub's own forgetConnection needs, since its registry is keyed by this exact Connection and must be cleaned up when it specifically ends. */
  onSessionEnd?: (connection: Readonly<Connection>) => void;
  /** Fired for every peer-advert entry as it's applied to the directory, regardless of source -- alongside (never instead of) this session's own internal peerDeviceId resolution, which uses this identical hook internally and keeps working unchanged. See createMeshSession's own onPeerAdvert doc comment for why this exists: a gossip-expansion consumer (wire-mesh#187) needs to observe every advert without becoming a second, competing consumer of this session's own single-reader events stream. */
  onPeerAdvert?: (advert: PeerAdvert) => void;
}

/** Wires an already-accepted Connection up as a full MeshSession, mirroring exactly what createMeshSession's own dial path does once a connection exists (send handshake, send self-advert, negotiate, consume frames) -- the wire-mesh#45 prerequisite agent-comms needs, since its peers both listen and dial rather than only ever dialing the way web-console's own console UI does. Reconnect does not apply here: if this connection drops, only the remote redialing and being accepted again produces a new connection, and therefore a new session -- there is nothing on this side to retry. */
export async function acceptMeshSession(
  connection: Readonly<Connection>,
  identity: Readonly<IdentityPort>,
  localDomains: readonly string[],
  options: Readonly<AcceptedMeshSessionOptions> = {},
): Promise<AcceptedMeshSession> {
  const clock = options.clock ?? { now: () => Date.now() };
  let resolvePeerDeviceId: ((device: DeviceId) => void) | null = null;
  const peerDeviceId = new Promise<DeviceId>((resolve) => {
    resolvePeerDeviceId = resolve;
  });
  let peerDeviceIdResolved = false;
  const { session, wireUpConnection } = createSessionCore(
    identity,
    clock,
    null,
    null,
    (advert) => {
      if (!peerDeviceIdResolved) {
        peerDeviceIdResolved = true;
        resolvePeerDeviceId?.(advert.device);
      }
      options.onPeerAdvert?.(advert);
    },
    options.addresses,
    options.onFrame,
    options.onSessionEnd,
  );
  await wireUpConnection(connection, options.label ?? "accepted", localDomains);
  return { ...session, peerDeviceId };
}
