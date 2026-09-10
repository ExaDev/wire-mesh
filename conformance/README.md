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

## Tasks, caching, and linting

`build`/`generate`/`test`/`typecheck`/`lint` are each a thin public script that calls `turbo run _<name>` -- e.g. `"build": "turbo run _build"`, `"_build": "tsdown"`. `turbo.json` keys its task graph on those same underscore names (never the public ones: a task literally named `build` would make `pnpm run build`'s own `turbo run build` call resolve straight back to itself, the recursive-call case Turborepo's docs warn against). `generate`/`test`/`typecheck`/`lint` all depend on `build`, so any of them rebuilds `codec.ts` first when something it depends on changed, and replays the cached result when nothing did -- running several in one invocation (`pnpm turbo run _generate _test _typecheck _lint`, what `just conformance` does) still only builds once, deduplicated across every task that needs it.

Linting uses [`@exadev/eslint-config`](https://www.npmjs.com/package/@exadev/eslint-config), the org's shared config, plus Prettier via `eslint-plugin-prettier`. Typed lint rules need `dist/`'s declarations to resolve the self-referenced package import, which is exactly why `_lint` depends on `_build` too.

## codec.ts is a real, polymorphic package, not just a shared file

`codec.ts` defines the one JSON convention every vector's `message` needs: since JSON has no byte-string type, a CDDL `bstr` field is written as `{ "hex": "<lowercase hex>" }` rather than a raw string or number array. `toWire`/`fromWire` convert between that marker shape and the real bytes CBOR needs on the way in and out; `isVectorFile` validates a parsed vector file at the JSON boundary rather than trusting an `as` cast.

`generate.ts` and `verify.test.ts` both import it as `@exadev/wire-mesh-conformance` (self-referencing the package by its own name), not via a relative path -- `pnpm run build` (`tsdown`) compiles `codec.ts` into dual ESM/CJS output plus `.d.mts`/`.d.cts` declarations under `dist/`, and `package.json`'s `exports` map is what makes the self-reference resolve to that built output rather than the source file. This means the same artifact every consumer would actually get is what runs here, not a stand-in. [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) (wired into the `build` script via `tsdown`'s own `attw` option) checks that dual-package surface resolves correctly under Node's `node16` module resolution -- catching the class of "works in this repo, broken for a real consumer" bug that a bare `tsc` build can't see, before it ever has to matter.

Node (26+) runs every `.ts` file here directly via its own native TypeScript support -- no `tsx`/`ts-node` needed. `tsconfig.json` sets `moduleResolution: "nodenext"` to match that reality, and is scoped to `codec.ts` alone (`"include": ["codec.ts"]`) since that's the one file `tsdown` actually builds -- anything else in this scope (a script's own top-level await, a config file's own type shape) would otherwise leak into what gets type-checked as part of the *build*. Everything else (`generate.ts`, `verify.test.ts`, `tsdown.config.ts`, `eslint.config.ts`) is covered by `tsconfig.node.json` instead, which extends `tsconfig.json`. `pnpm run typecheck` runs both.

Signature and public-key bytes throughout are clearly-synthetic filler (`aa`/`bb`/`ee`/`ff`-repeated hex), not real cryptographic material -- these vectors freeze the wire-exact envelope shape (map key ordering, field presence, the recursive delegation-chain nesting), not a working signature, the same scope Cascade's own frozen vectors commit to for fields with no real crypto behind them.

## Gotcha: `cbor2` doesn't recognise a Node `Buffer` as a byte string

Feeding a plain Node `Buffer` (rather than a plain `Uint8Array`) into `cbor2`'s `encode()` silently produces the wrong output: `Buffer` overrides `toJSON()`, and `cbor2`'s type dispatch falls through to a generic-object encoder that serialises it as a garbled `{ type: "Buffer", data: [...] }` CBOR map instead of a byte string, with no error raised. Confirmed directly while writing this generator -- caught only because the verifier's round-trip check failed with an unreadable diff. `toWire()` in `codec.ts` guards against this explicitly, converting every marker to a genuine `Uint8Array` via `Uint8Array.from(Buffer.from(hex, "hex"))` rather than passing a `Buffer` straight to `encode()`.

## Gotcha: `typescript` is pinned below 6.1, not left on latest

`typescript-eslint` (which `@exadev/eslint-config` depends on) does not yet support TypeScript 7 -- confirmed directly, `eslint` fails outright with "typescript-eslint does not support TS 7.0" against the latest `typescript` release. `typescript` is pinned to `6.0.3`, the newest release still inside `typescript-eslint`'s own `>=4.8.4 <6.1.0` peer range, rather than left on latest -- this is the documented-incompatibility exception the org's own dependency convention already carves out for exactly this situation. Bump it back to latest once [typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940) ships support for TS 7.
