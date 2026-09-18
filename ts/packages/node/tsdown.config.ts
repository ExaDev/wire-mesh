import { defineConfig } from "tsdown";

// Every real module gets its own build entry rather than a re-exporting index.ts -- the barrel-policy lint rule requires importing straight from the module that owns each export.
export default defineConfig({
  entry: ["src/adapters/node-websocket-transport.ts", "src/server.ts"],
  format: ["esm", "cjs"],
  dts: true,
  exports: true,
  attw: { profile: "node16" },
  clean: true,
  // web-console's built static output is copied into dist/web-console by scripts/copy-web-console-dist.mjs, run as a second step in package.json's own `_build` script — not tsdown's built-in `copy` option, whose flatten:false destination math (features/copy.ts's resolveCopyEntry) only strips the FIRST path segment of the source's cwd-relative path, mis-nesting a cross-package "../web-console/dist" source into "dist/web-console/web-console/dist" (confirmed directly: it is designed for a same-package glob like "assets/**", not a sibling package two directories up).
});
