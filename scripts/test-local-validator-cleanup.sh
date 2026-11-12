#!/usr/bin/env bash
# Checks that scripts/local-validator.sh never leaves a validator behind:
#   1. SIGTERM to the script after startup
#   2. SIGINT to the script after startup (delivered to the script only, which
#      is stricter than a terminal Ctrl-C to the whole process group)
#   3. a startup error right after the validator was launched
# After each: no process whose command line names this run's scratch dir, the
# RPC/faucet/gossip ports are free, and the work dir is gone.
#
#   LOCAL_SCRATCH=/abs/scratch scripts/test-local-validator-cleanup.sh [--port 18699]
set -uo pipefail

die() { echo "FATAL: $*" >&2; exit 2; }
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || die "cannot resolve the script dir"
SCRIPT="$HERE/local-validator.sh"
PORT=18699
[ "${1:-}" = "--port" ] && { PORT="${2:?--port needs a value}"; }
command -v pgrep >/dev/null || die "pgrep is required"

BASE="${LOCAL_SCRATCH:-}"
case "$BASE" in /*) ;; *) die "set LOCAL_SCRATCH to an absolute directory" ;; esac
mkdir -p -- "$BASE" || die "cannot create $BASE"
# A dedicated scratch dir, so pgrep only ever matches this test's validators.
T="$(mktemp -d -- "$BASE/validator-cleanup-test.XXXXXX")" || die "mktemp failed"
trap 'rm -rf -- "$T"' EXIT

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Run the script with default SIGINT/SIGTERM handling. A plain `&` job in a
# non-interactive shell starts with SIGINT ignored, which a trap cannot undo.
launch() {
  exec python3 -I -c 'import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGTERM, signal.SIG_DFL)
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
}

check_clean() {
  local name="$1"
  local left=""
  for _ in $(seq 1 50); do
    left="$(pgrep -f -- "$T/" || true)"
    [ -z "$left" ] && break
    sleep 0.2
  done
  if [ -z "$left" ]; then pass "$name: no validator process left"; else fail "$name: still running: pids ${left//$'\n'/ }"; fi
  local busy=""
  for p in "$PORT" $((PORT + 1)) $((PORT + 2)) $((PORT + 3)); do port_free "$p" || busy="$busy $p"; done
  if [ -z "$busy" ]; then pass "$name: ports $PORT-$((PORT + 3)) are free"; else fail "$name: ports still bound:$busy"; fi
  if compgen -G "$T/fund-local-validator.*" >/dev/null; then fail "$name: work dir left in $T"; else pass "$name: work dir removed"; fi
}

for sig in TERM INT; do
  LOG="$T/run-$sig.log"
  LOCAL_SCRATCH="$T" launch bash "$SCRIPT" --port "$PORT" >"$LOG" 2>&1 &
  PID=$!
  ready=0
  for _ in $(seq 1 480); do
    grep -q "Local validator is ready" "$LOG" && { ready=1; break; }
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  if [ "$ready" = 1 ]; then pass "SIG$sig: validator came up"; else fail "SIG$sig: validator never became ready"; tail -20 "$LOG"; fi
  VPID="$(pgrep -f -- "$T/fund-local-validator.*/ledger" | head -n1)"
  [ -n "$VPID" ] && pass "SIG$sig: real validator pid $VPID found" || fail "SIG$sig: no validator process found"
  kill "-$sig" "$PID"
  wait "$PID"
  echo "    script exit status $?"
  [ -n "$VPID" ] && ! kill -0 "$VPID" 2>/dev/null && pass "SIG$sig: pid $VPID is gone" || fail "SIG$sig: pid $VPID survived"
  check_clean "SIG$sig"
done

LOG="$T/run-die.log"
LOCAL_SCRATCH="$T" LOCAL_TEST_DIE_AFTER_LAUNCH=1 bash "$SCRIPT" --port "$PORT" >"$LOG" 2>&1
status=$?
if [ "$status" = 2 ] && grep -q "simulated startup error" "$LOG"; then pass "startup error: script failed as expected"; else fail "startup error: exit $status"; tail -20 "$LOG"; fi
check_clean "startup error"

echo
echo "validator cleanup: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
