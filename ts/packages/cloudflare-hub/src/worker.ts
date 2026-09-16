// The Worker entry. The Durable Object class must be exported from this entrypoint file for wrangler to bind it (wrangler.toml names this export), so it is defined here directly rather than re-exported from a sibling module.
//
// Hibernation-native by necessity: the original shape parked a JS consume loop (handleConnection over the adapter's receive() iteration) on classically-accepted sockets, which worked under `wrangler dev` but silently processed nothing in production -- after fetch() returned the 101, the real runtime never delivered further messages into that parked promise chain, so every inbound frame after connect was dropped (the first production live-check run failed exactly there: connects and upgrades fine, zero frames ever forwarded). The hibernation API is the documented production shape: state.acceptWebSocket hands the socket to the runtime, and inbound messages arrive as webSocketMessage handler invocations -- event-driven, no parked loop, and the socket itself survives DO eviction. The hub is driven per-message via its registerConnection/onFrame/onDisconnect surface (the same event-driven entry wire-mesh#102 added for ordinary relaying nodes).
//
// Eviction honesty: instance fields (the hub's registry and pairings, the socket-to-connection map) do NOT survive eviction -- only the sockets do, via hibernation. On wake, a message from a surviving socket finds no mapping and re-registers it: gossip state rebuilds from the re-gossipped adverts (clients re-advertise on reconnect, and the hub's catch-up reply re-syncs what the re-woken hub saw from still-connected peers via getWebSockets), while relay pairings -- inherently runtime state -- must be re-established by a fresh relay-connect from the client, exactly what every client already does on reconnect.

import { DurableObject } from "cloudflare:workers";
import { createRelayHub, type RelayHub } from "wire-mesh-core/domain/relay-hub";
import type { Connection } from "wire-mesh-core/ports/transport";
import type { Frame } from "wire-mesh-core/generated/protocol";
import {
  CLOSE_PROTOCOL_ERROR,
  SchemaInvalidFrameError,
  decodeMessage,
  messageFromFrame,
} from "./adapters/websocket-transport.js";

export function healthResponse(): Response {
  return Response.json({
    ok: true,
    node: "wire-mesh-cloudflare-hub",
    roles: ["relay"],
  });
}

/** A send-only Connection over a hibernating server socket -- the receive half is the runtime's webSocketMessage handler, not a JS stream, so only send/close exist here. */
function sendOnlyConnection(serverSocket: Readonly<WebSocket>): Connection {
  return {
    send: async (frame: Frame) => {
      serverSocket.send(messageFromFrame(frame));
    },
    close: async () => {
      serverSocket.close(1000, "hub closing connection");
    },
    receive: () => {
      // Unreachable in the hibernation shape: nothing calls receive() on a connection registered for event-driven operation.
      throw new Error("hibernating connections have no receive stream");
    },
  };
}

export class RelayHubDurableObject extends DurableObject<unknown> {
  private readonly hub: RelayHub = createRelayHub();
  /** The registered send-only Connection per live server socket, keyed by the socket object itself. */
  private readonly connections = new Map<Readonly<WebSocket>, Connection>();

  private connectionFor(serverSocket: Readonly<WebSocket>): Connection {
    const existing = this.connections.get(serverSocket);
    if (existing !== undefined) {
      return existing;
    }
    const connection = sendOnlyConnection(serverSocket);
    this.connections.set(serverSocket, connection);
    this.hub.registerConnection(connection);
    return connection;
  }

  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      // The Worker router already answers non-WebSocket requests itself; this covers only a malformed upgrade routed here anyway.
      return healthResponse();
    }
    const pair = new WebSocketPair();
    // Hibernation accept: the runtime owns delivery (webSocketMessage below) and the socket survives eviction, unlike classic accept.
    this.ctx.acceptWebSocket(pair[1]);
    this.connectionFor(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(
    serverSocket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (!(message instanceof ArrayBuffer)) {
      // Only binary messages carry frames; a text message from a confused or hostile client is a protocol violation, same class as undecodable bytes -- close the socket rather than relay anything.
      serverSocket.close(CLOSE_PROTOCOL_ERROR, "protocol error");
      this.forget(serverSocket);
      return;
    }
    let frame: Frame;
    try {
      frame = decodeMessage(message);
    } catch (error) {
      if (error instanceof SchemaInvalidFrameError) {
        // A decodable frame that fails schema validation is dropped, keeping the connection -- an unrecognised frame from a newer peer is what version negotiation exists to tolerate.
        return;
      }
      serverSocket.close(CLOSE_PROTOCOL_ERROR, "protocol error");
      this.forget(serverSocket);
      return;
    }
    // Re-registering on miss is the eviction-wake path: the socket survived, this instance did not.
    const connection = this.connectionFor(serverSocket);
    await this.hub.onFrame(connection, frame);
  }

  async webSocketClose(serverSocket: WebSocket): Promise<void> {
    this.forget(serverSocket);
  }

  async webSocketError(serverSocket: WebSocket): Promise<void> {
    this.forget(serverSocket);
  }

  private forget(serverSocket: Readonly<WebSocket>): void {
    const connection = this.connections.get(serverSocket);
    if (connection === undefined) {
      return;
    }
    this.connections.delete(serverSocket);
    this.hub.onDisconnect(connection);
  }
}

interface Env {
  HUB: DurableObjectNamespace<RelayHubDurableObject>;
}

const HUB_INSTANCE_NAME = "relay-hub";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const stub = env.HUB.get(env.HUB.idFromName(HUB_INSTANCE_NAME));
      return stub.fetch(request);
    }
    return healthResponse();
  },
} satisfies ExportedHandler<Env>;
