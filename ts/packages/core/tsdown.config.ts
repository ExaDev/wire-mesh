import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

// Every real module gets its own build entry rather than a re-exporting index.ts -- the barrel-policy lint rule requires importing straight from the module that owns each export. src/generated/protocol.ts is committed, machine-generated output (see generate.ts); it's built here like any other module (real code that needs to compile and bundle correctly) but excluded from eslint's own strict authored-code rules (see eslint.config.ts's ignores) since rules like no-use-before-define don't make sense for its z.lazy()-wrapped mutually-recursive schemas.
//
// The entry list is derived from package.json's exports map rather than hand-kept alongside it. The exports map is the package's public surface and has to be written out explicitly anyway (npm resolves subpaths from it, and tsdown's own exports handling does not rewrite it), so a second, independent list of the same modules here was one more thing to forget: adding a module to one list and not the other leaves the exports map pointing at files no build produced, which CI's attw step only catches after a full build. Deriving here makes the exports map the single source of truth and turns drift into an immediate, loud failure at config-load time: an exports key with no corresponding src/<path>.ts throws below, before anything builds. Internal modules consumed only from within other modules (relay-channels, secure-channel, the threshold internals, and their siblings) simply have no exports-map key, and therefore no entry, exactly as before.

const packageDir = dirname(fileURLToPath(import.meta.url));
const parsed: unknown = JSON.parse(
  readFileSync(join(packageDir, "package.json"), "utf8"),
);
if (
  typeof parsed !== "object" ||
  parsed === null ||
  !("exports" in parsed) ||
  typeof parsed.exports !== "object" ||
  parsed.exports === null
) {
  throw new Error(
    "package.json has no exports map to derive build entries from",
  );
}
const exportsMap: Record<string, unknown> = parsed.exports;

const entry = Object.keys(exportsMap)
  .filter((exportedPath) => exportedPath !== "./package.json")
  .map((exportedPath) => {
    const source = `src/${exportedPath.slice(2)}.ts`;
    if (!existsSync(join(packageDir, source))) {
      throw new Error(
        `package.json exports "${exportedPath}" but no source file exists at ${source}: every exported subpath must be a real module`,
      );
    }
    return source;
  });

export default defineConfig({
  entry,
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
