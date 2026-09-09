# wire-mesh

An application-neutral peer-mesh wire protocol. Any tool that speaks it — a file-sync client, an agent communication bus, a terminal broker — can be a first-class peer in the same mesh as any other, without depending on any one implementation as the canonical runtime. The protocol is the contract; no single codebase is.

> Status: **design phase**. Nothing here is implemented yet. This repository currently records the settled architectural decisions so that implementation is transcription against an agreed contract, not ad hoc invention per language.

## Why this exists

Two independent projects — [Cascade](https://github.com/Mearman/cascade), a peer-to-peer cloud storage filesystem, and [agent-comms](https://github.com/ExaDev/agent-comms), a cross-harness LLM-agent communication mesh — converged independently on the same shape of problem: peers identified by a public key, an authenticated transport, capability-scoped authorisation, and NAT traversal via relay. Cascade already publishes its own wire-protocol specification for exactly this reason, explicitly intended to let other tools join its mesh without depending on the Cascade binary at runtime.

Rather than have agent-comms couple to Cascade's specific implementation, or the two projects maintain parallel, incompatible protocols solving the same problem, wire-mesh is the neutral third artifact both refactor onto as equal peers — and that any future application is free to implement independently.

## What it specifies

- **Identity.** A node's identity is the hash of a self-generated, self-signed public key. Peer connections are mutually authenticated; a peer is exactly the holder of the private key for the certificate whose hash is its ID.
- **A capability-negotiation handshake.** Nodes advertise which capability domains they implement; the usable set for a connection is the intersection of what both sides advertise. Heterogeneous peers — one node with capabilities the other lacks — are the normal case, not an error.
- **Authorisation via signed, revocable capability tokens.** Authority is a verb over a scope, carried as a token signed by the issuing node's key. A bearer presents a token; the verifier checks signature, expiry, and revocation. Delegation forms bounded chains — each hop can only narrow authority, never widen it.
- **Relay and NAT traversal.** When two peers cannot connect directly, a relay carries their traffic as an opaque, unreadable byte pipe. The relay never has the keys to decrypt what it forwards.
- **An opaque, per-application data domain.** The protocol carries structured content for the domains it defines natively (identity, handshake, tokens, relay) and leaves application-specific payloads — chat messages, file blocks, an operation log entry — as opaque bytes to any peer that doesn't need to interpret them, so different applications can share a mesh without needing to understand each other's content.
- **A domain and capability registry**, so unrelated applications extending the protocol with their own capability domains or verbs don't collide on the same identifier.
- **Federation** between independent meshes, with selective, explicit cross-mesh sharing — distinct from ordinary intra-mesh relay.

## Encoding

The wire format is [CBOR](https://datatracker.ietf.org/doc/html/rfc8949), using the [DAG-CBOR](https://ipld.io/specs/codecs/dag-cbor/spec/) canonical profile for anything that is signed, hashed, or content-addressed. This was chosen deliberately over Protocol Buffers: Protobuf's own documentation states its serialisation is [not canonical across languages or library versions](https://protobuf.dev/programming-guides/serialization-not-canonical/), which makes it unsafe as the basis for a signature without inventing a separate canonicalisation scheme on top. CBOR's deterministic encoding is part of its own standard, and DAG-CBOR's specific profile has years of proven, multi-language, production interoperability across the IPFS/Filecoin ecosystem.

Capability tokens are signed using [COSE](https://www.rfc-editor.org/rfc/rfc9052.html) (RFC 9052) rather than a bespoke "sign the canonical bytes" scheme — COSE defines a purpose-built structure for exactly this, narrowing the correctness surface to one well-specified construction instead of a general canonicalisation algorithm every implementation must get bit-perfect.

The schema is described in [CDDL](https://datatracker.ietf.org/doc/html/rfc8610) (RFC 8610), the IETF standard for specifying CBOR structures. Interoperability between independent implementations is proven by shared, language-neutral conformance vectors — golden test cases every implementation's own CI runs — not by documentation alone.

## Implementations

None yet. The two known future implementers are Cascade (Rust) and agent-comms (TypeScript). A companion project, [cddl.js](https://github.com/ExaDev/cddl.js), exists to give the TypeScript side schema-driven code generation, since no such tool currently exists for CDDL.

## Contributing

This is early enough that the most useful contribution is scrutiny of the design decisions above before anything is built against them. Open an issue.
