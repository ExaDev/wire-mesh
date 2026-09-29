#!/usr/bin/env bash
# Runs the offline scenario against each way a browser could be asked to reach the LAN node, and checks which carry a conversation: a wss:// address whose certificate the browser accepts, and a WebTransport address that pins the certificate's hash. The other two are expected to fail (an untrusted certificate cannot be clicked through on a WebSocket, and a plain ws:// address is blocked from an https page); if a route that removes either limit lands, its expectation here changes with it. Run from ts/packages/web-console after the node package has been built.
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
"${compose[@]}" up -d --wait certs cloud lan-node lan-node-plain lan-node-wt || exit 2
peers warm || { echo "warm phase failed"; exit 2; }
"${compose[@]}" stop cloud
# The address the LAN node prints for WebTransport carries its own IP and the hash of the certificate it minted, so it is read from the node's output rather than known in advance.
pinned=""
for _ in $(seq 1 30); do
  pinned=$("${compose[@]}" logs --no-log-prefix lan-node-wt 2>/dev/null | grep -o 'https://[^ ]*#sha256=[0-9a-f]*' | head -n 1)
  [[ -n $pinned ]] && break
  sleep 1
done
[[ -n $pinned ]] || {
  echo "the LAN node printed no WebTransport address; its output was:"
  "${compose[@]}" logs --no-log-prefix lan-node-wt
  exit 2
}
declare -A results
for variant in "wss untrusted:wss://lan-node:8790:" "wss trusted:wss://lan-node:8790:spki" "ws plain:ws://lan-node-plain:8790:" "webtransport pinned:$pinned:"; do
  name=${variant%%:*}; rest=${variant#*:}; trust=${rest##*:}; address=${rest%:*}
  if peers connect "$address" "$trust"; then results[$name]=carries; else results[$name]=fails; fi
done
declare -A expected=(["wss untrusted"]=fails ["wss trusted"]=carries ["ws plain"]=fails ["webtransport pinned"]=carries)
status=0
for name in "${!expected[@]}"; do
  echo "RESULT $name: ${results[$name]} (expected ${expected[$name]})"
  [[ ${results[$name]} == "${expected[$name]}" ]] || status=1
done
exit $status
