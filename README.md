# Fund NFT

An Anchor program for X1. Each NFT owns a vault. Anyone can deposit the quote token. The vault dollar-cost-averages that quote into a fixed basket by calling an XDEX cp-swap pool directly. The crank does not supply a price. Minimum output is computed from the pool's on-chain observations. The NFT holder withdraws in kind. There is no admin, pause, owner, or fee switch. The crank tip is the constant 10 bps.

Tests use the USDC.X cash slice and the TEST target only. Candidate mints for JACK, PEPE, and GOOGL.X are listed in `docs/ASSUMPTIONS.md` and are not hard-coded.

## Tools

Pinned in `rust-toolchain.toml` and `Anchor.toml`:

- Rust 1.89.0
- Anchor CLI 1.2.2
- Agave CLI 4.1.2 (Anchor 1.2.2's recommended Solana version)

```sh
rustup toolchain install 1.89.0 --profile minimal
sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"
avm install 1.2.2
avm use 1.2.2
```

## Build and test

```sh
cargo test -p fund_nft --lib
anchor build --ignore-keys --arch v0
cargo test -p fund-nft-tests -- --test-threads=1
```

`--arch v0` is required. Anchor 1.2.2 defaults to `--arch v3` (ELF `e_flags` 3), and X1 mainnet and testnet have SBPF v1 and v3 deployment inactive. `--arch v0` produces `e_flags` 0. `--ignore-keys` skips the check that `target/deploy/fund_nft-keypair.json` matches `declare_id!`. The default build allows only the mainnet XDEX program; add `-- --features testnet` to allow the testnet one instead.

The integration test starts `solana-test-validator` on port 18999 and clones the USDC.X/TEST pool and X1's Tokenkeg, Token-2022, and ATA programs from `https://rpc.mainnet.x1.xyz`. By default it deactivates every feature X1 mainnet reports inactive, except SIMD-0127 (see `docs/PROGRESS.md`). `FUND_NFT_FEATURES=agave` uses Agave defaults; `FUND_NFT_FEATURES=clone` uses plain `--clone-feature-set` and is known to fail. The test needs the Agave CLI on `PATH` and network access to that RPC. Build the program first so `target/deploy/fund_nft.so` exists; the test checks it is SBPF v0 and does not import `sol_get_sysvar`.

Step-by-step build notes are in `docs/PROGRESS.md`. Deploy instructions for X1 testnet, including the command that freezes upgrade authority, are in `docs/DEPLOY_TESTNET.md`. This repo does not deploy to mainnet.

## Keeper

`keeper/` scans `Fund` accounts (filtered by the account discriminator), skips targets that are not due, and builds `execute_dca` from the pinned pool account.

```sh
cd keeper
npm ci
npx tsc --noEmit
npm test
RPC_URL=https://rpc.mainnet.x1.xyz npx tsx src/index.ts --dry-run
```

`npm test` runs offline: it encodes a `Fund` account with the IDL's Borsh coder, decodes it through the keeper's decoder, checks due-target selection, and checks the cluster guard.

`--dry-run` (or leaving `KEYPAIR` unset) prints the transactions and sends nothing; it needs no other flags. The keeper always calls `getGenesisHash` first, before any keypair is loaded, and maps the hash to `mainnet` or `testnet` (X1's known hashes), `localnet` (any other hash, but only when `RPC_URL` is a loopback address: 127.0.0.1, localhost or ::1), or `unknown`. Sends to an unknown chain are always refused. A send requires:

- `KEYPAIR` pointing at a JSON keypair file;
- `--cluster <mainnet|testnet|localnet>` matching the RPC's genesis hash, or the keeper refuses;
- for mainnet, `--i-understand-mainnet` as well. Without it, an `RPC_URL` containing `rpc.mainnet.x1.xyz` is also refused.

```sh
KEYPAIR=/path/to/payer.json RPC_URL=https://rpc.testnet.x1.xyz npx tsx src/index.ts --cluster testnet
```

Each transaction starts with compute-budget instructions. `COMPUTE_UNIT_LIMIT` sets the unit limit (default 400000) and `PRIORITY_FEE_MICROLAMPORTS` sets the price per unit (default 0).

A decode, build or send failure for one fund or target is logged with the fund address and target index, and the keeper continues with the rest. It exits non-zero if any item failed.

## Owner CLI

`keeper/src/cli.ts` creates a fund, deposits, withdraws, shows a fund, and repairs missing vaults. Run it from `keeper/` as `npx tsx src/cli.ts <command>` or `npm run cli -- <command>`. Amounts are raw integer units; the CLI prints them in UI units too, using the mint's decimals.

```sh
# Cash slice is <quoteMint>:default:<bps>; every other target is <mint>:<XDEX pool>:<bps>.
npx tsx src/cli.ts create-fund --quote <mint> \
  --target <quoteMint>:default:2000 --target <mint>:<pool>:8000 \
  --per-run <raw> --interval <secs> --window <secs> --max-dev-bps <n> --payer <pubkey>
npx tsx src/cli.ts deposit  --fund <pda> --amount <raw>          --payer <pubkey>
npx tsx src/cli.ts withdraw --fund <pda> --mint <mint> --amount <raw|all> --payer <pubkey>
npx tsx src/cli.ts show     --fund <pda>
npx tsx src/cli.ts ensure-vaults --fund <pda> --payer <pubkey>
npx tsx src/cli.ts set-metadata --fund <pda> [--name <text>] [--symbol <text>] [--uri <url>] --payer <pubkey>
```

- `create-fund` generates the NFT mint keypair in memory and prints it with the fund PDA (`["fund", nft_mint]`). It checks the same bounds as `state.rs` before touching the network (max deviation ≤ 500 bps, window 900–86400 s, interval ≥ 60 s, weights sum to 10000, 1–8 targets, unique mints and pools, cash slice on the default pool). Every non-cash pool must exist, be owned by XDEX `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`, and trade exactly the quote and target mints. `--xdex <id>` overrides the XDEX id on localnet only. The non-cash target mints go in as remaining accounts in target order. Transaction 1 is `create_fund` plus an idempotent create of the fund's quote-vault ATA. Transaction 2, when there are non-cash targets, idempotently creates each target vault ATA, which `execute_dca` needs. The two are separate transactions, not one atomic step: transaction 1 can confirm while transaction 2 is never sent. If that happens the CLI prints the confirmed signature, the fund PDA, which transactions were not sent, and the `ensure-vaults` command that finishes the job.
  - Size limit: `create_fund` carries every target's parameters (66 bytes each) and each non-cash mint as an account, so transaction 1 grows by about 99 bytes per target. With a Token-2022 quote and the compute-budget instructions, at most 6 non-cash targets fit (1220 bytes), or a cash slice plus 5; 7 and 8 targets would be 1319 and 1418 bytes, over the 1232-byte limit. The CLI builds the transactions, measures them, and refuses an oversized plan with the measured size before any simulation or send. The program allows 8 targets; reaching them would need an address lookup table, which this CLI does not use.
- `create-fund --name <text> --symbol <text> --uri <url>` (all three or none) also attaches Metaplex Token Metadata to the fund NFT. It goes as transaction 2, `attach_metadata`, before the target vaults, so `create_fund` itself is no bigger. It needs the fund that transaction 1 creates, so the CLI size-checks it up front, says it is not simulated yet, and relies on the RPC's preflight simulation when it is sent. On a partial failure the recovery lines are the `set-metadata` command and then `ensure-vaults`. Limits: name 32, symbol 10, uri 200 UTF-8 bytes.
- `set-metadata` is for the NFT holder only (the program checks). With no metadata yet it runs `attach_metadata` and needs all three fields. Otherwise it runs `update_metadata` with only the fields you pass, and prints a before → after summary. `show` prints the metadata and the master edition.
- `ensure-vaults` lists the fund's quote and target vault ATAs and creates any that are missing in one transaction. When none are missing it says so and sends nothing, so it is safe to rerun.
- `deposit` takes from the payer's quote ATA and adds an idempotent vault-ATA create only if the vault is missing. Its budget preview is computed on the gross amount and labelled "pre transfer-fee"; the program credits budgets from the vault's actual increase. For a mint with a Token-2022 transfer fee it also prints the gross debit, the estimated fee and the net receipt.
- `withdraw` sends to the holder's ATA for that mint, created idempotently in the same transaction. `--amount all` withdraws the vault's whole balance. A quote withdraw shrinks the target budgets by the gross amount, in proportion. With a transfer fee it prints the gross vault debit and the net the holder receives.
- `show` decodes the fund with `keeper/src/fund.ts` and prints parameters, each target's budget, `last_run`, next due time, the NFT holder, and every vault balance. It never signs.

Safety follows the keeper and reuses `keeper/src/cluster.ts`:

- The default is simulate-only. Each transaction is simulated (except a dependent `attach_metadata`, see below) (`sigVerify: false`, `replaceRecentBlockhash: true`) and the CLI prints the program logs and compute units. Without `KEYPAIR`, give the fee payer with `--payer <pubkey>`. If the program is not deployed on the RPC, the CLI says so and stops.
- A send needs all of `--send`, `KEYPAIR`, and `--cluster <mainnet|testnet|localnet>` matching the RPC's genesis hash; mainnet also needs `--i-understand-mainnet`. The genesis hash is checked before any keypair is loaded.
- Before signing, the CLI prints a summary of what it will sign. It size-checks every transaction and simulates every transaction that can be simulated before sending the first one, so a failed simulation means no transaction of that command was sent. The one exception is `attach_metadata` in a create-fund with metadata: it depends on the fund created by the first transaction, so it cannot be simulated in advance; the CLI says so and relies on the RPC's preflight check when it sends. A send can still fail after an earlier transaction confirmed (rejected, expired, or failed on chain); the CLI then lists the confirmed signatures, marks the failing transaction as not sent, of unknown status, or failed, lists the ones after it as not sent, and prints the recovery command.
- With `--send`, `--payer` is optional; when given it must equal the `KEYPAIR` pubkey, or the CLI refuses.
- Each transaction starts with the keeper's compute-budget instructions (`COMPUTE_UNIT_LIMIT`, `PRIORITY_FEE_MICROLAMPORTS`).
- The RPC is `--rpc <url>`, else `RPC_URL`, else `https://rpc.mainnet.x1.xyz`.

`npm test` also covers the CLI offline: the metadata flags, bounds, PDAs, builders, plan and decoder (`test/metadata.test.ts`), argument parsing, the bounds, the remaining-account order (cash skipped), the fund PDA, the pool check, the send gate, the create-fund transaction sizes, the partial-failure message, and the transfer-fee math.

`bash test/e2e-local.sh` (or `npm run e2e`) runs the CLI against a loopback `solana-test-validator` on ports 18989–19030. It needs `target/deploy/fund_nft.so`, the Agave CLI, `jq`, and read access to `https://rpc.mainnet.x1.xyz` for clones. It uses the same X1 feature mode as the Rust test (set `E2E_FEATURES=agave` for Agave defaults) and clones XDEX, the USDC.X/TEST pool and X1's token programs. The quote mint is the cloned USDC.X with its mint authority overwritten to a throwaway payer, so the fund can pin TEST to the real pool. Keys, the Solana CLI config and the ledger go in a temp dir under `E2E_SCRATCH` (absolute; default `$TMPDIR` or `/tmp`), deleted on exit. Every Agave tool runs through a wrapper that requires `-C <work dir config>` and sets `HOME` to an empty dir inside the work dir, and the validator gets `--mint <throwaway payer>`, so nothing reads `~/.config/solana` or a wallet outside the work dir. Every step uses `--send --cluster localnet`: create-fund, ensure-vaults twice (nothing to do), a bare `create_fund` without vaults (`test/e2e-bare-fund.ts`, loopback only) repaired by ensure-vaults and then rerun, deposit, show, keeper `--dry-run`, withdraw quote, a non-holder withdraw that the program rejects with `BadNft` during the CLI's pre-send simulation, and withdraw all. It also clones Token Metadata, then runs create-fund with `--name/--symbol/--uri` (three confirmed transactions), `show`, a check that the NFT's mint and freeze authority are the master edition with supply 1, a refused second mint, holder and non-holder `set-metadata` updates, client-side bounds, `set-metadata` attaching to a fund created without metadata, and deposit and withdraw after the attach.

## Owner web app

`app/` is a local web app that does the same work as the owner CLI from a browser wallet (Backpack or any other Wallet Standard wallet). It lists the funds your wallet's NFTs control, shows a fund's targets, budgets and vaults, and creates funds, deposits, withdraws and runs ensure-vaults. It also shows a read-only keeper status. Run it with `cd app && npm ci && npm run dev` and open http://127.0.0.1:5173. The dev server binds to loopback only.

The app does not have its own transaction builders. The CLI's bounds, builders, planners, size checks, fee math and `sendPlan` live in browser-safe `keeper/src/core/`, and both the CLI and the app import them. The app keeps the CLI's safety model:

- the genesis-hash cluster banner, with mainnet in red
- an "I understand this is X1 mainnet" tick for each session
- no sends to an unknown chain
- a check that the program is deployed
- simulation of every transaction and a review before **Sign & send**
- the same honest partial-failure report

`scripts/local-validator.sh` starts a loopback validator with the program and the cloned USDC.X/TEST pool. `--fund-wallet <pubkey>` funds a browser wallet on that local chain. See [app/README.md](app/README.md).
