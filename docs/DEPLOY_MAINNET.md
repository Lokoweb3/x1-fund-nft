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

## Trust the canary relies on

- **Upgrade authority.** The deployer key can replace the program, including with code that moves every vault. Before outside users deposit, move it to a multisig, or freeze it (see the freeze section above, which is irreversible).
- **Token issuers.** The mint-extension allowlist blocks permanent delegates, hooks and similar extensions. It does not remove ordinary issuer power. A mint's freeze authority can freeze a fund's vault, and its mint authority can inflate supply. A Token-2022 transfer-fee authority can change both the fee rate and its maximum-fee cap for future epochs (taking effect two epochs after the change), potentially charging 100% of a transfer. The current fee cap is not a permanent protection. Check these authorities on each mint you put in a fund.
- **Token programs.** X1 Token-2022 (`TokenzQd…`) is upgradeable, with authority `2sXr5THr5ZAwSfuJAc1KogPKZ2uKkhfNUAtEvNw5Q6Z7` (read on 2026-11-12). Its upgrade key can change how every Token-2022 vault behaves. The program allowlists that ID, not its code. Classic Tokenkeg is frozen (no upgrade authority), and the ATA program is on the non-upgradeable loader.
- **XDEX.** XDEX's own upgrade authority (`cveZ26DWAWDQb3jUubHmdEM3GxvYt6gqfxdxD2ASNNY` on 2026-11-11) can forge the price observations this program reads. Over successive cranks that could consume every fund's scheduled quote budget. No check in this program removes that risk.
- **Not an X1 rehearsal.** The integration test runs on Agave 4.1.2 with X1's inactive features turned off, except `X1_SYSVAR_SYSCALL_EXCEPTION`, and with X1's real Token, Token-2022 and ATA programs cloned. That is close to X1 but not X1 itself. The canary is the first run on X1.
- **Reverse direction.** A fund whose quote mint is token 1 in its pool is covered only by unit tests. Watch its first crank.

## Keeper on mainnet

The keeper sends to mainnet only with `--cluster mainnet --i-understand-mainnet` and a genesis hash that matches. Run it with `--dry-run` first. The owner decides whether it ever runs against mainnet.
