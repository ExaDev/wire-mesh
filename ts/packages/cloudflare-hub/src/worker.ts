// The Worker entry. The Durable Object class must be exported from this entrypoint file for wrangler to bind it (wrangler.toml names this export), so it is defined here directly rather than re-exported from a sibling module. A plain Worker's request context cannot host the hub's long-lived per-connection loops -- workerd's hang detection cancels any request whose promise chain parks on a pure-JS waiter (the pull-based receive() iteration), which is exactly what the relay loop does; a Durable Object is the documented home for that shape, its lifetime tied to the accepted WebSockets rather than to a single fetch. The DO keeps connections alive for its own lifetime; the hibernation API (state.acceptWebSocket + webSocketMessage handlers) is the idle-cost follow-up noted in README.md, not a correctness requirement.

import { DurableObject } from "cloudflare:workers";
import {
  createRelayHub,
  type RelayHub,
} from "@exadev/wire-mesh-core/domain/relay-hub";
import { wrapWebSocket } from "./adapters/websocket-transport.js";

export function healthResponse(): Response {
  return Response.json({
    ok: true,
    node: "wire-mesh-cloudflare-hub",
    roles: ["relay"],
  });
}

export class RelayHubDurableObject extends DurableObject<unknown> {
  private readonly hub: RelayHub = createRelayHub();

  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      // The Worker router already answers non-WebSocket requests itself; this covers only a malformed upgrade routed here anyway.
      return healthResponse();
    }
    const pair = new WebSocketPair();
    pair[1].accept();
    const connection = wrapWebSocket(pair[1]);
    // Drives the relay loop for this connection until it closes; handleConnection treats a receive rejection as disconnect internally, so there is no rejection to surface here.
    void this.hub.handleConnection(connection);
    return new Response(null, { status: 101, webSocket: pair[0] });
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
