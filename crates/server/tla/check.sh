#!/bin/sh
# Model-checks DesignLeases.tla with TLC.
#
#   crates/server/tla/check.sh                 # the everyday check, about a minute
#   crates/server/tla/check.sh --full          # also Finding4 and AllFixes, a few minutes more
#   crates/server/tla/check.sh Fencing.cfg     # one config
#
# TLC is pinned to tla2tools.jar v1.7.4, downloaded once into ~/.cache/finite.
# It needs Java 11 or newer on PATH.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
version=1.7.4
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar="${XDG_CACHE_HOME:-$HOME/.cache}/finite/tla2tools-$version.jar"

if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar.part" \
    "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar"
  mv "$jar.part" "$jar"
fi
echo "$sha  $jar" | shasum -a 256 -c - >/dev/null || {
  echo "check.sh: $jar doesn't match the pinned SHA-256; delete it and rerun" >&2
  exit 2
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Each config with the result it gives on the code today: "pass", or a known
# finding as the invariant that breaks and the last step of TLC's shortest
# path to it (see .agents/skills/verify-design-leases/SKILL.md).
expected() {
  case "$1" in
    Fencing.cfg) echo pass ;;
    DesignLeases.cfg) echo "AckedEditsStay after SaveReleases (finding 1)" ;;
    Finding2.cfg) echo "AckedEditsStay after TickReleases (finding 2)" ;;
    Finding3.cfg) echo "AckedEditsStay after TickDrops (finding 3)" ;;
    Finding4.cfg) echo "AckedEditsStay after CallEdits (finding 4)" ;;
    AllFixes.cfg) echo pass ;;
    *) echo unknown ;;
  esac
}

# TLC options per config. Fencing.cfg lets a read and an edit load two
# copies, and its full state space is too big to finish in minutes, so it
# checks every behavior of up to 18 steps (iterative deepening, one worker).
options() {
  case "$1" in
    Fencing.cfg) echo "-workers 1 -dfid 18" ;;
    *) echo "-workers auto" ;;
  esac
}

everyday="Fencing.cfg DesignLeases.cfg Finding2.cfg Finding3.cfg"
case "${1:-}" in
  "") configs=$everyday ;;
  --full) configs="$everyday Finding4.cfg AllFixes.cfg" ;;
  *) configs=$* ;;
esac
status=0
for cfg in $configs; do
  out="$work/$cfg.out"
  ( cd "$here" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC $(options "$cfg") \
      -metadir "$work/states-$cfg" -config "$cfg" DesignLeases.tla ) >"$out" 2>&1 || true
  # With -dfid, TLC prints no "No error" line, only that it finished.
  if grep -q "^Model checking completed. No error has been found." "$out" ||
     { grep -q "^Finished in" "$out" && ! grep -q "^Error" "$out"; }; then
    got=pass
  elif broken=$(sed -n 's/^Error: Invariant \([A-Za-z]*\) is violated\.$/\1/p' "$out") && [ -n "$broken" ]; then
    last=$(sed -n 's/^State [0-9]*: <\([A-Za-z]*\) .*/\1/p' "$out" | tail -1)
    got="$broken${last:+ after $last}"   # -dfid paths don't name their steps
  else
    got=error
  fi
  want=$(expected "$cfg")
  states=$(sed -n 's/^\([0-9,]* states generated, [0-9,]* distinct states found\).*/\1/p' "$out" | tail -1)
  if [ "$got" = "$want" ] || [ "${want%% (*}" = "$got" ]; then
    got=$want
    echo "ok   $cfg: $got as expected ($states)"
  else
    echo "FAIL $cfg: expected $want, got $got ($states)"
    status=1
  fi
  if [ "$got" != pass ]; then
    cp "$out" "$here/$cfg.out"
    echo "     TLC output: crates/server/tla/$cfg.out"
  fi
done
exit $status
