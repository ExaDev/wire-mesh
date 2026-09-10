# @exadev/wire-mesh-cloudflare-hub

A reference deployment of a wire-mesh hub node on Cloudflare Workers: a public, always-on node other peers dial into, serving the relay role the repo README names for this package (transport.cddl's `relay-offer`/`relay-connect`/`relay-data`/`relay-inbound` — an opaque byte pipe when two peers can't connect directly, with device discovery over gossip). It depends on `@exadev/wire-mesh-core` as an ordinary workspace consumer and reinvents nothing the core owns: all protocol logic is core's, reached through its ports.

## Why the hub lives in a Durable Object

A plain Worker's request context cannot host the hub: each connection is driven by a long-lived pull loop (`for await` over the `receive()` iteration, parked on a pure-JS waiter), and workerd's hang detection cancels any request whose promise chain parks that way — empirically, the original plain-Worker entry relayed zero frames across every run while looking alive (the socket-level listeners still fired; `wrangler deploy --dry-run` passed because bundling executes nothing). A Durable Object is the documented home for exactly this shape: its lifetime is tied to the accepted WebSockets rather than to a single fetch.

So the entrypoint (`src/worker.ts`) defines `RelayHubDurableObject` directly (wrangler resolves the binding against the entrypoint's own exports) — it owns the hub state, accepts the server side of the runtime's `WebSocketPair` on each upgrade, and drives the hub per connection, while the default export stays a thin router forwarding upgrades to the single named DO instance. The DO is SQLite-backed (hibernation-capable) per current wrangler guidance, though it keeps connections alive for its own lifetime rather than hibernating — see the deferrals below.

## How it maps onto core's ports

The ports architecture is what makes a Worker possible at all — Workers have no `net.Server`, no full `node:crypto`, no filesystem, so core's Node adapters can't run there and don't try to. This package supplies Worker-shaped implementations for the same contracts:

- **Connection** (`src/adapters/websocket-transport.ts`): WebSocket messages instead of TCP streams. Each binary WebSocket message is self-delimiting, so one message carries exactly one CBOR frame with no length prefix. Undecodable bytes and non-binary messages reject that connection; a decodable but schema-invalid frame drops without disconnecting — mirroring core's TCP adapter's split between connection-level and frame-level failure.
- **Identity** (`src/adapters/web-crypto-identity.ts`): Web Crypto (`crypto.subtle`) ECDSA P-256, deriving `device-id` as SHA-256 of the raw public-key bytes — never certificate DER. The test suite proves signature interop with core's Node identity adapter in both directions.

The hub domain logic itself (`src/hub.ts`) is deliberately thin and transport-agnostic (it runs unchanged over core's TCP adapter in tests): pairing `relay-connect` initiators with gossiped targets and forwarding `relay-data` both ways, tearing down both sides of a pairing when either endpoint re-pairs or disconnects, and moving a device's mapping when a newer gossip arrives on a fresher connection.

## What is real versus deferred

Real and tested: the WebSocket connection adapter (hostile-input behaviour included), the Web Crypto identity adapter with cross-adapter signature interop, the relay pairing logic — and the full entry path verified against the real workerd runtime, not just bundling: `pnpm dev` plus `node scripts/live-check.mjs` drives two genuine WebSocket clients through gossip → relay-connect → relay-inbound → bidirectional relay-data and asserts every hop, exiting non-zero and naming the failing step if the runtime ever regresses to the hang-cancellation behaviour. Unit tests additionally drive the hub over the real adapter, not only fakes.

Deferred deliberately:

- **Hibernation** — the DO keeps its connections alive for its own lifetime, which is correct but not the idle-cost optimum; the hibernation API (`state.acceptWebSocket` + `webSocketMessage` handlers) is the follow-up.
- **Raw TCP ingress** via `cloudflare:sockets` — the WebSocket ingress is the sound first pass; raw TCP is a follow-up adapter behind the same Connection contract.
- **The announcer role** (the second role the repo README names: `discovery.cddl`'s `mailboxes` — holding peers' handle-records as `core/data` entries) needs a Storage port adapter over KV or Durable Object storage.
- **A real deployment** — `wrangler deploy --dry-run --outdir=dist` (the `_build` task, and what CI runs) validates the bundle without Cloudflare credentials; an actual deploy needs `wrangler deploy` with an authenticated account and is not part of CI.

## Type environment

`src/` is pure Worker code and typechecks against `@cloudflare/workers-types` alone. The tests run in Node under vitest but import that src, so the test tsconfig loads both type packages — under which the `Buffer` global's overloads resolve as `any` for eslint, which is why the test helpers construct bytes from hex with a plain loop instead of `Buffer.from(hex, "hex")`.
