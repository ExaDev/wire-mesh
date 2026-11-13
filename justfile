# Thin task dispatcher across the three implementation subtrees. Each recipe
# just cd's into its own subtree and calls that language's native tool --
# this file has no build-graph or caching logic of its own, and isn't meant
# to. conformance/ and ts/ each own their own build/test/lint via turbo (see
# their own turbo.json files), so their recipes here just invoke that; rust/
# owns its own via cargo (see rust/Cargo.toml).

default:
    @just --list

# Build every subtree, if it exists.
build:
    cd conformance && pnpm turbo run _build
    @if [ -d rust ]; then cd rust && cargo build; else echo "rust/ does not exist yet"; fi
    cd ts && pnpm turbo run _build

# Test every subtree, if it exists.
test:
    cd conformance && pnpm turbo run _test
    @if [ -d rust ]; then cd rust && cargo test; else echo "rust/ does not exist yet"; fi
    cd ts && pnpm turbo run _test

# Lint every subtree, if it exists.
lint:
    cd conformance && pnpm turbo run _lint
    @if [ -d rust ]; then cd rust && cargo clippy --all-targets -- -D warnings && cargo fmt --check; else echo "rust/ does not exist yet"; fi
    cd ts && pnpm turbo run _lint

# Check each rust/ workspace member on its own, with and without default features, plus the wasm crate for wasm32. A whole-workspace build unifies features across members and hides a member that relies on a sibling to enable one.
rust-members:
    cd rust && ./check-members.sh

# Check the rust/ crate allowlist, licences and sources. CI runs this same recipe.
rust-deny:
    cd rust && cargo deny check bans licenses sources

# Check rust/ advisories against the live advisory database. Kept apart from rust-deny because a newly published advisory changes its verdict with no change to the repository.
rust-advisories:
    cd rust && cargo deny check advisories

# Check that deny.toml and the workflows that enforce it say what is true.
rust-deny-policy:
    cd rust && ./check-deny-policy.py

# Prove the cargo-deny policy rejects a second version, a feature-gated crate, a wildcard requirement and a git source.
rust-deny-selftest:
    cd rust && ./deny-selftest.sh

# Typecheck ts/ (conformance/'s own typecheck already runs as part of `just conformance`;
# rust/ has none separate from `cargo build`/`cargo clippy`). CI's ts/ Verify job runs this
# between lint and build -- a type error caught only here, not by build or test, is exactly
# what this recipe exists to catch locally before pushing.
typecheck:
    cd ts && pnpm turbo run _typecheck

# Regenerate spec/protocol.cddl and validate it against an RFC 8610 parser.
spec:
    cd spec && ./generate.sh
    cd spec && npx --yes cddl@0.21.1 validate protocol.cddl

# Regenerate conformance/'s golden vectors, typecheck, and verify every
# vector round-trips through cbor2. turbo owns the build/generate/test/
# typecheck task graph and caching within conformance/ itself. Each
# implementation's own conformance-check additionally runs against these same
# vector files -- rust/'s once it exists, ts/'s (via @exadev/wire-mesh-core)
# already.
conformance:
    cd conformance && pnpm install
    cd conformance && pnpm turbo run _generate _test _typecheck _lint
    @if [ -d rust ]; then cd rust && cargo run --bin conformance-check; else echo "rust/ does not exist yet"; fi
    cd ts && pnpm install && pnpm conformance-check
