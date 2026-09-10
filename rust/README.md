# rust/

The Rust implementation of wire-mesh: a Cargo workspace of three crates mirroring the TypeScript core's generated/ports/adapters/domain split.

```
crates/
  wire-mesh-wire/         The CDDL model + CDE codec. One hand-written module per CDDL rule family
                          (identity, handshake, tokens, transport, management, streaming, exec,
                          data, discovery, frame) plus the CborValue/CanonicalMap DOM for every
                          `any` and open-map position. alloc-only, no async/crypto/serde
                          dependencies.
  wire-mesh-core/         Ports (Transport, KeyValueStorage, Identity, Clock), domain logic
                          (handshake negotiation, capability-token verification, revocation),
                          and adapters (in-memory storage, Tokio TCP transport, system clock,
                          Ed25519/ES256 node identity).
  wire-mesh-conformance/  The conformance-check binary gating the frozen vectors in
                          ../../conformance/*.v1.json.
```

## Codec guarantees

Every wire type implements `minicbor` `Encode`/`Decode` by hand (minicbor is pinned to exactly 2.2.2; the 2.x trait shapes differ from the widely documented 0.2x series) with two invariants:

- **CDE by construction** (RFC 8949 4.2 core deterministic encoding, the rules DAG-CBOR builds on): map keys are written in encoded-length-first-then-bytewise order, integer heads are minimal-length, lengths are always definite. Closed-key structs hard-code the order (pinned by the conformance vectors); open maps go through `CanonicalMap`; mixed typed-plus-tail maps through `CdeMapBuilder`, because an extension key can sort anywhere among the typed fields.
- **Strict decode**: unknown keys, wrong arity, indefinite lengths, floats, tags, duplicate keys, non-32-byte device-ids, bad enum literals, and trailing bytes are all rejected — non-canonical input cannot decode only to re-encode differently.

## Running

```
cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
cargo run --bin conformance-check
```

The root `justfile` already dispatches these (`just build`, `just test`, `just lint`, `just conformance`); `just conformance` runs this binary alongside the vector-generation gate in `conformance/`.

`conformance-check` proves all 26 frozen vectors two ways per vector: a typed decode → validate → re-encode → byte-compare loop (with a first-divergence hex diff on mismatch), and a reverse message-JSON → `CborValue` DOM → CDE encode → byte-compare loop that pins the `{"hex": ...}` byte-string convention and rejects non-integral JSON numbers rather than truncating them. For the three COSE vectors it additionally round-trips the nested protected headers and claims through the on-demand accessors, proving those re-encode identically too.

## Known upstream quirk (flagged, worked around)

The frozen `tokens.v1.json` protected headers encode the RFC 9052 `alg`/`kid` labels as *text* keys `"1"`/`"4"` (bytes `0x61 0x31`/`0x61 0x34`), not the CDDL's integer labels 1/4 (`0x01`/`0x04`) — a JS-object-key quirk from the vector generator. The wire crate accepts both forms on decode (`HeaderLabel::Int` vs `HeaderLabel::Text`), but only the integer form is canonical for *emitted* tokens: `CoseTokenHeaders`'s typed `alg`/`kid` fields populate from integer labels and re-emit as integer labels, while a text form decodes into `extra` verbatim so byte-exact round-tripping still holds. The vector generator should eventually be fixed to emit true integer labels and re-frozen; worth doing before more implementations hard-code the quirk.

## Scope and deferrals

Real domain logic exists for the three areas the plan prioritised — transport (TCP adapter with 4-byte big-endian length-prefixed framing, matching the TS adapter), handshake negotiation (version min + order-independent domain intersection, retired `core/federation` rejected distinctly), and capability tokens (COSE_Sign1 per RFC 9052 Sig_structure, self-certifying sha256(device-id) check, expiry/not-before, delegation-chain narrowing with expiry clamping, and the revocation obligations from `management.cddl`: entries verified as signed claims, only a token's own issuer may revoke it, and every ancestor token-id swept against the view, not just the leaf's). Everything else is wire types plus schema validation only. Deferred, deliberately:

- **TLS transport adapter** — the TCP adapter implements the same `Transport` port a TLS adapter will; no TLS code exists yet.
- **Exec/data/discovery services** — the frame families decode, encode, and validate, but no process spawning, oplog storage, or handle-resolution client/server exists. `handle-record` verification (signature + `sha256(identity-key) == device-id` + expiry) is available through the same COSE machinery as tokens, but nothing performs DNS fetches of `/.well-known/wire-mesh/<local-part>`.
- **Coordinator election logic** — the frame type exists; the term/lowest-device-id tiebreak is a receiver obligation documented in `transport.cddl` but no gossip engine implements it.
- **Revocation persistence wiring** — `RevocationView` verifies and admits entries in memory; a service that stores raw entries via the `KeyValueStorage` port and rebuilds the view on startup is not built.
- **Streaming backpressure enforcement** — the credit-window frames exist; no producer/consumer engine enforces `ack-seq + window` yet.
- **CDRL-to-Rust drift mitigation** — there is no CDDL-to-Rust generator (cddl.js emits TS/Zod only), so beyond the 26 vectors, drift is caught by the per-family unit tests derived from the CDDL text (key order, regex tiers over the registry's examples, arity, and unknown-key rejection). Vectors should be regenerated and this gate re-run whenever `spec/*.cddl` changes.
