#!/usr/bin/env bash
# Runs the offline scenario against each way a browser could be asked to reach the LAN node, and prints which ones carry a conversation. Run from ts/packages/web-console after the node package has been built.
set -u
cd "$(dirname "$0")"
compose=(docker compose -f compose.yaml)
peers() { # phase, node address, trust
  local rc=0 pids=() role
  for role in responder initiator; do
    PEER_ROLE=$role PEER_PHASE=$1 NODE_ADDRESS=${2:-} TRUST_LAN_NODE=${3:-} "${compose[@]}" run --rm -T peer &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do wait "$pid" || rc=1; done
  return $rc
}
cleanup() { "${compose[@]}" down -v >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
"${compose[@]}" up -d --wait certs cloud lan-node lan-node-plain || exit 2
peers warm || { echo "warm phase failed"; exit 2; }
"${compose[@]}" stop cloud
declare -A results
for variant in "wss untrusted:wss://lan-node:8790:" "wss trusted:wss://lan-node:8790:spki" "ws plain:ws://lan-node-plain:8790:"; do
  name=${variant%%:*}; rest=${variant#*:}; trust=${rest##*:}; address=${rest%:*}
  if peers connect "$address" "$trust"; then results[$name]=carries; else results[$name]=fails; fi
done
for name in "${!results[@]}"; do echo "RESULT $name: ${results[$name]}"; done
