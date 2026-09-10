# Thin task dispatcher across the three implementation subtrees. Each recipe
# just cd's into its own subtree and calls that language's native tool --
# this file has no build-graph or caching logic of its own, and isn't meant
# to. rust/ and ts/ don't exist as code yet (only spec/ and conformance/ do),
# so their build/test/lint recipes stay no-ops until they do -- the point
# right now is that the dispatcher itself exists and matches what the
# README already describes, not that there's real work for those specific
# recipes to dispatch to yet. conformance/ owns its own build/test/lint via
# turbo (see conformance/turbo.json), so its recipes here just invoke that.

default:
    @just --list

# Build every subtree, if it exists.
build:
    cd conformance && pnpm turbo run _build
    @if [ -d rust ]; then cd rust && cargo build; else echo "rust/ does not exist yet"; fi
    @if [ -d ts ]; then cd ts && pnpm turbo run _build; else echo "ts/ does not exist yet"; fi

# Test every subtree, if it exists.
test:
    cd conformance && pnpm turbo run _test
    @if [ -d rust ]; then cd rust && cargo test; else echo "rust/ does not exist yet"; fi
    @if [ -d ts ]; then cd ts && pnpm turbo run _test; else echo "ts/ does not exist yet"; fi

# Lint every subtree, if it exists.
lint:
    cd conformance && pnpm turbo run _lint
    @if [ -d rust ]; then cd rust && cargo clippy --all-targets -- -D warnings && cargo fmt --check; else echo "rust/ does not exist yet"; fi
    @if [ -d ts ]; then cd ts && pnpm turbo run _lint; else echo "ts/ does not exist yet"; fi

# Regenerate spec/protocol.cddl and validate it against an RFC 8610 parser.
spec:
    cd spec && ./generate.sh
    cd spec && npx --yes cddl@0.21.1 validate protocol.cddl

# Regenerate conformance/'s golden vectors, typecheck, and verify every
# vector round-trips through cbor2. turbo owns the build/generate/test/
# typecheck task graph and caching within conformance/ itself; once rust/
# and ts/ exist, each implementation's own conformance-check additionally
# runs against these same vector files.
conformance:
    cd conformance && pnpm install
    cd conformance && pnpm turbo run _generate _test _typecheck _lint
    @if [ -d rust ]; then cd rust && cargo run --bin conformance-check; else echo "rust/ does not exist yet"; fi
    @if [ -d ts ]; then cd ts && pnpm conformance-check; else echo "ts/ does not exist yet"; fi
