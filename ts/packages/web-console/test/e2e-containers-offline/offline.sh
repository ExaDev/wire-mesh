#!/usr/bin/env bash
# Runs the offline scenario against each way a browser could be asked to reach the LAN node, and checks that only the one with a certificate the browser accepts carries a conversation. The other two are expected to fail today (an untrusted certificate cannot be clicked through on a WebSocket, and a plain ws:// address is blocked from an https page); when a route that removes either limit lands, its expectation here changes with it. Run from ts/packages/web-console after the node package has been built.
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
declare -A expected=(["wss untrusted"]=fails ["wss trusted"]=carries ["ws plain"]=fails)
status=0
for name in "${!expected[@]}"; do
  echo "RESULT $name: ${results[$name]} (expected ${expected[$name]})"
  [[ ${results[$name]} == "${expected[$name]}" ]] || status=1
done
exit $status
