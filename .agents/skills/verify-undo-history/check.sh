#!/bin/bash
# Runs every row of model/expected.tsv through TLC and compares the result with what the row expects.
# Exits 0 when every row matches, 1 when a row differs (the output names it), 2 when TLC couldn't run.
set -u
here=$(cd "$(dirname "$0")" && pwd)
jar=${TLA2TOOLS:-$HOME/.local/share/tlaplus/tla2tools.jar}
java=${JAVA:-java}
[ -f "$jar" ] || { echo "TLC not found at $jar. Set TLA2TOOLS to tla2tools.jar (TLC 2.19)."; exit 2; }
work=$(mktemp -d "${TMPDIR:-/tmp}/finite-tlc.XXXXXX")
cp "$here"/model/*.tla "$here"/model/*.cfg "$work"/
spec=$(sed -n '1p' "$here/model/spec.txt")
status=0
while IFS=$'\t' read -r variant kind rule expect || [ -n "$variant" ]; do
  case "$variant" in ''|\#*) continue ;; esac
  cfg="$work/run-$variant-$rule.cfg"
  { cat "$work/$variant.cfg"; printf '\n%s %s\n' "$kind" "$rule"; } > "$cfg"
  log="$work/$variant-$rule.out"
  (cd "$work" && "$java" -XX:+UseParallelGC -Djava.io.tmpdir="$work" -cp "$jar" tlc2.TLC -workers auto -metadir "$work/states-$variant-$rule" -config "$cfg" "$spec" > "$log" 2>&1)
  if grep -q "Model checking completed. No error has been found" "$log"; then got=holds
  elif grep -qE "is violated|Temporal properties were violated" "$log"; then got=breaks
  else got=error; fi
  if [ "$got" = "$expect" ]; then printf 'ok        %-22s %-34s %s\n' "$variant" "$rule" "$got"
  else
    printf 'MISMATCH  %-22s %-34s expected %s, got %s (%s)\n' "$variant" "$rule" "$expect" "$got" "$log"
    if [ "$got" = error ]; then [ "$status" = 1 ] || status=2; else status=1; fi
  fi
done < "$here/model/expected.tsv"
[ "$status" = 0 ] && rm -rf "$work" || echo "TLC output kept in $work"
exit "$status"
