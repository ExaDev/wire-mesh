// The relay hub bound to hibernating server sockets, kept out of worker.ts so it can be exercised without the `cloudflare:workers` module a Durable Object class has to import. Everything here is expressed against HubSocket, the slice of the runtime's own socket this hub actually touches, so a test drives the identical code path with a fake socket and the Durable Object simply forwards its handler arguments.
//
// Surviving eviction (wire-mesh#223): a Durable Object instance is discarded after a short idle period while its sockets stay open, and the next message runs the constructor again on an instance holding nothing. The hub's own registry and pairings are ordinary instance state and go with it, so before this module existed a woken instance saw a relay-data frame on a pairing it had never heard of and dropped it. That is invisible to both clients: neither socket closed, so neither has any reason to re-establish anything, and the sender simply never gets its answer. It bit exactly the case a relay is most useful for, a request whose response waits on a person rather than a machine, since anything answered within a few seconds beats the eviction and anything slower does not.
//
// The fix keeps each connection's relay state on its own socket, through serializeAttachment, and adopt() reassembles the hub from those attachments on first use. An attachment was chosen over Durable Object storage for three reasons, all about lifetime rather than capacity. The runtime discards an attachment when its socket closes, which is exactly when the state stops being meaningful, so nothing has to be swept and a client that goes away while no instance is running leaves nothing behind. It is read synchronously, so a woken instance has the hub whole before it routes the frame that woke it, with no await between arrival and routing. And a socket is the only thing that survives eviction with an identity, so a storage row would still have needed an attachment to say which row belonged to which socket. The 16KiB an attachment holds is far beyond a device-id, a handful of adverts, and a pairing list, which is the entire payload.
//
// Adoption is ordered, not incremental, because a pairing names its peer by device-id and the peer is a socket this instance has yet to look at: every survivor is registered first, then restoreConnections resolves pairings across the whole batch at once. A pairing whose peer is absent from that batch is genuinely gone, and is dropped rather than half-restored. The legacy unaddressed-relay-data route rides along in the same attachment as mostRecentDevice, so a client that omits to-device keeps reaching the same peer it did before the eviction.

import { z } from "zod";
import {
  createRelayHub,
  type RelayConnectionRestore,
  type RelayConnectionState,
} from "wire-mesh-core/domain/relay-hub";
import {
  deviceIdSchema,
  peerAdvertSchema,
  type Frame,
} from "wire-mesh-core/generated/protocol";
import type { Connection } from "wire-mesh-core/ports/transport";
import { deriveDeviceId, verifyWithPublicKey } from "./adapters/web-crypto-identity.js";
import {
  CLOSE_NORMAL,
  CLOSE_PROTOCOL_ERROR,
  SchemaInvalidFrameError,
  decodeMessage,
  messageFromFrame,
} from "./adapters/websocket-transport.js";

/** The part of a hibernating server socket this hub uses. A real runtime WebSocket satisfies it structurally, so nothing has to be cast at the Durable Object boundary and a test can supply a fake instead. */
export interface HubSocket {
  send: (message: Uint8Array<ArrayBuffer>) => void;
  close: (code: number, reason: string) => void;
  serializeAttachment: (value: unknown) => void;
  deserializeAttachment: () => unknown;
}

// The attachment this hub keeps on each socket. Validated rather than trusted on the way back in: deserializeAttachment hands back whatever was written, including by a Worker version deployed before this shape existed, and on a wake there is no other record of what a socket was doing.
const attachmentSchema = z.object({
  device: deviceIdSchema,
  adverts: z.array(peerAdvertSchema),
  pairedDevices: z.array(deviceIdSchema),
  mostRecentDevice: deviceIdSchema.optional(),
});

/** The relay state an earlier instance left on this socket, or undefined when it left none this instance recognises. */
function attachedState(
  socket: Readonly<HubSocket>,
): RelayConnectionState | undefined {
  const parsed = attachmentSchema.safeParse(socket.deserializeAttachment());
  if (!parsed.success) {
    return undefined;
  }
  const { device, adverts, pairedDevices, mostRecentDevice } = parsed.data;
  return {
    device,
    adverts,
    pairedDevices,
    ...(mostRecentDevice !== undefined ? { mostRecentDevice } : {}),
  };
}

/** A send-only Connection over a hibernating server socket: the receive half is the runtime's webSocketMessage handler rather than a JS stream, so only send and close exist here. */
function sendOnlyConnection(socket: Readonly<HubSocket>): Connection {
  return {
    async send(frame: Frame): Promise<void> {
      socket.send(messageFromFrame(frame));
      return Promise.resolve();
    },
    async close(): Promise<void> {
      socket.close(CLOSE_NORMAL, "hub closing connection");
      return Promise.resolve();
    },
    receive: () => {
      // Unreachable in the hibernation shape: nothing calls receive() on a connection registered for event-driven operation.
      throw new Error("hibernating connections have no receive stream");
    },
  };
}

/** The relay hub as the Durable Object's three runtime handlers see it. */
export interface HibernatingRelayHub {
  /** Takes on a socket the runtime has just accepted for this instance. */
  accept: (socket: Readonly<HubSocket>) => void;
  /** Handles one inbound runtime message on a socket this instance may or may not already know. */
  message: (
    socket: Readonly<HubSocket>,
    message: string | ArrayBuffer,
  ) => Promise<void>;
  /** Drops all state for a socket the runtime reports as closed or failed. */
  forget: (socket: Readonly<HubSocket>) => void;
}

/**
 * Builds a relay hub over the sockets of one Durable Object instance.
 * @param survivors - Every socket the runtime currently holds for this instance. On a wake these are sockets an earlier instance accepted and this one has never seen, which is what makes them the only record of what the hub was doing.
 */
export function createHibernatingRelayHub(
  survivors: () => readonly Readonly<HubSocket>[],
): HibernatingRelayHub {
  const hub = createRelayHub({
    // Only the verification half of this runtime's Web Crypto identity: a gossiped advert is self-certifying (wire-mesh#225), so the hub checks each one against the key the advert itself carries and never needs a signing identity of its own.
    identity: { verify: verifyWithPublicKey, deriveDeviceId },
    onConnectionStateChanged: (connection) => {
      persist(connection);
    },
  });
  const connections = new Map<Readonly<HubSocket>, Connection>();
  const sockets = new Map<Connection, Readonly<HubSocket>>();
  let adopted = false;

  function persist(connection: Readonly<Connection>): void {
    const socket = sockets.get(connection);
    if (socket === undefined) {
      // The connection's socket has already closed, so there is nothing left to write to: the runtime discards a closed socket's attachment along with the socket.
      return;
    }
    // null, not a stand-in for a missing value: it is what the runtime itself hands back for a socket carrying no attachment, so writing it says the connection has nothing worth restoring rather than leaving a stale earlier value in place.
    const state = hub.exportConnection(connection);
    socket.serializeAttachment(state ?? null);
  }

  function connectionFor(socket: Readonly<HubSocket>): Connection {
    const existing = connections.get(socket);
    if (existing !== undefined) {
      return existing;
    }
    const connection = sendOnlyConnection(socket);
    connections.set(socket, connection);
    sockets.set(connection, socket);
    hub.registerConnection(connection);
    return connection;
  }

  /** Takes over every socket the runtime still holds, restoring what the instance that accepted them knew. Runs once, before this instance handles anything, so the hub is whole by the time the first frame is routed. On a freshly started instance every socket is new and this is a no-op beyond registering them. */
  function adopt(): void {
    if (adopted) {
      return;
    }
    adopted = true;
    const entries: RelayConnectionRestore[] = [];
    for (const socket of survivors()) {
      const connection = connectionFor(socket);
      const state = attachedState(socket);
      if (state !== undefined) {
        entries.push({ connection, state });
      }
    }
    hub.restoreConnections(entries);
  }

  function forget(socket: Readonly<HubSocket>): void {
    adopt();
    const connection = connections.get(socket);
    if (connection === undefined) {
      return;
    }
    connections.delete(socket);
    sockets.delete(connection);
    hub.onDisconnect(connection);
  }

  return {
    accept(socket) {
      adopt();
      connectionFor(socket);
    },
    async message(socket, message) {
      adopt();
      if (!(message instanceof ArrayBuffer)) {
        // Only binary messages carry frames; a text message from a confused or hostile client is a protocol violation, same class as undecodable bytes, so the socket closes rather than anything being relayed.
        socket.close(CLOSE_PROTOCOL_ERROR, "protocol error");
        forget(socket);
        return;
      }
      let frame: Frame;
      try {
        frame = decodeMessage(message);
      } catch (error) {
        if (error instanceof SchemaInvalidFrameError) {
          // A decodable frame that fails schema validation is dropped, keeping the connection: an unrecognised frame from a newer peer is what version negotiation exists to tolerate.
          return;
        }
        socket.close(CLOSE_PROTOCOL_ERROR, "protocol error");
        forget(socket);
        return;
      }
      await hub.onFrame(connectionFor(socket), frame);
    },
    forget,
  };
}
