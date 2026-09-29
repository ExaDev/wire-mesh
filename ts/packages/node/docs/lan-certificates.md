# Reaching a LAN node from the HTTPS console

A wire-mesh node run on someone's LAN can be reached by the console served from a hub only if the browser will let a page from `https://mesh.exadev.io` open a connection to it. Today that fails, for two independent reasons in the code and one in the browser.

- The node serves `ws://` unless given `--tls-cert` and `--tls-key`, and it generates no certificate of its own (`packages/node/README.md`, TLS section).
- The console dials a bare `host:port` over plain `ws://` and an address that names its scheme (`wss://`, `https://`) with it (`toWebSocketAddress` in `web-console/src/dial-address.ts`), so a node given its own certificate with `--tls-cert` is reachable when the browser trusts that certificate.
- A browser blocks a plain `ws://` connection from a secure page to anything that is not a loopback address; loopback is the only exemption MDN documents ([Mixed content](https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content), [archived](https://web.archive.org/web/https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content)). A LAN address, addressed by IP, gets no exemption. A console served from the node itself over `http://` is no way round it: it is not a secure context, and the console needs Web Crypto for its identity.

## Options

**Carry the conversation through the hub.** The console and the node are both connected to the hub, so the console never dials the node. This needs no certificate and is what the relay fallback (#251) provides once the relay carries an encrypted session (#261). It does not work when the hub is unreachable, which is the case a LAN node exists for.

**A name that resolves to the node's LAN address, with a CA certificate.** The model Plex uses: a per-server hostname under a domain the operator controls, a wildcard certificate for it, and a DNS answer that points at a private address ([How Plex is doing HTTPS for all its users](https://words.filippo.io/how-plex-is-doing-https-for-all-its-users/), [archived](https://web.archive.org/web/https://words.filippo.io/how-plex-is-doing-https-for-all-its-users/)). It needs a service that issues and renews certificates and publishes the DNS records, and it needs DNS to work at connection time, so it fails with the internet down. Routers with DNS rebinding protection also drop private answers for a public name, which Plex documents as a known failure ([Plex support: Network](https://support.plex.tv/articles/200430283-network/), [archived](https://web.archive.org/web/https://support.plex.tv/articles/200430283-network/)).

**WebTransport with pinned certificate hashes.** A page can connect to a server with a self-signed certificate by giving the browser the certificate's SHA-256 hash, with no CA involved; the certificate must be valid for under two weeks and use ECDSA P-256 ([WebTransport constructor, `serverCertificateHashes`](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport), [archived](https://web.archive.org/web/https://developer.mozilla.org/en-US/docs/Web/API/WebTransport/WebTransport)). It works with a bare LAN address and with no internet. WebTransport is available in current Chrome, Firefox and Safari, but whether the hash option is honoured in Safari, and whether Node can serve HTTP/3 without a native dependency, were not established here.

**A WebRTC data channel from the console to the node.** The node acts as a peer, signalled through the hub, and the two connect over host candidates with no certificate. It needs the hub for signalling, so it is no better than the relay when the hub is down, and it needs a WebRTC implementation for Node.

**A certificate trusted by hand on each device.** Works, does not scale, and asks users to install trust roots.

## Decision

Two tiers, because the two situations differ.

With the hub reachable, every node is reachable through the relay (#251), and no certificate is involved. Nothing else is needed for that case.

With the hub down, use WebTransport with pinned hashes (implemented: `--webtransport` on the node, and a console that dials an address carrying `#sha256=` over WebTransport). It is the only option that needs neither a CA nor the internet, its certificate lifetime limit is met by a node that mints a new certificate on a schedule, and it fits behind the existing `Transport` port as one more adapter. The hash travels in the node's signed advert as part of its address, as a scheme-carrying address such as `https://192.0.2.5:4433#sha256=...`, which `wire-candidate.address` (a string) already permits, so no new frame or field is proposed. A console learns the hash by hearing the advert, from the hub earlier or from an out-of-band handle record, so it needs no way to fetch it over the network it cannot reach.

A gossiped or typed address that names its scheme is dialled with it, which also lets a node that was given its own CA certificate with `--tls-cert` be reached, in either case.

Rejected: the named-domain route, for the cost of running the issuing service and because it fails offline; the WebRTC route, for needing the hub; hand-trusted certificates.

## What the check found (wire-mesh#267)

A Node server built on `@fails-components/webtransport` (a pinned-hash ECDSA P-256 certificate valid for ten days, a datagram echo) was reached with `serverCertificateHashes` from a page on `http://localhost`:

- **Safari, Chrome and Firefox connect.** Safari 27.0, Chromium and release Firefox 157 (each driven by opening a page that reported its result back) completed a session with the Node server and echoed a datagram. Firefox 157 also connected to an independent server, a Rust one built on `wtransport`. Playwright's WebKit connects too. WebKit's datagram writer is `datagrams.createWritable()`, where Chromium still exposes `datagrams.writable`, so a client written against one shape fails on the other; the transport here uses a stream and avoids datagrams.
- **Playwright's Firefox build does not.** Its Firefox 155 rejected a pinned-hash session ("WebTransport connection rejected") from both the Node server and the Rust server, against an IP address and against a hostname, with the HTTP/3 preferences forced on, while release Firefox 157 connected to the same servers. The rejection is that build, not the server library, so no Firefox route can be automated with Playwright.
- **Node has no built-in QUIC.** Node has no `node:quic`, with or without `--experimental-quic`. The only server found is a native addon (`@fails-components/webtransport-transport-http3-quiche`), whose install script downloads a prebuilt binary. A default `ignore-scripts` configuration leaves it unbuilt, so the node package treats the addon as an optional dependency and `--webtransport` fails at startup where it is missing.
- **Platform coverage of the prebuilt binary.** Binaries are published for macOS (arm64, x64), Linux (arm64, x64) and Windows (x64), each for N-API 6, which any current Node release provides. There is none for Linux on musl, so Alpine-based images cannot use it. The Linux x64 binary needs glibc 2.38 or newer: it failed to load on Debian 12 (glibc 2.36) and loads on Debian 13.
- **Several hashes are accepted, and rotation replaces the server.** `serverCertificateHashes` takes a list and the browser accepts a certificate that matches any entry: checked in Chromium, Safari 27.0 and Firefox 157, with the served certificate last in a list of three, and a list with no match is refused. The server package's `updateCert` does not change the certificate a running HTTP/3 server presents to new sessions (a connection opened before the call keeps working, and new ones still see the old certificate), so a node rotates by replacing its server on the same port, which ends the sessions open on it.
- **A Node process cannot dial a pinned hash.** The package's Node client verifies against the system's trust and has no way to pin, so Node peers reach each other over WebSocket and only a browser is the client of this transport.

## Certificate renewal

A pinned hash goes stale when its certificate does, and a browser refuses any certificate valid for two weeks or more, so an address cannot simply be long-lived. The node keeps a rolling schedule instead (`certificate-schedule.ts`): the certificate serving now and the next ones, each valid for under two weeks and each taking over half a lifetime after its predecessor, so every successor is already valid, and its hash already listed, before it is served. An address lists the hashes of the serving certificate and the next two, and a browser accepts whichever the node presents. An address copied at any moment therefore keeps working until the last certificate it lists has finished serving, which is three serving periods later. Checked in Chromium: an address copied before any rotation connected after the first and second rotation and was refused after the third.

The schedule is kept in a state directory (`--state-dir`, readable by its owner only, since it holds the private keys), so a node that restarts resumes the same certificates and the addresses it already handed out keep working. Without a state directory the schedule is in memory and a restart starts a new one. A node that was down past every stored certificate starts a new schedule, and any address from before is stale.

## Open questions

- A console learns the current hash list only from the address it was given. A console that stays connected across rotations could be told the new list over the session, and one that reconnects could store the latest, so an address is only stale for a console that is away for longer than the window. That needs the node's own signed advert (the relay hub has no identity of its own today) or a new frame, so it is a protocol decision, tracked separately.
- Where an out-of-band handle record carries the address, so a node that never reached the hub can still be found.
