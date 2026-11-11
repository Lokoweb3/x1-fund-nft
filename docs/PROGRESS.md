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
