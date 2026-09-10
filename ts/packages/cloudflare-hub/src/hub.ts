// The hub's relay role, expressed purely against core's Transport port and the generated frame schemas -- no Worker-specific or WebSocket-specific type appears here, so the same logic runs under the TCP adapter in tests or any future transport. A connection's device-id is learned from its own gossiped peer-advert (the only spec frame that carries a device-id over a plain connection; TLS-cert identity extraction is deliberately out of scope for the WebSocket-ingress first pass, noted in the README). Registry semantics: last gossip wins for a device-id, and a mapping is only removed on disconnect if it still points at the connection that registered it, so a re-announcement by a newer connection isn't clobbered by an older one leaving.

import type {
  DeviceId,
  Frame,
} from "@exadev/wire-mesh-core/generated/protocol";
import type { Connection } from "@exadev/wire-mesh-core/ports/transport";

interface Registration {
  connection: Readonly<Connection>;
  /** The original bytes, kept so relay-inbound can carry the initiator's device-id without re-parsing; the map itself is keyed by the hex form because a Map keyed directly on Uint8Array compares by reference, and two equal device-ids from two different parsed frames are always distinct objects. */
  device: DeviceId;
}

/** Pairs an initiating connection with the target connection it asked to reach. `initiatorDevice` is the initiator's gossiped device-id, carried in relay-inbound so the target knows who is dialing it. */
interface RelayPairing {
  initiator: Readonly<Connection>;
  initiatorDevice: DeviceId;
  target: Readonly<Connection>;
}

export interface RelayHub {
  /** Drives one accepted connection until it closes: registers gossip-advertised devices, answers relay-connect by pairing and notifying the target, and forwards relay-data within established pairings. Resolves when the connection's frame stream ends. */
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
  const devices = new Map<string, Registration>();
  const pairingsByInitiator = new Map<Readonly<Connection>, RelayPairing>();
  const pairingsByTarget = new Map<Readonly<Connection>, RelayPairing>();

  function forgetConnection(connection: Readonly<Connection>): void {
    for (const [key, registration] of devices) {
      if (registration.connection === connection) {
        devices.delete(key);
      }
    }
    const asInitiator = pairingsByInitiator.get(connection);
    if (asInitiator) {
      pairingsByInitiator.delete(connection);
      pairingsByTarget.delete(asInitiator.target);
    }
    const asTarget = pairingsByTarget.get(connection);
    if (asTarget) {
      pairingsByTarget.delete(connection);
      pairingsByInitiator.delete(asTarget.initiator);
    }
  }

  function deviceOf(connection: Readonly<Connection>): DeviceId | null {
    for (const registration of devices.values()) {
      if (registration.connection === connection) {
        return registration.device;
      }
    }
    return null;
  }

  async function handleFrame(
    connection: Readonly<Connection>,
    frame: Frame,
  ): Promise<void> {
    if (frame.type === "gossip") {
      for (const advert of frame.peers) {
        devices.set(deviceKey(advert.device), {
          connection,
          device: advert.device,
        });
      }
      return;
    }

    if (frame.type === "relay-connect") {
      const registration = devices.get(deviceKey(frame["target-device"]));
      if (!registration || registration.connection === connection) {
        // No such device on this hub (or it dialled itself): the spec's transport.cddl defines no error frame for this, so a first pass silently ignores the request -- a protocol change would be needed to answer it, noted in the README.
        return;
      }
      const initiatorDevice = deviceOf(connection);
      if (initiatorDevice === null) {
        // The initiator never gossiped its own advert, so relay-inbound would carry no source-device; ignore until it identifies itself.
        return;
      }
      // A new relay-connect re-pairs: any pairing either side already belongs to is torn down in BOTH directions first, so a stale partner's mapping cannot survive to mis-attribute its relay-data onto the new pipe.
      const staleAsInitiator = pairingsByInitiator.get(connection);
      if (staleAsInitiator) {
        pairingsByInitiator.delete(connection);
        pairingsByTarget.delete(staleAsInitiator.target);
      }
      const staleTarget = pairingsByTarget.get(registration.connection);
      if (staleTarget) {
        pairingsByTarget.delete(registration.connection);
        pairingsByInitiator.delete(staleTarget.initiator);
      }
      await registration.connection.send({
        type: "relay-inbound",
        "source-device": initiatorDevice,
      });
      const pairing: RelayPairing = {
        initiator: connection,
        initiatorDevice,
        target: registration.connection,
      };
      pairingsByInitiator.set(connection, pairing);
      pairingsByTarget.set(registration.connection, pairing);
      return;
    }

    if (frame.type === "relay-data") {
      const pairing =
        pairingsByInitiator.get(connection) ?? pairingsByTarget.get(connection);
      if (!pairing) {
        return;
      }
      const peer =
        pairing.initiator === connection ? pairing.target : pairing.initiator;
      await peer.send(frame);
      return;
    }

    // Everything else (handshake, ping, candidates, manage-*, streaming, data-domain, coordinator, revocation-announce) is not the relay role's business: the hub is a transport-level node and forwards nothing it isn't named in. Frames are consumed and dropped.
  }

  return {
    async handleConnection(connection) {
      try {
        for await (const frame of connection.receive()) {
          await handleFrame(connection, frame);
        }
      } catch {
        // A rejecting receive iteration is the connection-level failure signal (the adapter already closed the socket for undecodable bytes or a non-binary message), and a failed peer.send inside handleFrame means that peer's connection died mid-forward -- both are disconnects, not errors to surface, and the entry point voids its caller anyway. Cleanup below runs identically to a clean end.
      } finally {
        forgetConnection(connection);
      }
    },
    stop() {
      devices.clear();
      pairingsByInitiator.clear();
      pairingsByTarget.clear();
    },
  };
}
