// The Worker entry: a public, always-on hub node. WebSocket upgrades on any path become mesh connections fed through the WebSocket transport adapter into the relay hub; everything else gets a plain health response. State is per-isolate (module scope), which is the standard shape for a reference Worker -- the registry lives in the relay hub and needs no bindings, so no KV/Durable-Object configuration appears in wrangler.toml yet.

import { createRelayHub } from "./hub.js";
import { createWebSocketTransport } from "./adapters/websocket-transport.js";

const hub = createRelayHub();
const { transport, acceptPair } = createWebSocketTransport();

// A Worker has no listener to bind; registering the connection handler through the port keeps the hub driven entirely by the transport contract, with acceptPair below as the ingress the runtime provides instead.
void transport.listen("wire-mesh-hub", (connection) => {
  void hub.handleConnection(connection);
});

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      acceptPair(pair);
      return Promise.resolve(
        new Response(null, { status: 101, webSocket: pair[0] }),
      );
    }
    return Promise.resolve(
      Response.json({
        ok: true,
        node: "wire-mesh-cloudflare-hub",
        roles: ["relay"],
      }),
    );
  },
} satisfies {
  fetch: (request: Request) => Promise<Response>;
};
