# wire-mesh

A self-hostable, no-cloud LAN counterpart to `@exadev/wire-mesh-cloudflare-hub`: the same relay role (device discovery over gossip, pairing `relay-connect` initiators with their target, forwarding `relay-data` both ways), served by a plain Node process instead of a Cloudflare Durable Object. Run it on any machine already reachable on the network — a home server, a laptop on the same Wi-Fi, a container on a LAN — with no Cloudflare account, no deployment step, and no cloud dependency at all.

## Why this exists

`cloudflare-hub` is the always-on, public reference deployment. It needs an account and a deployment pipeline, and it puts every relayed byte through Cloudflare's network. `wire-mesh` is for the opposite case: two devices on the same LAN (or reachable over a VPN/tailnet) that want a relay neither of them has to pay for or deploy anywhere — just `npx wire-mesh` on whichever machine is already running.

## How it maps onto core's ports

The relay/pairing/gossip-registry domain logic itself is not duplicated here — it is `wire-mesh-core`'s `./domain/relay-hub` export, the same module `cloudflare-hub` consumes, proven transport-agnostic by running against core's TCP adapter, `cloudflare-hub`'s WebSocket adapter, and this package's own adapter alike. This package supplies exactly one new thing: a **Connection**/**Transport** port implementation over the `ws` npm package (`src/adapters/node-websocket-transport.ts`) — the same one-CBOR-frame-per-binary-message convention as the hub's and web-console's own WebSocket adapters, but driven through `ws`'s idiomatic Node `EventEmitter` API (`.on`, not `.addEventListener`) rather than the platform `WebSocket` those two wrap. Unlike the browser adapter, whose `listen()` always rejects (a browser tab can never accept inbound connections), and unlike `cloudflare-hub`'s adapter, which has no `listen()` at all (ingress arrives through the Durable Object's own upgrade handling), this adapter's `listen()` is a real implementation: this package's entire reason to exist is being reachable on a LAN.

`src/server.ts` is the CLI entrypoint: it wires `createRelayHub()` over `createNodeWebSocketTransport()`. The same listener answers a browser too: `GET /health` returns a small JSON health response (the same shape `cloudflare-hub`'s own `healthResponse()` returns), and every other request is served from `@exadev/wire-mesh-web-console`'s own built static output — copied into this package's `dist/web-console` at build time (`scripts/copy-web-console-dist.mjs`, run as the second half of the `_build` script), so a self-hosted node has somewhere to point a browser at, not just other wire-mesh peers (wire-mesh#184). An extension-less path that doesn't match a real file falls back to `index.html`, so the console's own client-side routes still resolve.

## Running it

```sh
npx wire-mesh                       # binds 0.0.0.0:8787, plain ws:// + http://
npx wire-mesh --bind 0.0.0.0:9000    # a different port
npx wire-mesh --bind 127.0.0.1:8787  # loopback only, if that's genuinely what you want
npx wire-mesh --tls-cert cert.pem --tls-key key.pem   # wss:// + https://, cert/key must be given together
```

or, installed as a dependency:

```sh
pnpm add wire-mesh
wire-mesh --bind 0.0.0.0:8787
```

Every flag the CLI accepts, exactly as `wire-mesh --help` prints it. An unknown flag, a flag missing its value, or a malformed `--bind` address exits non-zero with a message on stderr rather than starting a node; the `--tls-cert`/`--tls-key` pairing is enforced the same way. The parser, this text, and the help output all come from one flag table in `src/cli-options.ts`, and a test fails if this block stops matching it.

```text
Usage: wire-mesh [options]

Options:
      --bind <host:port>  Address to listen on. Port 0 asks the OS for a free port. Use 127.0.0.1:8787 to accept local connections only. (default: 0.0.0.0:8787)
      --tls-cert <path>   PEM certificate file, to serve wss:// and https://. Requires --tls-key.
      --tls-key <path>    PEM private key file for --tls-cert. Requires --tls-cert.
  -h, --help              Print this help and exit.
  -v, --version           Print the version and exit.
```

**Default bind address is `0.0.0.0:8787`, not loopback.** Unlike a typical dev-server tool, whose loopback-only default assumes only the machine itself needs to reach it, this package's whole purpose is LAN reachability — a phone on the same network, a laptop in the next room. `--bind` overrides the address if you want to restrict it (loopback-only, a specific interface, a different port).

Point a browser at the bound address to reach the console, or check its health directly:

```sh
curl http://<host>:8787/health
# {"ok":true,"node":"wire-mesh","roles":["relay"]}
```

**TLS (`wss://`/`https://`)** is opt-in via `--tls-cert`/`--tls-key`, both required together — this package generates no certificate of its own, so bring your own (a real one from a CA, or a self-signed one for a LAN). This matters specifically for wire-mesh#182/#183: an `https://`-served PWA (`mesh.exadev.io`) can only reach a plain `ws://` node if it's literally on `localhost` of the same machine, since browsers block mixed-content WebSocket connections from a secure page to an insecure one — a self-hosted node on someone's LAN, addressed by its own IP, needs to answer `wss://` for that PWA to reach it at all.

**Security note:** this package adds no access control beyond the protocol's own capability tokens (`core/exec`/`core/management` verbs gated by a signed capability, same as any other wire-mesh node) — anyone who can reach the bound address can gossip, relay-connect, and relay-data through it. Bind to a trusted network (a home LAN, a VPN/tailnet) rather than a public interface unless the capability-token story for whatever you're relaying is one you're comfortable exposing to the open internet.

## What is real versus deferred

Real and tested: the Node WebSocket transport adapter (hostile-input behaviour included — undecodable bytes and non-binary messages close the connection; a decodable-but-schema-invalid frame drops without disconnecting), a real loopback round trip (`listen("127.0.0.1:0", ...)` + `connect(...)` against the actual bound address, proving the OS-assigned-port path works), a full relay path verified end to end against real sockets — two genuine WebSocket clients exchanging gossip, relay-connect, relay-inbound, and bidirectional relay-data through a real listener, the in-suite analogue of `cloudflare-hub/scripts/live-check.mjs` for a runtime (plain Node) with no dev-server lifecycle constraints to work around — a real TLS handshake terminating a genuine `wss://` WebSocket connection and an `https://` request against a self-signed fixture certificate, and the console's own static-file routing (root, nested assets, the service worker's required `Service-Worker-Allowed` header, the client-side-route fallback to `index.html`, and a 404 for a genuinely missing file) against a real HTTP server.

Deferred deliberately, matching `cloudflare-hub`'s own list:

- **The announcer role** (`discovery.cddl`'s `mailboxes`) needs a Storage port adapter; none is wired up here yet.

## Type environment

`src/` is plain Node code, typechecked against `@types/node` and `@types/ws` — no DOM lib, no Worker types, matching `wire-mesh-core`'s own type environment exactly (the closest precedent this package's scaffolding mirrors).
