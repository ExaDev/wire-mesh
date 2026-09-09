# wire-mesh

An application-neutral peer-mesh wire protocol. Any tool that speaks it — a file-sync client, an agent communication bus, a terminal broker — can be a first-class peer in the same mesh as any other tool. No single implementation is the canonical runtime. The protocol is the contract; no codebase is.

> **Status: schema written, no implementations yet.** [`spec/protocol.cddl`](spec/protocol.cddl) is a real, RFC 8610-valid schema, validated against a CDDL parser — not just prose. Nothing consumes it yet: `rust/` and `ts/packages/*` don't exist as code, only as the repository structure below.

## Why this exists

Two independent projects converged on the same shape of problem: peers identified by a public key, an authenticated transport, capability-scoped authorisation, and NAT traversal via relay.

- [Cascade](https://github.com/Mearman/cascade) is a peer-to-peer cloud storage filesystem, written in Rust. It already publishes its own wire-protocol specification, explicitly intended to let other tools join its mesh without depending on the Cascade binary at runtime.
- [agent-comms](https://github.com/ExaDev/agent-comms) is a cross-harness LLM-agent communication mesh, written in TypeScript.

Rather than have agent-comms couple to Cascade's specific implementation, or have the two projects maintain parallel, incompatible protocols for the same problem, wire-mesh is the neutral third artefact both refactor onto as equal peers. Any future application is free to implement it independently.

## Comparison to alternatives

Several existing protocols cover overlapping ground. None combines wire-mesh's specific set of properties — direct P2P topology, public-key identity, capability-token authorisation, and an opaque per-application content domain — in one protocol.

The first table is a set of objective presence checks — does the protocol have this specific mechanism at all (🟢 present, 🟡 present via a different layer or only partially, 🔴 absent) — tracking the bullets from [What the protocol specifies](#what-the-protocol-specifies). Hover any emoji for the detail behind the rating.

| Protocol | Handshake / capability negotiation | Relay / NAT traversal | Domain & capability registry | Handle discovery | Federation |
|---|---|---|---|---|---|
| **wire-mesh** | <abbr title="Explicit capability-domain negotiation; the usable set for a connection is the intersection of what both sides advertise">🟢</abbr> | <abbr title="A relay carries traffic as an opaque, unreadable byte pipe when peers cannot connect directly">🟢</abbr> | <abbr title="A registry so unrelated applications' own capability domains and verbs don't collide">🟢</abbr> | <abbr title="DNS-anchored resolution to a self-certifying record, mirroring WebFinger">🟢</abbr> | <abbr title="Selective, explicit cross-mesh sharing, distinct from ordinary intra-mesh relay">🟢</abbr> |
| [libp2p](https://libp2p.io/) | <abbr title="multistream-select negotiates supported protocols per connection, but as protocol selection, not a capability-domain intersection">🟡</abbr> | <abbr title="Circuit relay v2 and hole punching">🟢</abbr> | <abbr title="Protocol IDs are free-form strings; no formal collision-avoiding registry">🔴</abbr> | <abbr title="DHT/peer-routing discovery exists, but no DNS-anchored self-certifying handle scheme">🔴</abbr> | <abbr title="One flat overlay network; no concept of federation between independent meshes">🔴</abbr> |
| [Secure Scuttlebutt](https://scuttlebutt.nz/) | <abbr title="No negotiation; a connection is direct feed replication">🔴</abbr> | <abbr title="No relay primitive; pubs provide store-and-forward replication, not a transport relay">🔴</abbr> | <abbr title="None">🔴</abbr> | <abbr title="Invite codes and pub identifiers, not DNS-anchored resolution">🔴</abbr> | <abbr title="None">🔴</abbr> |
| [Syncthing](https://docs.syncthing.net/specs/bep-v1.html) (BEP) | <abbr title="Protocol-version negotiation only, not a capability-domain intersection">🔴</abbr> | <abbr title="Dedicated relay servers for NAT traversal">🟢</abbr> | <abbr title="None">🔴</abbr> | <abbr title="Device IDs plus discovery servers, not DNS-anchored resolution">🔴</abbr> | <abbr title="None">🔴</abbr> |
| [Matrix](https://spec.matrix.org/) | <abbr title="None">🔴</abbr> | <abbr title="Not peer-to-peer; homeservers are expected to be directly reachable">🔴</abbr> | <abbr title="None">🔴</abbr> | <abbr title="DNS-based homeserver discovery (.well-known/SRV) resolves to a server, not a self-certifying signed record">🟡</abbr> | <abbr title="Federation between homeservers is the primary topology itself, not a distinct selective layer on top of direct peering">🟡</abbr> |
| [ActivityPub](https://www.w3.org/TR/activitypub/) | <abbr title="None">🔴</abbr> | <abbr title="Not peer-to-peer; 'relay' actors rebroadcast activities between servers, not a transport relay">🔴</abbr> | <abbr title="None">🔴</abbr> | <abbr title="WebFinger handle discovery is standard in Fediverse deployments (e.g. Mastodon), but not part of the ActivityPub spec itself">🟡</abbr> | <abbr title="Unconditional inbox delivery to every known follower, not selective cross-mesh sharing">🔴</abbr> |

The second table describes each protocol's own approach in prose, for direct comparison against wire-mesh's own choice as described in [What the protocol specifies](#what-the-protocol-specifies).

| Protocol | Topology | Peer identity | Authorisation | Application content | Wire encoding |
|---|---|---|---|---|---|
| **wire-mesh** | Direct P2P mesh, with relay for NAT traversal and optional cross-mesh federation | Hash of a self-signed public key | Signed, revocable, delegatable capability tokens; delegation can only narrow authority | Opaque per-application payload; only identity, handshake, tokens and relay are protocol-native | CBOR/DAG-CBOR, signed via COSE, schema in CDDL |
| [libp2p](https://libp2p.io/) | Direct P2P mesh, with circuit relay and hole punching for NAT traversal | Multihash of a public key | Not built in; left to the application or its own protocols | Defined per protocol via multistream-select and application-registered protocol IDs | Protocol-specific; commonly Protobuf, which is not canonical across languages or library versions |
| [Secure Scuttlebutt](https://scuttlebutt.nz/) | P2P gossip replication of append-only logs; no relay primitive for NAT traversal | Ed25519 public key | None; a feed's own author key is its sole authority | Fixed: an append-only log of an identity's own signed messages | JSON, hashed for signing; no CBOR-style canonical encoding standard |
| [Syncthing](https://docs.syncthing.net/specs/bep-v1.html) (BEP) | Direct P2P mesh, with relay servers for NAT traversal | SHA-256 of a self-signed certificate | Access is device-list based, not token-scoped | Fixed: file blocks and index metadata for folder sync | Protobuf; not canonical across languages or library versions |
| [Matrix](https://spec.matrix.org/) | Federated client-server and server-server; not peer-to-peer | Homeserver-issued user ID; no peer key | Room-level power levels and access-control lists, not bearer capability tokens | Fixed: room events under a defined event-type schema | JSON, with a canonical-JSON scheme used specifically for event signing and federation |
| [ActivityPub](https://www.w3.org/TR/activitypub/) | Federated server-to-server, one-to-many broadcast | Server-hosted actor URI; no peer key | None; visibility is addressing-based (public, followers, etc), not capability tokens | Fixed: JSON-LD activity vocabulary | JSON-LD; no canonical signing scheme built into the base spec |

## Architecture

### What the protocol specifies

- **Identity.** A node's identity is the hash of a self-generated, self-signed public key. Peer connections are mutually authenticated: a peer is exactly the holder of the private key for the certificate whose hash is its ID.
- **A capability-negotiation handshake.** Nodes advertise which capability domains they implement. The usable set for a connection is the intersection of what both sides advertise. Heterogeneous peers — one node with capabilities the other lacks — are the normal case, not an error.
- **Authorisation via signed, revocable capability tokens.** Authority is a verb over a scope, carried as a token signed by the issuing node's key. A bearer presents a token; the verifier checks signature, expiry, and revocation. Delegation forms bounded chains: each hop can only narrow authority, never widen it.
- **Relay and NAT traversal.** When two peers cannot connect directly, a relay carries their traffic as an opaque, unreadable byte pipe. The relay never holds the keys to decrypt what it forwards.
- **An opaque, per-application data domain.** The protocol carries structured content for the domains it defines natively (identity, handshake, tokens, relay). It leaves application-specific payloads — a chat message, a file block, an operation-log entry — as opaque bytes to any peer that does not need to interpret them. Different applications can therefore share one mesh without understanding each other's content.
- **A domain and capability registry**, so unrelated applications extending the protocol with their own capability domains or verbs do not collide on the same identifier.
- **Handle discovery.** A DNS-anchored resolution convention, mirroring WebFinger, for reaching an arbitrary handle you have never interacted with — resolving to a self-certifying record signed by the same key it claims, safe to serve through an untrusted intermediary. The same record's optional mailbox hint unifies discovery with offline delivery: fan-out and delivery to a currently-offline peer both fall out of any peer being able to answer for another device's data-domain log, not a separate mechanism.
- **Federation** between independent meshes, with selective, explicit cross-mesh sharing, distinct from ordinary intra-mesh relay.

### Encoding

The wire format is [CBOR](https://datatracker.ietf.org/doc/html/rfc8949), using the [DAG-CBOR](https://ipld.io/specs/codecs/dag-cbor/spec/) canonical profile for anything that is signed, hashed, or content-addressed. This was chosen over Protocol Buffers: Protobuf's own documentation states its serialisation is [not canonical across languages or library versions](https://protobuf.dev/programming-guides/serialization-not-canonical/), which makes it unsafe as the basis for a signature without inventing a separate canonicalisation scheme on top. CBOR's deterministic encoding is part of its own standard, and the DAG-CBOR profile has years of proven, multi-language, production interoperability across the IPFS/Filecoin ecosystem.

Capability tokens are signed using [COSE](https://www.rfc-editor.org/rfc/rfc9052.html) (RFC 9052) rather than a bespoke "sign the canonical bytes" scheme. COSE defines a purpose-built structure for exactly this, narrowing the correctness surface to one well-specified construction instead of a general canonicalisation algorithm every implementation must get bit-perfect.

The schema is described in [CDDL](https://datatracker.ietf.org/doc/html/rfc8610) (RFC 8610), the IETF standard for specifying CBOR structures. Interoperability between independent implementations must be proven by shared, language-neutral conformance vectors — golden test cases every implementation's own CI runs — not by documentation alone.

### Ports and adapters

`core` is domain logic; it depends only on contracts, never on the runtime it executes in or the backend that holds its data. Every runtime-specific or vendor-specific concern lives in an adapter at the edge, satisfying one of these ports:

- **Transport** — send, broadcast, connect, receive. Adapters: Node TCP/TLS (a plain-hosted process), a Durable-Object-hibernation WebSocket adapter (`cloudflare-hub`), and a WebRTC DataChannel adapter (`web-console`). Streaming operations carry backpressure at the contract level — cascade's own credit-window design for exec stdio is the precedent — so a WebRTC DataChannel's `bufferedAmount`/`bufferedamountlow` and a TCP socket's `drain` event both have to satisfy the same abstract backpressure contract rather than leaking their own shape into `core`.
- **Storage** — `get`/`put`/`delete`. Adapters: a `NullStorage` no-op (ephemeral nodes), Durable Object storage (`cloudflare-hub`), a filesystem/SQLite adapter (a plain-hosted deployment).
- **Identity/crypto** — key generation, signing, verification. Likely one adapter, not three: Node has shipped a spec-compliant `crypto.webcrypto` since v15, so the same WebCrypto-based implementation can plausibly serve Node, browsers, and Cloudflare Workers alike. Worth confirming directly against each runtime rather than assumed.
- **Clock and observability** — first-class ports, not incidental detail. `core` doesn't call `Date.now()` or log directly, for the same reason it doesn't touch a socket directly: a test harness, a Cloudflare Worker's own trace context, and a plain Node process all want to supply these differently.

The bar for each of these: could a second implementation, built on a completely different vendor's primitives, satisfy the exact same contract with zero changes to the contract or its callers? The transport port in particular gets this validated for real rather than hypothetically — four genuinely different vendor primitives (Node sockets, Durable Object hibernation, WebRTC, and whatever Cascade's own Rust side needs) are all required from the start, not added speculatively later.

## Repository structure

```
spec/                     — the CDDL schema and prose specification, language-neutral
conformance/              — golden test vectors every implementation's CI must round-trip
rust/                     — the Rust implementation, published to crates.io
ts/
  packages/
    core/                 — the TypeScript implementation, published to npm
    cloudflare-hub/       — a reference Cloudflare Worker deployment of a public hub node
    web-console/          — a browser client (directory, room browser, join-from-browser) for any node
```

`spec/` and `conformance/` are the actual contract. `rust/` and `ts/packages/core` are two implementations of it, not two different things — neither is privileged over the other, and a future implementation in any other language is exactly as welcome. Tasks are orchestrated across the two languages by a thin root `justfile` that dispatches into each subtree's own native tooling (`cargo` for `rust/`, `turbo` for `ts/`) rather than a shared build system — there's no cross-language build graph complex enough yet to need one.

## Implementations

None yet. The schema exists (`spec/protocol.cddl`); `rust/` and `ts/packages/core` don't exist as code, only as the structure above. Once they do:

- **[Cascade](https://github.com/Mearman/cascade)** refactors its own hand-written protocol code onto `rust/` as an ordinary Cargo dependency, rather than maintaining a parallel implementation.
- **[agent-comms](https://github.com/ExaDev/agent-comms)** refactors its own wire-protocol and transport code onto `ts/packages/core` as an ordinary pnpm dependency, the same way.
- **[cddl.js](https://github.com/ExaDev/cddl.js)** gives `ts/packages/core` schema-driven Zod generation from `spec/protocol.cddl`, since no CDDL-to-TypeScript tool currently exists.

### The Cloudflare hub is a node, not a PWA — and the PWA is its own package

`ts/packages/cloudflare-hub` is a reference deployment of a public, always-on mesh **node** — a coordinator-of-coordinators that other peers dial into for company- or community-wide reach beyond a single local mesh. It depends on `ts/packages/core` as an ordinary consumer, exactly as agent-comms and Cascade do. It lives in this repository for now, during early co-development with the spec, but is deliberately structured as its own package rather than folded into the core library — the spec itself must stay adoptable by anyone with no interest in ExaDev's specific deployment, and that boundary is what makes moving the hub to its own repository later a packaging change, not an architectural one.

The web console a human actually opens in a browser — `ts/packages/web-console` — is a different thing, kept separate for the same reason: it is a *client* of a node, not a node itself. It may be served as static assets from the same origin as `cloudflare-hub` for deployment convenience, but it is not folded into it, and it is not tied to Cloudflare at all — it can equally connect to a purely local, laptop-hosted coordinator. This is also distinct from a third scenario this naming invites confusion with: an ordinary browser tab acting as its own genuine leaf peer (its own identity, its own `core`-implemented `MeshTransport`, entirely on an end user's device). That's not a package in this repository at all — it's just another consumer of `core`, built by whoever wants a browser-embedded node, the same as agent-comms or Cascade.

### Versioning

Two different things need their own versioning discipline, and neither substitutes for the other: the **wire protocol version**, negotiated at the handshake so mixed-version deployments degrade gracefully, and each **package's own semver**, since a package's public API can break independently of the wire format staying compatible. A protocol-version bump doesn't require a major package bump, and vice versa.

## Contributing

This is early enough that the most useful contribution is scrutiny of the design decisions above, before anything is built against them. Open an issue.

## References

- [Cascade](https://github.com/Mearman/cascade) — the peer-to-peer storage filesystem whose own wire-protocol spec motivated this repository.
- [agent-comms](https://github.com/ExaDev/agent-comms) — the agent-communication mesh that will refactor onto this protocol alongside Cascade.
- [cddl.js](https://github.com/ExaDev/cddl.js) — CDDL-driven TypeScript code generation for agent-comms' implementation.
