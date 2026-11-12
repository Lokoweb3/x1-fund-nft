#!/usr/bin/env bash
# Long-running LOCAL validator for trying the web app (app/) before the
# program is deployed. Loopback only. Nothing here touches a public network
# except reads: account dumps, program clones and `solana feature status` from
# X1 mainnet RPC.
#
# Start (runs until Ctrl-C; the work dir is deleted on exit):
#   LOCAL_SCRATCH=/abs/scratch/dir scripts/local-validator.sh [--port 8899] [--fund-wallet <pubkey>]...
#
# Fund a wallet on a validator this script already started:
#   LOCAL_SCRATCH=/abs/scratch/dir scripts/local-validator.sh --url http://127.0.0.1:8899 --fund-wallet <pubkey>
#
# --fund-wallet airdrops 10 XNT and mints 1000 local USDC.X to <pubkey> on the
# LOCAL validator only, so the owner can use their real browser wallet's
# address against the local chain. Any non-loopback URL, and any validator
# whose genesis hash is X1 mainnet or testnet, is refused.
#
# Same isolation as keeper/test/e2e-local.sh: every solana/spl-token call uses
# its own `-C` config in the work dir, HOME and XDG_CONFIG_HOME point at an
# empty dir inside it, the validator's --mint is a key generated there, and
# the work dir is a validated mktemp dir under the required absolute
# LOCAL_SCRATCH. The program is target/deploy/fund_nft.so at the canary ID.
#
# Env: LOCAL_SCRATCH (required, absolute), LOCAL_FEATURES x1 (default) | agave,
#      SOLANA_BIN_DIR (default ~/.local/share/solana/install/active_release/bin).
set -uo pipefail

die() { echo "FATAL: $*" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || die "cannot resolve the script dir"
REPO="$(cd "$HERE/.." && pwd -P)" || die "cannot resolve the repo root"
[ -n "$HERE" ] && [ -n "$REPO" ] || die "empty script paths"

PORT=8899
URL_ARG=""
FUND_WALLETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2 ;;
    --port=*) PORT="${1#--port=}"; shift ;;
    --url) [ $# -ge 2 ] || die "--url needs a value"; URL_ARG="$2"; shift 2 ;;
    --url=*) URL_ARG="${1#--url=}"; shift ;;
    --fund-wallet) [ $# -ge 2 ] || die "--fund-wallet needs a pubkey"; FUND_WALLETS+=("$2"); shift 2 ;;
    --fund-wallet=*) FUND_WALLETS+=("${1#--fund-wallet=}"); shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done
for pk in ${FUND_WALLETS[@]+"${FUND_WALLETS[@]}"}; do
  [[ "$pk" =~ ^[1-9A-HJ-NP-Za-km-z]{32,44}$ ]] || die "--fund-wallet $pk is not a base58 public key"
done

SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-$HOME/.local/share/solana/install/active_release/bin}"
for b in solana solana-keygen spl-token solana-test-validator; do
  [ -x "$SOLANA_BIN_DIR/$b" ] || die "missing $SOLANA_BIN_DIR/$b"
done
command -v jq >/dev/null || die "jq is required"
command -v python3 >/dev/null || die "python3 is required"

MAINNET_RPC="https://rpc.mainnet.x1.xyz"
X1_MAINNET_GENESIS="4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN"
X1_TESTNET_GENESIS="C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho"
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

# Scratch dir: required, absolute, resolved, never / or under keys/.
SCRATCH="${LOCAL_SCRATCH:-}"
[ -n "$SCRATCH" ] || die "set LOCAL_SCRATCH to an absolute directory for the throwaway work dir"
case "$SCRATCH" in /*) ;; *) die "LOCAL_SCRATCH must be an absolute path: $SCRATCH" ;; esac
mkdir -p -- "$SCRATCH" || die "cannot create $SCRATCH"
SCRATCH="$(cd -- "$SCRATCH" && pwd -P)" || die "cannot resolve $SCRATCH"
[ -n "$SCRATCH" ] && [ "$SCRATCH" != "/" ] || die "refusing scratch dir '$SCRATCH'"
case "$SCRATCH/" in "$REPO/keys/"*) die "refusing a scratch dir under keys/: $SCRATCH" ;; esac

# Only these hosts count as local. Anything else is refused outright.
is_loopback_url() {
  case "$1" in
    http://127.0.0.1:[0-9]*|http://localhost:[0-9]*|http://\[::1\]:[0-9]*) return 0 ;;
    *) return 1 ;;
  esac
}

# ---- tool wrappers (same contract as e2e-local.sh) -------------------------
# Set up once WORK is known. solana, spl-token and solana-test-validator die
# unless the call passes `-C "$CFG"`; all run with HOME=$SOL_HOME.
setup_wrappers() {
  SOL_HOME="$WORK/home"
  CFG="$WORK/solana-cli.yml"
  PAYER_KEY="$WORK/payer.json"
}
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
solana-test-validator() { require_cfg solana-test-validator "$@"; sol_exec solana-test-validator "$@"; }
solana-keygen() {
  case "$*" in *"$WORK"/*) ;; *) die "solana-keygen must name a file under \$WORK: $*" ;; esac
  sol_exec solana-keygen "$@"
}

# Refuse unless $URL is loopback AND its genesis hash is not X1 mainnet/testnet.
assert_local_chain() {
  is_loopback_url "$URL" || die "refusing $URL: not a loopback URL"
  local g
  g="$(solana -C "$CFG" genesis-hash --url "$URL")" || die "cannot read the genesis hash from $URL"
  case "$g" in
    "$X1_MAINNET_GENESIS"|"$X1_TESTNET_GENESIS") die "refusing $URL: genesis $g is X1 mainnet/testnet" ;;
  esac
}

fund_wallet() {
  local pk="$1"
  assert_local_chain
  echo "funding $pk on $URL (local validator only)"
  solana -C "$CFG" airdrop 10 "$pk" --url "$URL" >/dev/null || die "airdrop 10 XNT to $pk failed"
  spl-token -C "$CFG" create-account "$USDC" --owner "$pk" --fee-payer "$PAYER_KEY" --url "$URL" >/dev/null 2>&1 || true
  spl-token -C "$CFG" mint "$USDC" 1000 --recipient-owner "$pk" \
    --mint-authority "$PAYER_KEY" --fee-payer "$PAYER_KEY" --url "$URL" >/dev/null || die "mint 1000 USDC.X to $pk failed"
  echo "  +10 XNT, +1000 USDC.X ($USDC, local clone with a local mint authority)"
}

state_file() { echo "$SCRATCH/fund-local-validator-$1.state"; }

# ---- mode 1: fund a wallet on a validator this script started --------------
if [ -n "$URL_ARG" ]; then
  [ "${#FUND_WALLETS[@]}" -gt 0 ] || die "--url is only used with --fund-wallet"
  is_loopback_url "$URL_ARG" || die "refusing $URL_ARG: --fund-wallet only works on a loopback URL (http://127.0.0.1:<port>)"
  PORT_OF_URL="${URL_ARG##*:}"
  PORT_OF_URL="${PORT_OF_URL%%/*}"
  [[ "$PORT_OF_URL" =~ ^[0-9]+$ ]] || die "cannot read the port from $URL_ARG"
  STATE="$(state_file "$PORT_OF_URL")"
  [ -f "$STATE" ] || die "no validator started by this script on port $PORT_OF_URL under $SCRATCH ($STATE missing)"
  WORK="$(head -n1 -- "$STATE")"
  case "$WORK" in "$SCRATCH"/fund-local-validator.??????) ;; *) die "state file points outside $SCRATCH: $WORK" ;; esac
  [ -d "$WORK" ] && [ ! -L "$WORK" ] || die "work dir $WORK is gone"
  setup_wrappers
  [ -f "$CFG" ] && [ -f "$PAYER_KEY" ] || die "work dir $WORK is incomplete"
  URL="http://127.0.0.1:$PORT_OF_URL"
  for pk in "${FUND_WALLETS[@]}"; do fund_wallet "$pk"; done
  exit 0
fi

# ---- mode 2: start the validator --------------------------------------------
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65000 ] || die "--port must be 1024-65000"
SO="$REPO/target/deploy/fund_nft.so"
[ -f "$SO" ] || die "missing $SO; run: anchor build --ignore-keys --arch v0"

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in $(seq "$PORT" $((PORT + 41))); do
  port_free "$p" || die "port $p (in $PORT-$((PORT + 41))) is in use; pick another --port"
done
RPC_PORT="$PORT"
FAUCET_PORT=$((RPC_PORT + 2))
GOSSIP_PORT=$((RPC_PORT + 3))
DYN_LO=$((RPC_PORT + 4))
DYN_HI=$((RPC_PORT + 41))
URL="http://127.0.0.1:$RPC_PORT"

WORK="$(mktemp -d -- "$SCRATCH/fund-local-validator.XXXXXX")" || die "mktemp failed under $SCRATCH"
[ -n "$WORK" ] || die "mktemp returned an empty path"
case "$WORK" in "$SCRATCH"/fund-local-validator.??????) ;; *) die "work dir $WORK is not under $SCRATCH" ;; esac
[ -d "$WORK" ] && [ ! -L "$WORK" ] || die "work dir $WORK is not a plain directory"
setup_wrappers
STATE="$(state_file "$RPC_PORT")"

VALIDATOR_PID=""
cleanup() {
  if [ -n "$VALIDATOR_PID" ]; then kill "$VALIDATOR_PID" 2>/dev/null; wait "$VALIDATOR_PID" 2>/dev/null; fi
  [ -f "$STATE" ] && [ "$(head -n1 -- "$STATE" 2>/dev/null)" = "$WORK" ] && rm -f -- "$STATE"
  case "$WORK" in "$SCRATCH"/fund-local-validator.??????) rm -rf -- "$WORK" ;; esac
  echo "stopped; removed $WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -- "$SOL_HOME" || die "cannot create $SOL_HOME"
solana-keygen new --no-bip39-passphrase --silent --force -o "$PAYER_KEY" >/dev/null || die "keygen payer"
PAYER="$(solana-keygen pubkey "$PAYER_KEY")" || die "payer pubkey"
[ -n "$PAYER" ] || die "empty payer pubkey"
solana -C "$CFG" config set --url "$URL" --keypair "$PAYER_KEY" >/dev/null || die "config"
[ -f "$CFG" ] || die "config file $CFG was not written"
echo "work dir: $WORK"
echo "local mint authority / faucet mint: $PAYER (generated in the work dir)"

# USDC.X clone with one labeled local change: mint authority := the work-dir
# payer, so this script can mint local USDC.X. Same as e2e-local.sh.
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
case "${LOCAL_FEATURES:-x1}" in
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
  *) die "LOCAL_FEATURES must be x1 or agave" ;;
esac

CLONES=()
for a in "$POOL" "$AMM" "$OBS" "$VAULT_0" "$VAULT_1" "$TEST_MINT" "$AUTHORITY" "$ATA_PROGRAM"; do CLONES+=(--clone "$a"); done
solana-test-validator -C "$CFG" --mint "$PAYER" --reset --quiet \
  --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port "$FAUCET_PORT" \
  --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYN_LO-$DYN_HI" \
  --ledger "$WORK/ledger" \
  --bpf-program "$PROGRAM_ID" "$SO" \
  --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$TOKENKEG" --clone-upgradeable-program "$TOKEN_2022" \
  --clone-upgradeable-program "$XDEX" \
  --account "$USDC" "$USDC_FILE" \
  "${CLONES[@]}" "${FEATURE_ARGS[@]}" >"$WORK/validator.log" 2>&1 &
VALIDATOR_PID=$!

for _ in $(seq 1 240); do
  kill -0 "$VALIDATOR_PID" 2>/dev/null || { tail -40 "$WORK/validator.log"; die "validator exited"; }
  solana -C "$CFG" cluster-version >/dev/null 2>&1 && break
  sleep 0.5
done
solana -C "$CFG" cluster-version >/dev/null 2>&1 || { tail -40 "$WORK/validator.log"; die "validator not healthy"; }
[ ! -e "$SOL_HOME/.config/solana/id.json" ] || die "a tool created a default wallet under $SOL_HOME"
assert_local_chain
solana -C "$CFG" airdrop 10 "$PAYER" >/dev/null || die "airdrop payer"
printf '%s\n%s\n' "$WORK" "$URL" >"$STATE" || die "cannot write $STATE"

for pk in ${FUND_WALLETS[@]+"${FUND_WALLETS[@]}"}; do fund_wallet "$pk"; done

cat <<EOF

Local validator is ready (loopback only; feature mode ${LOCAL_FEATURES:-x1}).
  RPC URL:   $URL
  In the app: Network = "Local validator", Port = $RPC_PORT (or Custom URL = $URL), then Connect.
  Program:   $PROGRAM_ID (target/deploy/fund_nft.so)
  Quote:     USDC.X $USDC (local clone, local mint authority)
  Target:    TEST $TEST_MINT via pool $POOL (cloned from X1 mainnet)
Fund another wallet while this runs:
  LOCAL_SCRATCH='$SCRATCH' scripts/local-validator.sh --url $URL --fund-wallet <pubkey>
Ctrl-C stops the validator and deletes $WORK.
EOF

wait "$VALIDATOR_PID"
