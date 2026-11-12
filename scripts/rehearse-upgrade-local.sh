#!/usr/bin/env bash
# Local rehearsal of the mainnet upgrade that adds withdraw_native.
#
# The live mainnet program is the acb6953 build (403,520 bytes, sha256
# d7606fcf...). Funds on mainnet were created by it. This script loads that
# exact artifact as an UPGRADEABLE program at the real program id on a
# loopback solana-test-validator (upgrade authority: a key generated here),
# uses it to create a fund, deposit, run execute_dca and attach metadata,
# sends XNT to the fund PDA, then upgrades exactly as the owner would
# (scripts/upgrade-withdraw-native.sh check / apply in UPGRADE_TARGET=local
# mode, plus the manual extend it must not repeat), covers what a third party
# can do to ProgramData (anyone can extend it on X1 mainnet), and checks that the
# PRE-EXISTING fund works under the new program: show, withdraw-native part
# and all, a token withdraw, another execute_dca, and, after the NFT moves to
# a second wallet, the old holder refused and the new holder allowed.
#
#   REHEARSE_SCRATCH=/abs/scratch/dir scripts/rehearse-upgrade-local.sh
#
# Nothing here touches a public network except reads: account dumps, program
# clones and `solana feature status` from X1 mainnet RPC.
#
# Env:
#   REHEARSE_SCRATCH  required, absolute. Parent of the throwaway work dir.
#   OLD_SO            optional: path to the acb6953 build. Default: build it
#                     from `git archive acb6953` inside the work dir (~2 min).
#                     Either way its sha256 must be OLD_SHA.
#   NEW_SO            default target/deploy/fund_nft.so (anchor build
#                     --ignore-keys --arch v0 on this branch). Its sha256 is
#                     printed; set EXPECT_NEW_SHA to also assert it.
#   REHEARSE_KEEP=1   keep the work dir.
#   REHEARSE_PORT_BASES  space-separated 42-port block starts to try
#                     (default "19200 19250 19300").
#
# Isolation: the same rules as keeper/test/e2e-local.sh. Every solana /
# spl-token call names `-C $CFG` and runs with HOME and XDG_CONFIG_HOME inside
# the work dir; every key is generated there. The validator binds 127.0.0.1 on
# a 42-port block from 19200 (or 19250, 19300), away from the e2e's
# 18989-19030 and the Rust test's 18999/19000/19901, and is killed on exit.
# The script refuses to continue if the RPC's genesis hash is X1 mainnet's or
# testnet's.
#
# At the end a second, short-lived validator on the same ports runs with
# SIMD-0431 (minimum extend) ACTIVE, to rehearse the upgrade script's
# minimum-extend path. Nothing is cloned for it.
#
# One case overwrites target/deploy/fund_nft.so for a moment (to show that the
# upgrade script deploys its private copy, not that path). The file is put
# back straight after, and again by the exit trap.
set -uo pipefail

die() { echo "FATAL: $*" >&2; exit 2; }
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" || die "cannot resolve the script dir"
REPO="$(cd "$HERE/.." && pwd -P)" || die "cannot resolve the repo root"
KEEPER="$REPO/keeper"
[ -n "$HERE" ] && [ -n "$REPO" ] && [ -d "$KEEPER" ] || die "bad script paths"

SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-$HOME/.local/share/solana/install/active_release/bin}"
for b in solana solana-keygen spl-token solana-test-validator; do
  [ -x "$SOLANA_BIN_DIR/$b" ] || die "missing $SOLANA_BIN_DIR/$b"
done
for t in jq python3 sha256sum git; do command -v "$t" >/dev/null || die "$t is required"; done
ANCHOR_BIN="${ANCHOR_BIN:-$HOME/.avm/bin/anchor-1.2.2}"

MAINNET_RPC="https://rpc.mainnet.x1.xyz"
X1_MAINNET_GENESIS="4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN"
X1_TESTNET_GENESIS="C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho"
PROGRAM_ID="6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM"
OLD_COMMIT="acb6953"
OLD_SHA="d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47"
OLD_LEN=403520
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
METAPLEX="metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
X1_SYSVAR_SYSCALL_EXCEPTION="CLCoTADvV64PSrnR6QXty6Fwrt9Xc6EdxSJE4wLRePjq"

NEW_SO="${NEW_SO:-$REPO/target/deploy/fund_nft.so}"
[ -f "$NEW_SO" ] || die "missing $NEW_SO; run: anchor-1.2.2 build --ignore-keys --arch v0"

# ---- work dir (validated before anything derives a path from it) ----
SCRATCH="${REHEARSE_SCRATCH:-}"
[ -n "$SCRATCH" ] || die "set REHEARSE_SCRATCH to an absolute scratch dir"
case "$SCRATCH" in /*) ;; *) die "REHEARSE_SCRATCH must be an absolute path: $SCRATCH" ;; esac
mkdir -p -- "$SCRATCH" || die "cannot create $SCRATCH"
SCRATCH="$(cd -- "$SCRATCH" && pwd -P)" || die "cannot resolve $SCRATCH"
[ -n "$SCRATCH" ] && [ "$SCRATCH" != "/" ] || die "refusing scratch dir '$SCRATCH'"
case "$SCRATCH/" in "$REPO/keys/"*|"$REPO/state/"*) die "refusing a scratch dir under keys/ or state/: $SCRATCH" ;; esac
WORK="$(mktemp -d -- "$SCRATCH/fund-upgrade-rehearsal.XXXXXX")" || die "mktemp failed under $SCRATCH"
case "$WORK" in "$SCRATCH"/fund-upgrade-rehearsal.??????) ;; *) die "work dir $WORK is not under $SCRATCH" ;; esac
[ -d "$WORK" ] && [ ! -L "$WORK" ] || die "work dir $WORK is not a plain directory"
echo "work dir: $WORK"

VALIDATOR_PID=""
ARTIFACT_BACKUP=""
ARTIFACT_PATH=""
restore_artifact() {
  [ -n "$ARTIFACT_BACKUP" ] && [ -f "$ARTIFACT_BACKUP" ] || return 0
  cp -- "$ARTIFACT_BACKUP" "$ARTIFACT_PATH" || echo "WARNING: could not restore $ARTIFACT_PATH from $ARTIFACT_BACKUP" >&2
}
cleanup() {
  stop_validator
  restore_artifact
  if [ "${REHEARSE_KEEP:-0}" = 1 ]; then
    echo "kept $WORK"
  else
    case "$WORK" in "$SCRATCH"/fund-upgrade-rehearsal.??????) rm -rf -- "$WORK" ;; esac
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
spl-token() { require_cfg spl-token "$@"; sol_exec spl-token "$@"; }
solana-keygen() {
  case "$*" in *"$WORK"/*) ;; *) die "solana-keygen must name a file under \$WORK: $*" ;; esac
  sol_exec solana-keygen "$@"
}
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
sha() { sha256sum "$1" | awk '{print $1}'; }

# ---- artifacts ----
echo; echo "== artifacts"
if [ -n "${OLD_SO:-}" ]; then
  [ -f "$OLD_SO" ] || die "OLD_SO $OLD_SO is not a file"
else
  echo "building $OLD_COMMIT (git archive into the work dir; no checkout is touched)"
  [ -x "$ANCHOR_BIN" ] || die "missing $ANCHOR_BIN"
  mkdir -- "$WORK/old-src" || die "mkdir old-src"
  git -C "$REPO" archive "$OLD_COMMIT" programs tests Cargo.toml Cargo.lock Anchor.toml rust-toolchain.toml |
    tar -x -C "$WORK/old-src" || die "git archive $OLD_COMMIT"
  (cd "$WORK/old-src" && PATH="$SOLANA_BIN_DIR:$PATH" "$ANCHOR_BIN" build --ignore-keys --arch v0) \
    >"$WORK/old-build.log" 2>&1 || { tail -20 "$WORK/old-build.log"; die "old build failed"; }
  OLD_SO="$WORK/old-src/target/deploy/fund_nft.so"
fi
[ "$(sha "$OLD_SO")" = "$OLD_SHA" ] && pass "old artifact is the mainnet build: sha256 $OLD_SHA" ||
  die "old artifact sha256 $(sha "$OLD_SO") != mainnet $OLD_SHA"
[ "$(stat -c %s "$OLD_SO")" = "$OLD_LEN" ] || die "old artifact is $(stat -c %s "$OLD_SO") bytes, not $OLD_LEN"
NEW_SHA="$(sha "$NEW_SO")"
NEW_LEN="$(stat -c %s "$NEW_SO")"
echo "new artifact: $NEW_SO, $NEW_LEN bytes, sha256 $NEW_SHA"
if [ -n "${EXPECT_NEW_SHA:-}" ]; then
  [ "$NEW_SHA" = "$EXPECT_NEW_SHA" ] && pass "new artifact sha256 matches EXPECT_NEW_SHA" ||
    fail "new artifact sha256 $NEW_SHA != EXPECT_NEW_SHA $EXPECT_NEW_SHA"
fi
python3 -I - "$NEW_SO" <<'PY' && pass "new artifact is SBPF v0 and does not import sol_get_sysvar" || fail "new artifact e_flags/sol_get_sysvar check"
import struct, sys
d = open(sys.argv[1], "rb").read()
sys.exit(0 if struct.unpack("<I", d[0x30:0x34])[0] == 0 and b"sol_get_sysvar\0" not in d else 1)
PY

# ---- ports, keys, config ----
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
RPC_PORT=""
for base in ${REHEARSE_PORT_BASES:-19200 19250 19300}; do
  ok=1
  for p in $(seq "$base" $((base + 41))); do port_free "$p" || { ok=0; break; }; done
  if [ "$ok" = 1 ]; then RPC_PORT=$base; break; fi
done
[ -n "$RPC_PORT" ] || die "no free 42-port block at ${REHEARSE_PORT_BASES:-19200 19250 19300}"
URL="http://127.0.0.1:$RPC_PORT"
echo "validator: $URL"

PAYER_KEY="$WORK/payer.json"       # fund creator, first NFT holder
AUTH_KEY="$WORK/upgrade-auth.json" # upgrade authority (the owner's DEPLOYER on mainnet)
HOLDER2_KEY="$WORK/holder2.json"   # receives the NFT at the end
SECOND_KEY="$WORK/second-program.json" # a second instance for the auto-extend check
THIRD_KEY="$WORK/third-program.json"   # a third instance for the upgrade script's extend path
FOURTH_KEY="$WORK/fourth-program.json" # unknown code of the old size: must be refused
FIFTH_KEY="$WORK/fifth-program.json"     # a third party extends by 1 byte before check/apply
SIXTH_KEY="$WORK/sixth-program.json"     # a third party extends past the new length before apply
SEVENTH_KEY="$WORK/seventh-program.json" # old build + a non-zero byte in the tail: must be refused
EIGHTH_KEY="$WORK/eighth-program.json"   # new build + a non-zero byte in the tail: must be refused
NINTH_KEY="$WORK/ninth-program.json"     # the artifact is swapped after it was verified
SIMD_KEY="$WORK/simd-program.json"       # second validator, SIMD-0431 active
for k in "$PAYER_KEY" "$AUTH_KEY" "$HOLDER2_KEY" "$SECOND_KEY" "$THIRD_KEY" "$FOURTH_KEY" \
         "$FIFTH_KEY" "$SIXTH_KEY" "$SEVENTH_KEY" "$EIGHTH_KEY" "$NINTH_KEY" "$SIMD_KEY"; do
  solana-keygen new --no-bip39-passphrase --silent --force -o "$k" >/dev/null || die "keygen $k"
done
PAYER="$(solana-keygen pubkey "$PAYER_KEY")"
AUTH="$(solana-keygen pubkey "$AUTH_KEY")"
HOLDER2="$(solana-keygen pubkey "$HOLDER2_KEY")"
SECOND_ID="$(solana-keygen pubkey "$SECOND_KEY")"
THIRD_ID="$(solana-keygen pubkey "$THIRD_KEY")"
FOURTH_ID="$(solana-keygen pubkey "$FOURTH_KEY")"
FIFTH_ID="$(solana-keygen pubkey "$FIFTH_KEY")"
SIXTH_ID="$(solana-keygen pubkey "$SIXTH_KEY")"
SEVENTH_ID="$(solana-keygen pubkey "$SEVENTH_KEY")"
EIGHTH_ID="$(solana-keygen pubkey "$EIGHTH_KEY")"
NINTH_ID="$(solana-keygen pubkey "$NINTH_KEY")"
SIMD_ID="$(solana-keygen pubkey "$SIMD_KEY")"
# Same size as the mainnet build, one byte different (an error-message string).
TAMPERED_SO="$WORK/tampered-old.so"
python3 -I - "$OLD_SO" "$TAMPERED_SO" <<'PY' || die "make tampered .so"
import sys
d = open(sys.argv[1], "rb").read()
needle = b"Arithmetic overflow"
assert d.count(needle) >= 1
open(sys.argv[2], "wb").write(d.replace(needle, b"Arithmetic overfloW", 1))
PY
[ "$(stat -c %s "$TAMPERED_SO")" = "$OLD_LEN" ] && [ "$(sha "$TAMPERED_SO")" != "$OLD_SHA" ] || die "tampered .so is not same-size different-hash"
[ -n "$PAYER" ] && [ -n "$AUTH" ] && [ -n "$HOLDER2" ] && [ -n "$SECOND_ID" ] && [ -n "$THIRD_ID" ] || die "empty pubkeys"
[ -n "$FIFTH_ID" ] && [ -n "$SIXTH_ID" ] && [ -n "$SEVENTH_ID" ] && [ -n "$EIGHTH_ID" ] && [ -n "$NINTH_ID" ] && [ -n "$SIMD_ID" ] ||
  die "empty pubkeys"
# Payloads no extend or deploy can produce, loaded as ProgramData directly:
#   old build, zero padding up to the new length, but the last byte is 1;
#   new build followed by a zero byte and a 1.
# And the new build with one byte changed (same size): the "swapped" artifact.
OLD_BADTAIL_SO="$WORK/old-nonzero-tail.so"
NEW_BADTAIL_SO="$WORK/new-nonzero-tail.so"
SWAPPED_SO="$WORK/swapped-new.so"
python3 -I - "$OLD_SO" "$NEW_SO" "$OLD_BADTAIL_SO" "$NEW_BADTAIL_SO" "$SWAPPED_SO" <<'PY' || die "make crafted payloads"
import sys
old = open(sys.argv[1], "rb").read()
new = open(sys.argv[2], "rb").read()
assert len(new) > len(old)
open(sys.argv[3], "wb").write(old + b"\0" * (len(new) - len(old) - 1) + b"\1")
open(sys.argv[4], "wb").write(new + b"\0\1")
needle = b"Arithmetic overflow"
assert new.count(needle) >= 1
open(sys.argv[5], "wb").write(new.replace(needle, b"Arithmetic overfloW", 1))
PY
[ "$(stat -c %s "$OLD_BADTAIL_SO")" = "$NEW_LEN" ] && [ "$(stat -c %s "$NEW_BADTAIL_SO")" = "$((NEW_LEN + 2))" ] || die "crafted payload sizes"
[ "$(stat -c %s "$SWAPPED_SO")" = "$NEW_LEN" ] && [ "$(sha "$SWAPPED_SO")" != "$NEW_SHA" ] || die "swapped .so is not same-size different-hash"
solana -C "$CFG" config set --url "$URL" --keypair "$PAYER_KEY" >/dev/null || die "config"
echo "payer $PAYER, upgrade authority $AUTH, second holder $HOLDER2, second program $SECOND_ID"

USDC_FILE="$WORK/usdc-mint.authority-overridden.json"
solana -C "$CFG" account "$USDC" --url "$MAINNET_RPC" --output json -o "$USDC_FILE" >/dev/null || die "dump USDC.X"
python3 -I - "$USDC_FILE" "$PAYER" <<'PY' || die "override mint authority"
import base64, json, sys
path, authority = sys.argv[1], sys.argv[2]
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in authority:
    n = n * 58 + ALPHABET.index(c)
doc = json.load(open(path))
data = bytearray(base64.b64decode(doc["account"]["data"][0]))
data[0:4] = (1).to_bytes(4, "little")
data[4:36] = n.to_bytes(32, "big")
doc["account"]["data"][0] = base64.b64encode(bytes(data)).decode()
json.dump(doc, open(path, "w"))
PY

FEATURES_JSON="$WORK/x1-features.json"
solana -C "$CFG" feature status --display-all --output json --url "$MAINNET_RPC" >"$FEATURES_JSON" ||
  die "could not read X1 feature status"
mapfile -t INACTIVE < <(jq -r '.features[] | select(.status != "active") | .id' "$FEATURES_JSON")
[ "${#INACTIVE[@]}" -gt 0 ] || die "could not read X1 feature status"
FEATURE_ARGS=()
for f in "${INACTIVE[@]}"; do
  [ "$f" = "$X1_SYSVAR_SYSCALL_EXCEPTION" ] || FEATURE_ARGS+=(--deactivate-feature "$f")
done
echo "feature mode x1: deactivating $(( ${#FEATURE_ARGS[@]} / 2 )) X1-inactive features (SIMD-0127 kept active)"

CLONES=()
for a in "$POOL" "$AMM" "$OBS" "$VAULT_0" "$VAULT_1" "$TEST_MINT" "$AUTHORITY" "$ATA_PROGRAM"; do CLONES+=(--clone "$a"); done
# The OLD program at the real id, upgradeable, authority = the local AUTH key.
# A second instance at a random id (never invoked) checks deploy's auto-extend.
start_validator -C "$CFG" --mint "$PAYER" --reset --quiet \
  --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 2)) \
  --gossip-port $((RPC_PORT + 3)) --dynamic-port-range "$((RPC_PORT + 4))-$((RPC_PORT + 41))" \
  --ledger "$WORK/ledger" \
  --upgradeable-program "$PROGRAM_ID" "$OLD_SO" "$AUTH" \
  --upgradeable-program "$SECOND_ID" "$OLD_SO" "$AUTH" \
  --upgradeable-program "$THIRD_ID" "$OLD_SO" "$AUTH" \
  --upgradeable-program "$FOURTH_ID" "$TAMPERED_SO" "$AUTH" \
  --upgradeable-program "$FIFTH_ID" "$OLD_SO" "$AUTH" \
  --upgradeable-program "$SIXTH_ID" "$OLD_SO" "$AUTH" \
  --upgradeable-program "$SEVENTH_ID" "$OLD_BADTAIL_SO" "$AUTH" \
  --upgradeable-program "$EIGHTH_ID" "$NEW_BADTAIL_SO" "$AUTH" \
  --upgradeable-program "$NINTH_ID" "$OLD_SO" "$AUTH" \
  --url "$MAINNET_RPC" \
  --clone-upgradeable-program "$TOKENKEG" --clone-upgradeable-program "$TOKEN_2022" \
  --clone-upgradeable-program "$XDEX" --clone-upgradeable-program "$METAPLEX" \
  --account "$USDC" "$USDC_FILE" \
  "${CLONES[@]}" "${FEATURE_ARGS[@]}"
# Wait for the validator just started, and refuse a public genesis.
wait_validator() {
  [ -n "$VALIDATOR_PID" ] || die "validator did not start"
  for _ in $(seq 1 240); do
    kill -0 "$VALIDATOR_PID" 2>/dev/null || { tail -40 "$WORK/validator.log"; die "validator exited"; }
    solana -C "$CFG" cluster-version >/dev/null 2>&1 && break
    sleep 0.5
  done
  solana -C "$CFG" cluster-version >/dev/null 2>&1 || { tail -40 "$WORK/validator.log"; die "validator not healthy"; }
  GENESIS="$(solana -C "$CFG" genesis-hash)" || die "genesis-hash"
  case "$GENESIS" in
    "$X1_MAINNET_GENESIS"|"$X1_TESTNET_GENESIS") die "RPC $URL has X1 mainnet/testnet genesis $GENESIS; refusing" ;;
  esac
  echo "validator healthy, local genesis $GENESIS"
}
wait_validator
[ ! -e "$SOL_HOME/.config/solana/id.json" ] || die "a tool created a default wallet under $SOL_HOME"

solana -C "$CFG" airdrop 20 "$PAYER" >/dev/null || die "airdrop payer"
solana -C "$CFG" airdrop 10 "$AUTH" >/dev/null || die "airdrop authority"
solana -C "$CFG" airdrop 2 "$HOLDER2" >/dev/null || die "airdrop holder2"
spl-token -C "$CFG" create-account "$USDC" --owner "$PAYER" --fee-payer "$PAYER_KEY" >/dev/null || die "payer USDC ATA"
spl-token -C "$CFG" mint "$USDC" 5 --mint-authority "$PAYER_KEY" --fee-payer "$PAYER_KEY" >/dev/null || die "mint USDC"

cli() { (cd "$KEEPER" && RPC_URL="$URL" npx tsx src/cli.ts "$@"); }
OUT="$WORK/out.txt"
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
keeper_run() {
  local name="$1"
  if (cd "$KEEPER" && KEYPAIR="$PAYER_KEY" RPC_URL="$URL" npx tsx src/index.ts --cluster localnet) >"$OUT" 2>&1; then
    pass "$name"
  else
    fail "$name (exit $?)"
  fi
  sed 's/^/    /' "$OUT"
}
lamports_of() { solana -C "$CFG" balance "$1" --lamports | awk '{print $1}'; }
account_sha() { solana -C "$CFG" account "$1" --output json | jq -r '.account.data[0]' | base64 -d | sha256sum | awk '{print $1}'; }
programdata_len() {
  solana -C "$CFG" program show "$1" --output json | jq -r '.dataLen'
}
programdata_addr() {
  solana -C "$CFG" program show "$1" --output json | jq -r '.programdataAddress'
}
rent_at() { solana -C "$CFG" rent "$1" --lamports | awk '/Rent-exempt minimum/ {print $3}'; }
# sha256 of the first $2 bytes of the on-chain payload of program $1, and
# whether everything after them is zero ("<sha> zero-tail" / "<sha> dirty-tail").
onchain_prefix() {
  solana -C "$CFG" program dump "$1" "$WORK/prefix-dump.so" >/dev/null 2>&1 || { echo "dump-failed"; return 0; }
  python3 -I - "$WORK/prefix-dump.so" "$2" <<'PY'
import hashlib, sys
d = open(sys.argv[1], "rb").read()
n = int(sys.argv[2])
print(hashlib.sha256(d[:n]).hexdigest(), "dirty-tail" if any(d[n:]) else "zero-tail")
PY
}
# Anyone can extend ProgramData on X1 mainnet. Here "anyone" is the second
# holder's key, which is not the upgrade authority. The loader refuses two
# extends or an extend and a deploy in one slot, so wait a moment after.
third_party_extend() {
  local id="$1" bytes="$2" name="$3" before
  before="$(programdata_len "$id")"
  if solana -C "$CFG" program extend "$id" "$bytes" --keypair "$HOLDER2_KEY" >"$OUT" 2>&1 &&
     [ "$(programdata_len "$id")" = "$((before + bytes))" ]; then
    pass "$name: a key that is not the upgrade authority extended ProgramData by $bytes ($before -> $((before + bytes)))"
  else
    fail "$name: third-party extend by $bytes"
    sed 's/^/    /' "$OUT"
  fi
  sleep 2
}

# ---- the TWAP window: the cloned observation ring decides what is legal ----
# Smallest window the program's freshness/span rules accept now and 15 min
# later, with and without a fresh observation written by the first swap.
solana -C "$CFG" account "$OBS" --output json -o "$WORK/obs.json" >/dev/null || die "dump observation"
WINDOW="$(python3 -I - "$WORK/obs.json" "$(date +%s)" <<'PY'
import base64, json, sys
data = base64.b64decode(json.load(open(sys.argv[1]))["account"]["data"][0])
now = int(sys.argv[2])
index = int.from_bytes(data[9:11], "little")
ring = data[43:43 + 4000]
ts = [int.from_bytes(ring[i * 40:i * 40 + 8], "little") for i in range(100)]
def ok(stamps, newest_i, at, w):
    newest = stamps[newest_i]
    if newest == 0 or newest > at or at - newest > w:
        return False
    cutoff = at - w
    others = [t for i, t in enumerate(stamps) if i != newest_i and t != 0]
    if not others:
        return False
    older_c = [t for t in others if t <= cutoff]
    older = max(older_c) if older_c else min(others)
    dt = newest - older
    return dt > 0 and dt >= w // 2 and dt <= 2 * w
for w in (3600, 7200, 14400, 21600, 43200, 86400):
    fresh = list(ts)
    nxt = (index + 1) % 100
    fresh[nxt] = now + 900
    if ok(ts, index, now, w) and ok(ts, index, now + 900, w) and ok(fresh, nxt, now + 900, w):
        print(w)
        break
PY
)"
[ -n "$WINDOW" ] || die "no TWAP window fits the cloned observation history; rerun later"
echo "TWAP window: $WINDOW s"

# ================= OLD program =================
echo; echo "== old program at $PROGRAM_ID"
solana -C "$CFG" program show "$PROGRAM_ID" >"$OUT" 2>&1 && pass "program show (old)" || fail "program show (old)"
sed 's/^/    /' "$OUT"
grep -Eq "Authority: *$AUTH" "$OUT" && pass "upgrade authority is the local key" || fail "upgrade authority is not $AUTH"
OLD_DATA_LEN="$(programdata_len "$PROGRAM_ID")"
[ "$OLD_DATA_LEN" = "$OLD_LEN" ] && pass "ProgramData data length $OLD_DATA_LEN (= old .so, as on mainnet)" ||
  fail "ProgramData data length $OLD_DATA_LEN, expected $OLD_LEN"
solana -C "$CFG" program dump "$PROGRAM_ID" "$WORK/onchain-old.so" >/dev/null || die "dump old"
# The dump is the whole ProgramData payload, which equals the .so exactly.
[ "$(sha "$WORK/onchain-old.so")" = "$OLD_SHA" ] && pass "on-chain old program hash = $OLD_SHA" ||
  fail "on-chain old program hash $(sha "$WORK/onchain-old.so")"

CREATE=(create-fund --quote "$USDC"
  --target "$USDC:default:2000" --target "$TEST_MINT:$POOL:8000"
  --per-run 100000 --interval 60 --window "$WINDOW" --max-dev-bps 500
  --name "Rehearsal Fund" --symbol "RFUND" --uri "https://example.invalid/rehearsal/1.json")
run_ok "$PAYER_KEY" "old: create-fund with metadata --send" "${CREATE[@]}" --send --cluster localnet
FUND="$(sed -n 's/^fund PDA: *//p' "$OUT")"
NFT="$(sed -n 's/^NFT mint (generated in memory): *//p' "$OUT")"
[ -n "$FUND" ] && [ -n "$NFT" ] || die "no fund PDA / NFT mint in create-fund output"
[ "$(grep -c 'sent and confirmed' "$OUT")" = 3 ] && pass "old: three create transactions confirmed" || fail "old: expected three confirmations"
run_ok "$PAYER_KEY" "old: deposit 1 USDC.X --send" deposit --fund "$FUND" --amount 1000000 --send --cluster localnet
keeper_run "old: keeper runs execute_dca"
expect_out "old: execute_dca executed target 1" "executed $FUND target 1: "
run_ok "" "old: show" show --fund "$FUND"
expect_out "old: metadata attached" 'NFT metadata +"Rehearsal Fund" \("RFUND"\)'
expect_out "old: TEST budget spent 80000 of 800000" "budget 0.72 quote \\(raw 720000\\)"
TEST_VAULT_BAL="$(sed -n "s/^  $TEST_MINT [1-9A-HJ-NP-Za-km-z]* [0-9.]* (raw \([0-9]*\))$/\1/p" "$OUT")"
[ -n "$TEST_VAULT_BAL" ] && [ "$TEST_VAULT_BAL" -gt 0 ] && pass "old: TEST vault received $TEST_VAULT_BAL raw" ||
  fail "old: TEST vault balance '$TEST_VAULT_BAL'"

FUND_SPACE="$(solana -C "$CFG" account "$FUND" --output json | jq -r '.account.space')"
FUND_RENT="$(solana -C "$CFG" rent "$FUND_SPACE" --lamports | awk '/Rent-exempt minimum/ {print $3}')"
[ "$(lamports_of "$FUND")" = "$FUND_RENT" ] && pass "fund holds its rent minimum $FUND_RENT ($FUND_SPACE bytes)" ||
  fail "fund lamports $(lamports_of "$FUND") != rent $FUND_RENT"

echo; echo "== XNT sent to the fund PDA while the old program is live"
solana -C "$CFG" transfer "$FUND" 0.75 --keypair "$PAYER_KEY" >"$OUT" 2>&1 && pass "System transfer 0.75 XNT to the fund PDA" ||
  fail "System transfer to the fund PDA"
[ "$(lamports_of "$FUND")" = "$((FUND_RENT + 750000000))" ] && pass "fund holds rent + 0.75 XNT" || fail "fund balance after transfer"
run_fail "$PAYER_KEY" "old program has no withdraw_native" "InstructionFallbackNotFound|Fallback functions are not supported|0x65\\b|\"Custom\":101" \
  withdraw-native --fund "$FUND" --amount all
FUND_DATA_PRE="$(account_sha "$FUND")"

# ================= upgrade =================
echo; echo "== upgrade, as on mainnet"
DELTA=$((NEW_LEN - OLD_DATA_LEN))
echo "ProgramData data length $OLD_DATA_LEN, new .so $NEW_LEN: extend by $DELTA bytes"
RENT_OLD="$(solana -C "$CFG" rent $((OLD_DATA_LEN + 45)) --lamports | awk '/Rent-exempt minimum/ {print $3}')"
RENT_NEW="$(solana -C "$CFG" rent $((NEW_LEN + 45)) --lamports | awk '/Rent-exempt minimum/ {print $3}')"
RENT_BUF="$(solana -C "$CFG" rent $((NEW_LEN + 37)) --lamports | awk '/Rent-exempt minimum/ {print $3}')"
echo "rent: ProgramData $RENT_OLD -> $RENT_NEW (delta $((RENT_NEW - RENT_OLD))); temporary buffer $RENT_BUF"

# The second instance first: deploy with no explicit extend.
AUTH_BEFORE="$(lamports_of "$AUTH")"
if solana -C "$CFG" program deploy "$NEW_SO" --program-id "$SECOND_ID" --upgrade-authority "$AUTH_KEY" \
     --keypair "$AUTH_KEY" >"$OUT" 2>&1; then
  AUTO_LEN="$(programdata_len "$SECOND_ID")"
  pass "auto-extend: deploy without extend upgraded the second instance (data length $OLD_DATA_LEN -> $AUTO_LEN)"
  [ "$AUTO_LEN" = "$NEW_LEN" ] && pass "auto-extend grew ProgramData to exactly the new .so" ||
    fail "auto-extend data length $AUTO_LEN != $NEW_LEN"
else
  fail "auto-extend: deploy without extend failed on the second instance"
fi
sed 's/^/    /' "$OUT"
echo "authority spent $((AUTH_BEFORE - $(lamports_of "$AUTH"))) lamports on the auto-extend upgrade (rent delta + fees)"

# Without auto-extend and without extend, the upgrade must refuse cleanly.
if solana -C "$CFG" program deploy "$NEW_SO" --program-id "$PROGRAM_ID" --upgrade-authority "$AUTH_KEY" \
     --keypair "$AUTH_KEY" --no-auto-extend >"$OUT" 2>&1; then
  fail "--no-auto-extend deploy into a too-small ProgramData succeeded"
else
  pass "--no-auto-extend deploy into a too-small ProgramData is refused"
fi
sed 's/^/    /' "$OUT"
# A refused deploy has already written (and funded) its buffer. Recover it the
# way the runbook says: list buffers by authority, close each to the authority.
buffers_of_auth() {
  solana -C "$CFG" program show --buffers --keypair "$AUTH_KEY" --buffer-authority "$AUTH" --output json |
    jq -r '.buffers[]?.address'
}
mapfile -t LEFT < <(buffers_of_auth)
echo "buffers left by the refused deploy: ${#LEFT[@]} (${LEFT[*]:-none})"
[ "${#LEFT[@]}" -gt 0 ] && echo "note: the refused deploy left a funded buffer behind (its rent is held until closed)"
for b in "${LEFT[@]}"; do
  solana -C "$CFG" program close "$b" --keypair "$AUTH_KEY" --authority "$AUTH_KEY" --recipient "$AUTH" >/dev/null 2>&1 &&
    pass "closed leftover buffer $b (recovery path)" || fail "could not close buffer $b"
done
[ -z "$(buffers_of_auth)" ] && pass "no buffers remain after recovery" || fail "buffers remain after recovery"
[ "$(programdata_len "$PROGRAM_ID")" = "$OLD_DATA_LEN" ] && pass "refused deploy left the old program in place" ||
  fail "refused deploy changed the data length"

# The owner's path is scripts/upgrade-withdraw-native.sh. Here it runs in
# UPGRADE_TARGET=local mode against this validator (never mainnet). It builds
# with the real HOME (cargo, platform-tools) but every solana call it makes
# uses its own -C config with url = this validator and keypair = AUTH_KEY.
UPGRADER="$REPO/scripts/upgrade-withdraw-native.sh"
upgrader() {
  local name="$1" expect="$2"; shift 2
  local code=0
  TMPDIR="$WORK" UPGRADE_TARGET=local UPGRADE_URL="$URL" UPGRADE_AUTHORITY="$AUTH" \
    SOLANA_BIN_DIR="${UPGRADER_BIN_DIR:-$SOLANA_BIN_DIR}" bash "$UPGRADER" "$@" >"$OUT" 2>&1 || code=$?
  if { [ "$expect" = ok ] && [ "$code" = 0 ]; } || { [ "$expect" = fail ] && [ "$code" != 0 ]; }; then
    pass "$name (exit $code)"
  else
    fail "$name (exit $code, expected $expect)"
  fi
  sed 's/^/    /' "$OUT"
}

# fake_solana DIR SUBCOMMAND SNIPPET: a solana wrapper in DIR that runs the
# bash SNIPPET whenever SUBCOMMAND is among its arguments, and otherwise (or
# if the snippet does not exit) runs the real solana.
fake_solana() {
  local dir="$1" sub="$2" snippet="$3"
  mkdir -p -- "$dir" || die "mkdir $dir"
  printf '#!/usr/bin/env bash\nfor a in "$@"; do if [ "$a" = %q ]; then %s; fi; done\nexec %q "$@"\n' \
    "$sub" "$snippet" "$SOLANA_BIN_DIR/solana" >"$dir/solana" || die "write $dir/solana"
  chmod +x "$dir/solana" || die "chmod $dir/solana"
  ln -s "$SOLANA_BIN_DIR/solana-keygen" "$dir/solana-keygen" || die "link solana-keygen"
}
# The extend amount apply uses, straight from the upgrade script (no chain).
extend_by() {
  local name="$1" len="$2" simd="$3" want="$4" got
  got="$(TMPDIR="$WORK" UPGRADE_TARGET=local UPGRADE_URL="$URL" UPGRADE_AUTHORITY="$AUTH" \
    SOLANA_BIN_DIR="$SOLANA_BIN_DIR" bash "$UPGRADER" extend-by "$len" "$simd" 2>&1)"
  [ "$got" = "$want" ] && pass "extend-by $len $simd = $want ($name)" || fail "extend-by $len $simd = '$got', expected $want ($name)"
}

echo; echo "== upgrade script: the extend amount (unit check of extend_amount)"
extend_by "old length" "$OLD_LEN" inactive "$DELTA"
extend_by "old length + 1 byte from a third party" $((OLD_LEN + 1)) inactive $((DELTA - 1))
extend_by "one byte short" $((NEW_LEN - 1)) inactive 1
extend_by "already the new length" "$NEW_LEN" inactive 0
extend_by "longer than the new build" $((NEW_LEN + 100)) inactive 0
extend_by "SIMD-0431: old length, raised to the minimum" "$OLD_LEN" active 10240
extend_by "SIMD-0431: one byte short, raised to the minimum" $((NEW_LEN - 1)) active 10240
extend_by "SIMD-0431: exactly the minimum missing" $((NEW_LEN - 10240)) active 10240
extend_by "SIMD-0431: more than the minimum missing" $((NEW_LEN - 10241)) active 10241
extend_by "SIMD-0431: already the new length" "$NEW_LEN" active 0
# extend_by_refused NAME LEN TEXT: extend-by must exit non-zero, print TEXT
# and print no amount.
extend_by_refused() {
  local name="$1" len="$2" text="$3"
  if (TMPDIR="$WORK" UPGRADE_TARGET=local UPGRADE_URL="$URL" UPGRADE_AUTHORITY="$AUTH" SOLANA_BIN_DIR="$SOLANA_BIN_DIR" \
       bash "$UPGRADER" extend-by "$len" inactive >"$OUT" 2>&1); then
    fail "extend-by accepted $name ('$len'): $(tr '\n' ' ' <"$OUT")"
  elif grep -q "$text" "$OUT" && ! grep -Eq '^[0-9]+$' "$OUT"; then
    pass "extend-by refuses $name ('$len')"
  else
    fail "extend-by $name ('$len'): refusal text: $(tr '\n' ' ' <"$OUT")"
  fi
}
extend_by_refused "an empty data length" "" "not a decimal integer"
extend_by_refused "a leading-zero data length (would be read as octal)" "0$OLD_LEN" "not a decimal integer"
extend_by_refused "a data length of 2^64" 18446744073709551616 "not a decimal integer"
extend_by_refused "a data length above 10 MiB" 10485761 "above the maximum 10485760"
extend_by_refused "a negative data length" "-1" "not a decimal integer"

echo; echo "== upgrade script: refusals"
DEPLOYER="$HOLDER2_KEY" UPGRADE_SKIP_BUILD=1 upgrader "check with the wrong DEPLOYER key fails" fail check
expect_out "wrong key is named" "FAIL: DEPLOYER pubkey $HOLDER2 is not $AUTH"
DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 upgrader "apply without --i-understand-mainnet is refused" fail apply
expect_out "apply names the missing flag" "pass --i-understand-mainnet"
if (TMPDIR="$WORK" UPGRADE_TARGET=local UPGRADE_URL="https://rpc.mainnet.x1.xyz" UPGRADE_AUTHORITY="$AUTH" DEPLOYER="$AUTH_KEY" \
     SOLANA_BIN_DIR="$SOLANA_BIN_DIR" bash "$UPGRADER" check >"$OUT" 2>&1); then
  fail "local mode accepted a mainnet URL"
else
  grep -q "must be loopback" "$OUT" && pass "local mode refuses a non-loopback URL" || fail "non-loopback refusal text"
fi

echo; echo "== upgrade script: the on-chain code is authenticated"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$FOURTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "unknown same-size code at $OLD_LEN is refused" fail check
expect_out "unknown code named" "FAIL: on-chain code \(unknown, $OLD_LEN bytes\) at data length $OLD_LEN"
solana -C "$CFG" program extend "$FOURTH_ID" "$DELTA" --keypair "$AUTH_KEY" >/dev/null 2>&1 &&
  pass "fourth: extended to $NEW_LEN" || fail "fourth: extend"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$FOURTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "unknown code at $NEW_LEN (not new, not old + zeros) is refused" fail check
expect_out "unknown padded code named" "FAIL: on-chain code \(unknown, [0-9]+ bytes\) at data length $NEW_LEN"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$FOURTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "apply on unknown code sends nothing" fail apply --i-understand-mainnet
if grep -Eq "extending ProgramData|deploying " "$OUT"; then fail "apply on unknown code tried to send"; else pass "apply on unknown code did not extend or deploy"; fi
# A failing `program dump`: a solana wrapper that fails only that subcommand.
FAKEBIN="$WORK/fakebin"
mkdir -p -- "$FAKEBIN"
printf '#!/usr/bin/env bash\nfor a in "$@"; do [ "$a" = dump ] && { echo "simulated dump failure" >&2; exit 1; }; done\nexec %q "$@"\n' \
  "$SOLANA_BIN_DIR/solana" >"$FAKEBIN/solana"
chmod +x "$FAKEBIN/solana"
ln -s "$SOLANA_BIN_DIR/solana-keygen" "$FAKEBIN/solana-keygen"
if (TMPDIR="$WORK" UPGRADE_TARGET=local UPGRADE_URL="$URL" UPGRADE_AUTHORITY="$AUTH" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
     SOLANA_BIN_DIR="$FAKEBIN" bash "$UPGRADER" check >"$OUT" 2>&1); then
  fail "check passed although program dump failed"
else
  grep -q "program dump $PROGRAM_ID failed: the on-chain code cannot be authenticated" "$OUT" &&
    pass "a failed program dump is refused" || fail "dump failure refusal text"
fi
sed 's/^/    /' "$OUT"
# CLI output that cannot be parsed must stop the script, never count as 0.
fake_solana "$WORK/fakebin-feature-fail" feature 'echo "simulated feature status failure" >&2; exit 1'
UPGRADER_BIN_DIR="$WORK/fakebin-feature-fail" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed when feature status cannot be read" fail check
expect_out "unreadable feature status named" "FATAL: solana feature status [1-9A-HJ-NP-Za-km-z]+ failed: cannot tell whether SIMD-0431"
expect_out "the on-chain code was authenticated before the feature status read" \
  "PASS: on-chain code authenticated \(old\): the current build $OLD_SHA \(state: extend\)"
fake_solana "$WORK/fakebin-feature-empty" feature 'echo "{\"features\":[]}"; exit 0'
UPGRADER_BIN_DIR="$WORK/fakebin-feature-empty" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed when feature status has no status for SIMD-0431" fail check
expect_out "missing feature status named" "FATAL: solana feature status [1-9A-HJ-NP-Za-km-z]+ returned status ''"
fake_solana "$WORK/fakebin-rent" rent 'echo "Rent-exempt minimum: lamports"; exit 0'
UPGRADER_BIN_DIR="$WORK/fakebin-rent" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed on unparsable rent output (no silent zero)" fail check
expect_out "unparsable rent named" "FATAL: solana rent [0-9]+ --lamports returned '[^']*', not a decimal integer"
fake_solana "$WORK/fakebin-balance" balance 'echo "lamports"; exit 0'
UPGRADER_BIN_DIR="$WORK/fakebin-balance" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed on unparsable balance output" fail check
expect_out "unparsable balance named" "FATAL: solana balance [1-9A-HJ-NP-Za-km-z]+ --lamports returned 'lamports', not a decimal integer"
# Numbers that parse but are not canonical or are out of range.
fake_solana "$WORK/fakebin-rent-huge" rent 'echo "Rent-exempt minimum: 9223372036854775807 lamports"; exit 0'
UPGRADER_BIN_DIR="$WORK/fakebin-rent-huge" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed on a rent of 2^63-1 (the sum would wrap negative)" fail check
expect_out "huge rent named" "FATAL: solana rent [0-9]+ --lamports returned '9223372036854775807', not a decimal integer"
if grep -q "DEPLOYER balance" "$OUT"; then fail "huge rent reached the balance check"; else pass "huge rent never reached the balance check"; fi
fake_solana "$WORK/fakebin-rent-zero" rent 'echo "Rent-exempt minimum: 02872343280 lamports"; exit 0'
UPGRADER_BIN_DIR="$WORK/fakebin-rent-zero" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed on a leading-zero rent" fail check
expect_out "leading-zero rent named" "FATAL: solana rent [0-9]+ --lamports returned '02872343280', not a decimal integer"
# `program show` (not `show --buffers`) with a rewritten .dataLen.
fake_show() {
  fake_solana "$1" show "case \" \$* \" in *\" --buffers \"*) ;; *) $(printf '%q' "$SOLANA_BIN_DIR/solana") \"\$@\" | sed -E 's/\"dataLen\": *[0-9]+/\"dataLen\": $2/'; exit 0 ;; esac"
}
fake_show "$WORK/fakebin-len-zero" "\\\"0$OLD_LEN\\\""
UPGRADER_BIN_DIR="$WORK/fakebin-len-zero" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed on a leading-zero data length" fail check
expect_out "leading-zero data length named" "FATAL: solana program show [1-9A-HJ-NP-Za-km-z]+ \(.dataLen\) returned '0$OLD_LEN', not a decimal integer"
fake_show "$WORK/fakebin-len-big" 10485761
UPGRADER_BIN_DIR="$WORK/fakebin-len-big" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed on a data length above 10 MiB" fail check
expect_out "oversized data length named" "FATAL: solana program show [1-9A-HJ-NP-Za-km-z]+ \(.dataLen\) returned '10485761', above the maximum 10485760"
fake_show "$WORK/fakebin-len-huge" "\\\"18446744073709551616\\\""
UPGRADER_BIN_DIR="$WORK/fakebin-len-huge" DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 \
  upgrader "check fails closed on a data length of 2^64" fail check
expect_out "2^64 data length named" "FATAL: solana program show [1-9A-HJ-NP-Za-km-z]+ \(.dataLen\) returned '18446744073709551616', not a decimal integer"
[ "$(programdata_len "$PROGRAM_ID")" = "$OLD_DATA_LEN" ] && pass "the fail-closed checks sent nothing" || fail "a fail-closed check changed the chain"
BOGUS_ID="$(solana-keygen pubkey "$PAYER_KEY")"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$BOGUS_ID" UPGRADE_SKIP_BUILD=1 upgrader "a program id that is not a program is refused" fail check

DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$THIRD_ID" UPGRADE_SKIP_BUILD=1 upgrader "third: check before the upgrade" ok check
expect_out "check reports SIMD-0431 as inactive (as on X1 mainnet)" "SIMD-0431 minimum extend \([1-9A-HJ-NP-Za-km-z]+\): inactive"

echo; echo "== upgrade script on a third instance: apply from the old length extends, then deploys"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$THIRD_ID" UPGRADE_SKIP_BUILD=1 upgrader "third: apply (extend + deploy)" ok apply --i-understand-mainnet
expect_out "third: state was extend" "data length $OLD_LEN: extend by $DELTA bytes"
expect_out "third: on-chain hash asserted" "PASS: on-chain program hash is $NEW_SHA"
[ "$(programdata_len "$THIRD_ID")" = "$NEW_LEN" ] && pass "third: data length $NEW_LEN" || fail "third: data length $(programdata_len "$THIRD_ID")"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$THIRD_ID" UPGRADE_SKIP_BUILD=1 upgrader "third: apply again is a no-op" ok apply --i-understand-mainnet
expect_out "third: second apply sees the upgrade" "already upgraded; nothing sent"
[ "$(programdata_len "$THIRD_ID")" = "$NEW_LEN" ] && pass "third: not extended twice ($NEW_LEN)" || fail "third: extended twice"

echo; echo "== anyone can extend ProgramData: after a finished upgrade"
third_party_extend "$THIRD_ID" 1 "third"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$THIRD_ID" UPGRADE_SKIP_BUILD=1 upgrader "third: check after a third-party 1-byte extend" ok check
expect_out "third: still reported as upgraded" "data length $((NEW_LEN + 1)) and the on-chain program is already $NEW_SHA followed by 1 zero bytes: nothing to do"
expect_out "third: dump classified new+zero" "on-chain dump: $((NEW_LEN + 1)) bytes, sha256 [0-9a-f]+ \(new\+zero\)"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$THIRD_ID" UPGRADE_SKIP_BUILD=1 upgrader "third: apply after a third-party 1-byte extend is a no-op" ok apply --i-understand-mainnet
expect_out "third: apply sends nothing" "already upgraded; nothing sent"
[ "$(programdata_len "$THIRD_ID")" = "$((NEW_LEN + 1))" ] && pass "third: data length still $((NEW_LEN + 1))" || fail "third: data length $(programdata_len "$THIRD_ID")"

echo; echo "== anyone can extend ProgramData: 1 byte before check and apply"
third_party_extend "$FIFTH_ID" 1 "fifth"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$FIFTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "fifth: check after a third-party 1-byte extend" ok check
expect_out "fifth: old build + 1 zero byte is accepted, extend by $((DELTA - 1))" \
  "current build $OLD_SHA followed by 1 zero bytes; data length $((OLD_LEN + 1)): extend by $((DELTA - 1)) bytes, then deploy"
expect_out "fifth: dump classified old+zero" "on-chain dump: $((OLD_LEN + 1)) bytes, sha256 [0-9a-f]+ \(old\+zero\)"
FIFTH_EXTEND_RENT=$(( $(rent_at $((NEW_LEN + 45))) - $(rent_at $((OLD_LEN + 1 + 45))) ))
expect_out "fifth: balance check counts the rent for $((DELTA - 1)) bytes ($FIFTH_EXTEND_RENT)" "needed: extend rent $FIFTH_EXTEND_RENT \+"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$FIFTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "fifth: apply (extend by $((DELTA - 1)) + deploy)" ok apply --i-understand-mainnet
expect_out "fifth: extended by $((DELTA - 1))" "extending ProgramData by $((DELTA - 1)) bytes"
expect_out "fifth: on-chain hash asserted" "PASS: on-chain program hash is $NEW_SHA"
[ "$(programdata_len "$FIFTH_ID")" = "$NEW_LEN" ] && pass "fifth: data length $NEW_LEN" || fail "fifth: data length $(programdata_len "$FIFTH_ID")"
[ "$(onchain_prefix "$FIFTH_ID" "$NEW_LEN")" = "$NEW_SHA zero-tail" ] && pass "fifth: on-chain code is the new build" ||
  fail "fifth: on-chain code $(onchain_prefix "$FIFTH_ID" "$NEW_LEN")"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$FIFTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "fifth: check after the upgrade" ok check
expect_out "fifth: upgraded" "\(state: upgraded\)"

echo; echo "== anyone can extend ProgramData: past the new length before apply"
third_party_extend "$SIXTH_ID" $((DELTA + 100)) "sixth"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SIXTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "sixth: apply at data length $((NEW_LEN + 100)) (deploy only)" ok apply --i-understand-mainnet
expect_out "sixth: no extend needed" "data length $((NEW_LEN + 100)), current build $OLD_SHA plus zero padding \(already extended, not yet deployed\): no extend, deploy only"
if grep -q "extending ProgramData" "$OUT"; then fail "sixth: apply extended a ProgramData that was long enough"; else pass "sixth: apply did not extend"; fi
expect_out "sixth: on-chain hash asserted over the build, not the whole dump" \
  "PASS: on-chain program hash is $NEW_SHA \(first $NEW_LEN of $((NEW_LEN + 100)) bytes"
[ "$(programdata_len "$SIXTH_ID")" = "$((NEW_LEN + 100))" ] && pass "sixth: data length still $((NEW_LEN + 100))" || fail "sixth: data length $(programdata_len "$SIXTH_ID")"
[ "$(onchain_prefix "$SIXTH_ID" "$NEW_LEN")" = "$NEW_SHA zero-tail" ] && pass "sixth: first $NEW_LEN bytes are the new build, the rest zero" ||
  fail "sixth: on-chain code $(onchain_prefix "$SIXTH_ID" "$NEW_LEN")"
[ "$(sha "$WORK/prefix-dump.so")" != "$NEW_SHA" ] && pass "sixth: the whole-dump sha256 is not $NEW_SHA (why the script hashes the prefix)" ||
  fail "sixth: whole-dump hash unexpectedly equals the build hash"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SIXTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "sixth: check after the upgrade" ok check
expect_out "sixth: upgraded" "already $NEW_SHA followed by 100 zero bytes: nothing to do"

echo; echo "== padding that is not zero, or a wrong build before the padding, is refused"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SEVENTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "seventh: old build + a non-zero tail byte is refused" fail check
expect_out "seventh: unknown code named" "FAIL: on-chain code \(unknown, $NEW_LEN bytes\) at data length $NEW_LEN"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SEVENTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "seventh: apply sends nothing" fail apply --i-understand-mainnet
if grep -Eq "extending ProgramData|deploying " "$OUT"; then fail "seventh: apply tried to send"; else pass "seventh: apply did not extend or deploy"; fi
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$EIGHTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "eighth: new build + a non-zero tail byte is not 'upgraded'" fail check
expect_out "eighth: unknown code named" "FAIL: on-chain code \(unknown, $((NEW_LEN + 2)) bytes\) at data length $((NEW_LEN + 2))"
third_party_extend "$FOURTH_ID" 1 "fourth"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$FOURTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "fourth: wrong build + zero padding at another length is refused" fail check
expect_out "fourth: unknown code named" "FAIL: on-chain code \(unknown, $((NEW_LEN + 1)) bytes\) at data length $((NEW_LEN + 1))"

echo; echo "== the artifact is swapped after it was verified: the verified copy is what gets deployed"
# The upgrade script always reads this path, whatever NEW_SO is.
ARTIFACT_PATH="$REPO/target/deploy/fund_nft.so"
[ "$(sha "$ARTIFACT_PATH")" = "$NEW_SHA" ] || die "$ARTIFACT_PATH is not $NEW_SHA before the swap case"
cp -- "$ARTIFACT_PATH" "$WORK/artifact-backup.so" || die "back up $ARTIFACT_PATH"
ARTIFACT_BACKUP="$WORK/artifact-backup.so"
# genesis-hash is the first chain call, made after the artifact checks: the
# wrapper overwrites target/deploy/fund_nft.so there, before extend and deploy.
fake_solana "$WORK/fakebin-swap" genesis-hash "$(printf 'cp -- %q %q && echo swapped >>%q' "$SWAPPED_SO" "$ARTIFACT_PATH" "$WORK/swap.log")"
UPGRADER_BIN_DIR="$WORK/fakebin-swap" DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$NINTH_ID" UPGRADE_SKIP_BUILD=1 \
  upgrader "ninth: apply while target/deploy/fund_nft.so is overwritten after the checks" ok apply --i-understand-mainnet
[ -s "$WORK/swap.log" ] && [ "$(sha "$ARTIFACT_PATH")" = "$(sha "$SWAPPED_SO")" ] &&
  pass "ninth: target/deploy/fund_nft.so was overwritten during apply (sha256 $(sha "$ARTIFACT_PATH"))" ||
  fail "ninth: the swap did not happen"
expect_out "ninth: apply deployed its private copy" "^deploying $WORK/tmp\.[A-Za-z0-9]+/fund_nft\.so \(the verified private copy"
expect_out "ninth: on-chain hash asserted" "PASS: on-chain program hash is $NEW_SHA"
[ "$(onchain_prefix "$NINTH_ID" "$NEW_LEN")" = "$NEW_SHA zero-tail" ] && pass "ninth: the verified build is on chain, not the swapped file" ||
  fail "ninth: on-chain code $(onchain_prefix "$NINTH_ID" "$NEW_LEN")"
# With the swapped file still in place, a new check must fail on its hash.
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SIXTH_ID" UPGRADE_SKIP_BUILD=1 upgrader "a check that starts with the swapped file fails" fail check
expect_out "swapped file hash named" "FAIL: artifact sha256 $(sha "$SWAPPED_SO") != $NEW_SHA"
restore_artifact
[ "$(sha "$ARTIFACT_PATH")" = "$NEW_SHA" ] && pass "target/deploy/fund_nft.so restored ($NEW_SHA)" || die "could not restore $ARTIFACT_PATH"
ARTIFACT_BACKUP=""

echo; echo "== upgrade script on the real program id"
DEPLOYER="$AUTH_KEY" upgrader "check (fresh build, read-only)" ok check
expect_out "check deleted and rebuilt the artifact" "PASS: fresh build succeeded"
expect_out "check: extend by $DELTA" "data length $OLD_LEN: extend by $DELTA bytes, then deploy"
expect_out "check: balance covers the need" "PASS: DEPLOYER balance [0-9]+ >= [0-9]+ lamports"
[ "$(sha "$NEW_SO")" = "$NEW_SHA" ] && pass "rebuilt artifact still $NEW_SHA" || fail "rebuilt artifact hash changed"
[ "$(programdata_len "$PROGRAM_ID")" = "$OLD_DATA_LEN" ] && pass "check sent nothing (data length still $OLD_DATA_LEN)" || fail "check changed the chain"

# An interrupted earlier run that only got as far as the extend.
solana -C "$CFG" program extend "$PROGRAM_ID" "$DELTA" --keypair "$AUTH_KEY" >"$OUT" 2>&1 &&
  pass "manual program extend $PROGRAM_ID $DELTA (as if an earlier apply stopped after extend)" || fail "program extend"
sed 's/^/    /' "$OUT"
[ "$(programdata_len "$PROGRAM_ID")" = "$NEW_LEN" ] && pass "ProgramData data length is now $NEW_LEN" ||
  fail "ProgramData data length $(programdata_len "$PROGRAM_ID") after extend"
# The extended program still runs the old code until the deploy: a deposit
# simulation invokes it, and withdraw_native is still unknown.
sleep 2
run_ok "" "old program still executes after extend (deposit simulation)" deposit --fund "$FUND" --amount 1000 --payer "$PAYER"
expect_out "old program simulation ok after extend" "simulation: ok, [0-9]+ compute units"
run_fail "$PAYER_KEY" "after extend, before deploy, withdraw_native is still unknown" "\"Custom\":101" \
  withdraw-native --fund "$FUND" --amount all
AUTH_BEFORE="$(lamports_of "$AUTH")"
DEPLOYER="$AUTH_KEY" upgrader "apply after the extend (reruns check with a fresh build, deploys)" ok apply --i-understand-mainnet
expect_out "apply sees the extended state" "already extended, not yet deployed\): no extend, deploy only"
expect_out "dump after extend: full data length, old build + zero padding" "on-chain dump: $NEW_LEN bytes, sha256 [0-9a-f]+ \(old\+zero\)"
expect_out "apply asserted the on-chain hash" "PASS: on-chain program hash is $NEW_SHA"
if grep -q "extending ProgramData" "$OUT"; then fail "apply extended an already-extended program"; else pass "apply did not extend again"; fi
echo "authority spent $((AUTH_BEFORE - $(lamports_of "$AUTH"))) lamports on apply after extend (fees only; buffer rent refunded)"
[ "$(programdata_len "$PROGRAM_ID")" = "$NEW_LEN" ] && pass "data length still $NEW_LEN after apply" || fail "data length changed by apply"
DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 upgrader "apply again is a no-op" ok apply --i-understand-mainnet
expect_out "second apply sees the upgrade" "already upgraded; nothing sent"
[ "$(programdata_len "$PROGRAM_ID")" = "$NEW_LEN" ] && pass "not extended twice ($NEW_LEN)" || fail "extended twice"
solana -C "$CFG" program show "$PROGRAM_ID" >"$OUT" 2>&1
sed 's/^/    /' "$OUT"
grep -Eq "Authority: *$AUTH" "$OUT" && pass "authority unchanged after upgrade" || fail "authority changed"
solana -C "$CFG" program dump "$PROGRAM_ID" "$WORK/onchain-new.so" >/dev/null || die "dump new"
[ "$(sha "$WORK/onchain-new.so")" = "$NEW_SHA" ] && pass "on-chain program hash = new build $NEW_SHA" ||
  fail "on-chain program hash $(sha "$WORK/onchain-new.so") != $NEW_SHA"
# A program upgraded in slot N is invocable from slot N+1.
sleep 2

# ================= NEW program, PRE-EXISTING fund =================
echo; echo "== pre-existing fund under the new program"
[ "$(account_sha "$FUND")" = "$FUND_DATA_PRE" ] && pass "fund data unchanged by the upgrade" || fail "fund data changed by the upgrade"
run_ok "" "new: show" show --fund "$FUND"
expect_out "new: native available 0.75" "^native XNT available to withdraw: 0.75 \\(raw 750000000;"
expect_out "new: budgets as before the upgrade" "budget 0.72 quote \\(raw 720000\\)"
run_ok "" "new: withdraw-native simulate-only" withdraw-native --fund "$FUND" --amount 250000000 --payer "$PAYER"
expect_out "new: simulate-only sent nothing" "nothing was signed or sent"
run_ok "$PAYER_KEY" "new: withdraw-native 0.25 XNT --send" withdraw-native --fund "$FUND" --amount 250000000 --send --cluster localnet
expect_out "new: withdraw_native confirmed" "tx 1/1 \\(withdraw_native\\) sent and confirmed"
[ "$(lamports_of "$FUND")" = "$((FUND_RENT + 500000000))" ] && pass "new: fund holds rent + 0.5 XNT" || fail "new: fund balance after part"
run_ok "$PAYER_KEY" "new: withdraw-native all --send" withdraw-native --fund "$FUND" --amount all --send --cluster localnet
expect_out "new: all = 0.5" "amount +0.5 XNT \\(raw 500000000 lamports\\)"
[ "$(lamports_of "$FUND")" = "$FUND_RENT" ] && pass "new: fund back at exactly its rent minimum" || fail "new: fund balance after all"
[ "$(account_sha "$FUND")" = "$FUND_DATA_PRE" ] && pass "new: fund data unchanged by withdraw-native" ||
  fail "new: withdraw-native changed fund data"

run_ok "$PAYER_KEY" "new: token withdraw 0.1 USDC.X --send" withdraw --fund "$FUND" --mint "$USDC" --amount 100000 --send --cluster localnet
echo "waiting 65 s for the 60 s interval"
sleep 65
keeper_run "new: keeper runs execute_dca on the old fund"
expect_out "new: execute_dca executed target 1" "executed $FUND target 1: "
run_ok "" "new: show after withdraw and execute_dca" show --fund "$FUND"
python3 -I - "$OUT" "$TEST_VAULT_BAL" <<'PY' && pass "new: budgets and vaults consistent" || fail "new: budgets/vaults inconsistent"
import re, sys
text = open(sys.argv[1]).read()
budgets = [int(x) for x in re.findall(r"budget [0-9.]+ quote \(raw (\d+)\)", text)]
total = int(re.search(r"budget total .*\(raw (\d+)\)", text).group(1))
usdc = int(re.search(r"B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq \S+ \S+ \(raw (\d+)\)", text).group(1))
test = int(re.search(r"C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz \S+ \S+ \(raw (\d+)\)", text).group(1))
print("budgets", budgets, "total", total, "usdc vault", usdc, "test vault", test)
# After the first DCA: cash 200000, TEST 720000; vault 920000. The 100000
# withdraw shrinks budgets pro rata (cash ~178260, TEST ~641740, rounding
# remainder to one of them; vault 820000). The second DCA spends 80000 of
# the TEST budget and the quote vault.
assert sum(budgets) == total
assert total == usdc == 740000, "budget total must equal the quote vault"
assert budgets[0] in (178260, 178261), budgets
assert test > int(sys.argv[2]), "second DCA added TEST"
PY

# ================= NFT changes hands =================
echo; echo "== the NFT moves to a second wallet"
if spl-token -C "$CFG" transfer "$NFT" 1 "$HOLDER2" --fund-recipient --owner "$PAYER_KEY" --fee-payer "$PAYER_KEY" >"$OUT" 2>&1; then
  pass "NFT transferred to $HOLDER2"
else
  fail "NFT transfer"
fi
sed 's/^/    /' "$OUT"
solana -C "$CFG" transfer "$FUND" 0.1 --keypair "$PAYER_KEY" >/dev/null 2>&1 && pass "another 0.1 XNT to the fund PDA" || fail "second transfer"
run_ok "" "show: new holder" show --fund "$FUND"
expect_out "NFT holder is the second wallet" "NFT holder +$HOLDER2"
run_fail "$PAYER_KEY" "old holder withdraw-native is rejected by the program" "BadNft" \
  withdraw-native --fund "$FUND" --amount all --send --cluster localnet
expect_out "old holder warning printed" "does not hold the fund NFT"
HOLDER2_BEFORE="$(lamports_of "$HOLDER2")"
run_ok "$HOLDER2_KEY" "new holder withdraw-native all --send" withdraw-native --fund "$FUND" --amount all --send --cluster localnet
expect_out "new holder took 0.1" "amount +0.1 XNT \\(raw 100000000 lamports\\)"
GAIN=$(( $(lamports_of "$HOLDER2") - HOLDER2_BEFORE ))
[ "$GAIN" -le 100000000 ] && [ "$GAIN" -gt 99900000 ] && pass "new holder gained 0.1 XNT less the fee ($GAIN)" ||
  fail "new holder gained $GAIN"
[ "$(lamports_of "$FUND")" = "$FUND_RENT" ] && pass "fund back at its rent minimum" || fail "fund balance after new holder"
run_fail "$PAYER_KEY" "old holder token withdraw is rejected" "BadNft" \
  withdraw --fund "$FUND" --mint "$USDC" --amount 1 --send --cluster localnet

[ -z "$(buffers_of_auth)" ] && pass "no buffers remain at the end" || fail "buffers remain at the end"

# ================= rollback =================
# The runbook's rollback: redeploy the build that was dumped from chain BEFORE
# the upgrade ($WORK/onchain-old.so, taken above while the old program was
# live). The first OLD_LEN bytes are the build; ProgramData is already long
# enough, so no extend.
echo; echo "== rollback to the pre-upgrade dump"
ROLLBACK_SO="$WORK/fund_nft-pre-upgrade.so"
head -c "$OLD_LEN" "$WORK/onchain-old.so" >"$ROLLBACK_SO" || die "cut the pre-upgrade dump"
[ "$(sha "$ROLLBACK_SO")" = "$OLD_SHA" ] && pass "rollback file: first $OLD_LEN bytes of the pre-upgrade dump hash to $OLD_SHA" ||
  fail "rollback file sha256 $(sha "$ROLLBACK_SO")"
solana -C "$CFG" transfer "$FUND" 0.05 --keypair "$PAYER_KEY" >/dev/null 2>&1 && pass "0.05 XNT to the fund PDA before the rollback" || fail "transfer before rollback"
if solana -C "$CFG" program deploy "$ROLLBACK_SO" --program-id "$PROGRAM_ID" --upgrade-authority "$AUTH_KEY" \
     --keypair "$AUTH_KEY" --with-compute-unit-price 1000 >"$OUT" 2>&1; then
  pass "rollback deploy of the pre-upgrade build"
else
  fail "rollback deploy"
fi
sed 's/^/    /' "$OUT"
[ "$(programdata_len "$PROGRAM_ID")" = "$NEW_LEN" ] && pass "rollback: data length still $NEW_LEN (no extend needed)" ||
  fail "rollback: data length $(programdata_len "$PROGRAM_ID")"
[ "$(onchain_prefix "$PROGRAM_ID" "$OLD_LEN")" = "$OLD_SHA zero-tail" ] && pass "rollback: on-chain code is the old build + zero padding" ||
  fail "rollback: on-chain code $(onchain_prefix "$PROGRAM_ID" "$OLD_LEN")"
sleep 2
run_ok "" "rollback: show still decodes the fund" show --fund "$FUND"
run_ok "" "rollback: the old program executes (deposit simulation)" deposit --fund "$FUND" --amount 1000 --payer "$PAYER"
expect_out "rollback: deposit simulation ok" "simulation: ok, [0-9]+ compute units"
run_fail "$HOLDER2_KEY" "rollback: withdraw_native is unknown again" "\"Custom\":101" \
  withdraw-native --fund "$FUND" --amount all
DEPLOYER="$AUTH_KEY" UPGRADE_SKIP_BUILD=1 upgrader "rollback: check sees the old build, already long enough" ok check
expect_out "rollback: state extended (apply would deploy only)" "\(state: extended\)"
[ -z "$(buffers_of_auth)" ] && pass "rollback: no buffers remain" || fail "rollback: buffers remain"

# ================= SIMD-0431 active =================
echo; echo "== second validator: SIMD-0431 (minimum extend) active"
stop_validator
SIMD_FEATURE="YbbRLkvenrocjGPGyoQE4wjnvYzTgfsk38NFmcYK7a5"
SIMD_FEATURE_ARGS=()
SIMD_WAS_INACTIVE=0
for f in "${INACTIVE[@]}"; do
  if [ "$f" = "$SIMD_FEATURE" ]; then SIMD_WAS_INACTIVE=1; continue; fi
  [ "$f" = "$X1_SYSVAR_SYSCALL_EXCEPTION" ] || SIMD_FEATURE_ARGS+=(--deactivate-feature "$f")
done
echo "X1 mainnet has SIMD-0431 inactive today: $([ "$SIMD_WAS_INACTIVE" = 1 ] && echo yes || echo no). Here it stays active; the other $(( ${#SIMD_FEATURE_ARGS[@]} / 2 )) X1-inactive features are deactivated."
start_validator -C "$CFG" --mint "$PAYER" --reset --quiet \
  --bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port $((RPC_PORT + 2)) \
  --gossip-port $((RPC_PORT + 3)) --dynamic-port-range "$((RPC_PORT + 4))-$((RPC_PORT + 41))" \
  --ledger "$WORK/ledger-simd" \
  --upgradeable-program "$SIMD_ID" "$OLD_SO" "$AUTH" \
  "${SIMD_FEATURE_ARGS[@]}"
wait_validator
solana -C "$CFG" airdrop 10 "$AUTH" >/dev/null || die "airdrop authority (second validator)"
sleep 2
if solana -C "$CFG" program extend "$SIMD_ID" "$DELTA" --keypair "$AUTH_KEY" >"$OUT" 2>&1; then
  fail "simd: a $DELTA-byte extend was accepted, so SIMD-0431 is not active here"
else
  grep -q "minimum of 10240 additional bytes" "$OUT" && pass "simd: a plain $DELTA-byte extend is refused (minimum 10240)" ||
    fail "simd: $DELTA-byte extend failed without the minimum-extend message"
fi
sed 's/^/    /' "$OUT"
[ "$(programdata_len "$SIMD_ID")" = "$OLD_LEN" ] && pass "simd: data length still $OLD_LEN" || fail "simd: data length $(programdata_len "$SIMD_ID")"
SIMD_EXTEND_RENT=$(( $(rent_at $((OLD_LEN + 10240 + 45))) - $(rent_at $((OLD_LEN + 45))) ))
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SIMD_ID" UPGRADE_SKIP_BUILD=1 upgrader "simd: check" ok check
expect_out "simd: check reports the feature as active" "SIMD-0431 minimum extend \($SIMD_FEATURE\): ACTIVE"
expect_out "simd: extend raised to 10240" "data length $OLD_LEN: extend by 10240 bytes, then deploy"
expect_out "simd: balance check counts the rent for 10240 bytes ($SIMD_EXTEND_RENT)" "needed: extend rent $SIMD_EXTEND_RENT \+"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SIMD_ID" UPGRADE_SKIP_BUILD=1 upgrader "simd: apply (extend by 10240 + deploy)" ok apply --i-understand-mainnet
expect_out "simd: extended by 10240" "extending ProgramData by 10240 bytes"
expect_out "simd: on-chain hash asserted" "PASS: on-chain program hash is $NEW_SHA \(first $NEW_LEN of $((OLD_LEN + 10240)) bytes"
[ "$(programdata_len "$SIMD_ID")" = "$((OLD_LEN + 10240))" ] && pass "simd: data length $((OLD_LEN + 10240))" || fail "simd: data length $(programdata_len "$SIMD_ID")"
[ "$(onchain_prefix "$SIMD_ID" "$NEW_LEN")" = "$NEW_SHA zero-tail" ] && pass "simd: on-chain code is the new build" ||
  fail "simd: on-chain code $(onchain_prefix "$SIMD_ID" "$NEW_LEN")"
DEPLOYER="$AUTH_KEY" UPGRADE_PROGRAM_ID="$SIMD_ID" UPGRADE_SKIP_BUILD=1 upgrader "simd: apply again is a no-op at the longer length" ok apply --i-understand-mainnet
expect_out "simd: upgraded" "already $NEW_SHA followed by $((OLD_LEN + 10240 - NEW_LEN)) zero bytes: nothing to do"
expect_out "simd: nothing sent" "already upgraded; nothing sent"
[ -z "$(buffers_of_auth)" ] && pass "simd: no buffers remain" || fail "simd: buffers remain"
stop_validator

echo
echo "upgrade rehearsal: $PASS passed, $FAIL failed (old $OLD_SHA -> new $NEW_SHA, extend $DELTA bytes, window $WINDOW s)"
[ "$FAIL" = 0 ]
