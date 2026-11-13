#!/usr/bin/env bash
# Checks every workspace member on its own. A whole-workspace build unifies features across members, so a member that relies on a sibling to switch on a dependency feature builds there and fails for any consumer that depends on it alone.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

members=$(cargo metadata --no-deps --format-version 1 --locked | python3 -c 'import json,sys; print("\n".join(sorted(p["name"] for p in json.load(sys.stdin)["packages"])))')

failed=0
run() {
  echo "== $*"
  if ! cargo check --locked "$@"; then
    echo "FAILED: cargo check $*"
    failed=1
  fi
}

for member in $members; do
  run -p "$member" --all-targets
  run -p "$member" --all-targets --no-default-features
done
run -p wire-mesh-threshold-wasm --target wasm32-unknown-unknown

exit "$failed"
