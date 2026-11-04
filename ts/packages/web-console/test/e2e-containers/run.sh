#!/usr/bin/env bash
# Runs the two-containers scenario: both browsers run to the end and each must pass. `docker compose up --exit-code-from` cannot do this, because it stops every other container the moment one exits and then reports the exit code of the one it stopped (143 for a browser that was still running), so whichever test finished second failed the run. INITIATOR_NETWORK and RESPONDER_NETWORK select the topology as compose.yaml describes. Run from ts/packages/web-console after the node package has been built.
set -u
cd "$(dirname "$0")" || exit 2
compose=(docker compose -f compose.yaml)
cleanup() { "${compose[@]}" down -v >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
# The hub and the certificate it waits for are started once, here: two `compose run` commands that each had to create them would race on the shared networks and containers and one would fail with a name conflict.
"${compose[@]}" up -d --wait hub || exit 2
pids=()
for role in responder initiator; do
  "${compose[@]}" run --rm -T "$role" &
  pids+=($!)
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
if [[ $status -ne 0 ]]; then
  echo "a browser failed; the hub's output was:"
  "${compose[@]}" logs --no-log-prefix hub
fi
exit $status
