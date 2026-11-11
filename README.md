# Fund NFT

An Anchor program for X1. Each NFT owns a vault that dollar-cost-averages a quote token into a fixed basket by calling an XDEX cp-swap pool. The caller does not supply a price. Minimum output comes from the pool's on-chain observations.

The program is built one instruction at a time. See `docs/PROGRESS.md` for the commands and results so far. Pinned tools: Rust 1.89.0, Anchor 1.2.2, Agave CLI 4.1.2 (`rust-toolchain.toml`).
