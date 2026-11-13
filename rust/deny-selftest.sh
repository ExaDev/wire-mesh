#!/usr/bin/env bash
# Proves the allowlist can fail: each scenario adds one thing to a throwaway copy of the workspace and `cargo deny check bans` must reject it, after the unmodified copy passes. The scenarios are a second version of an allowed crate and a crate that exists only behind a non-default feature.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fresh_copy() {
  rm -rf "$work/rust"
  mkdir "$work/rust"
  tar --exclude=target -cf - . | tar -xf - -C "$work/rust"
}

expect_reject() {
  local scenario=$1
  (cd "$work/rust" && cargo metadata --format-version 1 >/dev/null)
  if (cd "$work/rust" && cargo deny check bans >"$work/out" 2>&1); then
    echo "FAILED: cargo deny accepted: $scenario" >&2
    cat "$work/out" >&2
    exit 1
  fi
  echo "rejected as expected: $scenario"
}

fresh_copy
(cd "$work/rust" && cargo metadata --format-version 1 >/dev/null && cargo deny check bans >"$work/out" 2>&1) || {
  echo "FAILED: the unmodified workspace does not pass cargo deny check bans" >&2
  cat "$work/out" >&2
  exit 1
}

fresh_copy
# serde_json already depends on itoa 1, so itoa 0.4 is a second version of an allowed crate.
sed -i.bak 's/^\[dependencies\]$/[dependencies]\nitoa-old = { package = "itoa", version = "0.4", default-features = false }/' "$work/rust/crates/wire-mesh-wire/Cargo.toml"
expect_reject "a second version of an allowed crate"

fresh_copy
# A dependency that no default build includes: only a check over all features sees it.
printf '\n[features]\nextra = ["dep:fnv"]\n' >>"$work/rust/crates/wire-mesh-wire/Cargo.toml"
sed -i.bak 's/^\[dependencies\]$/[dependencies]\nfnv = { version = "1", optional = true, default-features = false }/' "$work/rust/crates/wire-mesh-wire/Cargo.toml"
expect_reject "an unlisted crate behind a non-default feature"
