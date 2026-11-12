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
