# Deploy to X1 testnet

This is documentation only. Do not deploy to X1 mainnet, do not use a funded mainnet key, and do not send a mainnet transaction from this repo.

X1 testnet reported `solana-core 4.0.4` on 2026-11-11 (`https://rpc.testnet.x1.xyz`). The program is built with the toolchain below, which is the pair Anchor 1.2.2 documents. It is newer than the chain by a small amount (CLI 4.1.2 versus runtime 4.0.4). Re-check `getVersion` before deploying.

## Pinned tools

| Tool | Version |
| --- | --- |
| Rust | 1.89.0 (`rust-toolchain.toml`) |
| Anchor CLI | 1.2.2 |
| Agave / Solana CLI | 4.1.2 (`solana-cli 4.1.2 (src:182084b8; feat:c763ae0a, client:Agave)`) |
| cargo-build-sbf | 4.1.0, platform-tools v1.54 (what this CLI actually installed) |

Anchor 1.2.2's release notes say platform-tools v1.57. The 4.1.2 installer used here reported v1.54, and that is what built `target/deploy/fund_nft.so`.

Current stables on 2026-11-11, not what this repo pins:

- Anchor 1.2.2 is the current stable. 0.32.3 shipped later on the legacy 0.x line. 2.0.0-rc.2 is a pre-release.
- Agave 4.4.1 is the current stable CLI. 4.5.0-beta.0 is a pre-release. Anchor 1.2.2 recommends 4.1.2, and its `solana-v4` crate line is 4.3, so 4.4.1 is not the build CLI.

Install:

```sh
rustup toolchain install 1.89.0 --profile minimal
sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"
# Anchor CLI. AVM resolves the version in Anchor.toml when you invoke `anchor` through it.
avm install 1.2.2
avm use 1.2.2
# The release binary is the same artifact AVM installs:
# https://github.com/otter-sec/anchor/releases/download/v1.2.2/anchor-1.2.2-x86_64-unknown-linux-gnu
```

`Anchor.toml` pins `anchor_version = "1.2.2"` and `solana_version = "4.1.2"`.

## Build

```sh
cargo test -p fund_nft --lib
anchor build --arch v0 -- --features testnet
```

`--arch v0` is required: Anchor 1.2.2 defaults to `--arch v3`, and X1 mainnet and testnet have SBPF v1 and v3 deployment inactive, so a v3 `.so` (ELF `e_flags` 3) cannot be deployed there. `--features testnet` switches the program's single allowed pool program to the testnet XDEX id (see below). Without it the build only accepts mainnet XDEX pools.

Program id in the source: `BLMAQdL9dJtDakvDb1vbPpx6LVBbcWJiKThAHkz1g4ck`.

For a testnet deploy, generate a new program keypair and sync it. Do not reuse a mainnet key.

```sh
solana-keygen new -o keys/fund_nft-keypair.json --no-bip39-passphrase
anchor keys sync
```

`keys/` is gitignored.

## Testnet deploy

```sh
solana config set --url https://rpc.testnet.x1.xyz
solana-keygen new -o keys/testnet-deployer.json --no-bip39-passphrase
solana config set --keypair keys/testnet-deployer.json
solana airdrop 2
anchor deploy --provider.cluster https://rpc.testnet.x1.xyz --program-keypair keys/fund_nft-keypair.json
solana program show <PROGRAM_ID> --url https://rpc.testnet.x1.xyz
```

There is no faucet command in this repo. `solana airdrop` asks the testnet RPC. If that RPC does not airdrop, fund the deployer out of band and do not continue with a mainnet key.

XDEX on testnet is a different deployment from mainnet program `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`. Three testnet pools checked on 2026-11-11 are owned by `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf`, the address in the XDEX IDL. The fund program allowlists exactly one pool program. The default build allows the mainnet id; build with `--features testnet` to allow the testnet id instead (`anchor build --arch v0 -- --features testnet`). A fund created on testnet must pin testnet pool addresses. The keeper reads the pool program from the pool account's owner.

## Make the program immutable

Do this only after review, and only on the deployment you intend to freeze. Agave 4.1.2 accepts `--final` ("The program will not be upgradeable"):

```sh
solana program set-upgrade-authority <PROGRAM_ID> --final \
  --url https://rpc.testnet.x1.xyz \
  --keypair keys/testnet-deployer.json
```

Confirm with `solana program show <PROGRAM_ID>`. The upgrade authority should be none.

Freezing this program does not freeze XDEX. `execute_dca` CPIs into whatever program owns the pinned pool, and that program can be upgraded by its own authority.
