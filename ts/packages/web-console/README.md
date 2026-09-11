# @exadev/wire-mesh-web-console

The browser client for wire-mesh: a client of *any* node, not just the hub. It connects over WebSocket to a node's endpoint, drives the connection through core's Transport port via a browser-side adapter, and renders what the node has to show. Built as static assets (vite), servable from any static origin — including the hub's, for deployment convenience, with no Cloudflare tie whatsoever.

## What it does

- **Connect** — enter a node's `ws://`/`wss://` URL (defaulting to `ws://localhost:8787`, the hub's `wrangler dev` port), pick the capability domains to offer, and connect. The console sends its handshake and a self-advertisement gossip frame, and shows the negotiated result once the node answers. Multiple connections can be open at once, each to its own address, each with its own status/directory/frame-log panel.
- **Identity** — the console holds a persisted Web Crypto (P-256) identity (`src/adapters/web-crypto-identity.ts`'s `createPersistedWebCryptoIdentity`, backed by `src/adapters/indexeddb-storage.ts`), stable across reloads and shared across every connection the console makes.
- **Capability tokens** — `MeshSession.setToken` accepts a capability token to present on subsequent `manage-request`s (`sendManageRequest`), gating anything the connected node or a relayed peer requires authorization for.
- **Reconnect** — a dropped connection retries with backoff (opt-in `ReconnectPolicy`; `main.ts` wires a default exponential backoff, capped, for every session it creates), surfaced as an explicit `"reconnecting"` status rather than silently going dark.
- **Peer directory** — every `gossip` frame the node sends is folded into a directory table (device, addresses, snapshot time), latest advert per device winning.
- **Frame log** — a live, ordered feed of every frame that crossed the connection in either direction, plus a *Send ping* button.

## How it maps onto core's ports

`src/adapters/websocket-transport.ts` implements core's `Transport`/`Connection` port over the browser's native WebSocket, sharing the CBOR frame codec extracted into `src/adapters/frame-codec.ts` (one CBOR frame per binary message, no length prefix; undecodable bytes reject the connection, a decodable-but-unknown frame drops without disconnecting). `src/adapters/web-crypto-identity.ts` implements core's Identity port, `src/adapters/indexeddb-storage.ts` implements core's Storage port. `src/mesh-session.ts` is the DOM-free session state machine — handshake exchange with an explicit *unanswered* state (a relay-only node like the hub legitimately never answers a handshake; that's displayed, not treated as an error), self-advertisement, directory assembly, the frame log, capability-token-bearing generic `manage-request`/`manage-response` RPC (`sendManageRequest`/`incomingManageRequests`), and reconnect-with-backoff — unit-tested against a fake Transport. `src/main.ts` is deliberately thin DOM wiring, owning a `Map` of concurrently open sessions keyed by address plus the one shared identity/clock every session is constructed with.

## Connecting to a locally-running node

```sh
# terminal 1: run the hub (a wire-mesh node) locally on :8787
cd ts/packages/cloudflare-hub && pnpm dev   # wrangler dev, no credentials needed

# terminal 2: serve the console
cd ts/packages/web-console && pnpm dev      # vite on :5173
```

Open the vite URL, keep the default `ws://localhost:8787` address, and connect: the status line reaches *connected*, the handshake moves to *unanswered* after the timeout (the relay-only hub never sends one back — that is the honest state, not a failure), and *Send ping* records the outgoing frame in the log (the hub drops non-relay frames by design). As fuller node implementations start answering handshakes and gossiping, the negotiated-domains line and the directory table light up with no console changes.

Verified exactly that way during development, including an end-to-end run of the *actual* adapter and session modules (not a reimplementation) against a live `wrangler dev` hub: Node 26 provides the same native WebSocket the browser does, so the same code path a browser executes connected to `ws://localhost:8787`, reached `connected`, observed the handshake go `unanswered` after the timeout (the relay-only hub never sends one -- an honest state, not a failure), and recorded an outgoing ping in the frame log. The unit suite (`pnpm test`) covers the adapter and session against fakes; the live-hub run is a development-time verification, not part of CI, because it would couple the console's CI to a running workerd.

## WebRTC data channel

Beyond the WebSocket connection to whatever node it dials, the console can negotiate a genuine peer-to-peer `RTCDataChannel` with another peer, over the `core/webrtc` signaling domain -- `src/adapters/webrtc-transport.ts`'s `wrapRtcDataChannel` implements the same `Connection` port as the WebSocket adapter (sharing the CBOR frame codec in `src/adapters/frame-codec.ts`) over an already-open `RTCDataChannel`, and `src/webrtc-negotiation.ts`'s `createWebrtcNegotiator` drives a real `RTCPeerConnection` through offer/answer/ICE-candidate exchange using the session's `sendManageRequest`/`incomingManageRequests` plumbing, verifying an incoming offer's capability token via core's `verifyCapabilityToken` before accepting it.

The `webrtc:signal` capability itself carries no target-device field -- a `manage-request-frame` already travels to one specific peer, so who a signal is with needs no wire field of its own -- but *how* it gets there depends on what the session is connected to. `initiate()` takes an optional target device-id: when the console is connected directly to the peer it wants to negotiate with, signaling goes straight over that connection; when the console is connected to a relay hub instead (the common case, since a browser can't accept an inbound connection at all), `sendManageRequest`'s `targetDevice` parameter routes the same manage-request/response frames through an established `relay-connect` pairing, CBOR-encoded inside `relay-data`'s existing opaque payload -- exactly the mechanism `federation-envelope-frame` already uses elsewhere in this spec for one frame nested inside another. `relay-hub` (shared by `wire-mesh-node` and `cloudflare-hub`) never needs to understand `manage-request`/`manage-response` for this to work: it already forwards `relay-data` blindly between a paired connection, which is all this needs. A consumer of `sendManageRequest`/`incomingManageRequests` never needs to know or care whether a given exchange was direct or relayed -- the dispatched frame is structurally identical either way.

**Verifying the real data path:** neither `RTCPeerConnection` nor `RTCDataChannel` exists under Node/vitest at all (unlike `WebSocket`, which Node provides natively), so the unit suite covers the adapter against a hand-rolled fake channel and the negotiation module's pure command-building/candidate-mapping logic against plain objects, but never a real ICE handshake. `test/e2e/webrtc.spec.ts` is the real-runtime proof, and a genuine checked-in test (`pnpm test:e2e`, `@playwright/test`), not a manual script: two independent Playwright `BrowserContext`s (Playwright's own mechanism for two fully isolated sessions -- separate storage, separate IndexedDB, separate identity -- without the overhead of two full browser processes), each running the actual adapter/session/negotiator modules, gossiping to a real, unmodified `wire-mesh-node` relay (booted automatically by `playwright.config.ts`'s `webServer`) and negotiating a real `RTCDataChannel` through it -- proving the relayed signaling path traverses `relay-hub`'s actual `relay-data` forwarding, not a stand-in. It asserts the signaling round trip unconditionally; the data channel actually reaching `open` is a stronger check the test race-checks against a timeout and skips gracefully on a host whose network can't complete ICE (see the test's own header comment), rather than failing a check this package's own code has no control over. Kept out of `pnpm test`/`vitest` specifically, but run separately as its own CI job, since it needs a real browser and a real running relay that `vitest`'s environment doesn't provide.

## What is deliberately deferred

- **Room browser / join-from-browser** — the plan's phrase for the agent-comms-shaped application layer. wire-mesh's `core/data` domain carries such content as opaque entries, but no node implementation serves room semantics yet; shipping dead UI for it would be dishonest. The connection + directory + frame inspector is the honest first pass; the room UI arrives with the application that defines it.
- **Revocation-gossip ingestion** — the console has no way to learn a capability token was revoked after it was issued, so `webrtc-negotiation.ts`'s token check treats every otherwise-valid token as unrevoked (see the `noRevocationCheck` comment there) — an explicit, documented limitation, not a silent gap.
- **STUN/TURN** — no ICE servers are configured; host candidates alone are enough for the same-LAN scenario this feature exists for today, and cross-network NAT traversal is future work if a caller ever needs it.
- **TLS in dev** — `ws://` against localhost is fine; production deployments serve the console over HTTPS and dial `wss://`, which the adapter already handles.

## Type environment

`src/` typechecks against the DOM lib. The tests run in Node under vitest but import that src, so the test tsconfig loads node types alongside the DOM lib — and since Node 26 ships the same native WebSocket global the browser does, the adapter runs unmodified under Node, which is what makes the automated end-to-end test against a real hub possible.
