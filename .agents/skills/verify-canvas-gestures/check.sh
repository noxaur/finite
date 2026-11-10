#!/bin/bash
# Runs every row of model/expected.tsv through TLC and compares the result with what the row expects.
# Exits 0 when every row matches, 1 when a row differs (the output names it), 2 when TLC couldn't run.
# Needs Java 11 or later and tla2tools.jar (TLC 2.19). Uses only tools macOS ships with.
# Safe to run next to other checks: each run keeps its own copy of the model, state dir and Java tmp dir.
set -u
here=$(cd "$(dirname "$0")" && pwd)
jar=${TLA2TOOLS:-$HOME/.local/share/tlaplus/tla2tools.jar}
java=${JAVA:-${JAVA_HOME:+$JAVA_HOME/bin/java}}
java=${java:-java}

if ! major=$("$java" -version 2>&1 | sed -n '1s/.*"\([0-9][0-9]*\)[^0-9].*/\1/p') || [ -z "$major" ]; then
  echo "Java not found. Install it with: brew install openjdk (then put it on PATH, or set JAVA to its bin/java)."
  exit 2
fi
if [ "$major" -lt 11 ]; then
  echo "Java $major is too old; TLC 2.19 needs 11 or later. Install it with: brew install openjdk"
  exit 2
fi
if [ ! -f "$jar" ]; then
  echo "TLC not found at $jar. Install it with: curl -fL --create-dirs -o \"$jar\" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar"
  echo "Or set TLA2TOOLS to an existing tla2tools.jar (TLC 2.19)."
  exit 2
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/finite-tlc.XXXXXX") || { echo "Couldn't create a temp dir under ${TMPDIR:-/tmp}."; exit 2; }
cp "$here"/model/*.tla "$here"/model/*.cfg "$work"/
spec=$(sed -n '1p' "$here/model/spec.txt")
status=0
while IFS=$'\t' read -r variant kind rule expect || [ -n "$variant" ]; do
  case "$variant" in ''|\#*) continue ;; esac
  cfg="$work/run-$variant-$rule.cfg"
  { cat "$work/$variant.cfg"; printf '\n%s %s\n' "$kind" "$rule"; } > "$cfg"
  log="$work/$variant-$rule.out"
  # A tmp dir per run, because TLC unpacks the standard modules (Sequences, ...) into java.io.tmpdir.
  tmp="$work/tmp-$variant-$rule"
  mkdir -p "$tmp"
  (cd "$work" && "$java" -XX:+UseParallelGC -Djava.io.tmpdir="$tmp" -cp "$jar" tlc2.TLC -workers auto -metadir "$work/states-$variant-$rule" -config "$cfg" "$spec" > "$log" 2>&1)
  if grep -q "Model checking completed. No error has been found" "$log"; then got=holds
  elif grep -qE "is violated|Temporal properties were violated" "$log"; then got=breaks
  else got=error; fi
  if [ "$got" = "$expect" ]; then printf 'ok        %-22s %-34s %s\n' "$variant" "$rule" "$got"
  else
    printf 'MISMATCH  %-22s %-34s expected %s, got %s (%s)\n' "$variant" "$rule" "$expect" "$got" "$log"
    if [ "$got" = error ]; then [ "$status" = 1 ] || status=2; else status=1; fi
  fi
  rm -rf "$tmp" "$work/states-$variant-$rule"
done < "$here/model/expected.tsv"
if [ "$status" = 0 ]; then rm -rf "$work"; else echo "TLC output kept in $work"; fi
exit "$status"
