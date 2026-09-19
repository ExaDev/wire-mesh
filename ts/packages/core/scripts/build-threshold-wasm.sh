#!/usr/bin/env bash
# Builds wire-mesh-threshold-wasm (rust/crates/wire-mesh-threshold-wasm) for the wasm32-unknown-unknown target and runs wasm-bindgen's nodejs-target codegen over it, producing the module src/adapters/threshold-wasm.ts loads at runtime. Output goes to wasm-dist/ (gitignored, a genuine build artefact, never committed, matching this project's dist/ convention) rather than into src/generated/, which is reserved for the deterministic, no-native-toolchain-required TS codegen generate.ts already produces.
#
# Turbo runs this as the _build-wasm task (see turbo.json), which core's typecheck, lint, test and mutation tasks depend on, so `pnpm typecheck` or `pnpm lint` in a fresh checkout builds it on demand. It can also be run directly.
#
# Prerequisites, none of which this script installs: rustup with the wasm32-unknown-unknown target added to whichever toolchain `rustup run stable` resolves, and wasm-bindgen-cli on PATH at exactly the version rust/Cargo.lock pins for the wasm-bindgen crate (a mismatch fails the codegen step outright with an error naming both versions). The checks below name whichever of these is missing.
set -euo pipefail
cd "$(dirname "$0")/../../../.."  # repo root

RUST_DIR="rust"
CRATE="wire-mesh-threshold-wasm"
OUT_DIR="ts/packages/core/wasm-dist"

# The version the wasm-bindgen crate resolves to, which the CLI must match exactly. CI derives the same value from the same file to install the CLI.
WASM_BINDGEN_VERSION=$(grep -A1 '^name = "wasm-bindgen"$' "$RUST_DIR/Cargo.lock" | grep '^version' | head -1 | cut -d'"' -f2)

if ! command -v rustup >/dev/null 2>&1; then
  echo "::error::rustup not found on PATH. It is required to build $CRATE for wasm32-unknown-unknown; install it from https://rustup.rs/ and run this script again." >&2
  exit 1
fi
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "::error::wasm-bindgen (the CLI, not just the crate) not found on PATH. Install the version rust/Cargo.lock pins with: cargo install wasm-bindgen-cli --version $WASM_BINDGEN_VERSION --locked" >&2
  exit 1
fi
installed_version=$(wasm-bindgen --version | cut -d' ' -f2)
if [ "$installed_version" != "$WASM_BINDGEN_VERSION" ]; then
  echo "::error::wasm-bindgen CLI is $installed_version but rust/Cargo.lock pins $WASM_BINDGEN_VERSION. Install the matching version with: cargo install wasm-bindgen-cli --version $WASM_BINDGEN_VERSION --locked --force" >&2
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
