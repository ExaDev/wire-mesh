#!/usr/bin/env bash
# Checks every workspace member on its own. A whole-workspace build unifies features across members, so a member that relies on a sibling to switch on a dependency feature builds there and fails for any consumer that depends on it alone.
#
# Members that target WebAssembly are found from `cargo metadata`, not named here: a member with a cdylib crate type or a wasm-bindgen dependency is checked on wasm32-unknown-unknown, and so is every workspace crate such a member depends on, as a library with no default features, which is how a wasm32 consumer of that crate builds it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

plan=$(cargo metadata --no-deps --format-version 1 --locked | python3 -c '
import json, sys
packages = json.load(sys.stdin)["packages"]
by_name = {p["name"]: p for p in packages}
wasm = {
    p["name"]
    for p in packages
    if any("cdylib" in t["crate_types"] for t in p["targets"])
    or any(d["name"] == "wasm-bindgen" for d in p["dependencies"])
}
needed = set()
stack = list(wasm)
while stack:
    for dep in by_name[stack.pop()]["dependencies"]:
        if dep["name"] in by_name and dep["name"] not in needed:
            needed.add(dep["name"])
            stack.append(dep["name"])
for name in sorted(by_name):
    print("member", name)
for name in sorted(wasm):
    print("wasm", name)
for name in sorted(needed):
    print("wasm-lib", name)
')

failed=0
run() {
  echo "== $*"
  if ! cargo check --locked "$@"; then
    echo "FAILED: cargo check $*"
    failed=1
  fi
}

while read -r kind name; do
  case "$kind" in
    member)
      run -p "$name" --all-targets
      run -p "$name" --all-targets --no-default-features
      ;;
    wasm) run -p "$name" --target wasm32-unknown-unknown ;;
    wasm-lib) run -p "$name" --lib --no-default-features --target wasm32-unknown-unknown ;;
  esac
done <<<"$plan"

exit "$failed"
