# Upgrade X1 mainnet: add `withdraw_native`

DRAFT. The owner runs every command here. Agents prepare them and don't sign, fund or send anything.

What the upgrade does: it adds one instruction, `withdraw_native(amount)`. With it, the current NFT holder can take native XNT (lamports) from the Fund account above that account's rent-exempt minimum. Lamports reach a fund PDA from outside the program. The "Test" token's reflection bot pays XNT to the owner of each Test token account, and a fund's vault is owned by the fund PDA. Anyone can also send XNT to the PDA. Until this upgrade no instruction can move those lamports.

Nothing else changes:
- every existing instruction, account layout and error code stays the same, and the new error `NativeAboveAvailable` is appended as 6054
- `withdraw_native` touches no vault, budget, target or fund field
- live funds created by the current program keep working; the rehearsal below checks this on a fund created before the upgrade

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

A deploy that fails after the buffer is written leaves the buffer funded with 2.8723 XNT. Close it to get the XNT back; see step 5.

## Rehearsal (local, done before this runbook)

`scripts/rehearse-upgrade-local.sh` runs the whole upgrade on a loopback validator in X1 feature mode:
1. It loads the exact `d7606fcf…` artifact as an upgradeable program at the real program id, with a locally generated upgrade authority. ProgramData data length is 403,520, as on mainnet.
2. The old program creates a fund with metadata and takes a deposit, and the keeper runs `execute_dca`.
3. 0.75 XNT is System-transferred to the fund PDA. The old program refuses `withdraw_native` (Anchor 101, `InstructionFallbackNotFound`).
4. The upgrade goes as below: `program show`, then `program extend <id> 9008`, then `program deploy … --with-compute-unit-price 1000`. The dump hash after the deploy equals `a2ae4c9c…`.
5. On that pre-existing fund:
   - the fund data is byte-identical across the upgrade
   - `show` reports 0.75 XNT available
   - `withdraw-native` 0.25, then `all` (0.5), brings the fund to exactly its rent minimum, with fund data unchanged
   - a token withdraw and a second `execute_dca` work, and the budgets still sum to the quote vault
6. After the NFT moves to a second wallet, the old holder gets `BadNft` and the new holder withdraws.

Also checked:
- `solana program deploy` in Agave 4.1.2 **auto-extends** ProgramData when it is too small. On a second instance with no `extend`, it grew 403,520 to 412,528 bytes. The authority paid the rent delta plus fees, 64,750,680 lamports.
- With `--no-auto-extend` and no `extend`, the deploy is refused ("ProgramData account not large enough"). The old program stays in place, but **the funded buffer is left behind**. The recovery in step 5 closes it.

Run it yourself (about 6 minutes; it builds `acb6953` from `git archive` in its own scratch dir):

```sh
cd ~/X1_PROJECTS/X1_FundNFT     # on branch withdraw-native, after the build in step 1
REHEARSE_SCRATCH=/tmp/fund-rehearsal \
  EXPECT_NEW_SHA=a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388 \
  bash scripts/rehearse-upgrade-local.sh
# last line: upgrade rehearsal: 64 passed, 0 failed (...)
```

## Steps

```sh
cd ~/X1_PROJECTS/X1_FundNFT
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
URL='https://rpc.mainnet.x1.xyz'
PROGRAM_ID='6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM'
AUTHORITY='HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj'
# REPLACE the path below with the absolute path to the upgrade-authority keypair.
DEPLOYER='/absolute/path/to/deployer.json'
test -f "$DEPLOYER" || echo "DEPLOYER is not a file: fix it before continuing"

# 1. Build the reviewed commit and compare the hash with the table above.
git status --short                      # must be clean
git rev-parse --abbrev-ref HEAD         # withdraw-native (or main after it is merged)
~/.avm/bin/anchor-1.2.2 build --ignore-keys --arch v0
stat -c %s target/deploy/fund_nft.so    # 412528
sha256sum target/deploy/fund_nft.so     # a2ae4c9cedeb413a274dd93c7afb095ad88a6082d40f4f0aad4a53f7cab13388
strings target/deploy/fund_nft.so | grep sol_get_sysvar   # must print nothing

# 2. Check the network, the authority and the balance.
solana genesis-hash --url "$URL"                  # must be 4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN
solana-keygen pubkey "$DEPLOYER"                  # must be $AUTHORITY
solana balance --keypair "$DEPLOYER" --url "$URL" # >= 3.5 XNT
solana program show "$PROGRAM_ID" --url "$URL"
#   Authority: HffqrD7V3SK5e15cALv2tJAZKUJN2FGrxBq72kvnmWGj
#   ProgramData Address: p1AjEzTvg3uCskJZ2XxtgzQ9o9KmGPDcJz8LxaEwXkv
#   Data Length: 403520 (0x62840) bytes
solana program show --buffers --keypair "$DEPLOYER" --url "$URL"   # note any old buffers

# 3. Extend ProgramData by exactly new length - current length.
#    9008 = 412528 - 403520. Recompute if step 2 showed another Data Length.
#    This locks 0.0627 XNT of rent. The old code keeps running until step 4.
solana program extend "$PROGRAM_ID" 9008 --keypair "$DEPLOYER" --url "$URL"
solana program show "$PROGRAM_ID" --url "$URL"   # Data Length: 412528 (0x64b70) bytes

# 4. Deploy (upgrade). Without step 3 this would auto-extend anyway (Agave
#    4.1.2 default); the explicit extend keeps the rent change visible.
solana program deploy target/deploy/fund_nft.so \
  --program-id "$PROGRAM_ID" \
  --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
  --url "$URL" --with-compute-unit-price 1000

# 5. Only if step 4 stopped part-way. The buffer keeps its 2.8723 XNT. Either
#    resume: recover the buffer keypair from the 12-word phrase the CLI
#    printed, then deploy again with --buffer:
#      solana-keygen recover -o /absolute/path/buffer.json
#      solana program deploy target/deploy/fund_nft.so --buffer /absolute/path/buffer.json \
#        --program-id "$PROGRAM_ID" --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
#        --url "$URL" --with-compute-unit-price 1000
#    or give up and get the XNT back:
#      solana program show --buffers --keypair "$DEPLOYER" --url "$URL"
#      solana program close <BUFFER> --keypair "$DEPLOYER" --url "$URL"
#    The old program keeps running until a deploy completes.

# 6. Verify on chain.
solana program show "$PROGRAM_ID" --url "$URL"
#   Authority must still be $AUTHORITY; Data Length 412528; Last Deployed In Slot is new
solana program dump "$PROGRAM_ID" /tmp/fund_nft-onchain.so --url "$URL"
sha256sum /tmp/fund_nft-onchain.so target/deploy/fund_nft.so   # both a2ae4c9c...
solana program show --buffers --keypair "$DEPLOYER" --url "$URL"   # no new buffer left
```

## First withdraw-native on mainnet

The fund `AQL1ACxyMnRhMb9r4iN2C4k2SESvRsmA1W2JjsTeubt9` holds Test and receives the reflections. The command simulates first and loads no keypair. Read the summary before you add the send flags. `--amount all` is the Fund account's lamports minus the rent-exempt minimum for its data length. Every Fund account is 755 bytes (space for 8 targets), and that minimum is 6,145,680 lamports.

As of a read on 2026-11-12, this fund held exactly 6,145,680 lamports: its rent minimum, so 0 XNT was available. No reflection had reached the PDA yet. Until XNT arrives, `--amount all` stops client-side with "has no native XNT above its rent-exempt minimum". Check with `show` first.

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

`--amount <lamports>` takes a raw amount; 1 XNT is 1,000,000,000. The CLI refuses an amount above what is available, and so does the program (`NativeAboveAvailable`, 6054). It also refuses `all` when the balance is too large for a JS number to hold exactly, above about 9,007,199 XNT; pass raw lamports then.

## Trust notes

- **No trust added.** The upgrade adds no new program, authority or CPI. `withdraw_native` moves lamports only from the Fund account, only to the signer, and only when the signer passes the same holder check as `withdraw`: NFT supply 1, the holder's account holds it, classic SPL Token. It always leaves the rent-exempt minimum.
- **What the holder already controls.** Native XNT on the PDA was unreachable before. After the upgrade it belongs to whoever holds the NFT, like the vault tokens.
- **The upgrade authority** stays `HffqrD7V…`. Freezing it is a separate decision; see `DEPLOY_MAINNET.md`.
