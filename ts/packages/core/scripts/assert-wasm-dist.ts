#!/usr/bin/env node
// Refuses to pack this package unless wasm-dist actually holds the wasm-bindgen output.
//
// package.json's "files" lists wasm-dist, but it is a gitignored build artefact that only scripts/build-threshold-wasm.sh produces, and npm packs a listed directory that does not exist without complaint. That combination is how every release up to 1.58.3 shipped a tarball with nothing under wasm-dist while dist/adapters/threshold-wasm required out of it, leaving that export subpath unresolvable for anyone installing from the registry. The failure was invisible from inside the repository, where the directory is always present locally.
//
// This runs from prepack, so it covers `npm publish` and a bare `npm pack` alike, whatever builds the package beforehand. It deliberately only checks, never builds: producing these files needs a Rust toolchain and a version-matched wasm-bindgen CLI, and silently invoking that from a lifecycle script would be a far bigger surprise than a clear failure telling the caller which command to run.

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const wasmDist = join(packageRoot, "wasm-dist");

// The loader dist/adapters/threshold-wasm requires at runtime, and the binary that loader reads. Everything else wasm-bindgen emits is type declarations, which a consumer can live without; these two are what make the export subpath resolve and run at all.
const required = [
  "wire_mesh_threshold_wasm.js",
  "wire_mesh_threshold_wasm_bg.wasm",
];

const missing = required.filter((name) => !existsSync(join(wasmDist, name)));
const empty = required.filter(
  (name) =>
    !missing.includes(name) && statSync(join(wasmDist, name)).size === 0,
);

if (missing.length > 0 || empty.length > 0) {
  const problems = [
    ...missing.map((name) => `  missing: wasm-dist/${name}`),
    ...empty.map((name) => `  empty:   wasm-dist/${name}`),
  ].join("\n");
  console.error(
    [
      "Refusing to pack wire-mesh-core: its wasm-bindgen output is not built.",
      problems,
      "",
      'package.json lists "wasm-dist" in "files" and dist/adapters/threshold-wasm requires the loader above, so packing without it produces a tarball whose ./adapters/threshold-wasm export cannot resolve once installed.',
      "Run ./scripts/build-threshold-wasm.sh from this package first (it needs rustup with the wasm32-unknown-unknown target and a wasm-bindgen CLI matching the version rust/Cargo.lock pins).",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`wasm-dist is populated: ${required.join(", ")}`);
