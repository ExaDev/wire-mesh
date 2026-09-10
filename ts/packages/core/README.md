# @exadev/wire-mesh-core

The TypeScript implementation of wire-mesh's protocol, built ports/adapters: domain logic (`src/domain/`) depends only on port contracts (`src/ports/`) and the [cddl.js](https://github.com/ExaDev/cddl.js)-generated Zod schemas (`src/generated/protocol.ts`, regenerated from `../../../spec/protocol.cddl` via `generate.ts` -- never edited by hand), never on a specific adapter's own imports.

## Ports

- **Transport** (`src/ports/transport.ts`) -- an async contract for sending/receiving `Frame` values over a connection. Adapter: `src/adapters/tcp-transport.ts` (length-prefixed CBOR frames over plain `node:net`, matching Cascade's own transport shape).
- **Storage** (`src/ports/storage.ts`) -- an async key/value contract. Adapter: `src/adapters/memory-storage.ts` (in-process, for tests and single-process nodes).
- **Identity** (`src/ports/identity.ts`) -- device-id derivation and COSE signing/verification. Adapter: `src/adapters/node-identity.ts` (Web Crypto, ECDSA P-256 and Ed25519 -- the two algorithms the spec's own conformance vectors use).
- **Clock** (`src/ports/clock.ts`) -- injected time, never `Date.now()` pulled directly into domain logic. Adapter: `src/adapters/system-clock.ts`.

## Domain logic implemented

- **Handshake negotiation** (`src/domain/handshake.ts`) -- protocol-version and capability-domain negotiation between two peers, the mechanism agent-comms issue #31 is fixed by.
- **Capability-token verification** (`src/domain/tokens.ts`) -- the full chain tokens.cddl documents: COSE_Sign1 signature verification, the self-certifying issuer-key check (`sha256(issuer-key.public-key) == issuer`), expiry/not-before, revocation, and recursive delegation-chain narrowing (a delegated token's issuer must be its parent's bearer, and its expiry must not exceed its parent's).

## Deliberately deferred

Every other frame family (management/exec, streaming, data-domain, federation) is covered by schema validation only -- `conformance-check` proves the generated schemas decode and re-encode every golden vector byte-exactly, including these families, but no domain-level business logic (dispatch, session bookkeeping, PTY/proc lifecycle, oplog replication, federation-link state) exists for them yet. This matches the build-out plan's own stated option to land "transport + handshake + tokens first... with streaming/exec/federation behind later milestones" -- the conformance suite covers all families either way, so nothing here is unverified, only unimplemented.

## Regenerating the schema

```sh
pnpm generate   # rewrites src/generated/protocol.ts from ../../../spec/protocol.cddl
pnpm test       # confirms it still round-trips every conformance vector
```

CI regenerates and diffs against the committed file, the same way `conformance/`'s own vector files are verified never to drift from hand-editing.
