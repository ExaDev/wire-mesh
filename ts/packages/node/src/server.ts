#!/usr/bin/env node
// The wire-mesh-node CLI entrypoint: a self-hostable, no-cloud LAN counterpart to cloudflare-hub, wiring the same shared relay-hub domain logic from @exadev/wire-mesh-core over a real Node WebSocket + http server instead of a Cloudflare Durable Object. Default bind address is 0.0.0.0, not loopback -- the whole point of this package is LAN reachability, unlike a dev-server tool's usual loopback-only default.

import { createRelayHub } from "@exadev/wire-mesh-core/domain/relay-hub";
import { createNodeWebSocketTransport } from "./adapters/node-websocket-transport.js";

export function healthResponse(): { ok: true; node: string; roles: string[] } {
  return { ok: true, node: "wire-mesh-node", roles: ["relay"] };
}

const DEFAULT_BIND_ADDRESS = "0.0.0.0:8787";
const HTTP_OK = 200;

export function bindAddressFromArgs(argv: readonly string[]): string {
  const flagIndex = argv.indexOf("--bind");
  const value = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  return value ?? DEFAULT_BIND_ADDRESS;
}

// A genuine CLI startup message, not library logging -- isolated in its own function so eslint.config.ts's no-console override can scope narrowly to this file rather than the whole package.
function logStartup(message: string): void {
  console.log(message);
}

async function main(): Promise<void> {
  const hub = createRelayHub();
  const transport = createNodeWebSocketTransport({
    onHttpRequest: (_request, response) => {
      response.writeHead(HTTP_OK, { "content-type": "application/json" });
      response.end(JSON.stringify(healthResponse()));
    },
  });
  const listener = await transport.listen(
    bindAddressFromArgs(process.argv.slice(2)),
    (connection) => {
      void hub.handleConnection(connection);
    },
  );
  logStartup(`wire-mesh-node listening on ${listener.address}`);
}

// Only run as a side effect when executed directly (the CLI bin entry) -- never on a plain import, which is how the test suite reaches healthResponse()/bindAddressFromArgs() without binding a real port.
const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  void main();
}
