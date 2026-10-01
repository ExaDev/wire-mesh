import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// Every real module gets its own build entry rather than a re-exporting index.ts -- the barrel-policy lint rule requires importing straight from the module that owns each export. src/generated/protocol.ts is committed, machine-generated output (see generate.ts); it's built here like any other module (real code that needs to compile and bundle correctly) but excluded from eslint's own strict authored-code rules (see eslint.config.ts's ignores) since rules like no-use-before-define don't make sense for its z.lazy()-wrapped mutually-recursive schemas.
//
// Entries are discovered by glob rather than listed, so adding a module to src/ needs no edit here: it is built, and tsdown generates its package.json exports entry (`exports: true` below rewrites the exports map from the entries, alphabetically sorted, on every build). The committed map is that output, and CI fails any change whose build leaves the working tree dirty, so an entry that was added, removed or moved without regenerating the map is caught on the pull request instead of at release time.
//
// The public surface is everything under src/ except the modules named here. These are internal: each is consumed only by other modules in this package, is bundled into the entries that use it, and is deliberately not a subpath consumers can import. Naming the private ones (rather than the public ones) makes public the default, which is what the barrel policy above already assumes, and turns a stale name into a config-load error below instead of a silent gap.
const INTERNAL_MODULES = [
  "src/adapters/memory-nonce-store.ts",
  "src/adapters/threshold-dkg.ts",
  "src/adapters/threshold-network-coordinator.ts",
  "src/adapters/threshold-participant.ts",
  "src/domain/own-version.ts",
  "src/domain/relay-channels.ts",
  "src/domain/relay-pairing.ts",
  "src/domain/secure-channel.ts",
  "src/domain/sharded-delivery.ts",
  "src/domain/threshold-network.ts",
  "src/domain/threshold-share-envelope.ts",
  "src/domain/threshold-share-wire.ts",
  "src/ports/nonce-store.ts",
];

const packageDir = dirname(fileURLToPath(import.meta.url));
for (const internal of INTERNAL_MODULES) {
  if (!existsSync(join(packageDir, internal))) {
    throw new Error(
      `INTERNAL_MODULES names ${internal}, but no such file exists: remove the stale entry`,
    );
  }
}

export default defineConfig({
  entry: ["src/**/*.ts", ...INTERNAL_MODULES.map((internal) => `!${internal}`)],
  format: ["esm", "cjs"],
  dts: true,
  exports: true,
  attw: { profile: "node16" },
  clean: true,
  // wasm-dist/wire_mesh_threshold_wasm.js (threshold-wasm.ts's own import) is wasm-bindgen's generated CommonJS glue, which loads its .wasm binary via a `${__dirname}/...` path at its OWN call site. Bundling would inline that line into dist/adapters/threshold-wasm.{mjs,cjs}, where __dirname resolves to dist/adapters/ instead of wasm-dist/ -- and for the ESM output specifically, rolldown's CJS-interop shim does not define __dirname at all, breaking the import outright (confirmed: `node --input-type=module` against the bundled .mjs throws "__dirname is not defined"). Keeping the import external instead means it is resolved at its own real, unbundled path at runtime, identical in both src/ (before build) and dist/ (after build) layouts since wasm-dist/ sits two directories up from both src/adapters/ and dist/adapters/ alike -- package.json's own "files" field ships wasm-dist/ alongside dist/ in the published tarball for exactly this reason.
  //
  // mesh-session.ts's own "../../package.json" import (OWN_VERSION) needs the identical treatment for a different reason: bundling would inline today's committed version string ("0.0.0" -- semantic-release/npm only rewrites package.json in the tarball it publishes, AFTER this package has already been built by CI), so every real release would report the wrong, stale version forever. Confirmed by inspecting the bundled output before adding this line: `var version = "0.0.0";` was baked directly into dist/domain/mesh-session.{mjs,cjs}. Kept external instead, this reads package.json fresh off disk (Node's own JSON-module loader for the ESM build, plain `require()`'s always-JSON-parsed reads for the CJS build) at actual runtime, against whichever package.json the published tarball -- or a bundler resolving this package's own node_modules copy for a browser consumer -- really carries.
  //
  // The wasm-dist pattern names the glue module itself and is anchored at the end of the id. neverBundle patterns are tested against absolute module ids, so an unanchored /\/wasm-dist\// would also match every module of a checkout whose own path merely contains a wasm-dist directory (a git worktree named wasm-dist, say): nothing would be bundled and the declaration build would fail with MISSING_EXPORT errors.
  deps: {
    neverBundle: [
      /\/wasm-dist\/wire_mesh_threshold_wasm\.js$/,
      /\/package\.json$/,
    ],
  },
});
