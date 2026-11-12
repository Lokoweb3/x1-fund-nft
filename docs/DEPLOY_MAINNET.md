# Deploy to X1 mainnet: owner-only canary

The owner runs every command here. Agents prepare them and don't sign, fund or send anything.

Scope: an owner-only canary. Use small amounts and the owner's own funds only. Don't announce it, and don't take outside deposits, until the canary has run and the trust notes below are accepted.

Review status: independent dual review. The lead and Codex reviewed separately over three rounds, and Codex approves this scope. Every finding is labelled "confirmed by code review and models". See `ASSUMPTIONS.md`.

## What gets deployed

| Item | Value |
| --- | --- |
| Program ID | `6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM` (keypair `keys/fund_nft-mainnet.json`, owner-held, gitignored) |
| Build | `anchor build --ignore-keys --arch v0` with Anchor 1.2.2, Agave 4.1.2, platform-tools v1.57, Rust 1.89.0 |
| Artifact | `target/deploy/fund_nft.so`, 403,520 bytes, SBPF v0 (ELF e_flags 0), no `sol_get_sysvar` import |
| sha256 | `d7606fcf12fb6489a95b3c7c2601725a53a37b6491b2521c0a9287db48cd2c47` (lead build with the attach payer owner/data/debit guard, 2026-11-12; rebuild and compare) |
| XDEX program allowed | `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` (default build, no `testnet` feature) |
| Token Metadata allowed | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` (both builds) |

The artifact grew from 312,136 bytes when NFT metadata was added (`attach_metadata`, `update_metadata`, and `anchor-spl`'s `metadata` feature). The earlier hash `07eb8f02…` no longer applies.

Why v0: X1 mainnet has SBPF v1 and v3 deployment inactive. Anchor 1.2.2 defaults to v3, and X1's feature set rejects that.

## Cost

Rent on mainnet, read on 2026-11-12:
- program data, 403,565 bytes: **2.8097 XNT**, locked for the life of the program (was 2.1737 XNT at 312,181 bytes)
- program account: 0.0011 XNT

During the deploy a temporary buffer of the same size is also funded. It is refunded when the deploy finishes. Hold about **6 XNT** in the deployer wallet.

Per fund, `attach_metadata` costs the NFT holder about **0.0161 XNT**: the metadata account (rent plus Token Metadata's 0.01 creation fee) and the master edition. Figures are from the cloned program; see `ASSUMPTIONS.md`.

## Steps

```sh
cd ~/X1_PROJECTS/X1_FundNFT
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
URL='https://rpc.mainnet.x1.xyz'
PROGRAM_ID='6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM'
# REPLACE the path below with the absolute path to your deployer keypair.
# This key becomes the upgrade authority.
DEPLOYER='/absolute/path/to/deployer.json'
test -f "$DEPLOYER" || echo "DEPLOYER is not a file: fix it before continuing"

# 1. Rebuild and compare the hash with the table above.
anchor build --ignore-keys --arch v0     # use the Anchor 1.2.2 binary (~/.avm/bin/anchor-1.2.2)
sha256sum target/deploy/fund_nft.so
solana-keygen pubkey keys/fund_nft-mainnet.json   # must print $PROGRAM_ID

# 2. Check the network, the deployer and the balance.
solana genesis-hash --url "$URL"                  # must be 4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN
solana-keygen pubkey "$DEPLOYER"                  # the address that will be upgrade authority
solana balance --keypair "$DEPLOYER" --url "$URL" # ≥ 5 XNT
solana program show "$PROGRAM_ID" --url "$URL"    # must say not found

# 3. Deploy.
solana program deploy target/deploy/fund_nft.so \
  --program-id keys/fund_nft-mainnet.json \
  --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" \
  --url "$URL" --with-compute-unit-price 1000

# If it stops part-way, the buffer keeps its XNT. Recover it with:
#   solana program show --buffers --keypair "$DEPLOYER" --url "$URL"
#   solana program close <BUFFER> --keypair "$DEPLOYER" --url "$URL"

# 4. Verify on chain. Authority must be the pubkey printed in step 2.
solana program show "$PROGRAM_ID" --url "$URL"
solana program dump "$PROGRAM_ID" /tmp/fund_nft-onchain.so --url "$URL"
sha256sum /tmp/fund_nft-onchain.so target/deploy/fund_nft.so   # must match
```

Freezing is **not** part of the canary. Do it only later, after the canary has run, and only when you have decided the code is final. It is irreversible: no more fixes, ever. Immediately before it, rerun the genesis-hash and `program show` checks from steps 2 and 4, then:

```sh
solana program set-upgrade-authority "$PROGRAM_ID" --final \
  --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" --url "$URL"
solana program show "$PROGRAM_ID" --url "$URL"   # Authority must now be none
```

After deploying, back up `keys/fund_nft-mainnet.json` and the deployer keypair offline. The deployer is the upgrade authority.

## Canary walkthrough

Run this after the deploy has been verified. Use the owner's own wallet and small amounts. The fund below is USDC.X with a 20% cash slice and 80% TEST through the USDC.X/TEST pool; swap in the real basket. Each step is simulated first. Read the summary and the simulation logs before adding the send flags.

Alternative to the CLI: the local web app (`cd app && npm ci && npm run dev`, see `app/README.md`) does steps 1–4 and 6 with a browser wallet, using the same builders and checks. It shows the red mainnet banner and needs the "I understand this is X1 mainnet and uses real funds" tick. It simulates every transaction and shows a review before **Sign & send**. Step 5 stays in the keeper: the app only shows the `--dry-run` command.

The same canary in the app's **Create fund** wizard:

1. **Pay with**: paste `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` (or press USDC.X). Check that it says USDC.X, 6 decimals, Token-2022, allowed by the fund program, and your balance.
2. **Buy**: paste `C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz` (TEST). The app finds the pool from chain data; check that it picked `7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD` and that the depth says "deep enough". Share 80%, so 20% is kept as cash.
3. **How much and how often**: 0.1 per buy, every hour. Leave **Advanced** at 3600 s / 300 bps.
4. **The NFT**: name, symbol and a picture. Either paste a metadata uri you host (option b or c), or inscribe the JSON (option a, about 0.52 XNT, from a separate wallet holding about 0.53 XNT, because signing gives the third-party inscription program access to that wallet's whole XNT balance; copy the uri, switch back to the owner wallet, and paste it with option c). With an inscription as art, press **Check** and read the warnings. Attaching the metadata costs about 0.016 XNT; the program refuses more than 0.03 XNT.
5. **Review**: read the sentences ("Every 1 hour this fund spends 0.08 USDC.X on TEST…") and **Technical details**. Before the program is deployed this stops at "program … is not deployed on this RPC". With metadata it is three transactions; tx 2 (`attach_metadata`) is "not simulated yet" and is simulated by the RPC's preflight when sent, as in step 2 below.
6. On the fund page: deposit, read "Next buy of TEST …", withdraw. If a create transaction did not land, use **Set image / edit metadata** and **Ensure vaults** there (steps 2a and 2b).

The app talks only to the RPC, explorer links you click, and, only after **Check**, `www.x1inscriptions.io` and `<n>.x1ins.xyz` (see `app/README.md`).

```sh
cd ~/X1_PROJECTS/X1_FundNFT/keeper
npm ci
export RPC_URL='https://rpc.mainnet.x1.xyz'
# REPLACE with the owner's wallet address (base58 pubkey).
OWNER='REPLACE_WITH_OWNER_PUBKEY'
# REPLACE with the absolute path to the owner's keypair file.
OWNER_KEYPAIR='/absolute/path/to/owner.json'
USDC='B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq'
TEST='C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz'
POOL='7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD'
SEND=(--send --cluster mainnet --i-understand-mainnet)
test -f "$OWNER_KEYPAIR" || echo "OWNER_KEYPAIR is not a file: fix it before continuing"
# Every send also passes --payer "$OWNER", so the CLI refuses if KEYPAIR is another key.

# 1. Simulate create-fund. No keypair is loaded. Check the bounds, the pool
#    check, the summary, and "simulation: ok" for both transactions.
npx tsx src/cli.ts create-fund --quote "$USDC" \
  --target "$USDC:default:2000" --target "$TEST:$POOL:8000" \
  --per-run 100000 --interval 3600 --window 3600 --max-dev-bps 300 --payer "$OWNER"

# 2. Create a small fund with NFT metadata. The NFT mint is new on every
#    run, so copy the fund PDA printed by this run. This is three
#    transactions, not one atomic step: create_fund + quote vault, then
#    attach_metadata, then the target vaults. attach_metadata needs the fund
#    from the first one, so it is size-checked but only simulated by the RPC
#    when it is sent. If a later one is not sent, the output lists what did
#    confirm and prints the set-metadata and ensure-vaults commands to run
#    next (steps 2a and 2b). Without --name/--symbol/--uri it is two
#    transactions and the NFT has no metadata until step 2a.
# REPLACE the uri with your hosted metadata JSON (name, symbol, image, ...).
NFT_URI='https://REPLACE_WITH_YOUR_HOST/fund-nft.json'
NFT_NAME='X1 Fund NFT'   # at most 32 bytes
NFT_SYMBOL='XFUND'       # at most 10 bytes
KEYPAIR="$OWNER_KEYPAIR" npx tsx src/cli.ts create-fund --quote "$USDC" \
  --target "$USDC:default:2000" --target "$TEST:$POOL:8000" \
  --per-run 100000 --interval 3600 --window 3600 --max-dev-bps 300 \
  --name="$NFT_NAME" --symbol="$NFT_SYMBOL" --uri="$NFT_URI" \
  --payer "$OWNER" "${SEND[@]}"
# REPLACE with the fund PDA printed above.
FUND='REPLACE_WITH_FUND_PDA'

# 2a. Attach the NFT metadata (NFT holder only). Use this when the fund was
#     created without metadata or its attach transaction failed. Attaching
#     needs all three fields. Attach debits the holder about 0.016 XNT; the
#     program refuses any attach that takes more than 0.03 XNT.
npx tsx src/cli.ts set-metadata --fund "$FUND" \
  --name="$NFT_NAME" --symbol="$NFT_SYMBOL" --uri="$NFT_URI" --payer "$OWNER"
KEYPAIR="$OWNER_KEYPAIR" npx tsx src/cli.ts set-metadata --fund "$FUND" \
  --name="$NFT_NAME" --symbol="$NFT_SYMBOL" --uri="$NFT_URI" --payer "$OWNER" "${SEND[@]}"

# 2a'. Change existing metadata later: give only the fields that change.
KEYPAIR="$OWNER_KEYPAIR" npx tsx src/cli.ts set-metadata --fund "$FUND" \
  --uri="$NFT_URI" --payer "$OWNER" "${SEND[@]}"

# 2b. Create any missing quote/target vault ATAs. Idempotent: if step 2
#     completed it only reports that every vault exists.
npx tsx src/cli.ts ensure-vaults --fund "$FUND" --payer "$OWNER"
KEYPAIR="$OWNER_KEYPAIR" npx tsx src/cli.ts ensure-vaults --fund "$FUND" --payer "$OWNER" "${SEND[@]}"

# 3. Deposit a small amount (1 USDC.X = 1000000 raw). Simulate, then send.
npx tsx src/cli.ts deposit --fund "$FUND" --amount 1000000 --payer "$OWNER"
KEYPAIR="$OWNER_KEYPAIR" npx tsx src/cli.ts deposit --fund "$FUND" --amount 1000000 \
  --payer "$OWNER" "${SEND[@]}"

# 4. Show: budgets 0.2 cash / 0.8 TEST, the TEST target "due now", the
#    quote vault at 1 USDC.X and the TEST vault at 0.
npx tsx src/cli.ts show --fund "$FUND"

# 5. Crank: the keeper dry-run must list this fund's TEST target and print
#    the execute_dca accounts. Whether the keeper sends on mainnet is the
#    owner's call (see "Keeper on mainnet").
env -u KEYPAIR npx tsx src/index.ts --dry-run

# 6. Withdraw. Quote first; a quote withdraw shrinks the budgets in
#    proportion. After a crank, withdraw TEST the same way with --mint "$TEST".
npx tsx src/cli.ts withdraw --fund "$FUND" --mint "$USDC" --amount all --payer "$OWNER"
KEYPAIR="$OWNER_KEYPAIR" npx tsx src/cli.ts withdraw --fund "$FUND" --mint "$USDC" --amount all \
  --payer "$OWNER" "${SEND[@]}"
npx tsx src/cli.ts show --fund "$FUND"
```

Before the deploy, step 1 fails with `program 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM is not deployed on this RPC (https://rpc.mainnet.x1.xyz, mainnet)`. The CLI reaches that point only after the local bound checks and the pool check have passed.

## Trust the canary relies on

- **Upgrade authority.** The deployer key can replace the program, including with code that moves every vault. Before outside users deposit, move it to a multisig, or freeze it (see the freeze section above, which is irreversible).
- **Token issuers.** The mint-extension allowlist blocks permanent delegates, hooks and similar extensions. It does not remove ordinary issuer power. A mint's freeze authority can freeze a fund's vault, and its mint authority can inflate supply. A Token-2022 transfer-fee authority can change both the fee rate and its maximum-fee cap for future epochs (taking effect two epochs after the change), potentially charging 100% of a transfer. The current fee cap is not a permanent protection. Check these authorities on each mint you put in a fund.
- **Token programs.** X1 Token-2022 (`TokenzQd…`) is upgradeable, with authority `2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7` (read on 2026-11-12). Its upgrade key can change how every Token-2022 vault behaves. The program allowlists that ID, not its code. Classic Tokenkeg is frozen (no upgrade authority), and the ATA program is on the non-upgradeable loader.
- **Token Metadata.** `metaqbxx…` is upgradeable (authority `X1TMEC99KMa4MGEKfcrSJ6HZTiwvPVyrwQczZjuCoLV`, read on 2026-11-12). After `attach_metadata` its edition PDA holds the NFT's mint and freeze authority. Its upgrade key can change the displayed metadata, freeze the NFT (that blocks NFT transfers, not withdrawals), or mint another NFT unit. An extra unit cannot withdraw anything, because every holder action requires the NFT's total supply to be exactly 1, but it would block withdrawals until the extra unit is burned. It never receives a vault or a fund-PDA signature over one. At attach it does receive the holder as fee payer; the program refuses any attach that debits the holder more than 0.03 XNT (honest cost about 0.016 XNT) or changes the holder account's owner or data. See `ASSUMPTIONS.md` "Design risks".
- **XDEX.** XDEX's own upgrade authority (`cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` on 2026-11-11) can forge the price observations this program reads. Over successive cranks that could consume every fund's scheduled quote budget. No check in this program removes that risk.
- **Not an X1 rehearsal.** The integration test runs on Agave 4.1.2 with X1's inactive features turned off, except `X1_SYSVAR_SYSCALL_EXCEPTION`, and with X1's real Token, Token-2022 and ATA programs cloned. That is close to X1 but not X1 itself. The canary is the first run on X1.
- **Reverse direction.** A fund whose quote mint is token 1 in its pool is covered only by unit tests. Watch its first crank.

## Keeper on mainnet

The keeper sends to mainnet only with `--cluster mainnet --i-understand-mainnet` and a genesis hash that matches. Run it with `--dry-run` first. The owner decides whether it ever runs against mainnet.
