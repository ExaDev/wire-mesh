# @exadev/wire-mesh-cloudflare-hub

A reference deployment of a wire-mesh hub node as a Cloudflare Worker: a public, always-on node other peers dial into, serving the two roles the spec's README describes — **relay** (transport.cddl's `relay-offer`/`relay-connect`/`relay-data`/`relay-inbound`, an opaque byte pipe when two peers can't connect directly) and **connection endpoint** for gossip. It depends on `@exadev/wire-mesh-core` as an ordinary workspace consumer and reinvents nothing the core owns: all protocol logic is core's, reached through its ports.

## How it maps onto core's ports

The ports architecture is what makes a Worker possible at all — Workers have no `net.Server`, no full `node:crypto`, no filesystem, so core's Node adapters can't run there and don't try to. This package supplies Worker-shaped adapters for the same port contracts:

- **Transport** (`src/adapters/websocket-transport.ts`): WebSocket messages instead of TCP streams. Each binary WebSocket message is self-delimiting, so one message carries exactly one CBOR frame with no length prefix. Inbound connections arrive through the Worker's fetch handler (a WebSocket upgrade) rather than a bound listener — `listen()` on this adapter registers the handler; `acceptPair()` is the ingress the runtime provides. Outbound `connect()` genuinely dials `wss://` via the standard WebSocket API.
- **Identity** (`src/adapters/web-crypto-identity.ts`): Web Crypto (`crypto.subtle`) ECDSA P-256, deriving `device-id` as SHA-256 of the raw public-key bytes — never certificate DER. The test suite proves signature interop with core's Node identity adapter in both directions.

The hub domain logic itself (`src/hub.ts`) is deliberately thin: pairing `relay-connect` initiators with gossiped targets and forwarding `relay-data` both ways, forgetting a device when its connection ends, and moving a device's mapping when a newer gossip arrives on a fresher connection.

## What is real versus deferred

Real and tested: the WebSocket transport adapter (including hostile-input behaviour — undecodable bytes reject that connection, schema-invalid-but-decodable frames drop without disconnecting, matching core's TCP adapter's split), the Web Crypto identity adapter, the relay hub pairing logic over them, and the Worker entry (`src/worker.ts`) wiring upgrades through the transport into the hub.

Deferred deliberately:

- **Raw TCP ingress** via `cloudflare:sockets` — the WebSocket ingress is the sound first pass; raw TCP is a follow-up adapter behind the same port.
- **The announcer role** (`discovery.cddl`'s `mailboxes` — holding peers' handle-records as `core/data` entries) needs a Storage port adapter over KV or Durable Objects; the relay role needs no bindings, so `wrangler.toml` configures none yet.
- **A real deployment** — `wrangler deploy --dry-run --outdir=dist` (the `_build` task, and what CI runs) validates the bundle without Cloudflare credentials; an actual deploy needs `wrangler deploy` with an authenticated account and is not part of CI.

## Type environment

`src/` is pure Worker code and typechecks against `@cloudflare/workers-types` alone. The tests run in Node under vitest but import that src, so the test tsconfig loads both type packages — under which the `Buffer` global's overloads resolve as `any` for eslint, which is why the test helpers construct bytes from hex with a plain loop instead of `Buffer.from(hex, "hex")`.
