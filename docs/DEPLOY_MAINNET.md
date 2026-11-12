# Deploy to X1 mainnet: owner-only canary

The owner runs every command here. Agents prepare them and don't sign, fund or send anything.

Scope: an owner-only canary. Use small amounts and the owner's own funds only. Don't announce it, and don't take outside deposits, until the canary has run and the trust notes below are accepted.

Review status: independent dual review. The lead and Codex reviewed separately over three rounds, and Codex approves this scope. Every finding is labelled "confirmed by code review and models". See `ASSUMPTIONS.md`.

## What gets deployed

| Item | Value |
| --- | --- |
| Program ID | `6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM` (keypair `keys/fund_nft-mainnet.json`, owner-held, gitignored) |
| Build | `anchor build --ignore-keys --arch v0` with Anchor 1.2.2, Agave 4.1.2, platform-tools v1.57, Rust 1.89.0 |
| Artifact | `target/deploy/fund_nft.so`, 312,136 bytes, SBPF v0 (ELF e_flags 0), no `sol_get_sysvar` import |
| sha256 | `07eb8f02ccdd7df132cabf202d68d3789491c98ee80be050f1ef3b998dc51592` (lead build on 2026-11-12; rebuild and compare) |
| XDEX program allowed | `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` (default build, no `testnet` feature) |

Why v0: X1 mainnet has SBPF v1 and v3 deployment inactive. Anchor 1.2.2 defaults to v3, and X1's feature set rejects that.

## Cost

Rent on mainnet, read on 2026-11-12:
- program data, 312,181 bytes: **2.1737 XNT**, locked for the life of the program
- program account: 0.0011 XNT

During the deploy a temporary buffer of the same size is also funded. It is refunded when the deploy finishes. Hold about **5 XNT** in the deployer wallet.

## Steps

```sh
cd ~/X1_PROJECTS/X1_FundNFT
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
URL=https://rpc.mainnet.x1.xyz
DEPLOYER=<path to your deployer keypair>   # becomes the upgrade authority

# 1. Rebuild and compare the hash with the table above.
anchor build --ignore-keys --arch v0     # use the Anchor 1.2.2 binary (~/.avm/bin/anchor-1.2.2)
sha256sum target/deploy/fund_nft.so
solana-keygen pubkey keys/fund_nft-mainnet.json   # must print 6dmHta…2nrUM

# 2. Check the network and the balance.
solana genesis-hash --url $URL                    # must be 4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN
solana balance --keypair $DEPLOYER --url $URL     # ≥ 5 XNT
solana program show 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM --url $URL   # must say not found

# 3. Deploy.
solana program deploy target/deploy/fund_nft.so \
  --program-id keys/fund_nft-mainnet.json \
  --keypair $DEPLOYER --upgrade-authority $DEPLOYER \
  --url $URL --with-compute-unit-price 1000

# If it stops part-way, the buffer keeps its XNT. Recover it with:
#   solana program show --buffers --keypair $DEPLOYER --url $URL
#   solana program close <BUFFER> --keypair $DEPLOYER --url $URL

# 4. Verify on chain.
solana program show 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM --url $URL
solana program dump 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM /tmp/fund_nft-onchain.so --url $URL
sha256sum /tmp/fund_nft-onchain.so target/deploy/fund_nft.so   # must match
```

After deploying, back up `keys/fund_nft-mainnet.json` and the deployer keypair offline. The deployer is the upgrade authority.

## Canary walkthrough

Run this after the deploy has been verified. Use the owner's own wallet and small amounts. The fund below is USDC.X with a 20% cash slice and 80% TEST through the USDC.X/TEST pool; swap in the real basket. Each step is simulated first. Read the summary and the simulation logs before adding the send flags.

```sh
cd ~/X1_PROJECTS/X1_FundNFT/keeper
npm ci
export RPC_URL=https://rpc.mainnet.x1.xyz
OWNER=<owner wallet pubkey>
OWNER_KEYPAIR=<path to the owner's keypair>
USDC=B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq
TEST=C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz
POOL=7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD
SEND="--send --cluster mainnet --i-understand-mainnet"

# 1. Simulate create-fund. No keypair is loaded. Check the bounds, the pool
#    check, the summary, and "simulation: ok" for both transactions.
npx tsx src/cli.ts create-fund --quote $USDC \
  --target $USDC:default:2000 --target $TEST:$POOL:8000 \
  --per-run 100000 --interval 3600 --window 3600 --max-dev-bps 300 --payer $OWNER

# 2. Create a small fund. The NFT mint is new on every run, so copy the
#    printed fund PDA from this run.
KEYPAIR=$OWNER_KEYPAIR npx tsx src/cli.ts create-fund --quote $USDC \
  --target $USDC:default:2000 --target $TEST:$POOL:8000 \
  --per-run 100000 --interval 3600 --window 3600 --max-dev-bps 300 $SEND
FUND=<fund PDA printed above>

# 3. Deposit a small amount (1 USDC.X = 1000000 raw). Simulate, then send.
npx tsx src/cli.ts deposit --fund $FUND --amount 1000000 --payer $OWNER
KEYPAIR=$OWNER_KEYPAIR npx tsx src/cli.ts deposit --fund $FUND --amount 1000000 $SEND

# 4. Show: budgets 0.2 cash / 0.8 TEST, the TEST target "due now", the
#    quote vault at 1 USDC.X and the TEST vault at 0.
npx tsx src/cli.ts show --fund $FUND

# 5. Crank: the keeper dry-run must list this fund's TEST target and print
#    the execute_dca accounts. Whether the keeper sends on mainnet is the
#    owner's call (see "Keeper on mainnet").
env -u KEYPAIR npx tsx src/index.ts --dry-run

# 6. Withdraw. Quote first; a quote withdraw shrinks the budgets in
#    proportion. After a crank, withdraw TEST the same way with --mint $TEST.
npx tsx src/cli.ts withdraw --fund $FUND --mint $USDC --amount all --payer $OWNER
KEYPAIR=$OWNER_KEYPAIR npx tsx src/cli.ts withdraw --fund $FUND --mint $USDC --amount all $SEND
npx tsx src/cli.ts show --fund $FUND
```

Before the deploy, step 1 fails with `program 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM is not deployed on this RPC (https://rpc.mainnet.x1.xyz, mainnet)`. The CLI reaches that point only after the local bound checks and the pool check have passed.

## Trust the canary relies on

- **Upgrade authority.** The deployer key can replace the program, including with code that moves every vault. Before outside users deposit, move it to a multisig, or freeze it with `solana program set-upgrade-authority <ID> --final`, which is irreversible.
- **XDEX.** XDEX's own upgrade authority (`cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` on 2026-11-11) can forge the price observations this program reads. Over successive cranks that could consume every fund's scheduled quote budget. No check in this program removes that risk.
- **Not an X1 rehearsal.** The integration test runs on Agave 4.1.2 with X1's inactive features turned off, except `X1_SYSVAR_SYSCALL_EXCEPTION`, and with X1's real Token, Token-2022 and ATA programs cloned. That is close to X1 but not X1 itself. The canary is the first run on X1.
- **Reverse direction.** A fund whose quote mint is token 1 in its pool is covered only by unit tests. Watch its first crank.

## Keeper on mainnet

The keeper sends to mainnet only with `--cluster mainnet --i-understand-mainnet` and a genesis hash that matches. Run it with `--dry-run` first. The owner decides whether it ever runs against mainnet.
