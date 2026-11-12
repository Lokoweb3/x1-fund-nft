/**
 * Display-only valuation: spot price from the pinned pool's reserves,
 * either token order, decimals of both mints, empty pools, missing vaults.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { MintMeta } from "@core/owner.js";
import { POOL_DISCRIMINATOR, POOL_LEN, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@core/pool.js";
import { feeBps, formatApprox, netReserve, readPoolFees, sharePercent, valueHoldings, valueInQuote, withdrawFeeFor, type PoolSnapshot } from "../src/lib/value.js";

const k = () => Keypair.generate().publicKey;
const quoteMint = k();
const targetMint = k();
const meta = (address: PublicKey, decimals: number, bps = 0): MintMeta => ({
  address,
  decimals,
  tokenProgram: bps ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
  transferFee: bps
    ? { older: { epoch: 0n, maximumFee: 10n ** 18n, basisPoints: bps }, newer: { epoch: 0n, maximumFee: 10n ** 18n, basisPoints: bps } }
    : undefined,
});
const pool = (m0: PublicKey, r0: bigint | undefined, m1: PublicKey, r1: bigint | undefined): PoolSnapshot => ({
  side0: { mint: m0, reserve: r0 },
  side1: { mint: m1, reserve: r1 },
});

test("spot value: balance * quoteReserve / targetReserve, floored", () => {
  // 1000 target, 8000 quote: 1 target = 8 quote (both 9 decimals).
  const p = pool(targetMint, 1_000n * 10n ** 9n, quoteMint, 8_000n * 10n ** 9n);
  assert.equal(valueInQuote(2n * 10n ** 9n, targetMint, quoteMint, p), 16n * 10n ** 9n);
  assert.equal(valueInQuote(1n, targetMint, quoteMint, pool(targetMint, 3n, quoteMint, 2n)), 0n);
});

test("token0/token1 order either way gives the same value", () => {
  const a = pool(targetMint, 500n, quoteMint, 2_000n);
  const b = pool(quoteMint, 2_000n, targetMint, 500n);
  assert.equal(valueInQuote(10n, targetMint, quoteMint, a), 40n);
  assert.equal(valueInQuote(10n, targetMint, quoteMint, b), 40n);
});

test("decimals mismatch: raw reserves carry the decimals", () => {
  // Target has 6 decimals, quote 9. Pool: 1,000 target vs 4,000 quote, so 1 target = 4 quote.
  const p = pool(quoteMint, 4_000n * 10n ** 9n, targetMint, 1_000n * 10n ** 6n);
  const v = valueInQuote(25n * 10n ** 5n /* 2.5 target */, targetMint, quoteMint, p);
  assert.equal(v, 10n * 10n ** 9n); // 10 quote
  assert.equal(formatApprox(v!, 9), "10");
});

test("empty pool, unknown reserve, or a pool for other mints: unknown", () => {
  assert.equal(valueInQuote(10n, targetMint, quoteMint, pool(targetMint, 0n, quoteMint, 0n)), undefined);
  assert.equal(valueInQuote(10n, targetMint, quoteMint, pool(targetMint, 0n, quoteMint, 100n)), undefined);
  assert.equal(valueInQuote(10n, targetMint, quoteMint, pool(targetMint, undefined, quoteMint, 100n)), undefined);
  assert.equal(valueInQuote(10n, targetMint, quoteMint, pool(k(), 10n, quoteMint, 100n)), undefined);
  // An empty quote side prices the target at zero.
  assert.equal(valueInQuote(10n, targetMint, quoteMint, pool(targetMint, 10n, quoteMint, 0n)), 0n);
});

test("fee accumulators come off the vault amount, never below zero", () => {
  assert.equal(netReserve(1_000n, 30n), 970n);
  assert.equal(netReserve(10n, 30n), 0n);
  assert.equal(netReserve(undefined, 0n), undefined);
  const data = new Uint8Array(POOL_LEN);
  data.set(POOL_DISCRIMINATOR, 0);
  const v = new DataView(data.buffer);
  v.setBigUint64(341, 5n, true);
  v.setBigUint64(349, 7n, true);
  v.setBigUint64(357, 1n, true);
  v.setBigUint64(365, 2n, true);
  assert.deepEqual(readPoolFees(data), { fees0: 6n, fees1: 9n });
  assert.throws(() => readPoolFees(new Uint8Array(100)));
});

test("holdings: quote counts 1:1, missing vault and missing pool are unknown, total is the known sum", () => {
  const quote = meta(quoteMint, 9);
  const target = meta(targetMint, 9, 500);
  const other = meta(k(), 6);
  const gone = meta(k(), 6);
  const vaults = [
    { mint: quote, vault: k(), balance: 9_800_000_000n },
    { mint: target, vault: k(), balance: 1_000_000_000n },
    { mint: other, vault: k(), balance: 5n },
    { mint: gone, vault: k(), balance: undefined },
  ];
  const v = valueHoldings({
    quote,
    vaults,
    pools: { [targetMint.toBase58()]: pool(quoteMint, 8_000n, targetMint, 1_000n), [other.address.toBase58()]: undefined },
  });
  assert.equal(v.quoteBalance, 9_800_000_000n);
  assert.deepEqual(
    v.rows.map((r) => r.value),
    [9_800_000_000n, 8_000_000_000n, undefined, undefined],
  );
  assert.equal(v.rows[1]!.transferFeeBps, 500);
  assert.equal(v.total, 17_800_000_000n);
  assert.equal(v.complete, false);
  assert.equal(sharePercent(v.rows[1]!.value!, v.total), 44.9);

  // A zero balance needs no pool; a missing quote vault is unknown.
  const z = valueHoldings({ quote, vaults: [{ mint: quote, vault: k(), balance: undefined }, { mint: other, vault: k(), balance: 0n }], pools: {} });
  assert.deepEqual(z.rows.map((r) => r.value), [undefined, 0n]);
  assert.equal(z.quoteBalance, undefined);
  assert.equal(z.total, 0n);
  assert.equal(z.complete, false);
  assert.equal(sharePercent(1n, 0n), 0);
});

test("formatApprox: separators, short fractions, significant digits below 1", () => {
  assert.equal(formatApprox(9_812_345_678n, 9), "9.8123");
  assert.equal(formatApprox(1_119_612_345_678n, 9), "1,119.61");
  assert.equal(formatApprox(1_234n, 9), "0.000001234");
  assert.equal(formatApprox(0n, 9), "0");
  assert.equal(formatApprox(12_000_000n, 6), "12");
  assert.equal(formatApprox(7n, 0), "7");
});

test("transfer-fee note uses the schedule in force at the epoch, and the maximum-fee cap", () => {
  // Review finding: older 500 bps until epoch 102, then newer 0 bps.
  const m: MintMeta = {
    address: k(),
    decimals: 9,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    transferFee: { older: { epoch: 90n, maximumFee: 10n ** 18n, basisPoints: 500 }, newer: { epoch: 102n, maximumFee: 10n ** 18n, basisPoints: 0 } },
  };
  assert.equal(feeBps(m, 100n), 500);
  assert.equal(feeBps(m, 102n), 0);
  assert.equal(feeBps(m), 500, "unknown epoch: the higher rate");
  assert.equal(withdrawFeeFor(m, 1_000n, 100n), 50n);
  assert.equal(withdrawFeeFor(m, 1_000n, 102n), 0n);
  assert.equal(withdrawFeeFor(m, 1_000n), 50n);
  const rows = valueHoldings({ quote: meta(quoteMint, 9), vaults: [{ mint: m, vault: k(), balance: 1_000n }], pools: {}, epoch: 100n }).rows;
  assert.equal(rows[0]!.transferFeeBps, 500);
  assert.equal(rows[0]!.withdrawFee, 50n);
  // Cap: 5% of 1e12 is 5e10, capped at 7.
  const capped: MintMeta = { ...m, transferFee: { older: { epoch: 0n, maximumFee: 7n, basisPoints: 500 }, newer: { epoch: 0n, maximumFee: 7n, basisPoints: 500 } } };
  assert.equal(withdrawFeeFor(capped, 10n ** 12n, 5n), 7n);
  assert.equal(withdrawFeeFor(capped, 0n, 5n), 0n);
});
