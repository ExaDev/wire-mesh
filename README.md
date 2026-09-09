# wire-mesh

An application-neutral peer-mesh wire protocol. Any tool that speaks it — a file-sync client, an agent communication bus, a terminal broker — can be a first-class peer in the same mesh as any other tool. No single implementation is the canonical runtime. The protocol is the contract; no codebase is.

> **Status: design phase.** Nothing here is implemented yet. This repository records the settled architectural decisions, so implementation is transcription against an agreed contract, not ad hoc invention per language.

## Why this exists

Two independent projects converged on the same shape of problem: peers identified by a public key, an authenticated transport, capability-scoped authorisation, and NAT traversal via relay.

- [Cascade](https://github.com/Mearman/cascade) is a peer-to-peer cloud storage filesystem, written in Rust. It already publishes its own wire-protocol specification, explicitly intended to let other tools join its mesh without depending on the Cascade binary at runtime.
- [agent-comms](https://github.com/ExaDev/agent-comms) is a cross-harness LLM-agent communication mesh, written in TypeScript.

Rather than have agent-comms couple to Cascade's specific implementation, or have the two projects maintain parallel, incompatible protocols for the same problem, wire-mesh is the neutral third artefact both refactor onto as equal peers. Any future application is free to implement it independently.

## Architecture

### What the protocol specifies

- **Identity.** A node's identity is the hash of a self-generated, self-signed public key. Peer connections are mutually authenticated: a peer is exactly the holder of the private key for the certificate whose hash is its ID.
- **A capability-negotiation handshake.** Nodes advertise which capability domains they implement. The usable set for a connection is the intersection of what both sides advertise. Heterogeneous peers — one node with capabilities the other lacks — are the normal case, not an error.
- **Authorisation via signed, revocable capability tokens.** Authority is a verb over a scope, carried as a token signed by the issuing node's key. A bearer presents a token; the verifier checks signature, expiry, and revocation. Delegation forms bounded chains: each hop can only narrow authority, never widen it.
- **Relay and NAT traversal.** When two peers cannot connect directly, a relay carries their traffic as an opaque, unreadable byte pipe. The relay never holds the keys to decrypt what it forwards.
- **An opaque, per-application data domain.** The protocol carries structured content for the domains it defines natively (identity, handshake, tokens, relay). It leaves application-specific payloads — a chat message, a file block, an operation-log entry — as opaque bytes to any peer that does not need to interpret them. Different applications can therefore share one mesh without understanding each other's content.
- **A domain and capability registry**, so unrelated applications extending the protocol with their own capability domains or verbs do not collide on the same identifier.
- **Federation** between independent meshes, with selective, explicit cross-mesh sharing, distinct from ordinary intra-mesh relay.

### Encoding

The wire format is [CBOR](https://datatracker.ietf.org/doc/html/rfc8949), using the [DAG-CBOR](https://ipld.io/specs/codecs/dag-cbor/spec/) canonical profile for anything that is signed, hashed, or content-addressed. This was chosen over Protocol Buffers: Protobuf's own documentation states its serialisation is [not canonical across languages or library versions](https://protobuf.dev/programming-guides/serialization-not-canonical/), which makes it unsafe as the basis for a signature without inventing a separate canonicalisation scheme on top. CBOR's deterministic encoding is part of its own standard, and the DAG-CBOR profile has years of proven, multi-language, production interoperability across the IPFS/Filecoin ecosystem.

Capability tokens are signed using [COSE](https://www.rfc-editor.org/rfc/rfc9052.html) (RFC 9052) rather than a bespoke "sign the canonical bytes" scheme. COSE defines a purpose-built structure for exactly this, narrowing the correctness surface to one well-specified construction instead of a general canonicalisation algorithm every implementation must get bit-perfect.

The schema is described in [CDDL](https://datatracker.ietf.org/doc/html/rfc8610) (RFC 8610), the IETF standard for specifying CBOR structures. Interoperability between independent implementations must be proven by shared, language-neutral conformance vectors — golden test cases every implementation's own CI runs — not by documentation alone.

## Implementations

None yet. The two known future implementers are Cascade (Rust) and agent-comms (TypeScript). A companion project, [cddl.js](https://github.com/ExaDev/cddl.js), exists to give the TypeScript side schema-driven code generation, since no such tool currently exists for CDDL.

## Contributing

This is early enough that the most useful contribution is scrutiny of the design decisions above, before anything is built against them. Open an issue.

## References

- [Cascade](https://github.com/Mearman/cascade) — the peer-to-peer storage filesystem whose own wire-protocol spec motivated this repository.
- [agent-comms](https://github.com/ExaDev/agent-comms) — the agent-communication mesh that will refactor onto this protocol alongside Cascade.
- [cddl.js](https://github.com/ExaDev/cddl.js) — CDDL-driven TypeScript code generation for agent-comms' implementation.
