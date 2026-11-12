#!/usr/bin/env bash
# Upgrade the X1 mainnet fund program to the withdraw_native build. The OWNER
# runs this; see docs/UPGRADE_WITHDRAW_NATIVE.md.
#
#   DEPLOYER=/abs/path/deployer.json EXPECT_COMMIT=<reviewed commit> \
#     bash scripts/upgrade-withdraw-native.sh check
#   DEPLOYER=/abs/path/deployer.json EXPECT_COMMIT=<reviewed commit> \
#     bash scripts/upgrade-withdraw-native.sh apply --i-understand-mainnet
#
# check (default, read-only: it builds locally and only reads the chain):
#   toolchain versions; the build inputs are clean at EXPECT_COMMIT; a fresh
#   build (the old .so is deleted first) is exactly the reviewed artifact;
#   the RPC is X1 mainnet; DEPLOYER's pubkey is the program's upgrade
#   authority; ProgramData is either the current build's length (extend
#   needed) or already the new length; leftover buffers are listed; the
#   DEPLOYER balance covers what apply will spend. Any failure exits non-zero.
# apply --i-understand-mainnet:
#   reruns every check, then extends ProgramData only if it still has the old
#   length (by the computed delta), deploys with --with-compute-unit-price
#   1000, dumps the program and asserts the on-chain hash. Rerunning after a
#   finished upgrade changes nothing. If the deploy fails it prints the
#   buffer-recovery commands.
#
# Every solana call uses a fresh -C config in a temp dir (url = the target,
# keypair = DEPLOYER), so ~/.config/solana is never consulted. The keypair
# file is only ever passed to solana by path; its contents are never read or
# printed here.
#
# UPGRADE_TARGET=local is for scripts/rehearse-upgrade-local.sh only: it takes
# UPGRADE_URL (loopback), UPGRADE_AUTHORITY and optional UPGRADE_PROGRAM_ID /
# UPGRADE_SKIP_BUILD=1, and refuses an X1 mainnet or testnet genesis.
set -euo pipefail

die() { echo "FATAL: $*" >&2; exit 2; }
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }

CMD="${1:-check}"
[ $# -gt 0 ] && shift
I_UNDERSTAND=0
for a in "$@"; do
  case "$a" in
    --i-understand-mainnet) I_UNDERSTAND=1 ;;
    *) die "unknown argument $a (usage: check | apply --i-understand-mainnet)" ;;
  esac
done
case "$CMD" in check|apply) ;; *) die "unknown command $CMD (usage: check | apply --i-understand-mainnet)" ;; esac
if [ "$CMD" = apply ] && [ "$I_UNDERSTAND" != 1 ]; then
  die "apply spends XNT and upgrades the program: pass --i-understand-mainnet"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$HERE/.." && pwd -P)"
SOLANA_BIN_DIR="${SOLANA_BIN_DIR:-$HOME/.local/share/solana/install/active_release/bin}"
ANCHOR_BIN="${ANCHOR_BIN:-$HOME/.avm/bin/anchor-1.2.2}"
for b in solana solana-keygen; do [ -x "$SOLANA_BIN_DIR/$b" ] || die "missing $SOLANA_BIN_DIR/$b"; done
for t in jq python3 sha256sum git; do command -v "$t" >/dev/null || die "$t is required"; done

X1_MAINNET_GENESIS="4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN"
X1_TESTNET_GENESIS="C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho"
OLD_LEN=403520
NEW_LEN=412528
NEW_SHA="a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388"
# Lamports kept above the computed rent for transaction fees (rehearsal: the
# deploy paid 2,166,296 at --with-compute-unit-price 1000).
FEE_MARGIN=50000000

TARGET="${UPGRADE_TARGET:-mainnet}"
case "$TARGET" in
  mainnet)
    URL="https://rpc.mainnet.x1.xyz"
    PROGRAM_ID="6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM"
    AUTHORITY="HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj"
    for v in UPGRADE_URL UPGRADE_AUTHORITY UPGRADE_PROGRAM_ID UPGRADE_SKIP_BUILD; do
      [ -z "${!v:-}" ] || die "$v is only allowed with UPGRADE_TARGET=local"
    done
    [ -n "${EXPECT_COMMIT:-}" ] || die "set EXPECT_COMMIT to the reviewed commit"
    ;;
  local)
    URL="${UPGRADE_URL:?UPGRADE_URL is required with UPGRADE_TARGET=local}"
    case "$URL" in http://127.0.0.1:*|http://localhost:*) ;; *) die "UPGRADE_URL must be loopback: $URL" ;; esac
    PROGRAM_ID="${UPGRADE_PROGRAM_ID:-6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM}"
    AUTHORITY="${UPGRADE_AUTHORITY:?UPGRADE_AUTHORITY is required with UPGRADE_TARGET=local}"
    ;;
  *) die "UPGRADE_TARGET must be mainnet or local" ;;
esac
DEPLOYER="${DEPLOYER:?set DEPLOYER to the absolute path of the upgrade-authority keypair}"
case "$DEPLOYER" in /*) ;; *) die "DEPLOYER must be an absolute path" ;; esac
[ -f "$DEPLOYER" ] || die "DEPLOYER $DEPLOYER is not a file"
SO="$REPO/target/deploy/fund_nft.so"

TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
CFG="$TMP/solana-cli.yml"
solana() { "$SOLANA_BIN_DIR/solana" -C "$CFG" --url "$URL" "$@"; }
"$SOLANA_BIN_DIR/solana" -C "$CFG" config set --url "$URL" --keypair "$DEPLOYER" >/dev/null
sha() { sha256sum "$1" | awk '{print $1}'; }
rent_of() { solana rent "$1" --lamports | awk '/Rent-exempt minimum/ {print $3}'; }
show_json() { solana program show "$PROGRAM_ID" --output json; }

echo "target $TARGET: $URL, program $PROGRAM_ID, expected authority $AUTHORITY"

# Sets: STATE (extend | extended | upgraded), DATA_LEN, EXTEND_BY, NEED.
run_checks() {
  PASS=0
  FAIL=0
  echo; echo "== toolchain and build"
  local v
  v="$("$SOLANA_BIN_DIR/solana" --version)"
  case "$v" in *" 4.1.2 "*|*" 4.1.2") pass "solana $v" ;; *) fail "solana is not 4.1.2: $v" ;; esac
  if [ "${UPGRADE_SKIP_BUILD:-0}" = 1 ]; then
    echo "UPGRADE_SKIP_BUILD=1 (local rehearsal only): using the existing $SO"
  else
    [ -x "$ANCHOR_BIN" ] && v="$("$ANCHOR_BIN" --version)" || v="missing $ANCHOR_BIN"
    case "$v" in *1.2.2*) pass "anchor $v" ;; *) fail "anchor is not 1.2.2: $v" ;; esac
    local head
    head="$(git -C "$REPO" rev-parse HEAD)"
    if [ -n "${EXPECT_COMMIT:-}" ]; then
      [ "$head" = "$(git -C "$REPO" rev-parse --verify "${EXPECT_COMMIT}^{commit}" 2>/dev/null || echo none)" ] &&
        pass "HEAD is the reviewed commit $head" || fail "HEAD $head is not EXPECT_COMMIT $EXPECT_COMMIT"
    else
      echo "HEAD $head (EXPECT_COMMIT not set; local rehearsal)"
    fi
    if [ -z "$(git -C "$REPO" status --porcelain -- programs Cargo.toml Cargo.lock Anchor.toml rust-toolchain.toml)" ]; then
      pass "build inputs (programs/, Cargo.*, Anchor.toml, rust-toolchain.toml) have no local changes"
    else
      fail "build inputs have local changes:"; git -C "$REPO" status --porcelain -- programs Cargo.toml Cargo.lock Anchor.toml rust-toolchain.toml
    fi
    rm -f -- "$SO"
    echo "building (anchor build --ignore-keys --arch v0) ..."
    if (cd "$REPO" && PATH="$SOLANA_BIN_DIR:$PATH" "$ANCHOR_BIN" build --ignore-keys --arch v0) >"$TMP/build.log" 2>&1; then
      pass "fresh build succeeded"
    else
      tail -20 "$TMP/build.log"; fail "build failed"
    fi
  fi
  if [ -f "$SO" ]; then
    [ "$(stat -c %s "$SO")" = "$NEW_LEN" ] && pass "artifact is $NEW_LEN bytes" || fail "artifact is $(stat -c %s "$SO") bytes, not $NEW_LEN"
    [ "$(sha "$SO")" = "$NEW_SHA" ] && pass "artifact sha256 $NEW_SHA" || fail "artifact sha256 $(sha "$SO") != $NEW_SHA"
    python3 -I - "$SO" <<'PY' && pass "artifact is SBPF v0 (e_flags 0) and does not import sol_get_sysvar" || fail "artifact e_flags != 0 or imports sol_get_sysvar"
import struct, sys
d = open(sys.argv[1], "rb").read()
sys.exit(0 if struct.unpack("<I", d[0x30:0x34])[0] == 0 and b"sol_get_sysvar\0" not in d else 1)
PY
  else
    fail "no artifact at $SO"
  fi

  echo; echo "== chain"
  local genesis
  genesis="$(solana genesis-hash)"
  if [ "$TARGET" = mainnet ]; then
    [ "$genesis" = "$X1_MAINNET_GENESIS" ] && pass "RPC is X1 mainnet ($genesis)" || die "RPC genesis $genesis is not X1 mainnet; refusing"
  else
    case "$genesis" in
      "$X1_MAINNET_GENESIS"|"$X1_TESTNET_GENESIS") die "local target has X1 mainnet/testnet genesis $genesis; refusing" ;;
    esac
    pass "local genesis $genesis (not X1 mainnet or testnet)"
  fi
  local deployer_pub
  deployer_pub="$("$SOLANA_BIN_DIR/solana-keygen" pubkey "$DEPLOYER")"
  [ "$deployer_pub" = "$AUTHORITY" ] && pass "DEPLOYER pubkey is $AUTHORITY" || fail "DEPLOYER pubkey $deployer_pub is not $AUTHORITY"
  local show onchain_auth
  show="$(show_json)" || die "program show $PROGRAM_ID failed"
  onchain_auth="$(jq -r '.authority' <<<"$show")"
  DATA_LEN="$(jq -r '.dataLen' <<<"$show")"
  [ "$onchain_auth" = "$AUTHORITY" ] && pass "on-chain upgrade authority is $AUTHORITY" || fail "on-chain upgrade authority is $onchain_auth"
  echo "ProgramData $(jq -r '.programdataAddress' <<<"$show"), data length $DATA_LEN, last deployed in slot $(jq -r '.lastDeploySlot' <<<"$show")"
  EXTEND_BY=0
  case "$DATA_LEN" in
    "$OLD_LEN") STATE=extend; EXTEND_BY=$((NEW_LEN - DATA_LEN)); pass "data length $DATA_LEN: extend by $EXTEND_BY bytes, then deploy" ;;
    "$NEW_LEN")
      solana program dump "$PROGRAM_ID" "$TMP/onchain.so" >/dev/null
      if [ "$(sha "$TMP/onchain.so")" = "$NEW_SHA" ]; then
        STATE=upgraded; pass "data length $DATA_LEN and the on-chain program is already $NEW_SHA: nothing to do"
      else
        STATE=extended; pass "data length $DATA_LEN (already extended, not yet deployed): no extend, deploy only"
      fi
      ;;
    *) STATE=refuse; fail "data length $DATA_LEN is neither $OLD_LEN (current build) nor $NEW_LEN; refusing" ;;
  esac

  local buffers
  buffers="$(solana program show --buffers --buffer-authority "$AUTHORITY" --output json | jq -r '.buffers[]? | "\(.address) \(.lamports)"')"
  if [ -n "$buffers" ]; then
    echo "WARNING: buffers owned by $AUTHORITY exist (an earlier deploy stopped part-way). Their XNT is recoverable:"
    while read -r addr lamports; do
      echo "  $addr ($lamports lamports): solana program close $addr --keypair \"\$DEPLOYER\" --url $URL"
    done <<<"$buffers"
  else
    pass "no leftover buffers owned by $AUTHORITY"
  fi

  NEED=0
  if [ "$STATE" = extend ] || [ "$STATE" = extended ]; then
    local extend_rent=0 buffer_rent balance
    if [ "$STATE" = extend ]; then
      extend_rent=$(( $(rent_of $((NEW_LEN + 45))) - $(rent_of $((OLD_LEN + 45))) ))
    fi
    buffer_rent="$(rent_of $((NEW_LEN + 37)))"
    NEED=$((extend_rent + buffer_rent + FEE_MARGIN))
    balance="$(solana balance "$AUTHORITY" --lamports | awk '{print $1}')"
    echo "needed: extend rent $extend_rent + temporary buffer $buffer_rent (refunded) + fee margin $FEE_MARGIN = $NEED lamports"
    [ "$balance" -ge "$NEED" ] && pass "DEPLOYER balance $balance >= $NEED lamports" ||
      fail "DEPLOYER balance $balance < $NEED lamports"
  fi
  echo; echo "check: $PASS passed, $FAIL failed (state: $STATE)"
  [ "$FAIL" = 0 ]
}

if ! run_checks; then
  echo "check failed; nothing was sent"
  exit 1
fi
[ "$CMD" = check ] && exit 0

# ---- apply ----
echo; echo "== apply ($STATE)"
if [ "$STATE" = upgraded ]; then
  echo "already upgraded; nothing sent"
  exit 0
fi
if [ "$STATE" = extend ]; then
  echo "extending ProgramData by $EXTEND_BY bytes"
  solana program extend "$PROGRAM_ID" "$EXTEND_BY" --keypair "$DEPLOYER"
  DATA_LEN="$(show_json | jq -r '.dataLen')"
  [ "$DATA_LEN" = "$NEW_LEN" ] || die "data length after extend is $DATA_LEN, not $NEW_LEN; not deploying"
  echo "PASS: data length is now $DATA_LEN"
fi
echo "deploying $SO"
if ! solana program deploy "$SO" --program-id "$PROGRAM_ID" \
    --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" --with-compute-unit-price 1000; then
  echo "FAIL: deploy did not complete. The old program is still live. Any buffer keeps its XNT:"
  echo "  list:    solana program show --buffers --buffer-authority $AUTHORITY --url $URL"
  echo "  close:   solana program close <BUFFER> --keypair \"\$DEPLOYER\" --url $URL"
  echo "  or resume with the 12-word phrase printed above: solana-keygen recover -o /abs/buffer.json, then"
  echo "           solana program deploy $SO --buffer /abs/buffer.json --program-id $PROGRAM_ID \\"
  echo "             --keypair \"\$DEPLOYER\" --upgrade-authority \"\$DEPLOYER\" --url $URL --with-compute-unit-price 1000"
  echo "  then rerun this script: it sees the extended length and does not extend again."
  exit 1
fi
solana program dump "$PROGRAM_ID" "$TMP/onchain.so" >/dev/null
[ "$(sha "$TMP/onchain.so")" = "$NEW_SHA" ] || die "on-chain program hash $(sha "$TMP/onchain.so") != $NEW_SHA after deploy"
echo "PASS: on-chain program hash is $NEW_SHA"
[ "$(show_json | jq -r '.authority')" = "$AUTHORITY" ] || die "upgrade authority changed after deploy"
echo "PASS: upgrade authority is still $AUTHORITY"
echo "apply: upgraded $PROGRAM_ID to $NEW_SHA"
