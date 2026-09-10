# conformance/

Golden test vectors: every implementation's CI must decode each vector's `wire_hex` to its `message` and re-encode `message` back to exactly `wire_hex`. This is the actual forcing function against drift between implementations -- a schema alone never proves interop, only shared vectors do, the same lesson Cascade's own `docs/conformance/*.v1.json` was built to enforce for its XDR-based protocol.

`handshake.v1.json` covers `handshake-frame`. `tokens.v1.json` covers `capability-token` (including a delegation chain, one token's `parent` pointing at another) and `handle-record`. `frames.v1.json` covers every other `$frame-variant` in `spec/frame.cddl`.

## Regenerating

```
npm install
npm run generate   # writes {handshake,tokens,frames}.v1.json from generate.mjs's vector definitions
npm run verify      # decodes every committed vector and confirms it round-trips
```

`generate.mjs` is the actual source of truth, not the JSON files: every vector's `message` is authored as plain JS data matching a CDDL rule's fields, and `wire_hex` is derived mechanically by canonically CBOR-encoding it via [`cbor2`](https://www.npmjs.com/package/cbor2)'s CDE (CBOR Common Deterministic Encoding) mode -- the RFC 8949 4.2 core deterministic rules DAG-CBOR itself builds on -- never hand-typed. CI regenerates and diffs against the committed files the same way `spec/`'s own `cddl-validate` job does for `protocol.cddl`, so the two can never silently drift apart.

`codec.mjs` defines the one JSON convention every vector's `message` needs: since JSON has no byte-string type, a CDDL `bstr` field is written as `{ "hex": "<lowercase hex>" }` rather than a raw string or number array. `toWire`/`fromWire` convert between that marker shape and the real bytes CBOR needs on the way in and out.

Signature and public-key bytes throughout are clearly-synthetic filler (`aa`/`bb`/`ee`/`ff`-repeated hex), not real cryptographic material -- these vectors freeze the wire-exact envelope shape (map key ordering, field presence, the recursive delegation-chain nesting), not a working signature, the same scope Cascade's own frozen vectors commit to for fields with no real crypto behind them.

## Gotcha: `cbor2` doesn't recognise a Node `Buffer` as a byte string

Feeding a plain Node `Buffer` (rather than a plain `Uint8Array`) into `cbor2`'s `encode()` silently produces the wrong output: `Buffer` overrides `toJSON()`, and `cbor2`'s type dispatch falls through to a generic-object encoder that serialises it as a garbled `{ type: "Buffer", data: [...] }` CBOR map instead of a byte string, with no error raised. Confirmed directly while writing this generator -- caught only because the verifier's round-trip check failed with an unreadable diff. `toWire()` in `codec.mjs` guards against this explicitly, converting every marker to a genuine `Uint8Array` via `Uint8Array.from(Buffer.from(hex, "hex"))` rather than passing a `Buffer` straight to `encode()`.
