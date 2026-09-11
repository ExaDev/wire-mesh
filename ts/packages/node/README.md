# wire-mesh-node

A self-hostable, no-cloud LAN counterpart to `@exadev/wire-mesh-cloudflare-hub`: the same relay role (device discovery over gossip, pairing `relay-connect` initiators with their target, forwarding `relay-data` both ways), served by a plain Node process instead of a Cloudflare Durable Object. Run it on any machine already reachable on the network — a home server, a laptop on the same Wi-Fi, a container on a LAN — with no Cloudflare account, no deployment step, and no cloud dependency at all.

## Why this exists

`cloudflare-hub` is the always-on, public reference deployment. It needs an account and a deployment pipeline, and it puts every relayed byte through Cloudflare's network. `wire-mesh-node` is for the opposite case: two devices on the same LAN (or reachable over a VPN/tailnet) that want a relay neither of them has to pay for or deploy anywhere — just `npx wire-mesh-node` on whichever machine is already running.

## How it maps onto core's ports

The relay/pairing/gossip-registry domain logic itself is not duplicated here — it is `wire-mesh-core`'s `./domain/relay-hub` export, the same module `cloudflare-hub` consumes, proven transport-agnostic by running against core's TCP adapter, `cloudflare-hub`'s WebSocket adapter, and this package's own adapter alike. This package supplies exactly one new thing: a **Connection**/**Transport** port implementation over the `ws` npm package (`src/adapters/node-websocket-transport.ts`) — the same one-CBOR-frame-per-binary-message convention as the hub's and web-console's own WebSocket adapters, but driven through `ws`'s idiomatic Node `EventEmitter` API (`.on`, not `.addEventListener`) rather than the platform `WebSocket` those two wrap. Unlike the browser adapter, whose `listen()` always rejects (a browser tab can never accept inbound connections), and unlike `cloudflare-hub`'s adapter, which has no `listen()` at all (ingress arrives through the Durable Object's own upgrade handling), this adapter's `listen()` is a real implementation: this package's entire reason to exist is being reachable on a LAN.

`src/server.ts` is the CLI entrypoint: it wires `createRelayHub()` over `createNodeWebSocketTransport()`, answering any plain (non-Upgrade) HTTP request on the same listener with a small JSON health response, the same shape `cloudflare-hub`'s own `healthResponse()` returns.

## Running it

```sh
npx wire-mesh-node                       # binds 0.0.0.0:8787
npx wire-mesh-node --bind 0.0.0.0:9000    # a different port
npx wire-mesh-node --bind 127.0.0.1:8787  # loopback only, if that's genuinely what you want
```

or, installed as a dependency:

```sh
pnpm add wire-mesh-node
wire-mesh-node --bind 0.0.0.0:8787
```

**Default bind address is `0.0.0.0:8787`, not loopback.** Unlike a typical dev-server tool, whose loopback-only default assumes only the machine itself needs to reach it, this package's whole purpose is LAN reachability — a phone on the same network, a laptop in the next room. `--bind` overrides the address if you want to restrict it (loopback-only, a specific interface, a different port).

A plain HTTP request against the bound address (no `Upgrade` header) returns the health response:

```sh
curl http://<host>:8787/
# {"ok":true,"node":"wire-mesh-node","roles":["relay"]}
```

**Security note:** this package adds no access control beyond the protocol's own capability tokens (`core/exec`/`core/management` verbs gated by a signed capability, same as any other wire-mesh node) — anyone who can reach the bound address can gossip, relay-connect, and relay-data through it. Bind to a trusted network (a home LAN, a VPN/tailnet) rather than a public interface unless the capability-token story for whatever you're relaying is one you're comfortable exposing to the open internet.

## What is real versus deferred

Real and tested: the Node WebSocket transport adapter (hostile-input behaviour included — undecodable bytes and non-binary messages close the connection; a decodable-but-schema-invalid frame drops without disconnecting), a real loopback round trip (`listen("127.0.0.1:0", ...)` + `connect(...)` against the actual bound address, proving the OS-assigned-port path works), and a full relay path verified end to end against real sockets — two genuine WebSocket clients exchanging gossip, relay-connect, relay-inbound, and bidirectional relay-data through a real listener, the in-suite analogue of `cloudflare-hub/scripts/live-check.mjs` for a runtime (plain Node) with no dev-server lifecycle constraints to work around.

Deferred deliberately, matching `cloudflare-hub`'s own list:

- **The announcer role** (`discovery.cddl`'s `mailboxes`) needs a Storage port adapter; none is wired up here yet.
- **TLS** — this adapter serves plain `ws://`. A `wss://`-terminating variant (or a reverse proxy in front of it) is a deployment concern, not something this package's adapter needs to own directly.

## Type environment

`src/` is plain Node code, typechecked against `@types/node` and `@types/ws` — no DOM lib, no Worker types, matching `wire-mesh-core`'s own type environment exactly (the closest precedent this package's scaffolding mirrors).
