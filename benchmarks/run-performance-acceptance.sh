#!/usr/bin/env bash
set -euo pipefail

app_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mem_available_kib=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)

if [[ ! ${mem_available_kib:-} =~ ^[0-9]+$ ]] || (( mem_available_kib < 8388608 )); then
  echo "Performance acceptance requires MemAvailable >= 8388608 KiB; observed ${mem_available_kib:-unknown} KiB." >&2
  exit 1
fi

cd "$app_root"
exec flock -w 21600 /tmp/threadleaf-heavy-gate.lock -c \
  "exec env THREADLEAF_PERFORMANCE_HEAVY_GATE=primary node .bench-dist/performance-acceptance.cjs --require-heavy-gate"
