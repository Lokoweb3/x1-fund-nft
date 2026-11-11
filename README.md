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
anchor build
cargo test -p fund-nft-tests -- --test-threads=1
```

The integration test starts `solana-test-validator` on port 18999 and clones the USDC.X/TEST pool from `https://rpc.mainnet.x1.xyz`. It needs the Agave CLI on `PATH` and network access to that RPC. Build the program first so `target/deploy/fund_nft.so` exists.

Step-by-step build notes are in `docs/PROGRESS.md`. Deploy instructions for X1 testnet, including the command that freezes upgrade authority, are in `docs/DEPLOY_TESTNET.md`. This repo does not deploy to mainnet.

## Keeper

`keeper/` scans `Fund` accounts, skips targets that are not due, and builds `execute_dca` from the pinned pool account.

```sh
cd keeper
npm install
npx tsc --noEmit
RPC_URL=https://rpc.mainnet.x1.xyz npx tsx src/index.ts --dry-run
```

`--dry-run` prints the transaction and does not send it. A send also requires `KEYPAIR` pointing at a JSON keypair file, and the script refuses to send when `RPC_URL` contains `rpc.mainnet.x1.xyz`.
