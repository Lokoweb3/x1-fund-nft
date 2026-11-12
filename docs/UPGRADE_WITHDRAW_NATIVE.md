# Upgrade X1 mainnet: add `withdraw_native`

DRAFT. The owner runs every command here. Agents prepare them and don't sign, fund or send anything.

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
| New build | branch `withdraw-native`, `anchor-1.2.2 build --ignore-keys --arch v0`, Anchor 1.2.2, Agave 4.1.2 |
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

## Rehearsal (local, done before this runbook)

`scripts/rehearse-upgrade-local.sh` runs the whole upgrade on a loopback validator in X1 feature mode:
1. It loads the exact `d7606fcf…` artifact as an upgradeable program at the real program id, with a locally generated upgrade authority. ProgramData data length is 403,520, as on mainnet.
2. The old program creates a fund with metadata and takes a deposit, and the keeper runs `execute_dca`.
3. 0.75 XNT is System-transferred to the fund PDA. The old program refuses `withdraw_native` (Anchor 101, `InstructionFallbackNotFound`).
4. The upgrade runs through `scripts/upgrade-withdraw-native.sh` in its local mode, the same `check` and `apply` the owner runs:
   - `check` with the wrong key fails, and `apply` without `--i-understand-mainnet` is refused.
   - A fourth instance holds unknown code of the old size: the mainnet build with one byte changed. `check` refuses it at 403,520 bytes, and refuses it again at 412,528 after a manual extend. `apply` on it sends nothing.
   - A failing `program dump` is refused, and so is a program id that isn't a program.
   - On a third instance, `apply` from 403,520 bytes extends by 9,008 and deploys, and a second `apply` is a no-op.
   - On the real id, `check` deletes and rebuilds the artifact, sends nothing, and reports "extend by 9008".
   - Then a manual `program extend` simulates an earlier run that stopped after the extend. The old code still executes in that state: a deposit simulates, and `withdraw_native` is still unknown.
   - `apply` then sees "already extended", deploys without extending again, and asserts the dumped hash `a2ae4c9c…`. A further `apply` reports "already upgraded; nothing sent".
5. On that pre-existing fund:
   - the fund data is byte-identical across the upgrade
   - `show` reports 0.75 XNT available
   - `withdraw-native` 0.25, then `all` (0.5), brings the fund to exactly its rent minimum, with fund data unchanged
   - a token withdraw and a second `execute_dca` work, and the budgets still sum to the quote vault
6. After the NFT moves to a second wallet, the old holder gets `BadNft` and the new holder withdraws.

Also checked:
- `solana program deploy` in Agave 4.1.2 **auto-extends** ProgramData when it is too small. On a second instance with no `extend`, it grew 403,520 to 412,528 bytes. The authority paid the rent delta plus fees, 64,750,680 lamports.
- With `--no-auto-extend` and no `extend`, the deploy is refused ("ProgramData account not large enough"). The old program stays in place, but **the funded buffer is left behind**. The rehearsal closes it with the recovery commands below.

Run it yourself (about 10 minutes; it builds `acb6953` from `git archive` in its own scratch dir):

```sh
cd ~/X1_PROJECTS/X1_FundNFT     # the reviewed commit, after target/deploy/fund_nft.so is built
REHEARSE_SCRATCH=/tmp/fund-rehearsal \
  EXPECT_NEW_SHA=a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388 \
  bash scripts/rehearse-upgrade-local.sh
# last line: upgrade rehearsal: 99 passed, 0 failed (...)
```

## Steps

Run the upgrade with `scripts/upgrade-withdraw-native.sh`. It fails closed: every check is an assertion, and `apply` reruns all of them before it spends anything. It runs in its own process, so a failure never exits your shell. It reads the keypair only by path, through `solana-keygen pubkey` and as the signer. Every `solana` and `solana-keygen` call it makes passes `-C` with its own temporary config, so `~/.config/solana` is not consulted.

```sh
cd ~/X1_PROJECTS/X1_FundNFT      # a checkout of the reviewed commit
git fetch && git checkout <REVIEWED_COMMIT>
# REPLACE: the absolute path to the upgrade-authority keypair (pubkey HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj).
export DEPLOYER='/absolute/path/to/deployer.json'
# REPLACE: the commit the lead names as reviewed.
export EXPECT_COMMIT='<REVIEWED_COMMIT>'

# 1. check (read-only; about 2 minutes, mostly the build).
bash scripts/upgrade-withdraw-native.sh check
```

`check` asserts each of the following, and exits non-zero on any failure:
- Agave 4.1.2 and Anchor 1.2.2.
- `HEAD` is `EXPECT_COMMIT`, and the build inputs (`programs/`, `Cargo.*`, `Anchor.toml`, `rust-toolchain.toml`) have no local changes.
- It deletes `target/deploy/fund_nft.so` and builds again. The fresh artifact must be 412,528 bytes with sha256 `a2ae4c9c…`, ELF e_flags 0, and no `sol_get_sysvar` import.
- The RPC genesis hash is X1 mainnet's, `4SvBP3…`.
- `solana-keygen pubkey "$DEPLOYER"` and the program's on-chain upgrade authority are both `HffqrD7V…`.
- The on-chain code is authenticated before anything is planned. `check` runs `solana program dump`, and a failed dump is refused. The dump is the whole ProgramData payload: after an extend it is the full 412,528 bytes, including the zero padding, as observed in the rehearsal. Only three cases are accepted:
  - data length 403,520 and the dump's sha256 is the current build `d7606fcf…`: it plans "extend by 9008, then deploy"
  - data length 412,528 and the first 403,520 bytes hash to `d7606fcf…` with the remaining 9,008 bytes all zero: "already extended, not yet deployed", i.e. an earlier run stopped after the extend; deploy only
  - data length 412,528 and the dump's sha256 is `a2ae4c9c…`: "already upgraded: nothing to do"
  Anything else is refused: another length, or unknown code at either length.
- Leftover buffers owned by the authority are listed with their close commands. This is a warning, not a failure.
- The `DEPLOYER` balance covers: extend rent (if needed) + temporary buffer rent + a 0.05 XNT fee margin. All rent values come from `getMinimumBalanceForRentExemption`. From 403,520 bytes this is 2,985,038,960 lamports, about 2.99 XNT.

Read the whole output. The last line must be `check: N passed, 0 failed (state: extend)`.

```sh
# 2. apply (spends XNT, upgrades the program). Reruns step 1, extends only
#    from 403,520 bytes, deploys with --with-compute-unit-price 1000, then
#    dumps the program and asserts the on-chain hash and the authority.
bash scripts/upgrade-withdraw-native.sh apply --i-understand-mainnet
# last line: apply: upgraded 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM to a2ae4c9c...
```

If `apply` stops part-way:
- **It stopped after the extend.** Rerun `apply`. It sees 412,528 bytes and deploys without extending again.
- **The deploy command exited non-zero.** That does **not** prove the old program is still live: the upgrade transaction can land after the client has given up waiting. **Rerun `check` first.** It authenticates the on-chain code and tells you which state you are in: old, old plus padding, or already new. `apply` also prints the recovery commands, each with an empty `-C` config. A leftover buffer keeps its 2.8723 XNT. Either resume it with the 12-word phrase the CLI printed (`solana-keygen -C "$C" recover`, then `solana -C "$C" program deploy --buffer …`), or close it with `solana -C "$C" program close <BUFFER> --keypair "$DEPLOYER" --url https://rpc.mainnet.x1.xyz` and rerun `apply`.
- **Rerunning after a finished upgrade** prints "already upgraded; nothing sent".

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
solana program extend "$PROGRAM_ID" 9008 --keypair "$DEPLOYER" --url "$URL"   # 412528 - 403520; locks 0.0627 XNT
solana program deploy target/deploy/fund_nft.so --program-id "$PROGRAM_ID" \
  --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" --url "$URL" --with-compute-unit-price 1000
solana program dump "$PROGRAM_ID" /tmp/fund_nft-onchain.so --url "$URL"
sha256sum /tmp/fund_nft-onchain.so               # a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388
```

Without the extend, Agave 4.1.2's `program deploy` would auto-extend, as the rehearsal showed. `apply` extends explicitly so the rent change is visible and checked.

## First withdraw-native on mainnet

**The owner's fund NFT is in X1 Wallet, which has no keypair file, so the CLI cannot sign for it.** Use the web app's "Withdraw native XNT" action on the fund page. That action is being added on another branch. Like the other app actions, it simulates first and shows a review before Sign & send. The CLI steps below are for holders whose NFT sits in a keypair-file wallet. Their `show` and simulate-only steps also work for anyone, with no key.

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
