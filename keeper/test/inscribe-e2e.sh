#!/usr/bin/env bash
# Local end-to-end test of core/inscribe.ts against the X1 Inscriptions
# program cloned from X1 mainnet onto a loopback solana-test-validator.
# Nothing here touches a public network except reads: account clones and
# `solana feature status` from X1 mainnet RPC.
#
#   cd keeper && E2E_SCRATCH=/abs/scratch/dir bash test/inscribe-e2e.sh
#
# Env:
#   E2E_SCRATCH   REQUIRED absolute parent dir for the throwaway work dir
#                 (payer keys, ledger, logs). Never inside keys/.
#   E2E_FEATURES  x1 (default): Agave defaults minus every feature X1 mainnet
#                 reports inactive, except SIMD-0127 (as e2e-local.sh).
#                 agave: Agave defaults.
#   E2E_KEEP=1    keep the work dir afterwards.
#
# Same isolation as test/e2e-local.sh: own -C config, HOME pointed at an empty
# dir in the work dir, the validator exec'd so its pid is ours, and loopback
# ports. Ports start at 19139 so this can run beside e2e-local.sh.
set -uo pipefail

die() { echo "FATAL: $*" >&2; exit 2; }
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || die "cannot resolve the script dir"
KEEPER="$(cd "$HERE/.." && pwd -P)" || die "cannot resolve keeper/"
REPO="$(cd "$KEEPER/.." && pwd -P)" || die "cannot resolve the repo root"
[ -n "$HERE" ] && [ -n "$KEEPER" ] && [ -n "$REPO" ] || die "empty script paths"

SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-$HOME/.local/share/solana/install/active_release/bin}"
for b in solana solana-keygen solana-test-validator; do
  [ -x "$SOLANA_BIN_DIR/$b" ] || die "missing $SOLANA_BIN_DIR/$b"
done
command -v jq >/dev/null || die "jq is required"

MAINNET_RPC="https://rpc.mainnet.x1.xyz"
INS_PROGRAM="X1insUpfkQqtsuUJvwA8A3kbnixk3qtuexex1NDJWvN"
CORE="CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
INS_CONFIG="E33orhudcHnVwA46WejnDMXZ3HCdGQaf572r2oKcy3HP"
GENESIS_POOL="6z9rZwLdrvkpj1zmgXvgi3znvu1b8rZqH4vmXY6z3TUe"
INS_COLLECTION="8AoC9xrB7LchjfJmdUBxMcyCLjHjSQP8ZVnjDDQadDUy"
TREASURY="9TzfWeZRy2fjMaJ4o4msUjv8Q8VBL7qUqrDgbwnFxQ7b"
X1_SYSVAR_SYSCALL_EXCEPTION="CLCoTADvV64PSrnR6QXty6Fwrt9Xc6EdxSJE4wLRePjq"

# Work dir: E2E_SCRATCH must be given and absolute. WORK is a fresh mktemp
# dir strictly under it, validated before any path is derived from it or the
# cleanup trap is installed.
SCRATCH="${E2E_SCRATCH:-}"
[ -n "$SCRATCH" ] || die "E2E_SCRATCH is required (an absolute path)"
case "$SCRATCH" in /*) ;; *) die "E2E_SCRATCH must be an absolute path: $SCRATCH" ;; esac
mkdir -p -- "$SCRATCH" || die "cannot create $SCRATCH"
SCRATCH="$(cd -- "$SCRATCH" && pwd -P)" || die "cannot resolve $SCRATCH"
[ -n "$SCRATCH" ] && [ "$SCRATCH" != "/" ] || die "refusing scratch dir '$SCRATCH'"
case "$SCRATCH/" in "$REPO/keys/"*) die "refusing a scratch dir under keys/: $SCRATCH" ;; esac
WORK="$(mktemp -d -- "$SCRATCH/inscribe-e2e.XXXXXX")" || die "mktemp failed under $SCRATCH"
[ -n "$WORK" ] || die "mktemp returned an empty path"
case "$WORK" in "$SCRATCH"/inscribe-e2e.??????) ;; *) die "work dir $WORK is not under $SCRATCH" ;; esac
[ -d "$WORK" ] && [ ! -L "$WORK" ] || die "work dir $WORK is not a plain directory"
echo "work dir: $WORK"

VALIDATOR_PID=""
cleanup() {
  stop_validator
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "kept $WORK"
  else
    case "$WORK" in "$SCRATCH"/inscribe-e2e.??????) rm -rf -- "$WORK" ;; esac
  fi
}
trap cleanup EXIT

SOL_HOME="$WORK/home"
CFG="$WORK/solana-cli.yml"
mkdir -- "$SOL_HOME" || die "cannot create $SOL_HOME"

require_cfg() {
  local tool="$1"; shift
  local prev=""
  for a in "$@"; do
    if [ "$prev" = "-C" ]; then
      [ "$a" = "$CFG" ] && return 0
      die "$tool called with -C $a, not $CFG"
    fi
    prev="$a"
  done
  die "$tool called without -C \"\$CFG\": $tool $*"
}
sol_exec() {
  local bin="$1"; shift
  HOME="$SOL_HOME" XDG_CONFIG_HOME="$SOL_HOME/.config" "$SOLANA_BIN_DIR/$bin" "$@"
}
solana() { require_cfg solana "$@"; sol_exec solana "$@"; }
start_validator() {
  require_cfg solana-test-validator "$@"
  [ -z "$VALIDATOR_PID" ] || die "a validator is already running (pid $VALIDATOR_PID)"
  (HOME="$SOL_HOME" XDG_CONFIG_HOME="$SOL_HOME/.config" exec "$SOLANA_BIN_DIR/solana-test-validator" "$@") \
    </dev/null >"$WORK/validator.log" 2>&1 &
  VALIDATOR_PID=$!
}
stop_validator() {
  [ -n "$VALIDATOR_PID" ] || return 0
  kill -TERM "$VALIDATOR_PID" 2>/dev/null
  local state
  for _ in $(seq 1 150); do
    state="$(ps -o stat= -p "$VALIDATOR_PID" 2>/dev/null)" || break
    case "$state" in Z*|"") break ;; esac
    sleep 0.1
  done
  kill -KILL "$VALIDATOR_PID" 2>/dev/null
  wait "$VALIDATOR_PID" 2>/dev/null
  VALIDATOR_PID=""
}
solana-keygen() {
  case "$*" in *"$WORK"/*) ;; *) die "solana-keygen must name a file under \$WORK: $*" ;; esac
  sol_exec solana-keygen "$@"
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
RPC_PORT=""
for base in 19139 19189 19239; do
  ok=1
  for p in $(seq "$base" $((base + 41))); do port_free "$p" || { ok=0; break; }; done
  if [ "$ok" = 1 ]; then RPC_PORT=$base; break; fi
done
[ -n "$RPC_PORT" ] || die "no free 42-port block near 19139"
FAUCET_PORT=$((RPC_PORT + 2))
GOSSIP_PORT=$((RPC_PORT + 3))
DYN_LO=$((RPC_PORT + 4))
DYN_HI=$((RPC_PORT + 41))
URL="http://127.0.0.1:$RPC_PORT"
echo "validator: $URL (faucet $FAUCET_PORT, dynamic $DYN_LO-$DYN_HI)"

PAYER_KEY="$WORK/payer.json"
RIVAL_KEY="$WORK/rival.json"
solana-keygen new --no-bip39-passphrase --silent --force -o "$PAYER_KEY" >/dev/null || die "keygen payer"
solana-keygen new --no-bip39-passphrase --silent --force -o "$RIVAL_KEY" >/dev/null || die "keygen rival"
PAYER="$(solana-keygen pubkey "$PAYER_KEY")" || die "payer pubkey"
RIVAL="$(solana-keygen pubkey "$RIVAL_KEY")" || die "rival pubkey"
[ -n "$PAYER" ] && [ -n "$RIVAL" ] || die "empty pubkeys"
solana -C "$CFG" config set --url "$URL" --keypair "$PAYER_KEY" >/dev/null || die "config"
[ -f "$CFG" ] || die "config file $CFG was not written"
echo "payer $PAYER, rival $RIVAL"

FEATURE_ARGS=()
case "${E2E_FEATURES:-x1}" in
  x1)
    FEATURES_JSON="$WORK/x1-features.json"
    solana -C "$CFG" feature status --display-all --output json --url "$MAINNET_RPC" >"$FEATURES_JSON" ||
      die "could not read X1 feature status"
    mapfile -t INACTIVE < <(jq -r '.features[] | select(.status != "active") | .id' "$FEATURES_JSON")
    [ "${#INACTIVE[@]}" -gt 0 ] || die "could not read X1 feature status"
    for f in "${INACTIVE[@]}"; do
      [ "$f" = "$X1_SYSVAR_SYSCALL_EXCEPTION" ] || FEATURE_ARGS+=(--deactivate-feature "$f")
    done
    echo "feature mode x1: deactivating $(( ${#FEATURE_ARGS[@]} / 2 )) X1-inactive features (SIMD-0127 kept active)"
    ;;
  agave) echo "feature mode agave: Agave defaults" ;;
  *) die "E2E_FEATURES must be x1 or agave" ;;
esac

# The program, Core, and the three program accounts inscribe touches. The
# treasury is a plain system account; it is cloned so its balance is real.
start_validator -C "$CFG" --mint "$PAYER" --reset --quiet \
  --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" \
  --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYN_LO-$DYN_HI" \
  --ledger "$WORK/ledger" \
  --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$INS_PROGRAM" --clone-upgradeable-program "$CORE" \
  --clone "$INS_CONFIG" --clone "$GENESIS_POOL" --clone "$INS_COLLECTION" --clone "$TREASURY" \
  "${FEATURE_ARGS[@]}"
[ -n "$VALIDATOR_PID" ] || die "validator did not start"

for _ in $(seq 1 240); do
  kill -0 "$VALIDATOR_PID" 2>/dev/null || { tail -40 "$WORK/validator.log"; die "validator exited"; }
  solana -C "$CFG" cluster-version >/dev/null 2>&1 && break
  sleep 0.5
done
solana -C "$CFG" cluster-version >/dev/null 2>&1 || { tail -40 "$WORK/validator.log"; die "validator not healthy"; }
echo "validator healthy (pid $VALIDATOR_PID)"
[ ! -e "$SOL_HOME/.config/solana/id.json" ] || die "a tool created a default wallet under $SOL_HOME"

solana -C "$CFG" airdrop 5 "$RIVAL" >/dev/null || die "airdrop rival"

OUT="$WORK/driver.txt"
if (cd "$KEEPER" && RPC_URL="$URL" PAYER_KEY="$PAYER_KEY" RIVAL_KEY="$RIVAL_KEY" npx tsx test/inscribe-e2e.ts) >"$OUT" 2>&1; then
  pass "inscribe-e2e driver"
else
  fail "inscribe-e2e driver (exit $?)"
fi
sed 's/^/    /' "$OUT"
DRIVER_FAILS="$(grep -c '^FAIL:' "$OUT")"
DRIVER_PASSES="$(grep -c '^PASS:' "$OUT")"

stop_validator
# The validator we started must be gone; match on our own work dir so other
# validators on this machine (other worktrees) do not count.
if pgrep -f -- "$WORK/" >/dev/null; then
  fail "a process from $WORK is still running: $(pgrep -af -- "$WORK/")"
else
  pass "pgrep: no validator from this run is left"
fi
echo "pgrep -a solana-test-val (every validator on this machine, for the record):"
OTHERS="$(pgrep -a solana-test-val)"; if [ -n "$OTHERS" ]; then printf "%s\n" "$OTHERS" | sed "s/ --.*//; s/^/    /"; else echo "    (none)"; fi

echo
echo "inscribe-e2e: $PASS passed, $FAIL failed; driver checks: $DRIVER_PASSES passed, $DRIVER_FAILS failed (feature mode ${E2E_FEATURES:-x1})"
[ "$FAIL" = 0 ] && [ "$DRIVER_FAILS" = 0 ]
