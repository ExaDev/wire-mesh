# conformance/

Golden test vectors: every implementation's CI must decode each vector's `wire_hex` to its `message` and re-encode `message` back to exactly `wire_hex`. This is the actual forcing function against drift between implementations -- a schema alone never proves interop, only shared vectors do, the same lesson Cascade's own `docs/conformance/*.v1.json` was built to enforce for its XDR-based protocol.

`handshake.v1.json` covers `handshake-frame`. `tokens.v1.json` covers `capability-token` (including a delegation chain, one token's `parent` pointing at another) and `handle-record`. `frames.v1.json` covers every other `$frame-variant` in `spec/frame.cddl`.

## Regenerating

```
pnpm install
pnpm run generate   # rebuilds codec.ts first, then writes {handshake,tokens,frames}.v1.json from generate.ts's vector definitions
pnpm test            # rebuilds codec.ts first, then decodes every committed vector and confirms it round-trips
```

`generate.ts` is the actual source of truth, not the JSON files: every vector's `message` is authored as plain TypeScript data matching a CDDL rule's fields, and `wire_hex` is derived mechanically by canonically CBOR-encoding it via [`cbor2`](https://www.npmjs.com/package/cbor2)'s CDE (CBOR Common Deterministic Encoding) mode -- the RFC 8949 4.2 core deterministic rules DAG-CBOR itself builds on -- never hand-typed. CI regenerates and diffs against the committed files the same way `spec/`'s own `cddl-validate` job does for `protocol.cddl`, so the two can never silently drift apart.

## codec.ts is a real, polymorphic package, not just a shared file

`codec.ts` defines the one JSON convention every vector's `message` needs: since JSON has no byte-string type, a CDDL `bstr` field is written as `{ "hex": "<lowercase hex>" }` rather than a raw string or number array. `toWire`/`fromWire` convert between that marker shape and the real bytes CBOR needs on the way in and out; `isVectorFile` validates a parsed vector file at the JSON boundary rather than trusting an `as` cast.

`generate.ts` and `verify.test.ts` both import it as `@exadev/wire-mesh-conformance` (self-referencing the package by its own name), not via a relative path -- `pnpm run build` (`tsdown`) compiles `codec.ts` into dual ESM/CJS output plus `.d.mts`/`.d.cts` declarations under `dist/`, and `package.json`'s `exports` map is what makes the self-reference resolve to that built output rather than the source file. This means the same artifact every consumer would actually get is what runs here, not a stand-in. [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (wired into the `build` script via `tsdown`'s own `attw` option) checks that dual-package surface resolves correctly under Node's `node16` module resolution -- catching the class of "works in this repo, broken for a real consumer" bug that a bare `tsc` build can't see, before it ever has to matter.

Node (26+) runs every `.ts` file here directly via its own native TypeScript support -- no `tsx`/`ts-node` needed. `tsconfig.json` sets `moduleResolution: "nodenext"` and `allowImportingTsExtensions: true` specifically because that's what actually happens: relative imports carry real `.ts`/no extensions the way Node's own ESM resolution requires, not a bundler's more lenient extension-guessing.

Signature and public-key bytes throughout are clearly-synthetic filler (`aa`/`bb`/`ee`/`ff`-repeated hex), not real cryptographic material -- these vectors freeze the wire-exact envelope shape (map key ordering, field presence, the recursive delegation-chain nesting), not a working signature, the same scope Cascade's own frozen vectors commit to for fields with no real crypto behind them.

## Gotcha: `cbor2` doesn't recognise a Node `Buffer` as a byte string

Feeding a plain Node `Buffer` (rather than a plain `Uint8Array`) into `cbor2`'s `encode()` silently produces the wrong output: `Buffer` overrides `toJSON()`, and `cbor2`'s type dispatch falls through to a generic-object encoder that serialises it as a garbled `{ type: "Buffer", data: [...] }` CBOR map instead of a byte string, with no error raised. Confirmed directly while writing this generator -- caught only because the verifier's round-trip check failed with an unreadable diff. `toWire()` in `codec.ts` guards against this explicitly, converting every marker to a genuine `Uint8Array` via `Uint8Array.from(Buffer.from(hex, "hex"))` rather than passing a `Buffer` straight to `encode()`.
