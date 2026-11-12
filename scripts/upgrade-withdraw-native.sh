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
#   authority; the on-chain code is the current build or already the new one
#   (see below); whether SIMD-0431 (minimum extend) is active; leftover
#   buffers are listed; the DEPLOYER balance covers what apply will spend.
#   Any failure exits non-zero.
# apply --i-understand-mainnet:
#   reruns every check, then extends ProgramData only if it is still shorter
#   than the new build (by the computed amount), deploys the verified copy of
#   the artifact with --with-compute-unit-price 1000, dumps the program and
#   asserts the on-chain code. Rerunning after a finished upgrade changes
#   nothing. If the deploy fails it prints the buffer-recovery commands.
#
# Every solana and solana-keygen call passes -C with a fresh config in a
# private temp dir (url = the target, keypair = DEPLOYER), so ~/.config/solana
# is never consulted. The keypair file is only ever passed to solana by path;
# its contents are never read or printed here.
#
# The on-chain code is authenticated by content, not by length: on X1 mainnet
# anyone can extend ProgramData (ExtendProgramChecked is inactive), and an
# extend only appends zero bytes. `program dump` must return exactly the
# ProgramData data length, and be one of:
#   old build (first 403,520 bytes) followed only by zero bytes, any length:
#     extend by what is still missing up to the new build's length (nothing
#     if it is already long enough), then deploy;
#   new build (first 412,528 bytes) followed only by zero bytes, any length:
#     already upgraded, nothing to do.
# Anything else (other code, a non-zero tail, a failed dump) is refused.
# With SIMD-0431 active an extend must add at least 10,240 bytes, so the
# extend is raised to that and the balance check counts the larger rent.
#
# The artifact is copied into the private temp dir right after the build. The
# size, hash and ELF checks run on that copy and apply deploys that copy, so
# a later write to target/deploy/fund_nft.so cannot change what is deployed.
#
# UPGRADE_TARGET=local is for scripts/rehearse-upgrade-local.sh only: it takes
# UPGRADE_URL (loopback), UPGRADE_AUTHORITY and optional UPGRADE_PROGRAM_ID /
# UPGRADE_SKIP_BUILD=1, and refuses an X1 mainnet or testnet genesis. Local
# mode also has `extend-by <data length> <active|inactive>`, which only prints
# the extend amount apply would use (no chain access; for the rehearsal).
set -euo pipefail

die() { echo "FATAL: $*" >&2; exit 2; }
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $*"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $*"; }

CMD="${1:-check}"
[ $# -gt 0 ] && shift
I_UNDERSTAND=0
case "$CMD" in
  check|apply)
    for a in "$@"; do
      case "$a" in
        --i-understand-mainnet) I_UNDERSTAND=1 ;;
        *) die "unknown argument $a (usage: check | apply --i-understand-mainnet)" ;;
      esac
    done ;;
  extend-by) [ $# = 2 ] || die "usage (UPGRADE_TARGET=local only): extend-by <data length> <active|inactive>" ;;
  *) die "unknown command $CMD (usage: check | apply --i-understand-mainnet)" ;;
esac
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
# The build live on X1 mainnet today (acb6953).
OLD_SHA="d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47"
NEW_LEN=412528
NEW_SHA="a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388"
# Lamports kept above the computed rent for transaction fees (rehearsal: the
# deploy paid 2,166,296 at --with-compute-unit-price 1000).
FEE_MARGIN=50000000
# SIMD-0431 (Loader V3 minimum extend program size). Inactive on X1 mainnet
# on 2026-11-12. Once active, ExtendProgram must add at least
# MIN_EXTEND_BYTES. (Its one exception, a smaller extend to exactly the 10 MiB
# maximum, cannot apply: an extend is only planned below NEW_LEN.)
SIMD_0431_FEATURE="YbbRLkvenrocjGPGyoQE4wjnvYzTgfsk38NFmcYK7a5"
MIN_EXTEND_BYTES=10240

# need_uint VALUE WHAT: die unless VALUE is a non-empty decimal integer, so
# unparsed CLI output can never become 0 in arithmetic.
need_uint() {
  [[ "$1" =~ ^[0-9]+$ ]] || die "$2 returned '$1', not a decimal integer; refusing"
}
# extend_amount DATA_LEN active|inactive: how many bytes to extend ProgramData
# by so the new build fits; 0 when it already fits. With SIMD-0431 active the
# amount is raised to MIN_EXTEND_BYTES.
extend_amount() {
  local len="$1" simd="$2" by
  need_uint "$len" "extend_amount: data length"
  case "$simd" in active|inactive) ;; *) die "extend_amount: SIMD-0431 status '$simd' is not active or inactive" ;; esac
  if [ "$len" -ge "$NEW_LEN" ]; then echo 0; return 0; fi
  by=$((NEW_LEN - len))
  if [ "$simd" = active ] && [ "$by" -lt "$MIN_EXTEND_BYTES" ]; then
    by=$MIN_EXTEND_BYTES
  fi
  echo "$by"
}

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
if [ "$CMD" = extend-by ]; then
  [ "$TARGET" = local ] || die "extend-by is only allowed with UPGRADE_TARGET=local"
  extend_amount "$1" "$2"
  exit 0
fi
DEPLOYER="${DEPLOYER:?set DEPLOYER to the absolute path of the upgrade-authority keypair}"
case "$DEPLOYER" in /*) ;; *) die "DEPLOYER must be an absolute path" ;; esac
[ -f "$DEPLOYER" ] || die "DEPLOYER $DEPLOYER is not a file"
SO="$REPO/target/deploy/fund_nft.so"

# Private work dir (mode 700: only this user can enter it). The verified copy
# of the artifact, ART, lives here with mode 600.
TMP="$(mktemp -d)"
trap 'rm -rf -- "$TMP"' EXIT
chmod 700 -- "$TMP"
CFG="$TMP/solana-cli.yml"
ART="$TMP/fund_nft.so"
solana() { "$SOLANA_BIN_DIR/solana" -C "$CFG" --url "$URL" "$@"; }
"$SOLANA_BIN_DIR/solana" -C "$CFG" config set --url "$URL" --keypair "$DEPLOYER" >/dev/null
sha() { sha256sum "$1" | awk '{print $1}'; }
# These helpers print one validated value. They run in a command
# substitution, so the caller must propagate a die: x="$(helper)" || exit $?
rent_of() {
  local out lamports
  out="$(solana rent "$1" --lamports)" || die "solana rent $1 --lamports failed"
  lamports="$(awk '/Rent-exempt minimum/ {print $3}' <<<"$out")"
  need_uint "$lamports" "solana rent $1 --lamports"
  echo "$lamports"
}
show_json() { solana program show "$PROGRAM_ID" --output json; }
data_len_now() {
  local show len
  show="$(show_json)" || die "solana program show $PROGRAM_ID failed"
  len="$(jq -r '.dataLen' <<<"$show")" || die "cannot parse solana program show $PROGRAM_ID"
  need_uint "$len" "solana program show $PROGRAM_ID (.dataLen)"
  echo "$len"
}
# active | inactive. A pending activation counts as active: an extend of at
# least MIN_EXTEND_BYTES is valid both before and after it.
simd_0431_status() {
  local out status
  out="$(solana feature status "$SIMD_0431_FEATURE" --output json)" ||
    die "solana feature status $SIMD_0431_FEATURE failed: cannot tell whether SIMD-0431 (minimum extend) is active; refusing"
  status="$(jq -r --arg id "$SIMD_0431_FEATURE" '[.features[]? | select(.id == $id) | .status] | join(",")' <<<"$out")" ||
    die "cannot parse solana feature status $SIMD_0431_FEATURE: cannot tell whether SIMD-0431 (minimum extend) is active; refusing"
  case "$status" in
    active|pending) echo active ;;
    inactive) echo inactive ;;
    *) die "solana feature status $SIMD_0431_FEATURE returned status '$status' (expected active, pending or inactive): cannot tell whether SIMD-0431 (minimum extend) is active; refusing" ;;
  esac
}
keygen_pubkey() { "$SOLANA_BIN_DIR/solana-keygen" -C "$CFG" pubkey "$1"; }
# Classify a `program dump` of ProgramData by content: old / old+zero (the
# current mainnet build, alone / followed only by zero bytes), new / new+zero
# (the reviewed build, likewise), or unknown. An extend appends zero bytes and
# a deploy zero-fills past the program, so the length alone decides nothing.
classify_dump() {
  python3 -I - "$1" "$OLD_LEN" "$OLD_SHA" "$NEW_LEN" "$NEW_SHA" <<'PY'
import hashlib, sys
path, old_len, old_sha, new_len, new_sha = sys.argv[1], int(sys.argv[2]), sys.argv[3], int(sys.argv[4]), sys.argv[5]
d = open(path, "rb").read()
def is_build(n, sha):
    return len(d) >= n and hashlib.sha256(d[:n]).hexdigest() == sha and not any(d[n:])
if is_build(new_len, new_sha):
    print("new" if len(d) == new_len else "new+zero")
elif is_build(old_len, old_sha):
    print("old" if len(d) == old_len else "old+zero")
else:
    print("unknown")
PY
}
# dump_and_classify FILE DATA_LEN: dump the program into FILE and print its
# class. The dump must be the whole ProgramData payload (DATA_LEN bytes),
# else unknown. Dies if the dump fails.
dump_and_classify() {
  local file="$1" want_len="$2" class len
  if ! solana program dump "$PROGRAM_ID" "$file" >"$TMP/dump.log" 2>&1; then
    cat "$TMP/dump.log" >&2
    die "program dump $PROGRAM_ID failed: the on-chain code cannot be authenticated; refusing"
  fi
  class="$(classify_dump "$file")" || die "could not classify the program dump"
  case "$class" in old|old+zero|new|new+zero|unknown) ;; *) die "could not classify the program dump (got '$class')" ;; esac
  len="$(stat -c %s "$file")" || die "stat $file"
  [ "$len" = "$want_len" ] || class="unknown"
  echo "$class"
}

echo "target $TARGET: $URL, program $PROGRAM_ID, expected authority $AUTHORITY"

# Sets: STATE (extend | extended | upgraded | refuse), DATA_LEN, EXTEND_BY,
# SIMD_0431, NEED. Leaves the verified copy of the artifact at ART.
run_checks() {
  PASS=0
  FAIL=0
  echo; echo "== toolchain and build"
  local v
  v="$("$SOLANA_BIN_DIR/solana" -C "$CFG" --version)" || die "solana --version failed"
  case "$v" in *" 4.1.2 "*|*" 4.1.2") pass "solana $v" ;; *) fail "solana is not 4.1.2: $v" ;; esac
  if [ "${UPGRADE_SKIP_BUILD:-0}" = 1 ]; then
    echo "UPGRADE_SKIP_BUILD=1 (local rehearsal only): using the existing $SO"
  else
    [ -x "$ANCHOR_BIN" ] && v="$("$ANCHOR_BIN" --version)" || v="missing $ANCHOR_BIN"
    case "$v" in *1.2.2*) pass "anchor $v" ;; *) fail "anchor is not 1.2.2: $v" ;; esac
    local head
    head="$(git -C "$REPO" rev-parse HEAD)" || die "git rev-parse HEAD failed"
    if [ -n "${EXPECT_COMMIT:-}" ]; then
      [ "$head" = "$(git -C "$REPO" rev-parse --verify "${EXPECT_COMMIT}^{commit}" 2>/dev/null || echo none)" ] &&
        pass "HEAD is the reviewed commit $head" || fail "HEAD $head is not EXPECT_COMMIT $EXPECT_COMMIT"
    else
      echo "HEAD $head (EXPECT_COMMIT not set; local rehearsal)"
    fi
    local dirty
    dirty="$(git -C "$REPO" status --porcelain -- programs Cargo.toml Cargo.lock Anchor.toml rust-toolchain.toml)" ||
      die "git status failed"
    if [ -z "$dirty" ]; then
      pass "build inputs (programs/, Cargo.*, Anchor.toml, rust-toolchain.toml) have no local changes"
    else
      fail "build inputs have local changes:"; echo "$dirty"
    fi
    rm -f -- "$SO"
    echo "building (anchor build --ignore-keys --arch v0) ..."
    if (cd "$REPO" && PATH="$SOLANA_BIN_DIR:$PATH" "$ANCHOR_BIN" build --ignore-keys --arch v0) >"$TMP/build.log" 2>&1; then
      pass "fresh build succeeded"
    else
      tail -20 "$TMP/build.log"; fail "build failed"
    fi
  fi
  # From here on only the private copy is read: it is what gets checked and
  # what apply deploys.
  rm -f -- "$ART"
  if [ -f "$SO" ]; then
    cp -- "$SO" "$ART" || die "cannot copy $SO to $ART"
    chmod 600 -- "$ART" || die "chmod $ART failed"
    local art_len
    art_len="$(stat -c %s "$ART")" || die "stat $ART failed"
    echo "checking the private copy $ART"
    [ "$art_len" = "$NEW_LEN" ] && pass "artifact is $NEW_LEN bytes" || fail "artifact is $art_len bytes, not $NEW_LEN"
    [ "$(sha "$ART")" = "$NEW_SHA" ] && pass "artifact sha256 $NEW_SHA" || fail "artifact sha256 $(sha "$ART") != $NEW_SHA"
    python3 -I - "$ART" <<'PY' && pass "artifact is SBPF v0 (e_flags 0) and does not import sol_get_sysvar" || fail "artifact e_flags != 0 or imports sol_get_sysvar"
import struct, sys
d = open(sys.argv[1], "rb").read()
sys.exit(0 if struct.unpack("<I", d[0x30:0x34])[0] == 0 and b"sol_get_sysvar\0" not in d else 1)
PY
  else
    fail "no artifact at $SO"
  fi

  echo; echo "== chain"
  local genesis
  genesis="$(solana genesis-hash)" || die "genesis-hash failed for $URL"
  if [ "$TARGET" = mainnet ]; then
    [ "$genesis" = "$X1_MAINNET_GENESIS" ] && pass "RPC is X1 mainnet ($genesis)" || die "RPC genesis $genesis is not X1 mainnet; refusing"
  else
    case "$genesis" in
      "$X1_MAINNET_GENESIS"|"$X1_TESTNET_GENESIS") die "local target has X1 mainnet/testnet genesis $genesis; refusing" ;;
    esac
    pass "local genesis $genesis (not X1 mainnet or testnet)"
  fi
  local deployer_pub
  deployer_pub="$(keygen_pubkey "$DEPLOYER")" || die "solana-keygen pubkey failed for DEPLOYER"
  [ "$deployer_pub" = "$AUTHORITY" ] && pass "DEPLOYER pubkey is $AUTHORITY" || fail "DEPLOYER pubkey $deployer_pub is not $AUTHORITY"
  local show onchain_auth
  show="$(show_json)" || die "program show $PROGRAM_ID failed"
  onchain_auth="$(jq -r '.authority' <<<"$show")" || die "cannot parse program show"
  DATA_LEN="$(jq -r '.dataLen' <<<"$show")" || die "cannot parse program show"
  need_uint "$DATA_LEN" "solana program show $PROGRAM_ID (.dataLen)"
  [ "$onchain_auth" = "$AUTHORITY" ] && pass "on-chain upgrade authority is $AUTHORITY" || fail "on-chain upgrade authority is $onchain_auth"
  echo "ProgramData $(jq -r '.programdataAddress' <<<"$show"), data length $DATA_LEN, last deployed in slot $(jq -r '.lastDeploySlot' <<<"$show")"
  SIMD_0431="$(simd_0431_status)" || exit $?
  if [ "$SIMD_0431" = active ]; then
    echo "SIMD-0431 minimum extend ($SIMD_0431_FEATURE): ACTIVE or pending on this cluster; an extend must add at least $MIN_EXTEND_BYTES bytes"
  else
    echo "SIMD-0431 minimum extend ($SIMD_0431_FEATURE): inactive on this cluster; an extend may add any number of bytes"
  fi
  EXTEND_BY=0
  # Authenticate the code on chain before planning anything. `program dump`
  # writes the whole ProgramData payload (data length bytes, including the
  # zero padding an extend adds; see docs/UPGRADE_WITHDRAW_NATIVE.md).
  local dump_class dump_len padding=""
  dump_class="$(dump_and_classify "$TMP/onchain.so" "$DATA_LEN")" || exit $?
  dump_len="$(stat -c %s "$TMP/onchain.so")" || die "stat dump"
  echo "on-chain dump: $dump_len bytes, sha256 $(sha "$TMP/onchain.so") ($dump_class)"
  case "$dump_class" in
    old|old+zero)
      [ "$DATA_LEN" = "$OLD_LEN" ] || padding=" followed by $((DATA_LEN - OLD_LEN)) zero bytes"
      EXTEND_BY="$(extend_amount "$DATA_LEN" "$SIMD_0431")" || exit $?
      need_uint "$EXTEND_BY" "extend_amount"
      if [ "$EXTEND_BY" -gt 0 ]; then
        STATE=extend
        pass "on-chain code is the current build $OLD_SHA$padding; data length $DATA_LEN: extend by $EXTEND_BY bytes, then deploy"
      else
        STATE=extended
        pass "data length $DATA_LEN, current build $OLD_SHA plus zero padding (already extended, not yet deployed): no extend, deploy only"
      fi ;;
    new|new+zero)
      [ "$DATA_LEN" = "$NEW_LEN" ] || padding=" followed by $((DATA_LEN - NEW_LEN)) zero bytes"
      STATE=upgraded; pass "data length $DATA_LEN and the on-chain program is already $NEW_SHA$padding: nothing to do" ;;
    *)
      STATE=refuse
      fail "on-chain code ($dump_class, $dump_len bytes) at data length $DATA_LEN is neither the current build $OLD_SHA nor $NEW_SHA, each followed only by zero bytes; refusing" ;;
  esac

  local buffers
  buffers="$(solana program show --buffers --buffer-authority "$AUTHORITY" --output json)" ||
    die "solana program show --buffers failed"
  buffers="$(jq -r 'if (.buffers | type) == "array" then .buffers[] | "\(.address) \(.lamports)" else error("no .buffers array") end' <<<"$buffers")" ||
    die "cannot parse solana program show --buffers"
  if [ -n "$buffers" ]; then
    echo "WARNING: buffers owned by $AUTHORITY exist (an earlier deploy stopped part-way). Their XNT is recoverable:"
    while read -r addr lamports; do
      echo "  $addr ($lamports lamports): C=\$(mktemp) && solana -C \"\$C\" program close $addr --keypair \"\$DEPLOYER\" --url $URL"
    done <<<"$buffers"
  else
    pass "no leftover buffers owned by $AUTHORITY"
  fi

  NEED=0
  if [ "$STATE" = extend ] || [ "$STATE" = extended ]; then
    local extend_rent=0 buffer_rent balance rent_after rent_before
    if [ "$STATE" = extend ]; then
      rent_after="$(rent_of $((DATA_LEN + EXTEND_BY + 45)))" || exit $?
      rent_before="$(rent_of $((DATA_LEN + 45)))" || exit $?
      [ "$rent_after" -ge "$rent_before" ] || die "rent after the extend ($rent_after) is below the rent now ($rent_before)"
      extend_rent=$((rent_after - rent_before))
    fi
    buffer_rent="$(rent_of $((NEW_LEN + 37)))" || exit $?
    NEED=$((extend_rent + buffer_rent + FEE_MARGIN))
    balance="$(solana balance "$AUTHORITY" --lamports)" || die "solana balance $AUTHORITY --lamports failed"
    balance="$(awk 'NR == 1 {print $1}' <<<"$balance")"
    need_uint "$balance" "solana balance $AUTHORITY --lamports"
    echo "needed: extend rent $extend_rent + temporary buffer $buffer_rent (refunded) + fee margin $FEE_MARGIN = $NEED lamports"
    [ "$balance" -ge "$NEED" ] && pass "DEPLOYER balance $balance >= $NEED lamports" ||
      fail "DEPLOYER balance $balance < $NEED lamports"
  fi
  echo; echo "check: $PASS passed, $FAIL failed (state: $STATE)"
}

# Called as a plain command so errexit applies inside: every command in
# run_checks either succeeds, is an explicit test, or dies.
STATE=refuse
run_checks
if [ "$FAIL" != 0 ] || [ "$STATE" = refuse ]; then
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
  solana program extend "$PROGRAM_ID" "$EXTEND_BY" --keypair "$DEPLOYER" || die "extend failed; rerun check"
  DATA_LEN="$(data_len_now)" || die "program show failed after extend; rerun check"
  [ "$DATA_LEN" -ge "$NEW_LEN" ] || die "data length after extend is $DATA_LEN, below $NEW_LEN; not deploying"
  echo "PASS: data length is now $DATA_LEN"
fi
# Deploy the private copy that the checks verified, if it is still that.
[ "$(sha "$ART")" = "$NEW_SHA" ] || die "the verified artifact copy $ART no longer hashes to $NEW_SHA; not deploying"
echo "deploying $ART (the verified private copy of $SO, sha256 $NEW_SHA)"
if ! solana program deploy "$ART" --program-id "$PROGRAM_ID" \
    --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" --with-compute-unit-price 1000; then
  echo "FAIL: the deploy command exited non-zero. That does NOT prove the old program is still live:"
  echo "  the upgrade transaction may have landed after the client gave up. First rerun"
  echo "    bash scripts/upgrade-withdraw-native.sh check"
  echo "  which authenticates the on-chain code (old or new, with or without zero padding). Then:"
  echo "  any buffer keeps its XNT. With an empty config (so ~/.config/solana is not used):"
  echo "    C=\$(mktemp)"
  echo "    list:   solana -C \"\$C\" program show --buffers --buffer-authority $AUTHORITY --url $URL"
  echo "    close:  solana -C \"\$C\" program close <BUFFER> --keypair \"\$DEPLOYER\" --url $URL"
  echo "    resume: solana-keygen -C \"\$C\" recover -o /abs/buffer.json   (the 12-word phrase printed above), then"
  echo "            sha256sum $SO    (must print $NEW_SHA), then"
  echo "            solana -C \"\$C\" program deploy $SO --buffer /abs/buffer.json --program-id $PROGRAM_ID \\"
  echo "              --keypair \"\$DEPLOYER\" --upgrade-authority \"\$DEPLOYER\" --url $URL --with-compute-unit-price 1000"
  echo "  or simply rerun apply: it sees the extended length and does not extend again."
  exit 1
fi
# The code on chain must now be the new build followed only by zero bytes
# (ProgramData may be longer than the build), over the whole data length.
DATA_LEN="$(data_len_now)" || die "program show failed after deploy; rerun check"
AFTER="$(dump_and_classify "$TMP/onchain.so" "$DATA_LEN")" || die "program dump after deploy failed; rerun check"
case "$AFTER" in
  new|new+zero) ;;
  *) die "on-chain code after deploy is $AFTER (dump sha256 $(sha "$TMP/onchain.so"), data length $DATA_LEN), not $NEW_SHA; rerun check" ;;
esac
echo "PASS: on-chain program hash is $NEW_SHA (first $NEW_LEN of $DATA_LEN bytes; any bytes after are zero)"
[ "$(show_json | jq -r '.authority')" = "$AUTHORITY" ] || die "upgrade authority changed after deploy"
echo "PASS: upgrade authority is still $AUTHORITY"
echo "apply: upgraded $PROGRAM_ID to $NEW_SHA"
