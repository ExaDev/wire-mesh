// The hub's relay role, expressed purely against core's Transport port and the generated frame schemas -- no Worker-specific or WebSocket-specific type appears here, so the same logic runs under the TCP adapter in tests or any future transport. A connection's device-id is learned from its own gossiped peer-advert (the only spec frame that carries a device-id over a plain connection; TLS-cert identity extraction is deliberately out of scope for the WebSocket-ingress first pass, noted in the README).
//
// Registry semantics (wire-mesh#225). Every advert is verified before it is registered, forwarded, or replayed in a catch-up frame: the embedded identity-key must hash to the device the advert names, and the signature must verify under that key (see peer-advert.ts). Nothing else authenticates a gossiped device-id here, so an unverified advert would let any connection publish an entry under another device's id and draw that device's routed traffic to itself. Adverts for devices other than the gossiping connection's own are entirely legitimate -- a gateway forwards the adverts of the local peers it fronts -- which is exactly why an advert is bound to the device that signed it rather than to the connection it arrived on. An advert that fails verification is dropped individually: the frame's remaining adverts are still registered and forwarded, since one forged entry says nothing about the others, and a frame whose adverts are all refused is dropped entirely rather than earning its sender a catch-up dump of the directory.
//
// A signature alone does not stop a connection replaying a victim's genuine, correctly-signed advert to take over its route, so registration additionally compares freshness. An advert naming a device currently registered to a DIFFERENT live connection takes that registration over only when its `snapshot-seconds` is strictly greater than the registered advert's; an advert from the connection that already holds the registration updates it when `snapshot-seconds` is greater than or equal, so an unchanged heartbeat from the rightful owner still refreshes what the hub holds. The limitation this leaves, stated rather than papered over: a device that reconnects within the same second while its previous connection is still open does not displace that connection until its next gossip carries a later second. A device-id mapping is still only removed on disconnect if it still points at the connection that registered it, so a re-announcement by a newer connection isn't clobbered by an older one leaving.
//
// Multiplexing: a connection may hold more than one relay pairing at once (a peer fanning a message out to several members of a group, all of whom are only reachable through this same hub). Pairings are therefore a symmetric adjacency map keyed by *connection*, not resolved through the device registry at forward time -- device-ids here are gossip-asserted, not certificate-verified, and re-resolving through the registry per frame would let a pairing silently re-attach to whichever connection most recently claimed a device-id, a spoofing vector. Keying by connection preserves the existing behaviour that an established pairing survives its peer's device mapping moving to a fresher connection, and dies only with the connection itself. `relay-data-frame`'s `to-device`/`from-device` fields disambiguate which pairing a frame belongs to now that a connection can hold several; a connection with exactly one pairing may omit `to-device`, which every legacy peer already does, so an unaddressed frame under multiplexing routes to the most recently established pairing -- the same "last one wins" semantics the old single-pairing hub already had. `to-device` is also echoed onward, unmodified, in the frame this hub delivers to the receiving connection, never just consumed for the routing lookup above: a receiving connection that itself fronts more than one locally-addressable device (a gateway advertising several local peers over one hub connection, wire-mesh#170) has no other way to tell which of its own devices a given frame was actually addressed to, since from its side every relay-data frame arrives multiplexed over the same single connection regardless of target.
//
// Gossip forwarding and catch-up (wire-mesh#110): every `gossip-frame` this hub receives triggers two things, beyond registering the advert locally. First, the frame's accepted adverts are re-broadcast, byte-identical to how they arrived, to every *other* currently-connected client (never back to the sender) -- unconditionally, on every frame, with no dedup against a previously-seen advert. Forwarding an advert verbatim is not an optimisation but a requirement: the signature covers every entry, so a hub that rebuilt or edited an advert on the way through would invalidate it for every receiver. This is deliberately not the same "never touches payload" blindness `relay-data` gets: the hub already parses a gossip frame's `peers` to populate its own device registry above, so forwarding it is extending existing, already-established visibility, not opening a new blind spot -- `relay-data`'s ciphertext payload stays untouched and unforwarded-to-third-parties, which is the invariant that actually matters for end-to-end confidentiality. Unconditional (no per-advert or per-recipient cache) is a deliberate choice, not an oversight: `peer-advert.snapshot-seconds`/`addresses` are meant to keep propagating on every re-gossip (a liveness heartbeat, an address change), so suppressing a "duplicate" would silently stop legitimate freshness updates from reaching other clients. Loop-safety needs no extra bookkeeping either: this hub only ever re-broadcasts to its own directly-connected clients (a star topology, one hop), and nothing here re-gossips a frame it received back onto the wire on its own initiative, so there is no path for a forwarded frame to cycle back through this hub a second time. A forward that fails (the target connection has died) is swallowed per-recipient so one dead peer never aborts delivery to the rest of the fan-out, or the sending connection's own frame processing -- that peer's own `handleConnection` loop notices the same death independently via its `receive()` stream and cleans up through the ordinary disconnect path.
//
// Second, the sender itself is sent a catch-up `gossip-frame` bundling every *other* currently-known device's latest advert. This is not optional polish: every client gossips its own self-advert exactly once, at connect time, and never repeats it on its own initiative (see `mesh-session.ts`'s `sendGossipUpdate` doc comment -- there is no re-advertisement timer built into a session, so a caller that never calls it again is "today's existing gossip-once-on-connect behaviour"). Forwarding alone therefore only reaches whichever clients happen to already be connected at the exact moment a given advert is gossiped; a client that connects even slightly later would otherwise never learn about anyone who gossiped before it, no matter how long it then stays connected, since nothing ever re-sends that earlier advert again. The catch-up frame closes this gap by replaying the hub's own already-known directory to every gossiping connection, not only ones that have never gossiped before -- a connection re-gossiping (an address change, a fresher `snapshot-seconds`) is caught up again too, which is harmless and correctly reflects current state under the same no-caching philosophy as the forward above. `Registration` keeps the full `peer-advert`, not just a bare device-id, specifically so this catch-up frame can be built from real, previously-received adverts rather than synthesising one.

// Outliving the hub instance (wire-mesh#223): registry and pairing state is held in memory and keyed by Connection, neither of which a host can hand to a successor instance directly. exportConnection/restoreConnections bridge that gap by expressing one connection's state as device-ids and adverts alone: serialisable, and resolvable back to connections by a successor that still holds them. A host that can be torn down while its connections stay open subscribes to onConnectionStateChanged, persists the exported value wherever it keeps per-connection state, and replays the survivors through restoreConnections before handling their next frame. The hub itself neither persists nor schedules anything: what a pairing is keyed by, and when a state changes, are its own business, and where that state is kept between instances is the host's.

import type { DeviceId, Frame, PeerAdvert } from "../generated/protocol.js";
import type { Connection } from "../ports/transport.js";
import { verifyPeerAdvert, type PeerAdvertVerifier } from "./peer-advert.js";

interface Registration {
  connection: Readonly<Connection>;
  // The full advert, not just the device-id, so a late-joining connection can be caught up with a real, replayable peer-advert (see the gossip catch-up mechanism in handleFrame) rather than a synthesised one.
  advert: PeerAdvert;
}

/**
 * One connection's relay state in serialisable form: everything a hub that never saw the connection register needs, alongside the still-open connection itself, to answer its next frame exactly as the hub that established the state would have. Only device-ids and adverts appear, never a Connection, so a host can persist this wherever it keeps per-connection state.
 */
export interface RelayConnectionState {
  /** The device-id the hub attributes to the connection itself: what its relay-data frames are stamped with as `from-device`, and what a peer's own pairing map keys this connection by. */
  readonly device: DeviceId;
  /** Every peer-advert still registered against this connection in the hub's device directory, in registration order, so a restored hub can resolve a relay-connect naming one of them and can replay them in its gossip catch-up. Empty when a later connection has taken over every device-id this one advertised. */
  readonly adverts: readonly PeerAdvert[];
  /** The device-id of each peer this connection currently holds a relay pairing with. Order carries no meaning; the unaddressed-relay-data route is `mostRecentDevice` alone. */
  readonly pairedDevices: readonly DeviceId[];
  /** The peer a relay-data frame carrying no `to-device` routes to. Absent when the connection has no such fallback, either because it holds no pairings or because the peer that was most recent has since disconnected. */
  readonly mostRecentDevice?: DeviceId;
}

/** One surviving connection paired with what a previous hub instance knew about it, as restoreConnections takes it. */
export interface RelayConnectionRestore {
  readonly connection: Readonly<Connection>;
  readonly state: RelayConnectionState;
}

export interface RelayHubOptions {
  /** The crypto primitives this hub verifies every gossiped advert with (wire-mesh#225). Narrowed to verify/deriveDeviceId rather than a full IdentityPort because an advert is self-certifying: a hub checks one against the key the advert itself carries, and never needs a signing identity of its own to do it. */
  readonly identity: Readonly<PeerAdvertVerifier>;
  /** Called whenever the value exportConnection returns for a connection changes: it gossiped an advert, gained or lost a pairing, or had one of its adverts taken over by another connection. A host whose own instance can be torn down while its connections stay open (the Cloudflare hub's hibernating Durable Object) reads the new value back with exportConnection, persists it against the connection, and hands it to a later instance through restoreConnections. */
  readonly onConnectionStateChanged?: (
    connection: Readonly<Connection>,
  ) => void;
}

export interface RelayHub {
  /** Drives one accepted connection until it closes: registers gossip-advertised devices, re-broadcasts each gossip frame to every other connected client and replies to the gossiping connection with a catch-up frame of every other already-known device, answers relay-connect by pairing and notifying the target, forwards relay-data within established pairings, and replies to a bare ping with a bare pong (wire-mesh#181) so a client can time its own sender-to-hub leg independent of anything being relayed. Resolves when the connection's frame stream ends. Internally just registerConnection followed by a loop of onFrame calls and a final onDisconnect -- kept as its own method since a dedicated hub deployment (wire-mesh/cloudflare-hub) has nothing else driving the connection and wants the whole lifecycle in one call. */
  handleConnection: (connection: Readonly<Connection>) => Promise<void>;
  /** Registers a connection with this hub without taking over its own frame-consumption loop (wire-mesh#102) -- the entry point an "ordinary opted-in node relays for peers it's already talking to" uses, alongside onFrame/onDisconnect below, to let a MeshSession's own single connection.receive() loop drive this hub rather than running a second, competing one. Must be called once, before the first onFrame call for this connection, so gossip fan-out (which forwards to every OTHER registered connection) already sees it. */
  registerConnection: (connection: Readonly<Connection>) => void;
  /** Observes one frame on an already-registered connection -- the same per-frame logic handleConnection's own loop calls internally, exposed directly so a caller with its own frame-consumption loop can drive it without a second for-await over the same connection.receive(). */
  onFrame: (connection: Readonly<Connection>, frame: Frame) => Promise<void>;
  /** Cleans up all registry and pairing state for one connection once its own frame stream has ended -- the onSessionEnd counterpart registerConnection/onFrame needs for the shared-consumption case, since this hub's registry is keyed by Connection and has no other way to learn a connection is gone. */
  onDisconnect: (connection: Readonly<Connection>) => void;
  /** The serialisable relay state of one registered connection, or undefined when it holds none worth keeping: a connection that has never gossiped an advert can neither be named by a relay-connect nor send a routable relay-data frame, so there is nothing for a later hub to restore. */
  exportConnection: (
    connection: Readonly<Connection>,
  ) => RelayConnectionState | undefined;
  /** Rebuilds device-registry and pairing state for connections that outlived the hub instance which established it, so a frame arriving on one of them routes as it did before rather than being dropped as unknown. Each entry's connection is registered as if registerConnection had been called for it. Pairings resolve within the batch: a paired device-id no entry claims belonged to a peer that disconnected while no instance was running, and its pairing is correctly left out. Meant for a freshly created hub, before it handles any frame. */
  restoreConnections: (entries: readonly RelayConnectionRestore[]) => void;
  /** Drops all registry and pairing state -- used by tests and by transport teardown. */
  stop: () => void;
}

const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;

function deviceKey(device: Uint8Array): string {
  let key = "";
  for (const byte of device) {
    key += byte.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_BYTE, "0");
  }
  return key;
}

/** The exact inverse of deviceKey, so a pairing map's own hex keys can be exported as the device-ids they were built from without holding a second copy of the bytes on the forwarding path. */
function deviceFromKey(key: string): DeviceId {
  const device = new Uint8Array(key.length / HEX_DIGITS_PER_BYTE);
  for (let i = 0; i < device.length; i++) {
    device[i] = Number.parseInt(
      key.slice(i * HEX_DIGITS_PER_BYTE, (i + 1) * HEX_DIGITS_PER_BYTE),
      HEX_RADIX,
    );
  }
  return device;
}

/**
 * Whether an already-verified advert may take over the registration a device currently holds (wire-mesh#225).
 *
 * Strictly newer when it arrives on a different connection from the one holding the registration, so replaying a victim's genuine advert -- which carries the victim's own `snapshot-seconds` unchanged, since altering it would break the signature -- can never steal its route. Newer-or-equal from the connection that already holds it, so an unchanged heartbeat from the rightful owner still refreshes the addresses and extensions the hub replays in catch-up frames.
 */
function supersedes(
  registered: Readonly<Registration>,
  advert: Readonly<PeerAdvert>,
  connection: Readonly<Connection>,
): boolean {
  const incoming = advert["snapshot-seconds"];
  const held = registered.advert["snapshot-seconds"];
  return registered.connection === connection ? incoming >= held : incoming > held;
}

export function createRelayHub(options: Readonly<RelayHubOptions>): RelayHub {
  // Every currently-connected client, independent of whether it has gossiped a device yet -- the fan-out set for gossip re-broadcast (see module header). Not derivable from `devices`/`connectionDevice`, since a connection that hasn't gossiped anything of its own still needs to receive other clients' adverts.
  const connections = new Set<Readonly<Connection>>();
  const devices = new Map<string, Registration>();
  // The connection each gossip-registered device is currently reachable over -- maintained alongside `devices` so relay-data forwarding never needs the linear scan `deviceOf` used to do, which would otherwise run once per forwarded frame instead of once per relay-connect.
  const connectionDevice = new Map<Readonly<Connection>, DeviceId>();
  // Symmetric: pairing a connection with a peer always registers both directions, so either side's own map lookup finds the other. Each connection's own map is keyed by the peer's device hex, letting one connection hold pairings with several peers at once.
  const pairings = new Map<
    Readonly<Connection>,
    Map<string, Readonly<Connection>>
  >();
  // The most recently established pairing per connection, for routing a legacy peer's unaddressed relay-data (no to-device) the same way the old single-pairing hub always did: whichever relay-connect happened last wins.
  const mostRecentPairing = new Map<
    Readonly<Connection>,
    Readonly<Connection>
  >();

  function stateChanged(connection: Readonly<Connection>): void {
    options.onConnectionStateChanged?.(connection);
  }

  function pairingsOf(
    connection: Readonly<Connection>,
  ): Map<string, Readonly<Connection>> {
    const existing = pairings.get(connection);
    if (existing) {
      return existing;
    }
    const created = new Map<string, Readonly<Connection>>();
    pairings.set(connection, created);
    return created;
  }

  function addPairing(
    a: Readonly<Connection>,
    aDevice: DeviceId,
    b: Readonly<Connection>,
    bDevice: DeviceId,
  ): void {
    pairingsOf(a).set(deviceKey(bDevice), b);
    pairingsOf(b).set(deviceKey(aDevice), a);
    mostRecentPairing.set(a, b);
    mostRecentPairing.set(b, a);
  }

  function forgetConnection(connection: Readonly<Connection>): void {
    connections.delete(connection);
    for (const [key, registration] of devices) {
      if (registration.connection === connection) {
        devices.delete(key);
      }
    }
    // Captured before deletion: needed below to find which key in each peer's own pairing map points back at this connection.
    const ownDevice = connectionDevice.get(connection);
    connectionDevice.delete(connection);
    mostRecentPairing.delete(connection);
    const own = pairings.get(connection);
    if (own) {
      for (const peer of own.values()) {
        const peerOwn = pairings.get(peer);
        if (peerOwn && ownDevice !== undefined) {
          peerOwn.delete(deviceKey(ownDevice));
        }
        if (mostRecentPairing.get(peer) === connection) {
          mostRecentPairing.delete(peer);
        }
        stateChanged(peer);
      }
      pairings.delete(connection);
    }
  }

  function exportConnection(
    connection: Readonly<Connection>,
  ): RelayConnectionState | undefined {
    const device = connectionDevice.get(connection);
    if (device === undefined) {
      return undefined;
    }
    const adverts: PeerAdvert[] = [];
    for (const registration of devices.values()) {
      if (registration.connection === connection) {
        adverts.push(registration.advert);
      }
    }
    const own = pairings.get(connection);
    const pairedDevices = [...(own?.keys() ?? [])].map(deviceFromKey);
    const recentPeer = mostRecentPairing.get(connection);
    // Recovered by scanning this connection's own (small) pairing map rather than held as a second field on the forwarding path, since nothing but an export ever needs the most recent peer's device-id rather than its connection.
    let mostRecentDevice: DeviceId | undefined;
    if (own && recentPeer) {
      for (const [key, peer] of own) {
        if (peer === recentPeer) {
          mostRecentDevice = deviceFromKey(key);
          break;
        }
      }
    }
    return {
      device,
      adverts,
      pairedDevices,
      ...(mostRecentDevice !== undefined ? { mostRecentDevice } : {}),
    };
  }

  function restoreConnections(
    entries: readonly RelayConnectionRestore[],
  ): void {
    // Restored adverts are registered without being re-verified, and that is correct rather than a gap: each one was already verified by the hub instance that accepted it, and the host is handing back the very bytes it persisted for a connection it still holds open. Re-checking would only re-derive the same verdict from the same bytes, at the cost of making restoreConnections asynchronous on a path that runs before the instance answers its first frame. An advert arriving on the wire afterwards is verified normally, and is compared for freshness against these restored ones exactly as against any other registration.
    //
    // Two passes, because a pairing names its peer by device-id and only the first pass establishes which connection each device-id belongs to. Keyed on each entry's own `device` rather than on the rebuilt `devices` directory: a pairing is with the connection that held the device-id when the pairing was made, which is exactly what that connection's own state records, whereas the directory may already have handed the id to a fresher connection.
    const byDevice = new Map<string, Readonly<Connection>>();
    for (const { connection, state } of entries) {
      connections.add(connection);
      connectionDevice.set(connection, state.device);
      byDevice.set(deviceKey(state.device), connection);
      for (const advert of state.adverts) {
        devices.set(deviceKey(advert.device), { connection, advert });
      }
    }
    for (const { connection, state } of entries) {
      for (const paired of state.pairedDevices) {
        const peer = byDevice.get(deviceKey(paired));
        if (peer === undefined) {
          // That peer's connection did not survive, so the pairing genuinely no longer exists and restoring half of it would leave a forward with nowhere to go.
          continue;
        }
        pairingsOf(connection).set(deviceKey(paired), peer);
        pairingsOf(peer).set(deviceKey(state.device), connection);
      }
    }
    for (const { connection, state } of entries) {
      const recent = state.mostRecentDevice;
      if (recent === undefined) {
        continue;
      }
      const peer = byDevice.get(deviceKey(recent));
      if (peer !== undefined) {
        mostRecentPairing.set(connection, peer);
      }
    }
  }

  async function handleFrame(
    connection: Readonly<Connection>,
    frame: Frame,
  ): Promise<void> {
    if (frame.type === "gossip") {
      // A device-id already registered to a different connection moves here under the freshness rule above, which shrinks that connection's own exported adverts, so it is told alongside the gossiping one.
      const supplanted = new Set<Readonly<Connection>>();
      // Only the adverts that both verified and won their freshness comparison: what gets registered, forwarded, and replayed in catch-up frames. A refused advert is not forwarded either, so neither a forgery nor a replayed stale advert reaches another client through this hub.
      const accepted: PeerAdvert[] = [];
      for (const advert of frame.peers) {
        if (!(await verifyPeerAdvert(options.identity, advert))) {
          continue;
        }
        const key = deviceKey(advert.device);
        const previous = devices.get(key);
        if (previous !== undefined && !supersedes(previous, advert, connection)) {
          continue;
        }
        if (previous !== undefined && previous.connection !== connection) {
          supplanted.add(previous.connection);
        }
        devices.set(key, { connection, advert });
        accepted.push(advert);
      }
      if (accepted.length === 0) {
        // Nothing this connection sent was both authentic and fresh enough to register, so there is no state change to report, nothing new for other clients to hear, and no reason to hand an unauthenticated connection the directory in a catch-up frame.
        return;
      }
      // Recomputed here, once per gossip frame, rather than scanned per relay-data forward: mirrors the previous deviceOf() scan's own semantics (the connection's own device is whichever currently-registered device points back at it) without paying that scan's cost on every forwarded frame.
      for (const registration of devices.values()) {
        if (registration.connection === connection) {
          connectionDevice.set(connection, registration.advert.device);
          break;
        }
      }
      stateChanged(connection);
      for (const other of supplanted) {
        stateChanged(other);
      }
      // Re-broadcast to every other currently-connected client, each accepted advert exactly as it arrived -- see module header for why this is unconditional, undeduplicated, and loop-safe, and why an advert must never be rebuilt on the way through. A per-recipient send failure is swallowed so one dead peer never aborts the rest of the fan-out or this connection's own frame processing.
      const forwarded: Frame = { type: "gossip", peers: accepted };
      for (const other of connections) {
        if (other === connection) {
          continue;
        }
        try {
          await other.send(forwarded);
        } catch {
          // That peer's own connection has died; its own handleConnection loop will discover this independently via its receive() stream and clean up through the ordinary disconnect path.
        }
      }
      // Catch up the sender with every other currently-known device's latest advert -- see module header for why forwarding alone is not sufficient for a late joiner.
      const catchUp: PeerAdvert[] = [];
      for (const registration of devices.values()) {
        if (registration.connection !== connection) {
          catchUp.push(registration.advert);
        }
      }
      if (catchUp.length > 0) {
        try {
          await connection.send({ type: "gossip", peers: catchUp });
        } catch {
          // The sender's own connection just died; its own handleConnection loop (the very call running this handleFrame) will observe this the same way any other send failure on this connection would.
        }
      }
      return;
    }

    if (frame.type === "relay-connect") {
      const registration = devices.get(deviceKey(frame["target-device"]));
      if (!registration || registration.connection === connection) {
        // No such device on this hub (or it dialled itself): the spec's transport.cddl defines no error frame for this, so a first pass silently ignores the request -- a protocol change would be needed to answer it, noted in the README.
        return;
      }
      const initiatorDevice = connectionDevice.get(connection);
      if (initiatorDevice === undefined) {
        // The initiator never gossiped its own advert, so relay-inbound would carry no source-device; ignore until it identifies itself.
        return;
      }
      // Adds a pairing; does not tear down any existing ones -- a connection may hold several simultaneously. Idempotent for a target already paired (re-adding the same map entry is a no-op beyond refreshing mostRecentPairing).
      addPairing(
        connection,
        initiatorDevice,
        registration.connection,
        registration.advert.device,
      );
      stateChanged(connection);
      stateChanged(registration.connection);
      await registration.connection.send({
        type: "relay-inbound",
        "source-device": initiatorDevice,
      });
      return;
    }

    if (frame.type === "relay-data") {
      const own = pairings.get(connection);
      const toDevice = frame["to-device"];
      const peer =
        toDevice !== undefined
          ? own?.get(deviceKey(toDevice))
          : mostRecentPairing.get(connection);
      if (!peer) {
        return;
      }
      const senderDevice = connectionDevice.get(connection);
      if (senderDevice === undefined) {
        return;
      }
      await peer.send({
        type: "relay-data",
        payload: frame.payload,
        "from-device": senderDevice,
        // Echoed straight through from the frame this hub just received, not merely consumed for its own routing use above: a receiving connection fronting more than one locally-addressable device (a gateway) has no other way to learn which of its own devices the sender actually meant, since it's on the far side of a single multiplexed connection from the hub's own perspective. Omitted when the sender left it unaddressed, matching the legacy single-pairing convention (module header, "may omit to-device").
        ...(toDevice !== undefined ? { "to-device": toDevice } : {}),
      });
      return;
    }

    if (frame.type === "ping") {
      // A bare pong reply (wire-mesh#181, transport.cddl's own pong-frame), deliberately below the manage-command/capability layer this hub otherwise stays out of entirely: it lets a client isolate its own sender-to-hub leg of a relayed round trip by timing a plain ping/pong over the same connection a relay-data frame travelled, with no relay-pairing or device-registry lookup involved -- any connected client gets a pong for its own ping, exactly the same "trivial echo" scope the frame's own CDDL comment states. A failed reply means this connection just died; that's the ordinary disconnect path, not an error to surface here.
      try {
        await connection.send({ type: "pong" });
      } catch {
        // The connection died between receiving this ping and replying -- its own handleConnection loop (or the caller driving onFrame directly) will observe that independently via its receive() stream.
      }
      return;
    }

    // Everything else (handshake, candidates, manage-*, streaming, data-domain, coordinator, revocation-announce) is not the relay role's business: the hub is a transport-level node and forwards nothing it isn't named in. Frames are consumed and dropped.
  }

  return {
    async handleConnection(connection) {
      connections.add(connection);
      try {
        for await (const frame of connection.receive()) {
          await handleFrame(connection, frame);
        }
      } catch {
        // A rejecting receive iteration is the connection-level failure signal (the adapter already closed the socket for undecodable bytes or a non-binary message), and a failed relay-data peer.send inside handleFrame means that peer's connection died mid-forward (gossip's own per-recipient sends are caught individually above and never reach here) -- both are disconnects, not errors to surface, and the entry point voids its caller anyway. Cleanup below runs identically to a clean end.
      } finally {
        forgetConnection(connection);
      }
    },
    registerConnection(connection) {
      connections.add(connection);
    },
    onFrame: handleFrame,
    onDisconnect: forgetConnection,
    exportConnection,
    restoreConnections,
    stop() {
      connections.clear();
      devices.clear();
      connectionDevice.clear();
      pairings.clear();
      mostRecentPairing.clear();
    },
  };
}
