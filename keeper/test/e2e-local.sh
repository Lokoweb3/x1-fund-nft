#!/usr/bin/env bash
# Local end-to-end test of the owner CLI (src/cli.ts) against a loopback
# solana-test-validator. Nothing here touches a public network except reads:
# account dumps, clones and `solana feature status` from X1 mainnet RPC.
#
#   cd keeper && bash test/e2e-local.sh
#
# Env:
#   E2E_SCRATCH   parent dir for the throwaway work dir (payer keys, ledger,
#                 logs). Default ${TMPDIR:-/tmp}. Never inside keys/.
#   E2E_FEATURES  x1 (default): Agave defaults minus every feature X1 mainnet
#                 reports inactive, except SIMD-0127 (same as tests/src/lib.rs).
#                 agave: Agave defaults.
#   E2E_KEEP=1    keep the work dir afterwards.
#
# The validator binds 127.0.0.1 only and uses ports 18989-19030, away from the
# Rust test's 18999/19000/19901 and its default dynamic range.
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

# Agave binaries are resolved once and are NOT added to PATH. Every call goes
# through the wrappers below, which run with HOME pointed at an empty dir
# inside $WORK, so no tool can fall back to ~/.config/solana or the user's
# default wallet.
SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-$HOME/.local/share/solana/install/active_release/bin}"
for b in solana solana-keygen spl-token solana-test-validator; do
  [ -x "$SOLANA_BIN_DIR/$b" ] || die "missing $SOLANA_BIN_DIR/$b"
done
command -v jq >/dev/null || die "jq is required"
command -v python3 >/dev/null || die "python3 is required"

MAINNET_RPC="https://rpc.mainnet.x1.xyz"
PROGRAM_ID="6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM"
XDEX="sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN"
USDC="B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq"
TEST_MINT="C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz"
POOL="7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD"
AMM="2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c"
OBS="6EV7aqfYx15yVPdBANkaEBdLpKUkyQrC6thUAy5CCi4y"
VAULT_0="E52PrH4XT4fTdPZMPXwtwigdQv9C2yQF8stm2EReUbHL"
VAULT_1="Hyvb75SAvMof44331mgAhpAT59jxP2DVe9fTFXXLUoRp"
AUTHORITY="9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU"
TOKENKEG="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
TOKEN_2022="TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
ATA_PROGRAM="ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
X1_SYSVAR_SYSCALL_EXCEPTION="CLCoTADvV64PSrnR6QXty6Fwrt9Xc6EdxSJE4wLRePjq"

SO="$REPO/target/deploy/fund_nft.so"
[ -f "$SO" ] || die "missing $SO; run: anchor build --ignore-keys --arch v0"

# Work dir: absolute, freshly created, and strictly under E2E_SCRATCH. No path
# is derived from WORK, and the cleanup trap is not installed, until this
# validation has passed.
SCRATCH="${E2E_SCRATCH:-${TMPDIR:-/tmp}}"
case "$SCRATCH" in /*) ;; *) die "E2E_SCRATCH must be an absolute path: $SCRATCH" ;; esac
mkdir -p -- "$SCRATCH" || die "cannot create $SCRATCH"
SCRATCH="$(cd -- "$SCRATCH" && pwd -P)" || die "cannot resolve $SCRATCH"
[ -n "$SCRATCH" ] && [ "$SCRATCH" != "/" ] || die "refusing scratch dir '$SCRATCH'"
case "$SCRATCH/" in "$REPO/keys/"*) die "refusing a scratch dir under keys/: $SCRATCH" ;; esac
WORK="$(mktemp -d -- "$SCRATCH/fund-cli-e2e.XXXXXX")" || die "mktemp failed under $SCRATCH"
[ -n "$WORK" ] || die "mktemp returned an empty path"
case "$WORK" in "$SCRATCH"/fund-cli-e2e.??????) ;; *) die "work dir $WORK is not under $SCRATCH" ;; esac
[ -d "$WORK" ] && [ ! -L "$WORK" ] || die "work dir $WORK is not a plain directory"
echo "work dir: $WORK"

VALIDATOR_PID=""
cleanup() {
  stop_validator
  if [ "${E2E_KEEP:-0}" = 1 ]; then
    echo "kept $WORK"
  else
    case "$WORK" in "$SCRATCH"/fund-cli-e2e.??????) rm -rf -- "$WORK" ;; esac
  fi
}
trap cleanup EXIT

SOL_HOME="$WORK/home"
CFG="$WORK/solana-cli.yml"
mkdir -- "$SOL_HOME" || die "cannot create $SOL_HOME"

# Wrappers. solana, spl-token and solana-test-validator die unless the call
# passes `-C "$CFG"`; all four run with HOME=$SOL_HOME.
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
spl-token() { require_cfg spl-token "$@"; sol_exec spl-token "$@"; }
# The validator is NOT a wrapper function run with `&`: then $! would be the
# backgrounded function's subshell and killing it would leave the real
# validator on the ports. start_validator checks -C "$CFG" like the other
# wrappers, then a dedicated background subshell `exec`s the real binary with
# the isolated HOME/XDG, so $! is the validator's own pid.
start_validator() {
  require_cfg solana-test-validator "$@"
  [ -z "$VALIDATOR_PID" ] || die "a validator is already running (pid $VALIDATOR_PID)"
  (HOME="$SOL_HOME" XDG_CONFIG_HOME="$SOL_HOME/.config" exec "$SOLANA_BIN_DIR/solana-test-validator" "$@") \
    </dev/null >"$WORK/validator.log" 2>&1 &
  VALIDATOR_PID=$!
}
# SIGTERM, wait up to 15 s (a zombie counts as gone), then SIGKILL; always reap.
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
# solana-keygen here only writes `-o $WORK/...` or reads a $WORK file by path.
solana-keygen() {
  case "$*" in *"$WORK"/*) ;; *) die "solana-keygen must name a file under \$WORK: $*" ;; esac
  sol_exec solana-keygen "$@"
}

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
RPC_PORT=""
for base in 18989 19039 19089; do
  ok=1
  for p in $(seq "$base" $((base + 41))); do port_free "$p" || { ok=0; break; }; done
  if [ "$ok" = 1 ]; then RPC_PORT=$base; break; fi
done
[ -n "$RPC_PORT" ] || die "no free 42-port block near 18989"
FAUCET_PORT=$((RPC_PORT + 2))
GOSSIP_PORT=$((RPC_PORT + 3))
DYN_LO=$((RPC_PORT + 4))
DYN_HI=$((RPC_PORT + 41))
URL="http://127.0.0.1:$RPC_PORT"
echo "validator: $URL (faucet $FAUCET_PORT, dynamic $DYN_LO-$DYN_HI)"

PAYER_KEY="$WORK/payer.json"
STRANGER_KEY="$WORK/stranger.json"
solana-keygen new --no-bip39-passphrase --silent --force -o "$PAYER_KEY" >/dev/null || die "keygen payer"
solana-keygen new --no-bip39-passphrase --silent --force -o "$STRANGER_KEY" >/dev/null || die "keygen stranger"
PAYER="$(solana-keygen pubkey "$PAYER_KEY")" || die "payer pubkey"
STRANGER="$(solana-keygen pubkey "$STRANGER_KEY")" || die "stranger pubkey"
[ -n "$PAYER" ] && [ -n "$STRANGER" ] || die "empty pubkeys"
# The config file is written before any other solana call so -C always names
# an existing file with a $WORK keypair.
solana -C "$CFG" config set --url "$URL" --keypair "$PAYER_KEY" >/dev/null || die "config"
[ -f "$CFG" ] || die "config file $CFG was not written"
echo "payer $PAYER, stranger $STRANGER"

# The quote mint the script controls: the cloned USDC.X with one labeled local
# change, mint authority := payer (as tests/src/lib.rs does). Its pool side
# matches the USDC.X/TEST pool, so the fund can pin TEST to that pool.
USDC_FILE="$WORK/usdc-mint.authority-overridden.json"
solana -C "$CFG" account "$USDC" --url "$MAINNET_RPC" --output json -o "$USDC_FILE" >/dev/null || die "dump USDC.X"
python3 -I - "$USDC_FILE" "$PAYER" <<'PY' || die "override mint authority"
import base64, json, sys
path, authority = sys.argv[1], sys.argv[2]
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in authority:
    n = n * 58 + ALPHABET.index(c)
key = n.to_bytes(32, "big")
doc = json.load(open(path))
data = bytearray(base64.b64decode(doc["account"]["data"][0]))
data[0:4] = (1).to_bytes(4, "little")
data[4:36] = key
doc["account"]["data"][0] = base64.b64encode(bytes(data)).decode()
json.dump(doc, open(path, "w"))
PY

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

CLONES=()
for a in "$POOL" "$AMM" "$OBS" "$VAULT_0" "$VAULT_1" "$TEST_MINT" "$AUTHORITY" "$ATA_PROGRAM"; do CLONES+=(--clone "$a"); done
# --mint names the faucet/mint pubkey explicitly, so the validator never
# derives it from a default keypair file.
start_validator -C "$CFG" --mint "$PAYER" --reset --quiet \
  --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" \
  --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYN_LO-$DYN_HI" \
  --ledger "$WORK/ledger" \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$TOKENKEG" --clone-upgradeable-program "$TOKEN_2022" \
  --clone-upgradeable-program "$XDEX" \
  --account "$USDC" "$USDC_FILE" \
  "${CLONES[@]}" "${FEATURE_ARGS[@]}"
[ -n "$VALIDATOR_PID" ] || die "validator did not start"

for _ in $(seq 1 240); do
  kill -0 "$VALIDATOR_PID" 2>/dev/null || { tail -40 "$WORK/validator.log"; die "validator exited"; }
  solana -C "$CFG" cluster-version >/dev/null 2>&1 && break
  sleep 0.5
done
solana -C "$CFG" cluster-version >/dev/null 2>&1 || { tail -40 "$WORK/validator.log"; die "validator not healthy"; }
echo "validator healthy"
# Nothing may have appeared under the sandbox HOME's .config/solana.
[ ! -e "$SOL_HOME/.config/solana/id.json" ] || die "a tool created a default wallet under $SOL_HOME"

solana -C "$CFG" airdrop 10 "$PAYER" >/dev/null || die "airdrop payer"
solana -C "$CFG" airdrop 2 "$STRANGER" >/dev/null || die "airdrop stranger"
spl-token -C "$CFG" create-account "$USDC" --owner "$PAYER" --fee-payer "$PAYER_KEY" >/dev/null || die "payer USDC ATA"
spl-token -C "$CFG" mint "$USDC" 5 --mint-authority "$PAYER_KEY" --fee-payer "$PAYER_KEY" >/dev/null || die "mint USDC"


cli() { (cd "$KEEPER" && RPC_URL="$URL" npx tsx src/cli.ts "$@"); }
OUT="$WORK/out.txt"

# Run "$@" with KEYPAIR=$1; expect success; tee output to $OUT.
run_ok() {
  local key="$1" name="$2"; shift 2
  if KEYPAIR="$key" cli "$@" >"$OUT" 2>&1; then pass "$name"; else fail "$name (exit $?)"; fi
  sed 's/^/    /' "$OUT"
}
run_fail() {
  local key="$1" name="$2" pattern="$3"; shift 3
  if KEYPAIR="$key" cli "$@" >"$OUT" 2>&1; then
    fail "$name: succeeded but must fail"
  elif grep -Eq "$pattern" "$OUT"; then
    pass "$name (failed with /$pattern/)"
  else
    fail "$name: failed without /$pattern/"
  fi
  sed 's/^/    /' "$OUT"
}
expect_out() { if grep -Eq "$2" "$OUT"; then pass "$1"; else fail "$1: no /$2/ in output"; fi; }

CREATE=(create-fund --quote "$USDC"
  --target "$USDC:default:2000" --target "$TEST_MINT:$POOL:8000"
  --per-run 100000 --interval 3600 --window 3600 --max-dev-bps 300)

echo; echo "== guards"
run_fail "$PAYER_KEY" "send without --cluster is refused" "requires --cluster" "${CREATE[@]}" --send
run_fail "$PAYER_KEY" "send with --cluster testnet on localnet is refused" "is localnet" "${CREATE[@]}" --send --cluster testnet
run_fail "" "send without KEYPAIR is refused" "needs KEYPAIR" "${CREATE[@]}" --send --cluster localnet
run_fail "$PAYER_KEY" "max-dev-bps 501 is refused client-side" "cannot exceed 500" \
  create-fund --quote "$USDC" --target "$USDC:default:10000" --per-run 1 --interval 60 --window 900 --max-dev-bps 501
run_fail "$PAYER_KEY" "pool not owned by --xdex is refused" "not XDEX" "${CREATE[@]}" --xdex "$TOKEN_2022"

echo; echo "== create-fund (simulate-only, then send)"
run_ok "" "create-fund simulate with --payer" "${CREATE[@]}" --payer "$PAYER"
expect_out "simulation printed compute units" "simulation: ok, [0-9]+ compute units"
expect_out "simulate-only sent nothing" "nothing was signed or sent"
run_ok "$PAYER_KEY" "create-fund --send" "${CREATE[@]}" --send --cluster localnet
FUND="$(sed -n 's/^fund PDA: *//p' "$OUT")"
NFT="$(sed -n 's/^NFT mint (generated in memory): *//p' "$OUT")"
[ -n "$FUND" ] && pass "fund PDA printed: $FUND" || fail "no fund PDA in output"
expect_out "create-fund confirmed both transactions" "tx 2/2 .*"
[ "$(grep -c 'sent and confirmed' "$OUT")" = 2 ] && pass "two confirmed signatures" || fail "expected two confirmations"

echo; echo "== ensure-vaults is idempotent on a complete fund"
for round in 1 2; do
  run_ok "$PAYER_KEY" "ensure-vaults round $round" ensure-vaults --fund "$FUND" --send --cluster localnet
  expect_out "round $round: all vaults exist, nothing sent" "all 2 vaults exist; nothing to do"
  if grep -q "sent and confirmed" "$OUT"; then fail "round $round sent a transaction"; else pass "round $round sent nothing"; fi
done

echo; echo "== ensure-vaults recovers a fund whose vault transaction never ran"
if (cd "$KEEPER" && KEYPAIR="$PAYER_KEY" RPC_URL="$URL" npx tsx test/e2e-bare-fund.ts \
      "$USDC" 2000 "$TEST_MINT" "$POOL" 8000) >"$OUT" 2>&1; then
  pass "bare create_fund (no vault ATAs)"
else
  fail "bare create_fund (exit $?)"
fi
sed 's/^/    /' "$OUT"
BARE="$(sed -n 's/^fund PDA: *//p' "$OUT")"
[ -n "$BARE" ] && pass "bare fund PDA: $BARE" || fail "no bare fund PDA"
run_ok "" "show bare fund: vaults missing" show --fund "$BARE"
[ "$(grep -c ' missing$' "$OUT")" = 2 ] && pass "bare fund has 2 missing vaults" || fail "bare fund vaults not missing"
run_ok "$PAYER_KEY" "ensure-vaults creates the missing vaults" ensure-vaults --fund "$BARE" --send --cluster localnet
expect_out "both vaults reported missing" "creating 2 missing vault\\(s\\)"
expect_out "vault transaction confirmed" "tx 1/1 \\(ensure vaults\\) sent and confirmed"
run_ok "$PAYER_KEY" "ensure-vaults again" ensure-vaults --fund "$BARE" --send --cluster localnet
expect_out "second run: nothing to do" "all 2 vaults exist; nothing to do"
run_ok "" "show bare fund after recovery" show --fund "$BARE"
expect_out "bare quote vault exists" "$USDC [1-9A-HJ-NP-Za-km-z]+ 0 \\(raw 0\\)"
expect_out "bare TEST vault exists" "$TEST_MINT [1-9A-HJ-NP-Za-km-z]+ 0 \\(raw 0\\)"

echo; echo "== deposit"
run_ok "" "deposit simulate-only" deposit --fund "$FUND" --amount 1000000 --payer "$PAYER"
run_ok "$PAYER_KEY" "deposit --send 1 USDC.X" deposit --fund "$FUND" --amount 1000000 --send --cluster localnet
expect_out "deposit summary in UI units" "amount +1 of $USDC \\(raw 1000000\\)"
expect_out "budget preview is labelled pre transfer-fee" "budget preview \\(pre transfer-fee, approximate\\)"

echo; echo "== show"
run_ok "" "show" show --fund "$FUND"
expect_out "cash budget 200000" "budget 0.2 quote \\(raw 200000\\)"
expect_out "TEST budget 800000" "budget 0.8 quote \\(raw 800000\\)"
expect_out "TEST target due now" "next due due now"
expect_out "quote vault holds 1 USDC.X" "$USDC [1-9A-HJ-NP-Za-km-z]+ 1 \\(raw 1000000\\)"
expect_out "TEST vault exists and is empty" "$TEST_MINT [1-9A-HJ-NP-Za-km-z]+ 0 \\(raw 0\\)"
expect_out "NFT holder is the payer" "NFT holder +$PAYER"

echo; echo "== keeper dry-run sees the due target (execute_dca is not run here)"
if (cd "$KEEPER" && env -u KEYPAIR RPC_URL="$URL" npx tsx src/index.ts --dry-run) >"$OUT" 2>&1; then
  pass "keeper --dry-run"
else
  fail "keeper --dry-run (exit $?)"
fi
sed 's/^/    /' "$OUT"
expect_out "keeper finds 1 due target (bare fund has no budget)" "2 fund accounts, 1 due targets"
expect_out "keeper targets the TEST vault" "\"targetIndex\": 1"

echo; echo "== withdraw"
run_ok "$PAYER_KEY" "withdraw 0.1 USDC.X --send" withdraw --fund "$FUND" --mint "$USDC" --amount 100000 --send --cluster localnet
run_ok "" "show after withdraw" show --fund "$FUND"
expect_out "cash budget 180000" "raw 180000\\)"
expect_out "TEST budget 720000" "raw 720000\\)"
expect_out "quote vault 0.9" "$USDC [1-9A-HJ-NP-Za-km-z]+ 0.9 \\(raw 900000\\)"
BAL="$(spl-token -C "$CFG" balance "$USDC" --owner "$PAYER")"
[ "$BAL" = "4.1" ] && pass "payer USDC.X balance 4.1" || fail "payer USDC.X balance $BAL, expected 4.1"

run_fail "$STRANGER_KEY" "non-holder withdraw is rejected by the program" "BadNft" \
  withdraw --fund "$FUND" --mint "$USDC" --amount 1 --send --cluster localnet
run_ok "" "show after rejected withdraw" show --fund "$FUND"
expect_out "quote vault unchanged at 0.9" "$USDC [1-9A-HJ-NP-Za-km-z]+ 0.9 \\(raw 900000\\)"

run_ok "$PAYER_KEY" "withdraw all USDC.X --send" withdraw --fund "$FUND" --mint "$USDC" --amount all --send --cluster localnet
run_ok "" "show after withdraw all" show --fund "$FUND"
expect_out "budget total 0" "budget total +0 quote \\(raw 0\\)"
expect_out "quote vault empty" "$USDC [1-9A-HJ-NP-Za-km-z]+ 0 \\(raw 0\\)"

echo
echo "e2e-local: $PASS passed, $FAIL failed (feature mode ${E2E_FEATURES:-x1}, NFT $NFT)"
[ "$FAIL" = 0 ]
