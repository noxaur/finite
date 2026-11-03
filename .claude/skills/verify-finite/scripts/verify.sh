#!/usr/bin/env bash
# Launch, check, drive and stop one verification run of Finite.
# Each run is a separate e2e/headless.mjs session named verify-<run>, with its
# own server, port, data folder and Chrome. Evidence goes to .verify/<run>/ in
# this checkout and survives cleanup.
#
#   verify.sh launch [--no-build] [--at <git ref>] [--width <px> --height <px>]
#                                          start a run, print its id
#   verify.sh doctor <run>                 is this run worth driving?
#   verify.sh h <run> <headless args...>   any e2e/headless.mjs command
#   verify.sh save <run> <name> <headless args...>
#                                          run a command, keep its transcript
#   verify.sh shot <run> <name> [--selector <css>]
#                                          screenshot into the evidence folder
#   verify.sh bg <run> <name> <headless args...>
#                                          start a command in the background
#   verify.sh await <run> <name> [seconds] wait for a bg command, print its transcript
#   verify.sh cleanup <run>                stop the run, keep the evidence
#   verify.sh list                         runs from this checkout still running
#   verify.sh prune [days]                 delete evidence of stopped runs older than days (7)
set -euo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$root"

die() { echo "verify: $*" >&2; exit 1; }
need_run() { [[ -n "${1:-}" ]] || die "missing <run>; launch prints it"; [[ -d "$(evidence "$1")" ]] || die "no run $1 in .verify/"; }
evidence() { echo "$root/.verify/$1"; }
session() { echo "verify-$1"; }
# The checkout a run was built from: this one, or a worktree made by --at.
run_root() { cat "$(evidence "$1")/.root" 2>/dev/null || echo "$root"; }
headless() { local run="$1"; shift; node "$(run_root "$run")/e2e/headless.mjs" "$@" --session "$(session "$run")"; }
# Where e2e/headless.mjs keeps a session's files, as its sessionDir() computes it.
session_dir() { node -e 'const c=require("crypto"),o=require("os"),p=require("path");console.log(p.join(o.tmpdir(),"finite-headless",c.createHash("sha256").update(process.argv[1]).digest("hex").slice(0,10)+"-"+process.argv[2]))' "$1" "$2"; }

# A hash of the contents of everything the server, finite.wasm, the web app and
# the harness are built from, untracked files included. Two checkouts with the
# same hash build the same app.
inputs() {
  (cd "$1" && git ls-files -co --exclude-standard -z -- crates apps/web e2e/headless.mjs e2e/cdp.mjs \
    e2e/mcp.mjs Cargo.toml Cargo.lock package.json pnpm-lock.yaml pnpm-workspace.yaml \
    | python3 -c '
import hashlib, os, sys
h = hashlib.sha256()
for f in sorted(p for p in sys.stdin.buffer.read().split(b"\0") if p):
    h.update(f + b"\0")
    if os.path.isfile(f):
        h.update(open(f, "rb").read())
print(h.hexdigest()[:16])')
}
# The inputs hash of the last build launch made in a checkout.
built() { cat "$1/target/.verify-build" 2>/dev/null || true; }

find_chrome() {
  [[ -n "${FINITE_CHROME:-}" && -x "$FINITE_CHROME" ]] && { echo "$FINITE_CHROME"; return; }
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/microsoft-edge; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
  return 1
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  launch)
    build=1; at=""; start_flags=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --no-build) build=0; shift ;;
        --at) at="${2:-}"; [[ -n "$at" ]] || die "--at needs a git ref"; shift 2 ;;
        *) start_flags+=("$1"); shift ;;
      esac
    done
    run="$(date +%Y%m%d-%H%M%S)-$RANDOM"
    dir="$(evidence "$run")"
    mkdir -p "$dir"
    rr="$root"
    if [[ -n "$at" ]]; then
      rr="${TMPDIR:-/tmp}"; rr="${rr%/}/finite-verify-worktrees/$run"
      mkdir -p "$(dirname "$rr")"
      git worktree add --detach "$rr" "$at" > "$dir/worktree.log" 2>&1 \
        || { cat "$dir/worktree.log" >&2; rm -rf "$dir"; die "can't check out $at"; }
      echo "$rr" > "$dir/.root"
      echo "Checked out $at ($(git -C "$rr" rev-parse --short HEAD)) in $rr. Installing; a fresh checkout builds from scratch (about 3 minutes)."
      (cd "$rr" && vp install --frozen-lockfile) >> "$dir/worktree.log" 2>&1 \
        || { tail -20 "$dir/worktree.log" >&2; die "vp install failed in $rr; run cleanup $run"; }
      [[ -f "$rr/e2e/headless.mjs" ]] || die "$at has no e2e/headless.mjs to drive it with; run cleanup $run"
    fi
    want="$(inputs "$rr")"
    if [[ $build == 0 && "$(built "$rr")" != "$want" ]]; then
      rm -rf "$dir"
      die "the last builds don't match this checkout's code; launch without --no-build"
    fi
    flags=("${start_flags[@]+"${start_flags[@]}"}")
    [[ $build == 0 ]] && flags+=(--no-build)
    node "$rr/e2e/headless.mjs" start --session "$(session "$run")" "${flags[@]+"${flags[@]}"}" > "$dir/launch.log" 2>&1 \
      || { tail -30 "$dir/launch.log" >&2; die "start failed; see $dir/launch.log, then run cleanup $run"; }
    mkdir -p "$rr/target" && echo "$want" > "$rr/target/.verify-build"
    echo "$want" > "$dir/.fingerprint"
    [[ -n "$at" ]] && echo "$at" > "$dir/.ref"
    grep -E '^(Finite at|Data in|Session files)' "$dir/launch.log"
    echo "RUN=$run"
    echo "Evidence in $dir"
    ;;

  doctor)
    run="${1:-}"; need_run "$run"
    dir="$(evidence "$run")"; rr="$(run_root "$run")"
    state="$(headless "$run" state 2>/dev/null)" \
      || die "FAIL session $(session "$run") is not running. Run cleanup $run, then launch again."
    url="$(python3 -c 'import sys,json;print(json.load(sys.stdin)["server"])' <<<"$state")"
    data="$(python3 -c 'import sys,json;print(json.load(sys.stdin).get("dataDir") or "")' <<<"$state")"
    ok=1
    if [[ -f "$dir/.ref" ]]; then
      echo "note run of $(cat "$dir/.ref") ($(git -C "$rr" rev-parse --short HEAD)), checked out in $rr"
    fi
    [[ -n "$data" && "$data" == *finite-headless-data-* ]] \
      && echo "ok   data folder is this run's own: $data" \
      || { echo "FAIL session attached to someone else's server (no private data folder)"; ok=0; }
    health="$(curl -fsS "$url/api/health" 2>/dev/null || true)"
    want="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$rr/package.json")"
    if [[ "$health" == *'"ok"'* && "$health" == *"\"$want\""* ]]; then
      echo "ok   $url/api/health answers ok, version $want"
    else
      echo "FAIL $url/api/health: ${health:-no answer} (want version $want)"; ok=0
    fi
    if [[ "$(cat "$dir/.fingerprint" 2>/dev/null)" == "$(inputs "$rr")" ]]; then
      echo "ok   the running build matches the code in $rr"
    else
      echo "FAIL the code changed since this build: run cleanup $run, then launch again"; ok=0
    fi
    if chrome="$(find_chrome)"; then
      echo "ok   Chrome for get_screenshot: $chrome"
    else
      echo "FAIL no Chrome, Chromium or Edge for get_screenshot; set FINITE_CHROME"; ok=0
    fi
    page="$(headless "$run" eval 'location.href' 2>&1)" \
      && echo "ok   page answers: $page" || { echo "FAIL page: $page"; ok=0; }
    echo "--- console since last call"
    headless "$run" console || true
    [[ $ok == 1 ]] || exit 1
    ;;

  h)
    run="${1:-}"; need_run "$run"; shift
    headless "$run" "$@"
    ;;

  save)
    run="${1:-}"; need_run "$run"; name="${2:-}"; [[ -n "$name" ]] || die "missing <name>"; shift 2
    out="$(evidence "$run")/$name.txt"
    mkdir -p "$(dirname "$out")"
    set +e
    { echo "\$ node e2e/headless.mjs $*"; headless "$run" "$@" 2>&1; echo "[exit $?]"; } > "$out"
    set -e
    cat "$out"
    ;;

  shot)
    run="${1:-}"; need_run "$run"; name="${2:-}"; [[ -n "$name" ]] || die "missing <name>"; shift 2
    headless "$run" screenshot "$(evidence "$run")/$name.png" "$@"
    ;;

  bg)
    run="${1:-}"; need_run "$run"; name="${2:-}"; [[ -n "$name" ]] || die "missing <name>"; shift 2
    out="$(evidence "$run")/$name.txt"
    rm -f "$out" "$out.done"
    # The transcript fills when the command ends; .done marks that it has.
    ( { echo "\$ node e2e/headless.mjs $*"; headless "$run" "$@" 2>&1; echo "[exit $?]"; } > "$out.part"
      mv "$out.part" "$out"; touch "$out.done" ) > /dev/null 2>&1 &
    echo "Started $name in the background. Wait for it with: verify.sh await $run $name"
    ;;

  await)
    run="${1:-}"; need_run "$run"; name="${2:-}"; [[ -n "$name" ]] || die "missing <name>"
    limit="${3:-60}"
    out="$(evidence "$run")/$name.txt"
    for ((i = 0; i < limit * 5; i++)); do
      if [[ -f "$out.done" ]]; then rm -f "$out.done"; cat "$out"; exit 0; fi
      [[ -f "$out" || -f "$out.part" ]] || die "nothing named $name was started with bg"
      sleep 0.2
    done
    die "$name still running after ${limit}s"
    ;;

  cleanup)
    run="${1:-}"; need_run "$run"
    dir="$(evidence "$run")"; rr="$(run_root "$run")"; s="$(session "$run")"
    if headless "$run" status > /dev/null 2>&1; then headless "$run" stop; else echo "Not running."; fi
    sdir="$(session_dir "$rr" "$s")"
    [[ -f "$sdir/server.log" ]] && cp "$sdir/server.log" "$dir/server.log"
    if [[ -d "$sdir/shots" ]] && compgen -G "$sdir/shots/*" > /dev/null; then
      mkdir -p "$dir/tool-images"
      cp "$sdir/shots"/* "$dir/tool-images/"
    fi
    rm -rf "$sdir"
    if [[ "$rr" != "$root" ]]; then
      git worktree remove --force "$rr" && echo "Removed the checkout of $(cat "$dir/.ref" 2>/dev/null) at $rr"
      rm -f "$dir/.root"
    fi
    echo "Evidence kept in $dir"
    ls "$dir"
    ;;

  list)
    found=0
    for dir in "$root"/.verify/*/; do
      [[ -d "$dir" ]] || continue
      run="$(basename "$dir")"
      if headless "$run" status > /dev/null 2>&1; then
        echo "running: $run  (clean up with: verify.sh cleanup $run)"; found=1
      elif [[ -f "$dir/.root" ]]; then
        echo "stopped, checkout left behind: $run  (clean up with: verify.sh cleanup $run)"; found=1
      fi
    done
    [[ $found == 1 ]] || echo "No runs from this checkout are running."
    ;;

  prune)
    days="${1:-7}"
    [[ -d "$root/.verify" ]] || { echo "Nothing to prune."; exit 0; }
    while IFS= read -r dir; do
      run="$(basename "$dir")"
      if headless "$run" status > /dev/null 2>&1 || [[ -f "$dir/.root" ]]; then
        echo "kept $run: not cleaned up yet"
      else
        rm -rf "$dir" && echo "deleted $run"
      fi
    done < <(find "$root/.verify" -mindepth 1 -maxdepth 1 -type d -mtime "+$days")
    ;;

  *)
    sed -n 2,20p "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
