#!/bin/bash
# Runs every verify-*/check.sh, one after another, and prints pass or fail per model with its time.
# Exits 0 when every model passes, 1 when a row differs, 2 when TLC couldn't run.
# Each model's own output follows its summary line only when it fails; run its check.sh to see all rows.
set -u
here=$(cd "$(dirname "$0")" && pwd)
status=0
for script in "$here"/verify-*/check.sh; do
  name=$(basename "$(dirname "$script")")
  start=$(date +%s)
  out=$("$script" 2>&1)
  code=$?
  secs=$(( $(date +%s) - start ))
  if [ "$code" = 0 ]; then printf 'pass  %-24s %4ss\n' "$name" "$secs"
  else
    printf 'FAIL  %-24s %4ss (exit %s)\n' "$name" "$secs" "$code"
    printf '%s\n' "$out" | grep -v '^ok ' | sed 's/^/      /'
    [ "$status" = 2 ] || status=$code
  fi
done
exit "$status"
