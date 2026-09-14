// The hub's relay role, expressed purely against core's Transport port and the generated frame schemas -- no Worker-specific or WebSocket-specific type appears here, so the same logic runs under the TCP adapter in tests or any future transport. A connection's device-id is learned from its own gossiped peer-advert (the only spec frame that carries a device-id over a plain connection; TLS-cert identity extraction is deliberately out of scope for the WebSocket-ingress first pass, noted in the README). Registry semantics: last gossip wins for a device-id, and a mapping is only removed on disconnect if it still points at the connection that registered it, so a re-announcement by a newer connection isn't clobbered by an older one leaving.
//
// Multiplexing: a connection may hold more than one relay pairing at once (a peer fanning a message out to several members of a group, all of whom are only reachable through this same hub). Pairings are therefore a symmetric adjacency map keyed by *connection*, not resolved through the device registry at forward time -- device-ids here are gossip-asserted, not certificate-verified, and re-resolving through the registry per frame would let a pairing silently re-attach to whichever connection most recently claimed a device-id, a spoofing vector. Keying by connection preserves the existing behaviour that an established pairing survives its peer's device mapping moving to a fresher connection, and dies only with the connection itself. `relay-data-frame`'s `to-device`/`from-device` fields disambiguate which pairing a frame belongs to now that a connection can hold several; a connection with exactly one pairing may omit `to-device`, which every legacy peer already does, so an unaddressed frame under multiplexing routes to the most recently established pairing -- the same "last one wins" semantics the old single-pairing hub already had.
//
// Gossip forwarding and catch-up (wire-mesh#110): every `gossip-frame` this hub receives triggers two things, beyond registering the advert locally. First, the frame is re-broadcast, unmodified, to every *other* currently-connected client (never back to the sender) -- unconditionally, on every frame, with no dedup against a previously-seen advert. This is deliberately not the same "never touches payload" blindness `relay-data` gets: the hub already parses a gossip frame's `peers` to populate its own device registry above, so forwarding it is extending existing, already-established visibility, not opening a new blind spot -- `relay-data`'s ciphertext payload stays untouched and unforwarded-to-third-parties, which is the invariant that actually matters for end-to-end confidentiality. Unconditional (no per-advert or per-recipient cache) is a deliberate choice, not an oversight: `peer-advert.snapshot-seconds`/`addresses` are meant to keep propagating on every re-gossip (a liveness heartbeat, an address change), so suppressing a "duplicate" would silently stop legitimate freshness updates from reaching other clients. Loop-safety needs no extra bookkeeping either: this hub only ever re-broadcasts to its own directly-connected clients (a star topology, one hop), and nothing here re-gossips a frame it received back onto the wire on its own initiative, so there is no path for a forwarded frame to cycle back through this hub a second time. A forward that fails (the target connection has died) is swallowed per-recipient so one dead peer never aborts delivery to the rest of the fan-out, or the sending connection's own frame processing -- that peer's own `handleConnection` loop notices the same death independently via its `receive()` stream and cleans up through the ordinary disconnect path.
//
// Second, the sender itself is sent a catch-up `gossip-frame` bundling every *other* currently-known device's latest advert. This is not optional polish: every client gossips its own self-advert exactly once, at connect time, and never repeats it on its own initiative (see `mesh-session.ts`'s `sendGossipUpdate` doc comment -- there is no re-advertisement timer built into a session, so a caller that never calls it again is "today's existing gossip-once-on-connect behaviour"). Forwarding alone therefore only reaches whichever clients happen to already be connected at the exact moment a given advert is gossiped; a client that connects even slightly later would otherwise never learn about anyone who gossiped before it, no matter how long it then stays connected, since nothing ever re-sends that earlier advert again. The catch-up frame closes this gap by replaying the hub's own already-known directory to every gossiping connection, not only ones that have never gossiped before -- a connection re-gossiping (an address change, a fresher `snapshot-seconds`) is caught up again too, which is harmless and correctly reflects current state under the same no-caching philosophy as the forward above. `Registration` keeps the full `peer-advert`, not just a bare device-id, specifically so this catch-up frame can be built from real, previously-received adverts rather than synthesising one.

import type { DeviceId, Frame, PeerAdvert } from "../generated/protocol.js";
import type { Connection } from "../ports/transport.js";

interface Registration {
  connection: Readonly<Connection>;
  // The full advert, not just the device-id, so a late-joining connection can be caught up with a real, replayable peer-advert (see the gossip catch-up mechanism in handleFrame) rather than a synthesised one.
  advert: PeerAdvert;
}

export interface RelayHub {
  /** Drives one accepted connection until it closes: registers gossip-advertised devices, re-broadcasts each gossip frame to every other connected client and replies to the gossiping connection with a catch-up frame of every other already-known device, answers relay-connect by pairing and notifying the target, and forwards relay-data within established pairings. Resolves when the connection's frame stream ends. */
  handleConnection: (connection: Readonly<Connection>) => Promise<void>;
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

export function createRelayHub(): RelayHub {
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
      }
      pairings.delete(connection);
    }
  }

  async function handleFrame(
    connection: Readonly<Connection>,
    frame: Frame,
  ): Promise<void> {
    if (frame.type === "gossip") {
      for (const advert of frame.peers) {
        devices.set(deviceKey(advert.device), { connection, advert });
      }
      // Recomputed here, once per gossip frame, rather than scanned per relay-data forward: mirrors the previous deviceOf() scan's own semantics (the connection's own device is whichever currently-registered device points back at it) without paying that scan's cost on every forwarded frame.
      for (const registration of devices.values()) {
        if (registration.connection === connection) {
          connectionDevice.set(connection, registration.advert.device);
          break;
        }
      }
      // Re-broadcast, unmodified, to every other currently-connected client -- see module header for why this is unconditional, undeduplicated, and loop-safe. A per-recipient send failure is swallowed so one dead peer never aborts the rest of the fan-out or this connection's own frame processing.
      for (const other of connections) {
        if (other === connection) {
          continue;
        }
        try {
          await other.send(frame);
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
      });
      return;
    }

    // Everything else (handshake, ping, candidates, manage-*, streaming, data-domain, coordinator, revocation-announce) is not the relay role's business: the hub is a transport-level node and forwards nothing it isn't named in. Frames are consumed and dropped.
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
    stop() {
      connections.clear();
      devices.clear();
      connectionDevice.clear();
      pairings.clear();
      mostRecentPairing.clear();
    },
  };
}
