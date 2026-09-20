// The Worker entry. The Durable Object class must be exported from this entrypoint file for wrangler to bind it (wrangler.toml names this export), so it is defined here directly rather than re-exported from a sibling module. The class itself is only an adapter: the runtime's three WebSocket handlers forward straight to hibernating-hub.ts, which holds everything the hub actually does and needs no `cloudflare:workers` import to be tested.
//
// Hibernation-native by necessity: the original shape parked a JS consume loop (handleConnection over the adapter's receive() iteration) on classically-accepted sockets, which worked under `wrangler dev` but silently processed nothing in production. After fetch() returned the 101, the real runtime never delivered further messages into that parked promise chain, so every inbound frame after connect was dropped (the first production live-check run failed exactly there: connects and upgrades fine, zero frames ever forwarded). The hibernation API is the documented production shape: state.acceptWebSocket hands the socket to the runtime, and inbound messages arrive as webSocketMessage handler invocations, event-driven, with no parked loop, and the socket itself survives DO eviction. The hub is driven per-message via its registerConnection/onFrame/onDisconnect surface (the same event-driven entry wire-mesh#102 added for ordinary relaying nodes).
//
// Eviction honesty: no instance field survives eviction, only the sockets, via hibernation. The hub therefore keeps every connection's relay state (its device-id, its adverts, its pairings) on the socket that state belongs to, through serializeAttachment, and rebuilds itself from ctx.getWebSockets() the first time a woken instance is asked to do anything. Both the device registry and the relay pairings come back that way, so a client whose socket stayed open through an eviction needs to do nothing and notice nothing: its next frame routes exactly as it would have. See hibernating-hub.ts for why an attachment rather than Durable Object storage holds it, and why adoption resolves the whole set of sockets at once rather than one at a time.

import { DurableObject } from "cloudflare:workers";
import { createHibernatingRelayHub } from "./hibernating-hub.js";

export function healthResponse(): Response {
  return Response.json({
    ok: true,
    node: "wire-mesh-cloudflare-hub",
    roles: ["relay"],
  });
}

export class RelayHubDurableObject extends DurableObject<unknown> {
  // The sockets are read through a callback rather than captured once: on a wake this instance is constructed before the runtime hands it the message that woke it, and getWebSockets() is what tells it which sockets it inherited.
  private readonly hub = createHibernatingRelayHub(() =>
    this.ctx.getWebSockets(),
  );

  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      // The Worker router already answers non-WebSocket requests itself; this covers only a malformed upgrade routed here anyway.
      return healthResponse();
    }
    const pair = new WebSocketPair();
    // Hibernation accept: the runtime owns delivery (webSocketMessage below) and the socket survives eviction, unlike classic accept.
    this.ctx.acceptWebSocket(pair[1]);
    this.hub.accept(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(
    serverSocket: Readonly<WebSocket>,
    message: string | ArrayBuffer,
  ): Promise<void> {
    await this.hub.message(serverSocket, message);
  }

  webSocketClose(serverSocket: Readonly<WebSocket>): void {
    this.hub.forget(serverSocket);
  }

  webSocketError(serverSocket: Readonly<WebSocket>): void {
    this.hub.forget(serverSocket);
  }
}

interface Env {
  HUB: DurableObjectNamespace<RelayHubDurableObject>;
  // web-console's built output (wrangler.toml's [assets] binding, ExaDev/wire-mesh#183); see wrangler.toml for why run_worker_first is scoped to exactly the two paths below rather than every request.
  ASSETS: Fetcher;
}

const HUB_INSTANCE_NAME = "relay-hub";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get("Upgrade") === "websocket") {
      const stub = env.HUB.get(env.HUB.idFromName(HUB_INSTANCE_NAME));
      return stub.fetch(request);
    }
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return healthResponse();
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
