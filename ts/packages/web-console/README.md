# @exadev/wire-mesh-web-console

The browser client for wire-mesh: a client of *any* node, not just the hub. It connects over WebSocket to a node's endpoint, drives the connection through core's Transport port via a browser-side adapter, and renders what the node has to show. Built as static assets (vite), servable from any static origin — including the hub's, for deployment convenience, with no Cloudflare tie whatsoever.

## What it does

- **Connect** — enter a node's `ws://`/`wss://` URL (defaulting to `ws://localhost:8787`, the hub's `wrangler dev` port), pick the capability domains to offer, and connect. The console sends its handshake and shows the negotiated result once the node answers.
- **Peer directory** — every `gossip` frame the node sends is folded into a directory table (device, addresses, snapshot time), latest advert per device winning.
- **Frame log** — a live, ordered feed of every frame that crossed the connection in either direction, plus a *Send ping* button.

## How it maps onto core's ports

`src/adapters/websocket-transport.ts` implements core's `Transport`/`Connection` port over the browser's native WebSocket, the same message convention as the hub's Worker-side adapter (one CBOR frame per binary message, no length prefix; undecodable bytes reject the connection, a decodable-but-unknown frame drops without disconnecting). `src/mesh-session.ts` is the DOM-free session state machine — handshake exchange with an explicit *unanswered* state (a relay-only node like the hub legitimately never answers a handshake; that's displayed, not treated as an error), directory assembly, and the frame log — unit-tested against a fake Transport. `src/main.ts` is deliberately thin DOM wiring.

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

Beyond the WebSocket connection to whatever node it dials, the console can negotiate a genuine peer-to-peer `RTCDataChannel` with whatever is on the other end of that same connection, over the `core/webrtc` signaling domain -- `src/adapters/webrtc-transport.ts`'s `wrapRtcDataChannel` implements the same `Connection` port as the WebSocket adapter (sharing the CBOR frame codec extracted into `src/adapters/frame-codec.ts`) over an already-open `RTCDataChannel`, and `src/webrtc-negotiation.ts`'s `createWebrtcNegotiator` drives a real `RTCPeerConnection` through offer/answer/ICE-candidate exchange using the session's `sendManageRequest`/`incomingManageRequests` plumbing, verifying an incoming offer's capability token via core's `verifyCapabilityToken` before accepting it. The protocol carries no target-device field for this domain -- a webrtc-offer's scope is this node's own signaling, not a routed resource -- so negotiation is always between the two direct ends of one existing connection, never relayed to a third party by this module.

**Deliberately not built:** no revocation-gossip ingestion in this console yet, so every otherwise-valid capability token is treated as unrevoked (see the comment on `noRevocationCheck` in `webrtc-negotiation.ts`) -- an explicit, documented limitation, not a silent gap. No STUN/TURN servers are configured; host candidates alone are enough for the same-LAN scenario this feature exists for, and cross-network NAT traversal is future work if a caller ever needs it.

**Verifying the real data path:** neither `RTCPeerConnection` nor `RTCDataChannel` exists under Node/vitest at all (unlike `WebSocket`, which Node provides natively), so the unit suite covers the adapter against a hand-rolled fake channel and the negotiation module's pure command-building/candidate-mapping logic against plain objects, but never a real ICE handshake. `scripts/live-check.mjs` is the real-runtime proof: two genuine headless-Chromium contexts, driven by Playwright, each running the actual adapter/session/negotiator modules, negotiating a real `RTCDataChannel` and exchanging a byte-identical frame through it. It is dev-time-only, not part of `pnpm test`/CI, for the same reason `cloudflare-hub/scripts/live-check.mjs` is -- it needs a real browser and a real running relay, neither of which CI provides for this package. Its own header comment documents a further deliberate deviation: the merged `relay-hub` domain (used by both `wire-mesh-node` and `cloudflare-hub`) does not forward `manage-request`/`manage-response` frames between connected clients, so the live-check runs its own small, purpose-built broadcast relay instead of either of those, solely for this one check.

## What is deliberately deferred

- **Room browser / join-from-browser** — the plan's phrase for the agent-comms-shaped application layer. wire-mesh's `core/data` domain carries such content as opaque entries, but no node implementation serves room semantics yet; shipping dead UI for it would be dishonest. The connection + directory + frame inspector is the honest first pass; the room UI arrives with the application that defines it.
- **Identity** — the console connects anonymously (no local keypair). When a node requires a client identity, core's Identity port gets a Web Crypto adapter here, exactly like the hub's.
- **TLS in dev** — `ws://` against localhost is fine; production deployments serve the console over HTTPS and dial `wss://`, which the adapter already handles.

## Type environment

`src/` typechecks against the DOM lib. The tests run in Node under vitest but import that src, so the test tsconfig loads node types alongside the DOM lib — and since Node 26 ships the same native WebSocket global the browser does, the adapter runs unmodified under Node, which is what makes the automated end-to-end test against a real hub possible.
