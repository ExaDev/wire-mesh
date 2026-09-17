#!/usr/bin/env bash
# Builds wire-mesh-threshold-wasm (rust/crates/wire-mesh-threshold-wasm) for the wasm32-unknown-unknown target and runs wasm-bindgen's nodejs-target codegen over it, producing the module src/adapters/threshold-wasm.ts loads at runtime. Output goes to wasm-dist/ (gitignored, a genuine build artifact -- never committed, matching this project's dist/ convention) rather than into src/generated/, which is reserved for the deterministic, no-native-toolchain-required TS codegen generate.ts already produces.
#
# Prerequisites (not installed by this script): rustup with the wasm32-unknown-unknown target added to whichever toolchain `rustup run stable` resolves, and wasm-bindgen-cli on PATH at the exact version rust/crates/wire-mesh-threshold-wasm/Cargo.toml's wasm-bindgen dependency resolves to (a version mismatch between the crate and the CLI fails the codegen step outright with an explicit error naming both versions).
set -euo pipefail
cd "$(dirname "$0")/../../../.."  # repo root

RUST_DIR="rust"
CRATE="wire-mesh-threshold-wasm"
OUT_DIR="ts/packages/core/wasm-dist"

if ! command -v rustup >/dev/null 2>&1; then
  echo "::error::rustup not found on PATH -- required to build $CRATE for wasm32-unknown-unknown (see this script's own header comment)." >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "::error::wasm-bindgen (the CLI, not just the crate) not found on PATH -- install with 'cargo install wasm-bindgen-cli --version <matching the crate's own resolved version> --locked'." >&2
  exit 1
fi

rustup run stable rustc --print target-list >/dev/null 2>&1 || {
  echo "::error::rustup's 'stable' toolchain is not installed." >&2
  exit 1
}
rustup target add wasm32-unknown-unknown --toolchain stable

echo "Building $CRATE for wasm32-unknown-unknown (release)..."
(cd "$RUST_DIR" && rustup run stable cargo build -p "$CRATE" --target wasm32-unknown-unknown --release)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "Running wasm-bindgen codegen (nodejs target)..."
wasm-bindgen --target nodejs --out-dir "$OUT_DIR" \
  "$RUST_DIR/target/wasm32-unknown-unknown/release/wire_mesh_threshold_wasm.wasm"

# wasm-bindgen's nodejs target emits CommonJS (exports.foo = ..., require(...)), but this package's own package.json declares "type": "module" -- Node resolves a file's module format from the NEAREST ancestor package.json, so without this override wasm-dist/*.js would be parsed as ESM and fail on its own `exports.` assignments. A directory-scoped package.json is Node's own supported mechanism for exactly this boundary.
echo '{"type":"commonjs"}' > "$OUT_DIR/package.json"

echo "Built $OUT_DIR"
