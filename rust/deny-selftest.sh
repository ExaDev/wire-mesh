#!/usr/bin/env bash
# Proves the cargo-deny policy can fail: each scenario changes a throwaway copy of the workspace in one way and the named check must reject it with the named message, after the unmodified copy passes. Matching the message means a scenario passes only for the reason it exists, not because something else broke, so reverting the setting it covers makes it fail.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
manifest=$work/rust/crates/wire-mesh-wire/Cargo.toml

fresh_copy() {
  rm -rf "$work/rust"
  mkdir "$work/rust"
  tar --exclude=target -cf - . | tar -xf - -C "$work/rust"
}

add_dependency() {
  sed -i.bak "s|^\[dependencies\]\$|[dependencies]\n$1|" "$manifest"
}

# expect_reject <scenario> <cargo deny checks> <message the output must contain>
expect_reject() {
  (cd "$work/rust" && cargo metadata --format-version 1 >/dev/null)
  if (cd "$work/rust" && cargo deny check $2 >"$work/out" 2>&1); then
    echo "FAILED: cargo deny accepted: $1" >&2
    cat "$work/out" >&2
    exit 1
  fi
  if ! grep -q "$3" "$work/out"; then
    echo "FAILED: cargo deny rejected '$1' but not with '$3'" >&2
    cat "$work/out" >&2
    exit 1
  fi
  echo "rejected as expected: $1"
}

fresh_copy
(cd "$work/rust" && cargo metadata --format-version 1 >/dev/null && cargo deny check bans licenses sources >"$work/out" 2>&1) || {
  echo "FAILED: the unmodified workspace does not pass cargo deny" >&2
  cat "$work/out" >&2
  exit 1
}

fresh_copy
# serde_json already depends on itoa 1, so itoa 0.4 is a second version of an allowed crate.
add_dependency 'itoa-old = { package = "itoa", version = "0.4", default-features = false }'
expect_reject "a second version of an allowed crate" bans "duplicate"

fresh_copy
# A dependency that no default build includes: only a check over all features sees it.
printf '\n[features]\nextra = ["dep:fnv"]\n' >>"$manifest"
add_dependency 'fnv = { version = "1", optional = true, default-features = false }'
expect_reject "an unlisted crate behind a non-default feature" bans "not explicitly allowed"

fresh_copy
# serde_json is allowed, so only the wildcard version requirement can fail.
add_dependency 'serde_json = { version = "*", default-features = false }'
expect_reject "a wildcard version requirement on an allowed crate" bans "wildcard"

fresh_copy
add_dependency 'serde_json = { git = "https://github.com/serde-rs/json", default-features = false }'
expect_reject "a git source" sources "source-not-allowed"
