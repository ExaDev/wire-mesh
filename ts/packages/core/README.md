# wire-mesh-core

The TypeScript implementation of wire-mesh's protocol, built ports/adapters: domain logic (`src/domain/`) depends only on port contracts (`src/ports/`) and the [cddl.js](https://github.com/ExaDev/cddl.js)-generated Zod schemas (`src/generated/protocol.ts`, regenerated from `../../../spec/protocol.cddl` via `generate.ts` -- never edited by hand), never on a specific adapter's own imports.

## Ports

- **Transport** (`src/ports/transport.ts`): an async contract for sending/receiving `Frame` values over a connection. Adapters: `src/adapters/tcp-transport.ts` (length-prefixed CBOR frames over plain `node:net`, matching Cascade's own transport shape) and `src/adapters/tls-transport.ts` (the same framing over `node:tls`).
- **Storage** (`src/ports/storage.ts`): an async key/value contract. Adapters: `src/adapters/memory-storage.ts` (in-process, for tests and single-process nodes) and `src/adapters/node-fs-storage.ts` (filesystem).
- **Identity** (`src/ports/identity.ts`) -- device-id derivation and COSE signing/verification. Adapter: `src/adapters/node-identity.ts` (Web Crypto, ECDSA P-256 and Ed25519 -- the two algorithms the spec's own conformance vectors use).
- **Clock** (`src/ports/clock.ts`) -- injected time, never `Date.now()` pulled directly into domain logic. Adapter: `src/adapters/system-clock.ts`.

## Domain logic implemented

- **Handshake negotiation** (`src/domain/handshake.ts`) -- protocol-version and capability-domain negotiation between two peers, the mechanism agent-comms issue #31 is fixed by.
- **Capability-token verification** (`src/domain/tokens.ts`) -- the full chain tokens.cddl documents: COSE_Sign1 signature verification, the self-certifying issuer-key check (`sha256(issuer-key.public-key) == issuer`), expiry/not-before, issuer-matched revocation (only a token's own issuer's signed revocation-entry counts, checked across every ancestor in the delegation chain, not just the leaf), and recursive delegation-chain narrowing across all three axes of authority: a delegated token's issuer must be its parent's bearer (the chain is unbroken), its expiry must not exceed its parent's, and its scope must narrow its parent's (identical kind, equal-or-descendant path when the parent carries one) with an identical capability verb (the verb grammar has no sub-verb relation, so a different verb is different authority, not narrower). Also exports `verifyRevocationEntry` for ingesting gossiped revocation-announce frames: each entry is itself a signed, self-certifying COSE_Sign1 over revocation-claims, verified before it may enter the revocation view.
- **Peer-advert verification** (`src/domain/peer-advert.ts`): the two checks transport.cddl states for a gossiped advert, applied by the relay hub before it registers or forwards one and by every session before one reaches its directory: the embedded identity-key self-certifies (`sha256(identity-key.public-key) == device`), and the signature verifies under that same key over the domain-separated canonical encoding of the advert with its signature removed, which covers the open extension tail as well. Deliberately not tokens.cddl's COSE Sig_structure: an advert's open tail lets an attacker craft one whose encoding also satisfies token-claims, so the prefixed construction keeps the two byte strings disjoint. Reaches a verdict for every input rather than throwing, since an advert's algorithm and key bytes are attacker-chosen.
- **Secure channel** (`src/domain/secure-channel.ts`, `src/domain/relay-channels.ts`): the end-to-end channel spec/secure-channel.cddl defines between two devices that reach each other through a relay. A session opens one with each peer it addresses through a relay pairing, seals every manage-request, manage-response and core/data frame in it, drops any that arrives as plain relay-data, and attributes a request to the identity the peer's handshake proved rather than to the `from-device` a hub stamps. There is no plaintext fallback, so a peer that does not speak it cannot be reached through a relay.
- **Relay hub** (`src/domain/relay-hub.ts`, `src/domain/relay-pairing.ts`, `src/domain/hub-mailbox.ts`): the hub's relay role against the Transport port alone. It verifies every gossiped advert before registering, forwarding or replaying it, pairs devices for relayed traffic, and, as a mailbox, replicates the `core/data` logs of devices that are offline.
- **Bulk transfer** (`src/domain/bulk.ts`): resumable, flow-controlled `core/bulk` transfer, with a byte-credit window that the receiver's acknowledgements move. `src/domain/sharded-delivery.ts` composes it with erasure coding (`src/domain/erasure-coding.ts`) and shard manifests (`src/domain/shard-manifest.ts`) to spread a payload across holder devices.
- **Data sync** (`src/domain/data-sync.ts`): the have, request and entries primitive over a storage-backed oplog, which never accepts a gap. What to broadcast, whose logs to track and which holder to ask are left to the application.
- **Coordinator election** (`src/domain/coordinator-election.ts`): the gossiped, term-based election over `coordinator-frame`, where a higher term supersedes a lower one and equal terms are broken by lowest device-id.
- **Rooms** (`src/domain/room.ts`, `src/domain/room-path.ts`, `src/domain/room-token-verification.ts`, `src/domain/room-rekey.ts`, `src/domain/group-key.ts`, `src/domain/notice-board.ts`): self-certifying room-notice verification, owner-named and direct-message room paths, the room verifier obligations on top of token verification, content-key distribution and rotation, and the encrypted noticeboard that composes them with data sync.
- **Threshold signing** (`src/domain/threshold-network.ts`, `src/adapters/threshold-*.ts`): the `exadev.io/threshold` manage-commands for FROST(Ed25519) key generation, resharing and two-round signing, with the cryptography supplied by the WebAssembly build of the Rust threshold crate.
- **Mesh session** (`src/domain/mesh-session.ts`): the connection session that owns the handshake exchange, the gossip-built peer directory, manage-request dispatch and reconnection, and that the hub, LAN node and web console build on.

## Not implemented

Exec and streaming are schema only: `conformance-check` proves the generated schemas decode and re-encode their golden vectors byte-exactly, but no code spawns a process or PTY (`proc.*`, `pty.*`) or sends, receives or enforces the credit window of a stream (`stream-data` and its acknowledgements). Tracked in [#341](https://github.com/ExaDev/wire-mesh/issues/341). Direct-path NAT traversal is not implemented either, so a connection across a NAT goes through the relay; tracked in [#343](https://github.com/ExaDev/wire-mesh/issues/343). Nothing resolves DNS-anchored handles. The federation link protocol no longer exists in the spec: cross-scope sharing is ordinary capability-token delegation, and the verification chain in `src/domain/tokens.ts` is the mechanism that governs it.

## Building from a fresh checkout

The threshold-signing adapter wraps a WebAssembly module built from the Rust crate `rust/crates/wire-mesh-threshold-wasm`. Its output, `wasm-dist/`, is gitignored, and core's `_typecheck`, `_lint`, `_test` and `_mutation` tasks depend on a `_build-wasm` turbo task that produces it, so a fresh checkout needs no manual step beyond having the toolchain:

- `rustup`, with the `stable` toolchain (the `wasm32-unknown-unknown` target is added by the build script).
- `wasm-bindgen-cli` at exactly the version `rust/Cargo.lock` pins for the `wasm-bindgen` crate. The script prints the matching `cargo install` command if the CLI is missing or on a different version.

```sh
pnpm install
pnpm typecheck   # builds wasm-dist first, then typechecks
```

Turbo hashes the Rust sources as the inputs of `_build-wasm`, so the module is rebuilt only after a Rust change and restored from cache otherwise. `pnpm build-wasm` runs just that task.

## Regenerating the schema

```sh
pnpm generate   # rewrites src/generated/protocol.ts from ../../../spec/protocol.cddl
pnpm test       # confirms it still round-trips every conformance vector
```

CI regenerates and diffs against the committed file, the same way `conformance/`'s own vector files are verified never to drift from hand-editing.

## Publishing

Published to npm as [`wire-mesh-core`](https://www.npmjs.com/package/wire-mesh-core). A push to `main` runs `semantic-release` (`ts/packages/core/release.config.ts`, tagged `core-v*` to keep this package's releases distinct from any other publishable package in the workspace), which versions from conventional-commit messages, builds `dist/` fresh, and publishes it -- `dist/` itself is never committed to the repo.
