# Upgrade X1 mainnet: add `withdraw_native`

The owner runs every command here. Agents prepare them and don't sign, fund or send anything.

What the upgrade does: it adds one instruction, `withdraw_native(amount)`. With it, the current NFT holder can take native XNT (lamports) from the Fund account above that account's rent-exempt minimum. Lamports reach a fund PDA from outside the program. The "Test" token's reflection bot pays XNT to the owner of each Test token account, and a fund's vault is owned by the fund PDA. Anyone can also send XNT to the PDA. Until this upgrade no instruction can move those lamports.

Nothing else changes:
- every existing instruction, account layout and error code stays the same, and the new error `NativeAboveAvailable` is appended as 6054
- `withdraw_native` touches no vault, budget, target or fund field
- live funds created by the current program keep working; the rehearsal below checks this on a fund created before the upgrade

**When to upgrade.** On 2026-11-12 the fund `AQL1ACxyMnRhMb9r4iN2C4k2SESvRsmA1W2JjsTeubt9` held exactly its rent-exempt minimum: 6,145,680 lamports, so 0 XNT was available. No reflection had reached the fund PDA yet. The upgrade is only useful once XNT arrives there. There is no rush. XNT that arrives before the upgrade stays on the fund account and becomes withdrawable after it, as the rehearsal shows.

## What gets deployed

| Item | Value |
| --- | --- |
| Program ID | `6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM` (upgradeable, unchanged) |
| Upgrade authority | `HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj` (the `DEPLOYER` key) |
| ProgramData | `p1AjEzTvg3uCskJZ2XxtgzQ9o9KmGPDcJz8LxaEwXkv` |
| Current build | `acb6953`, 403,520 bytes, sha256 `d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47` (rebuilt from `git archive acb6953` in a fresh directory: same hash) |
| New build | the reviewed commit (`EXPECT_COMMIT` below), `anchor-1.2.2 build --ignore-keys --arch v0`, Anchor 1.2.2, Agave 4.1.2 CLI |
| New artifact | `target/deploy/fund_nft.so`, **412,528 bytes**, SBPF v0 (ELF e_flags 0), no `sol_get_sysvar` import |
| New sha256 | `a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388` |

## Cost

The rent figures are mainnet `getMinimumBalanceForRentExemption` results, read on 2026-11-12. The local validator returns the same values. The fee figures come from the local rehearsal.

| Item | Lamports | XNT |
| --- | ---: | ---: |
| ProgramData rent now (403,565 bytes) | 2,809,703,280 | 2.8097 |
| ProgramData rent after (412,573 bytes) | 2,872,398,960 | 2.8724 |
| **Extend: rent added, locked for the life of the program** (9,008 bytes) | **62,695,680** | **0.0627** |
| Temporary buffer for the deploy (412,565 bytes), refunded when the deploy completes | 2,872,343,280 | 2.8723 |
| Deploy fees with `--with-compute-unit-price 1000` (rehearsal) | 2,166,296 | 0.0022 |

Peak need during the deploy is the extend rent plus the buffer plus fees, about **2.937 XNT**. Hold at least **3.5 XNT** in `DEPLOYER`. After a successful deploy, `DEPLOYER` is about 0.065 XNT lighter.

A deploy that fails after the buffer is written leaves the buffer funded with 2.8723 XNT. Close it to get the XNT back; see "If `apply` stops part-way".

Two things can change the extend line. `check` prints the real figures and sizes the balance check from them:
- **SIMD-0431** (feature `YbbRLkvenrocjGPGyoQE4wjnvYzTgfsk38NFmcYK7a5`, inactive on X1 mainnet on 2026-11-12) makes the loader refuse an extend of less than 10,240 bytes. If it is active or pending when you run the script, the extend is 10,240 bytes: 71,270,400 lamports (0.0713 XNT) locked, and ProgramData ends at 413,760 bytes.
- **Someone else has extended ProgramData** (see the next section). The extend is then smaller, or not needed.

## Anyone can extend ProgramData

On X1 mainnet the loader does not require the upgrade authority's signature for `ExtendProgram` (`ExtendProgramChecked` is inactive). Any wallet can run `solana program extend 6dmHtar… <bytes>` and pay the rent for it. An extend only appends zero bytes. It cannot change the code, and the program keeps working.

The script therefore identifies the on-chain code by content, not by length. `program dump` must return exactly the ProgramData data length, and then:
- the first 403,520 bytes hash to `d7606fcf…` and every byte after them is zero: this is the current build. If the data length is below 412,528, `apply` extends by what is missing and deploys. Otherwise it deploys only.
- the first 412,528 bytes hash to `a2ae4c9c…` and every byte after them is zero: already upgraded, nothing to do.
- anything else is refused: other code, or a non-zero byte after the build.

After the deploy, `apply` verifies the on-chain code the same way. A third-party extend before, during or after the upgrade no longer stops the script.

One thing it can still do: the loader refuses an extend or a deploy in the same slot as another extend of the same program ("Program was extended in this block already", seen on the local validator for two extends in one slot). If `apply` stops on that, rerun it.

## Rehearsal (local, done before this runbook)

X1 mainnet validators run Agave 4.0.4 (99.97% of stake on 2026-11-12). The rehearsal runs an Agave 4.1.2 test validator with every feature X1 mainnet reports inactive switched off. That is an approximation of X1, not the same runtime. `program extend` has never been run against this program on mainnet.

`scripts/rehearse-upgrade-local.sh` runs the whole upgrade on that loopback validator:
1. It loads the exact `d7606fcf…` artifact as an upgradeable program at the real program id, with a locally generated upgrade authority. ProgramData data length is 403,520, as on mainnet.
2. The old program creates a fund with metadata and takes a deposit, and the keeper runs `execute_dca`.
3. 0.75 XNT is System-transferred to the fund PDA. The old program refuses `withdraw_native` (Anchor 101, `InstructionFallbackNotFound`).
4. The upgrade runs through `scripts/upgrade-withdraw-native.sh` in its local mode, the same `check` and `apply` the owner runs:
   - `check` with the wrong key fails, and `apply` without `--i-understand-mainnet` is refused.
   - Unknown code is refused at any length: the mainnet build with one byte changed, at 403,520, 412,528 and 412,529 bytes; the old build with a non-zero byte in its padding; the new build followed by a non-zero byte. `apply` on these sends nothing.
   - A failing `program dump` is refused, and so is a program id that isn't a program. An unreadable feature status stops `check`, after the on-chain code line has been printed. So does a rent, balance or data length that is not a plain decimal integer in range (a leading zero, 2^63-1, above 10 MiB).
   - On a third instance, `apply` from 403,520 bytes extends by 9,008 and deploys, and a second `apply` is a no-op. Then a key that is not the upgrade authority extends it by 1 byte: `check` still says "already upgraded".
   - Third-party extends before the upgrade: after a 1-byte extend, `apply` extends by 9,007 and deploys. After an extend to 412,628 bytes, `apply` deploys without extending. Both end upgraded.
   - The artifact is overwritten in `target/deploy/` after the checks have passed: `apply` still deploys its verified private copy, and the on-chain code is `a2ae4c9c…`.
   - On the real id, `check` deletes and rebuilds the artifact, sends nothing, and reports "extend by 9008".
   - Then a manual `program extend` simulates an earlier run that stopped after the extend. The old code still executes in that state: a deposit simulates, and `withdraw_native` is still unknown.
   - `apply` then sees "already extended", deploys without extending again, and asserts the on-chain code `a2ae4c9c…`. A further `apply` reports "already upgraded; nothing sent".
5. On that pre-existing fund:
   - the fund data is byte-identical across the upgrade
   - `show` reports 0.75 XNT available
   - `withdraw-native` 0.25, then `all` (0.5), brings the fund to exactly its rent minimum, with fund data unchanged
   - a token withdraw and a second `execute_dca` work, and the budgets still sum to the quote vault
6. After the NFT moves to a second wallet, the old holder gets `BadNft` and the new holder withdraws.
7. Rollback: the dump taken before the upgrade is redeployed with the command in "Rollback". The fund still decodes, a deposit simulates, `withdraw_native` is unknown again, and `check` reports the old build.
8. A second validator with SIMD-0431 active: a 9,008-byte extend is refused, `check` reports the feature and plans 10,240 bytes with the larger rent, and `apply` ends upgraded at 413,760 bytes.

Also checked:
- `solana program deploy` in Agave 4.1.2 **auto-extends** ProgramData when it is too small. On a second instance with no `extend`, it grew 403,520 to 412,528 bytes. The authority paid the rent delta plus fees, 64,750,680 lamports.
- With `--no-auto-extend` and no `extend`, the deploy is refused ("ProgramData account not large enough"). The old program stays in place, but **the funded buffer is left behind**. The rehearsal closes it with the recovery commands below.

Run it yourself (5 to 10 minutes; it builds `acb6953` from `git archive` in its own scratch dir):

```sh
cd ~/X1_PROJECTS/X1_FundNFT     # the reviewed commit, after target/deploy/fund_nft.so is built
REHEARSE_SCRATCH=/tmp/fund-rehearsal \
  EXPECT_NEW_SHA=a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388 \
  bash scripts/rehearse-upgrade-local.sh
# last line: upgrade rehearsal: 210 passed, 0 failed (...)
```

## Steps

Run the upgrade with `scripts/upgrade-withdraw-native.sh`. It fails closed: every check is an assertion, and `apply` reruns all of them before it spends anything. It runs in its own process, so a failure never exits your shell. It reads the keypair only by path, through `solana-keygen pubkey` and as the signer. Every `solana` and `solana-keygen` call it makes passes `-C` with its own temporary config, so `~/.config/solana` is not consulted.

`<REVIEWED_COMMIT>` below is a placeholder. The lead fills in the final reviewed commit before handing this runbook over. Don't run with any other value.

```sh
cd ~/X1_PROJECTS/X1_FundNFT      # a checkout of the reviewed commit
git fetch && git checkout <REVIEWED_COMMIT>
# REPLACE: the absolute path to the upgrade-authority keypair (pubkey HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj).
export DEPLOYER='/absolute/path/to/deployer.json'
# REPLACE: the commit the lead names as reviewed.
export EXPECT_COMMIT='<REVIEWED_COMMIT>'
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# 0. Save the program that is live now (read-only). This file is the
#    rollback. Keep it outside /tmp. The dump is the whole ProgramData
#    payload; the build is its first 403,520 bytes.
C=$(mktemp)
solana -C "$C" program dump 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM \
  "$HOME/fund_nft-pre-upgrade.dump" --url https://rpc.mainnet.x1.xyz
head -c 403520 "$HOME/fund_nft-pre-upgrade.dump" > "$HOME/fund_nft-pre-upgrade.so"
sha256sum "$HOME/fund_nft-pre-upgrade.so"
# must print d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47; if not, stop.

# 1. check (read-only; about 2 minutes, mostly the build).
bash scripts/upgrade-withdraw-native.sh check
```

`check` asserts each of the following, and exits non-zero on any failure:
- Agave 4.1.2 and Anchor 1.2.2.
- `HEAD` is `EXPECT_COMMIT`, and the build inputs (`programs/`, `Cargo.*`, `Anchor.toml`, `rust-toolchain.toml`) have no local changes.
- It deletes `target/deploy/fund_nft.so` and builds again. The fresh artifact must be 412,528 bytes with sha256 `a2ae4c9c…`, ELF e_flags 0, and no `sol_get_sysvar` import.
- The RPC genesis hash is X1 mainnet's, `4SvBP3…`.
- `solana-keygen pubkey "$DEPLOYER"` and the program's on-chain upgrade authority are both `HffqrD7V…`.
- The on-chain code is authenticated before anything is planned. `check` runs `solana program dump`, and a failed dump is refused. The dump must be the whole ProgramData payload, and its content decides the state (see "Anyone can extend ProgramData"):
  - current build `d7606fcf…`, data length below 412,528: `state: extend`. From 403,520 bytes it plans "extend by 9008 bytes, then deploy".
  - current build, data length 412,528 or more: `state: extended`. An earlier run stopped after the extend, or someone else extended. Deploy only.
  - new build `a2ae4c9c…`: `state: upgraded`. Nothing to do.
  - anything else: `state: refuse`.
- The line `PASS: on-chain code authenticated (…): … (state: …)` is printed as soon as the dump is classified, before the feature status, buffers, rent and balance are read.
- It reads whether SIMD-0431 is active (`solana feature status`, read-only) and prints the result. If it is active or pending, the extend is at least 10,240 bytes. If the status can't be read, `check` stops.
- Leftover buffers owned by the authority are listed with their close commands. This is a warning, not a failure.
- The `DEPLOYER` balance covers: extend rent for the planned extend (if any) + temporary buffer rent + a 0.05 XNT fee margin. All rent values come from `getMinimumBalanceForRentExemption`. From 403,520 bytes with a 9,008-byte extend this is 2,985,038,960 lamports, about 2.99 XNT.
- Every number it reads from the CLI (rent, balance, data length) must be a plain decimal integer: no leading zero, at most 18 digits, and a length at most 10 MiB. Otherwise `check` stops and names the command.

Read the whole output. The last line must be `check: N passed, 0 failed (state: extend)`. `state: extended` is also fine: the code is still the current build and ProgramData is already long enough, because an earlier run or someone else extended it.

```sh
# 2. apply (spends XNT, upgrades the program). Reruns step 1, extends only
#    if ProgramData is shorter than the new build, deploys its verified
#    private copy of the artifact with --with-compute-unit-price 1000, then
#    dumps the program and asserts the on-chain code and the authority.
bash scripts/upgrade-withdraw-native.sh apply --i-understand-mainnet
# last line: apply: upgraded 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM to a2ae4c9c...
```

If `apply` stops part-way:
- **It stopped after the extend.** Rerun `apply`. It sees that ProgramData is long enough and deploys without extending again.
- **The deploy command exited non-zero.** That does **not** prove the old program is still live: the upgrade transaction can land after the client has given up waiting. **Rerun `check` first.** It authenticates the on-chain code and tells you which state you are in: `extend`, `extended` or `upgraded`. `apply` also prints the recovery commands, each with an empty `-C` config. A leftover buffer keeps its 2.8723 XNT. Either resume it with the 12-word phrase the CLI printed (`solana-keygen -C "$C" recover`, then `solana -C "$C" program deploy --buffer …`), or close it with `solana -C "$C" program close <BUFFER> --keypair "$DEPLOYER" --url https://rpc.mainnet.x1.xyz` and rerun `apply`.
- **Rerunning after a finished upgrade** prints "already upgraded; nothing sent".

## Post-upgrade checks

Steps 1 to 4 are read-only. Nothing is signed.

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
C=$(mktemp)
URL='https://rpc.mainnet.x1.xyz'
PROGRAM_ID='6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM'
FUND='AQL1ACxyMnRhMb9r4iN2C4k2SESvRsmA1W2JjsTeubt9'

# 1. The code on chain. The build is the first 412,528 bytes of the dump.
solana -C "$C" program dump "$PROGRAM_ID" /tmp/fund_nft-onchain.so --url "$URL"
head -c 412528 /tmp/fund_nft-onchain.so | sha256sum
# a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388
solana -C "$C" program show "$PROGRAM_ID" --url "$URL"    # Authority: HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj

# 2. The fund still decodes: targets, budgets and vaults as before the
#    upgrade, plus the new line "native XNT available to withdraw: ...".
cd ~/X1_PROJECTS/X1_FundNFT/keeper
export RPC_URL="$URL"
npx tsx src/cli.ts show --fund "$FUND"

# 3. The keeper decodes every fund. First line: "dry-run ... N fund accounts,
#    M due targets". No "decode failed" line.
env -u KEYPAIR npx tsx src/index.ts --dry-run

# 4. The existing deposit instruction still runs (simulation only). REPLACE
#    OWNER with a wallet that holds at least 1000 raw units of the quote token.
npx tsx src/cli.ts deposit --fund "$FUND" --amount 1000 --payer "$OWNER"
# expect: simulation: ok, N compute units
```

5. **The keeper's next `execute_dca`.** In the output of the running keeper, wait for the next due target of the fund. Success is the line `executed AQL1ACxy… target N: <signature>`.
   - A failure is the line `fund AQL1ACxy… target N: <error>`. Compare it with the keeper's output from before the upgrade. An error that was already there (for example a price outside the TWAP band) is not caused by the upgrade.
   - If the error is new, or step 2, 3 or 4 fails: stop, keep the output, and roll back (next section).

## Rollback

Rollback redeploys the file saved in step 0, `$HOME/fund_nft-pre-upgrade.so`. ProgramData is already long enough, so there is no extend. It needs about 2.81 XNT for the temporary buffer (refunded) plus fees. The extend rent is not returned.

```sh
sha256sum "$HOME/fund_nft-pre-upgrade.so"
# must print d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47
C=$(mktemp)
solana -C "$C" program deploy "$HOME/fund_nft-pre-upgrade.so" \
  --program-id 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM \
  --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
  --url https://rpc.mainnet.x1.xyz --with-compute-unit-price 1000
solana -C "$C" program dump 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM \
  /tmp/fund_nft-rolled-back.so --url https://rpc.mainnet.x1.xyz
head -c 403520 /tmp/fund_nft-rolled-back.so | sha256sum    # d7606fcf...
```

After a rollback:
- `withdraw_native` is unknown again. XNT on the fund PDA stays there until the next upgrade.
- `bash scripts/upgrade-withdraw-native.sh check` reports `state: extended`, and a later `apply` deploys the new build without extending.

### If the rollback deploy fails part-way

**Never run `apply` to recover a rollback.** `apply` deploys the new build, so it would upgrade again. Don't use the recovery commands `apply` prints either: they name the new artifact.

A deploy command that exited non-zero does not prove which build is live. First classify the live code:

```sh
C=$(mktemp)
URL='https://rpc.mainnet.x1.xyz'
PROGRAM_ID='6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM'
solana -C "$C" genesis-hash --url "$URL"    # 4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN
solana -C "$C" program show "$PROGRAM_ID" --url "$URL" --output json | jq -r '.dataLen, .authority'
# line 1: the data length. line 2: HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj
solana -C "$C" program dump "$PROGRAM_ID" "$HOME/fund_nft-live.dump" --url "$URL"
stat -c %s "$HOME/fund_nft-live.dump"       # must equal the data length above
# Old build?
head -c 403520 "$HOME/fund_nft-live.dump" | sha256sum
# d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47
tail -c +403521 "$HOME/fund_nft-live.dump" | tr -d '\0' | wc -c     # 0
# New build?
head -c 412528 "$HOME/fund_nft-live.dump" | sha256sum
# a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388
tail -c +412529 "$HOME/fund_nft-live.dump" | tr -d '\0' | wc -c     # 0
```

- **Old build** (the first pair matches: hash `d7606fcf…` and `0`): the rollback landed. Nothing more to deploy. Close the leftover buffer, if any, as below.
- **New build** (the second pair matches): the rollback did not land. Continue below.
- **Neither**: stop and ask the lead.

List the buffers. The rollback buffer is the one whose address the failed deploy printed:

```sh
solana -C "$C" program show --buffers \
  --buffer-authority HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj --url "$URL"
```

Then do one of these. Both deploy the same old artifact, and both start with its hash:

```sh
sha256sum "$HOME/fund_nft-pre-upgrade.so"
# must print d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47

# A. Resume with the recovered buffer (the 12-word phrase the failed deploy printed).
solana-keygen -C "$C" recover -o "$HOME/rollback-buffer.json"
solana -C "$C" program deploy "$HOME/fund_nft-pre-upgrade.so" --buffer "$HOME/rollback-buffer.json" \
  --program-id "$PROGRAM_ID" --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
  --url "$URL" --with-compute-unit-price 1000

# B. Or close only the rollback buffer (its XNT comes back), then deploy again.
solana -C "$C" program close <ROLLBACK_BUFFER> --keypair "$DEPLOYER" --url "$URL"
solana -C "$C" program deploy "$HOME/fund_nft-pre-upgrade.so" \
  --program-id "$PROGRAM_ID" --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
  --url "$URL" --with-compute-unit-price 1000
```

Afterwards run the classification again. The old-build pair must match.

If the step 0 file is missing, the same build can be rebuilt from `git archive acb6953` (see "What gets deployed"). Check its sha256 before deploying it.

## If the script refuses: manual deploy

Use this only when both of these hold:
- `check` printed `PASS: on-chain code authenticated (old)` or `(old+zero)`, and every artifact, cluster, key and authority line is a PASS.
- `check` then stopped for a reason you understand and that is not about the code: for example the toolchain or feature-status check fails on a newer CLI.

If that PASS line is missing, or `check` says the on-chain code is unknown (`state: refuse`), don't deploy. Ask the lead.

Then authenticate the live code yourself, right before the deploy. Do not deploy if any of these differ:

```sh
C=$(mktemp)
URL='https://rpc.mainnet.x1.xyz'
PROGRAM_ID='6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM'
solana -C "$C" genesis-hash --url "$URL"    # 4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN
solana -C "$C" program show "$PROGRAM_ID" --url "$URL" --output json | jq -r '.dataLen, .authority'
# line 1: the data length. line 2: HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj
solana -C "$C" program dump "$PROGRAM_ID" "$HOME/fund_nft-live.dump" --url "$URL"
stat -c %s "$HOME/fund_nft-live.dump"       # must equal the data length above
head -c 403520 "$HOME/fund_nft-live.dump" | sha256sum
# must print d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47
tail -c +403521 "$HOME/fund_nft-live.dump" | tr -d '\0' | wc -c
# must print 0 (every byte after the build is zero)
```

Only then, the artifact and the deploy:

```sh
sha256sum target/deploy/fund_nft.so
# must print a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388
cp target/deploy/fund_nft.so "$HOME/fund_nft-new.so" && sha256sum "$HOME/fund_nft-new.so"   # the same hash
solana -C "$C" program deploy "$HOME/fund_nft-new.so" \
  --program-id "$PROGRAM_ID" \
  --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
  --url "$URL" --with-compute-unit-price 1000
```

`program deploy` extends ProgramData itself when it is too small (rehearsed on Agave 4.1.2). Then run "Post-upgrade checks".

## Appendix: the manual commands `apply` runs

These are for reference only. Run the script instead; these lines don't check anything themselves.

```sh
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
URL='https://rpc.mainnet.x1.xyz'
PROGRAM_ID='6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM'
solana genesis-hash --url "$URL"                 # 4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN
solana-keygen pubkey "$DEPLOYER"                 # HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj
solana program show "$PROGRAM_ID" --url "$URL"   # Authority HffqrD7V...; Data Length: 403520 (0x62840) bytes
solana program show --buffers --buffer-authority HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj --url "$URL"
solana feature status YbbRLkvenrocjGPGyoQE4wjnvYzTgfsk38NFmcYK7a5 --url "$URL"   # SIMD-0431: inactive on 2026-11-12
solana program dump "$PROGRAM_ID" /tmp/fund_nft-before.so --url "$URL"         # authenticated by content
solana program extend "$PROGRAM_ID" 9008 --keypair "$DEPLOYER" --url "$URL"   # 412528 - data length; locks 0.0627 XNT
solana program deploy <private copy of target/deploy/fund_nft.so> --program-id "$PROGRAM_ID" \
  --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" --url "$URL" --with-compute-unit-price 1000
solana program dump "$PROGRAM_ID" /tmp/fund_nft-onchain.so --url "$URL"
head -c 412528 /tmp/fund_nft-onchain.so | sha256sum   # a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388
```

The script passes `-C <its own config>` on every one of these calls. The extend amount is `max(0, 412528 - data length)`, raised to 10,240 when SIMD-0431 is active or pending.

Without the extend, Agave 4.1.2's `program deploy` would auto-extend, as the rehearsal showed. `apply` extends explicitly so the rent change is visible and checked.

## First withdraw-native on mainnet

**The owner's fund NFT is in X1 Wallet, which has no keypair file, so the CLI cannot sign for it.** Use the web app's "Withdraw native XNT" action on the fund page. Like the other app actions, it simulates first and shows a review before Sign & send. The CLI steps below are for holders whose NFT sits in a keypair-file wallet. Their `show` and simulate-only steps also work for anyone, with no key.

The fund `AQL1ACxyMnRhMb9r4iN2C4k2SESvRsmA1W2JjsTeubt9` holds Test and receives the reflections. `--amount all` is the Fund account's lamports minus the rent-exempt minimum for its data length. Every Fund account is 755 bytes (space for 8 targets), and that minimum is 6,145,680 lamports.

As of 2026-11-12 the fund held exactly that minimum, so 0 XNT was available (see "When to upgrade"). Until XNT arrives, `--amount all` stops client-side with "has no native XNT above its rent-exempt minimum". Check with `show` first.

```sh
cd ~/X1_PROJECTS/X1_FundNFT/keeper
npm ci
export RPC_URL='https://rpc.mainnet.x1.xyz'
FUND='AQL1ACxyMnRhMb9r4iN2C4k2SESvRsmA1W2JjsTeubt9'
# REPLACE with the wallet that holds the fund NFT (base58 pubkey).
OWNER='REPLACE_WITH_OWNER_PUBKEY'
# REPLACE with the absolute path to that wallet's keypair file.
OWNER_KEYPAIR='/absolute/path/to/owner.json'
SEND=(--send --cluster mainnet --i-understand-mainnet)

# 1. How much is there. Last line: native XNT available to withdraw: X
npx tsx src/cli.ts show --fund "$FUND"

# 2. Simulate (no keypair loaded, nothing signed or sent). Check "holder" is
#    OWNER, no "does not hold the fund NFT" warning, and "simulation: ok".
npx tsx src/cli.ts withdraw-native --fund "$FUND" --amount all --payer "$OWNER"

# 3. Send. Guarded: needs KEYPAIR, --cluster mainnet matching the genesis hash,
#    --i-understand-mainnet, and --payer must equal KEYPAIR's pubkey.
KEYPAIR="$OWNER_KEYPAIR" npx tsx src/cli.ts withdraw-native --fund "$FUND" --amount all \
  --payer "$OWNER" "${SEND[@]}"

# 4. Check: available is 0 again; vaults and budgets are as in step 1.
npx tsx src/cli.ts show --fund "$FUND"
```

`--amount <lamports>` takes a raw amount; 1 XNT is 1,000,000,000. The CLI refuses an amount above what is available, and so does the program (`NativeAboveAvailable`, 6054).

Above 2^53 − 1 lamports (about 9,007,199 XNT), a JS number can't hold the balance exactly:
- `show` prints "balance too large to display exactly"
- `--amount all` is refused
- an explicit `--amount <lamports>` is sent without the client-side check, and the program still enforces the rent floor

## Trust notes

- **No trust added.** The upgrade adds no new program, authority or CPI. `withdraw_native` moves lamports only from the Fund account, only to the signer, and only when the signer passes the same holder check as `withdraw`: NFT supply 1, the holder's account holds it, classic SPL Token. It always leaves the rent-exempt minimum.
- **What the holder already controls.** Native XNT on the PDA was unreachable before. After the upgrade it belongs to whoever holds the NFT, like the vault tokens.
- **The upgrade authority** stays `HffqrD7V…`. Freezing it is a separate decision; see `DEPLOY_MAINNET.md`.
