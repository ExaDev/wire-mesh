# wire-mesh-sfu

An SFU (Selective Forwarding Unit): a media-aware relay for group audio/video calls, where `relay-hub` is deliberately blind to payload and cannot fill this role. A client's own signaling to this SFU is ordinary, unmodified `core/webrtc` (`webrtc.offer`/`webrtc.answer`/`webrtc.ice-candidate`, exactly the same exchange it would use against any other peer); the one thing `core/webrtc` did not already cover is `webrtc.sfu-track-map` (`spec/webrtc.cddl`), the mapping from an SDP mid on a client's own connection back to which room member's track it carries. That verb is spec-level, not backend-specific, so any SFU implementation speaking it is interoperable with any wire-mesh client by construction.

## Why this exists

`core/webrtc`'s own signaling (`spec/webrtc.cddl`) is a pure, opaque, 1:1 SDP/ICE relay correlated by `negotiation-id`, with no assumption baked in about what is on the other end of a negotiation. That is genuinely sufficient for a client's negotiation with an SFU as-is: the SFU is just the client's one remote peer. The real gap only appears once that one connection is carrying more than one other participant's media multiplexed onto SDP mids — raw SDP has no way to say "mid 2 is device X's video". `webrtc.sfu-track-map` closes that gap.

## Two independent design axes

- **Deployment mode**: `src/server.ts` is a standalone service, accepting real `MeshSession`s over `wire-mesh-node`'s own WebSocket transport (reused, not duplicated) and handing each one to a shared `SfuCall`. An in-process deployment inside another wire-mesh-node process would call `createSfuCall`/`createMediasoupMediaBackend` directly instead of spawning this binary, sharing the identical domain and adapter code — nothing here is standalone-only.
- **Backend**: `src/adapters/mediasoup-media-backend.ts` wraps [mediasoup](https://mediasoup.org), leaning on an audited, maintained RTP-forwarding implementation over a from-scratch one — the same reasoning that already settled FROST over a hand-rolled threshold-signing implementation (wire-mesh#29). The contract it implements, `SfuMediaBackend` (`src/domain/media-backend.ts`), mentions no mediasoup type in its own signature: every method takes and returns plain, serialisable data (participant ids as strings, SDP as strings, ICE candidates as the already-portable `WireRtcIceCandidateInit` shape `wire-mesh-core` already defined), so a second, differently-licensed or from-scratch backend could satisfy it later with zero changes to this contract or any of its callers.

## How a join actually works

mediasoup does not process or generate SDP itself (its own FAQ says as much) — `src/adapters/sdp-bridge.ts` is the translation layer between a browser's own plain SDP offer/answer and mediasoup's structured `RtpParameters`/`IceParameters`/`DtlsParameters`. For each participant's own offer:

1. Every send-capable m-line (the participant's own outbound audio/video) has its codecs intersected against the router's own configured codec set (Opus and VP8 by default), and, when a codec matches, becomes a real mediasoup `Producer`.
2. Every already-proposed recvonly m-line is filled, if an already-connected other participant has a matching-kind track available, with a real mediasoup `Consumer` — the SDP answer reports it `sendonly`, carrying that Consumer's own negotiated codec.
3. A non-audio/video m-line (an SCTP m-line for a data channel bundled on the same connection) is answered as rejected (port 0) — never produced or consumed.
4. The built answer carries the participant's own real `WebRtcTransport`'s ICE/DTLS parameters. DTLS role is fixed: this SFU always answers `a=setup:active` (it initiates the handshake as the DTLS client), so the remote is always told `role: "server"`. Either choice is a valid outcome for an offer proposing `a=setup:actpass`; this is a deliberate, fixed pick for simplicity, not a constraint mediasoup or the browser imposes.
5. Trickled ICE candidates from the client are accepted but never forwarded into mediasoup: mediasoup's `WebRtcTransport` runs ICE Lite, which never needs the remote's own candidates to complete connectivity — it listens passively on its own already-advertised candidates and lets the client (the ICE-controlling side) perform connectivity checks.

Every mid this bridge reads through `sdp-transform` is read defensively: a purely numeric `a=mid` (the common case — Chrome, Firefox, and Safari all number their own mids from 0) parses back as a JS number despite the library's own declared `string` type, confirmed directly against `sdp-transform`'s own grammar and fixed at the one place this bridge reads a mid.

## What is real versus deferred

Real and tested: the SDP↔mediasoup bridge against a realistic Chrome-shaped offer (`test/sdp-bridge.unit.test.ts`), `createSfuCall`'s own authorization/dispatch/track-map-fan-out orchestration against fakes (`test/sfu-session.unit.test.ts`), and the mediasoup backend itself against a real mediasoup Worker/Router/WebRtcTransport — a real offer produces a real `Producer`, a second participant's recvonly slot gets filled by a real `Consumer`, `leave()` actually closes resources and reports the right affected participant (`test/mediasoup-media-backend.integration.test.ts`).

Deferred deliberately, not silently:

- **No dynamic renegotiation.** A participant's own recvonly m-line count, fixed at their initial offer, bounds how many other participants' tracks they can receive. A participant who joins *after* another's own recvonly slots are already exhausted or filled is not connected to them without a later renegotiation this backend does not drive. `core/webrtc`'s own spec has no "please renegotiate" push verb yet; adding one (or having clients pre-allocate a generous number of recvonly slots up front, a common production SFU technique) is real follow-up work, not implemented here.
- **No simulcast.** `sdp-bridge.ts` builds a single-encoding `RtpParameters` per m-line; a simulcast offer's own multiple encodings collapse to whichever the offer's own SSRC/RID grammar this bridge parses picks up as the one encoding.
- **Restart identity is not persisted.** `src/server.ts` generates a fresh, in-memory ES256 keypair every time it starts. It matters for restart continuity (a restarted SFU is not recognisable as "the same device" to anyone holding an old capability-token scoped to its old device-id) but not for correctness within one run.
- **No real end-to-end media test.** The integration test proves the bridge produces real mediasoup resources from real offers; it does not drive a real browser peer, so no test in this package proves media actually flows through a completed ICE/DTLS/SRTP handshake. Verifying that needs a real `RTCPeerConnection` (a headless browser via Playwright, or a second WebRTC stack), which this PR does not add.

## Running it

```sh
npx wire-mesh-sfu                              # binds 0.0.0.0:8788, mediasoup listens on 0.0.0.0
npx wire-mesh-sfu --bind 0.0.0.0:9000          # a different signaling port
npx wire-mesh-sfu --listen-ip 10.0.0.5         # mediasoup's own media listen address
npx wire-mesh-sfu --announced-ip 203.0.113.9   # for a host behind NAT: the address advertised in ICE candidates
```

A plain HTTP request against the bound address (no `Upgrade` header) returns the health response:

```sh
curl http://<host>:8788/
# {"ok":true,"node":"wire-mesh-sfu","roles":["sfu"]}
```

mediasoup's own `postinstall` fetches a prebuilt native worker binary for the current platform or, absent one, builds it locally via its own bundled Meson/Ninja invocation (needs a C++ toolchain). This workspace's `pnpm-workspace.yaml` explicitly approves mediasoup's build script (`onlyBuiltDependencies`/`allowBuilds`) for exactly this reason.

**Security note:** matching `wire-mesh-node`'s own posture, this package adds no access control beyond the protocol's own capability tokens (`webrtc:signal`, gated the same way `core/exec`'s verbs are) — anyone who can reach the bound address and present a valid token can join a call. Bind to a trusted network, or ensure whatever issues `webrtc:signal` tokens is itself trusted, before exposing this to the open internet.

## Type environment

`src/` is plain Node code, no DOM lib, matching `wire-mesh-core`'s and `wire-mesh-node`'s own type environment.
