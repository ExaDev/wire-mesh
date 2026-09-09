#!/usr/bin/env bash
# Regenerates protocol.cddl by concatenating every other *.cddl file in this directory, in sorted order. Source files are discovered by glob, not a hand-maintained list -- adding a new one here is enough, nothing else needs updating. Order doesn't affect validity: CDDL resolves rule references and socket ($name) extensions regardless of which file appears first.
set -euo pipefail
cd "$(dirname "$0")"

shopt -s nullglob
sources=()
for f in *.cddl; do
  [[ "$f" == "protocol.cddl" ]] && continue
  sources+=("$f")
done
IFS=$'\n' sources=($(sort <<<"${sources[*]}")); unset IFS

cat "${sources[@]}" > protocol.cddl
echo "Regenerated protocol.cddl from ${#sources[@]} source files: ${sources[*]}"
