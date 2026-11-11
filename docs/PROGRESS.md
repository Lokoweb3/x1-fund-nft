# Build progress

Toolchain pinned before any program code. Versions were checked on 2026-11-11.

- Current stable Anchor: **1.2.2** (2026-10-28). The 0.32.3 line was published later (2026-11-03) but is the legacy 0.x track. 2.0.0-rc.2 is a pre-release.
- Current stable Agave: **4.4.1** (2026-11-05). 4.5.0-beta.0 is a pre-release.
- X1 mainnet and testnet both report `solana-core 4.0.4`.
- Anchor 1.2.2 release notes recommend Solana **4.1.2**, platform-tools v1.57, SBPF v3, and Rust 1.89. That is the pair pinned here. Agave 4.4.1 is newer than both that recommendation and the X1 runtime, and Anchor's `solana-v4` crate cohort is 4.3, so neither is used for the build. The program uses Anchor's default `solana-v3` feature.
- Installed: `rustc 1.89.0`, `solana-cli 4.1.2 (src:182084b8; feat:c763ae0a, client:Agave)`, `anchor-cli 1.2.2`. `cargo-build-sbf --version` reports `cargo-build-sbf 4.1.0` and `platform-tools v1.54` before the first SBF build.

## Step 1 — pure `twap` module

Command:

```bash
cargo test -p fund_nft --lib -- --test-threads=8
```

Compile: `cargo test` compiled `fund_nft v0.1.0` with rustc 1.89.0 and finished the test profile successfully (first compile 0.71s, rerun 0.21s). No Anchor or Solana crate is linked at this step.

Tests: **10 passed, 0 failed**.

- cumulative wrap-around (`wrapping_sub`) matches an unwrapped delta
- observation ring index wrap (newest at index 1, older sample at index 99)
- sparse history (24h gap accepted for a 1h window; 10s of history rejected)
- a single observation is rejected
- precision trap: token-1 x32 price 83 truncates to 0, the inverted token-0 side quotes 1; the other direction uses the large side directly
- trade-fee net 199_440 and the reference 5% ceiling fee 513_634_030_221
- output transfer fee then `max_dev_bps`
- transfer-fee cap
- wide `mul_div` property check (300 random products)

## Step 2 — `create_fund`

Commands:

```bash
cargo test -p fund_nft --lib -- --test-threads=8
anchor build
```

`cargo test` compile: success, rustc 1.89.0, `fund_nft v0.1.0`. Test result: **11 passed, 0 failed** (the step 1 TWAP tests plus two `validate_create` tests: a cash slice plus one pool is accepted; bad weights, duplicate mints, an unpinned swap pool, and a cash slice with a non-default pool are rejected).

`anchor build`: success. Release profile finished in 58.30s. Artifact `target/deploy/fund_nft.so` (181K). Program id stayed `BLMAQdL9dJtDakvDb1vbPpx6LVBbcWJiKThAHkz1g4ck`. `cargo-build-sbf --version` still reports platform-tools **v1.54** (the tools shipped with Agave CLI 4.1.2). Anchor's release notes mention platform-tools v1.57; that version was not what this CLI downloaded.

`anchor-spl` 1.2.2 `CpiContext::new_with_signer` takes a `Pubkey`, not an `AccountInfo`. `token_interface::mint_to` passes account infos in a different order from `spl_token_2022::instruction::mint_to`, so `create_fund` builds that instruction directly and passes `[mint, destination, authority]`. `set_authority` uses the helper, whose order matches the instruction.

## Step 3 — `deposit`

Commands:

```bash
cargo test -p fund_nft --lib -- --test-threads=8
anchor build
```

`cargo test` compile: success (0.87s incremental). Test result: **13 passed, 0 failed**. The two new tests cover deposit rounding (3 units at 50/50 becomes 2 and 1, remainder on the first target; 1_000_000 at 20/80 becomes 200_000 and 800_000) and the quote-withdrawal budget reduction used by the later `withdraw` instruction.

`anchor build`: success. Release profile finished in 1.31s. The Anchor 1.2 program macro expects each `#[derive(Accounts)]` helper module to be glob-reexported to the crate root, so the instruction modules are re-exported and the handlers have distinct names.

## Step 4 — `execute_dca`

Commands:

```bash
cargo test -p fund_nft --lib --offline -- --test-threads=8
anchor build
```

`cargo test` compile: success. Test result: **17 passed, 0 failed**. New tests: the 10 bps slice (budget 800_000, per-run 500_000, weight 8_000, vault 1_000_000 → slice 400_000, tip 400, swap input 399_600), pool and observation offset round-trips, amm config fee 2800, and the Token-2022 fee TLV (older schedule before the newer epoch, newer schedule at that epoch, classic 82-byte mint has no fee).

`anchor build`: success. Release profile finished in 1.82s. No stack-frame warning from the SBF build.

## Step 5 — `withdraw`

Commands:

```bash
cargo test -p fund_nft --lib --offline -- --test-threads=8
anchor build
```

`cargo test` compile: success. Test result: **17 passed, 0 failed**. The quote-budget reduction used by `withdraw` was already covered in step 3 (100_000 out of budgets 200_000 and 400_000 becomes 166_666 and 333_334). No new host test was added; the instruction is covered by the clone test in step 6.

`anchor build`: success. Release profile finished in 1.94s.

## Step 6 — mainnet-clone integration test

Command:

```bash
cargo test -p fund-nft-tests -- --test-threads=1 cloned_usdc_test_pool_create_deposit_dca_withdraw --nocapture
```

Compile: success. Test result: **1 passed, 0 failed**, about 5 seconds.

The local validator is Agave 4.1.2 `solana-test-validator`. It clones the XDEX program (upgradeable), the USDC.X/TEST pool, amm config, both vaults, the observation account, the pool authority, and the TEST mint from `https://rpc.mainnet.x1.xyz`. The USDC.X mint is that same cloned account with one labeled change: its mint authority is set to the test payer so the test can mint USDC.X. `--clone-feature-set` was tried first and the validator exited with `ELF error: Detected sbpf_version required by the executable which are not enabled` (the fund program's SBF version is not in the feature set cloned from X1's 4.0.4). The passing run does not clone the feature set, so the validator uses its own defaults. That was enough to execute the cloned XDEX program.

The test creates a fund (20% USDC.X cash, 80% TEST, window chosen from the cloned observations), deposits 1_000_000 raw USDC.X, cranks the TEST target, and checks that the TEST received by the vault equals the pool vault's decrease minus the ceiling 5% transfer fee. It then withdraws half the TEST (budgets unchanged) and 100_000 USDC.X (budgets become 166_666 and 333_334). A second signer who does not hold the NFT cannot withdraw. The `DcaExecuted` min-out from the transaction logs is below the pre-fee gross and no greater than the amount received.

## Step 7 — keeper typecheck

```bash
cd keeper && npm install && npx tsc --noEmit
```

`tsc --noEmit` exited 0 with `@anchor-lang/core` 1.2.2 and `@solana/web3.js` 1.99.0. A dry run against `https://rpc.mainnet.x1.xyz` (`npx tsx src/index.ts --dry-run`) printed `0 program accounts, 0 due targets` and did not send a transaction.

## Follow-up — min-out side and the authority seed

`cargo test -p fund_nft --lib raydium_authority_seed` passed. `cargo test -p fund-nft-tests -- --test-threads=1 cloned_usdc_test_pool_create_deposit_dca_withdraw` passed again, in 6.21s, with one added probe.

The probe quotes 20_000 raw USDC.X from the cloned reserves, swaps with `minimum_amount_out = 1`, and checks the formula including the 5% ceiling fee. It then swaps the same size with `minimum_amount_out` one raw unit above the post-fee amount and still below the pre-fee amount. XDEX returns `ExceededSlippage` (code 6005). The pool's minimum is the amount the destination receives after the output transfer fee.

The authority seed check is a host unit test. It does not change the program.
