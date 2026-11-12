/**
 * What a fund holds, priced in its quote token at each pinned XDEX pool's
 * current spot price. DISPLAY ONLY: nothing here feeds a review, a
 * simulation, a transaction or an amount anyone signs.
 *
 * value = balance * quoteReserve / targetReserve (constant-product spot
 * price, raw units, floor). Raw reserves already carry each mint's
 * decimals, so the ratio converts target raw units straight into quote raw
 * units. Transfer fees are NOT subtracted; the page notes them instead.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { transferFeeFor, type MintMeta } from "@core/owner.js";
import { readPool } from "@core/pool.js";
import { tokenAmount, type FundView } from "@core/rpc.js";

/**
 * XDEX is a Raydium cp-swap fork; its 637-byte PoolState matches Raydium's
 * layout: after the observation key (296) come auth_bump, status,
 * lp_mint_decimals, mint_0_decimals, mint_1_decimals (328..333), lp_supply
 * (333), then protocol_fees_token_0/1 (341, 349) and fund_fees_token_0/1
 * (357, 365). Those fee accumulators sit in the pool vaults but are not
 * liquidity, so Raydium's vault_amount_without_fee subtracts them; we do
 * the same. Checked against the live WXNT/Test pool
 * 6FszF7uwrujG8vdmxUCyLLAoQMRCUNgoWuebhuzZ6sVn (decimals 9/9 at 331/332,
 * open_time and recent_epoch sane at 373/381). Newer Raydium versions also
 * keep creator fees in the trailing padding; those bytes read zero on the
 * live pool and are not subtracted here. The fund program itself never
 * reads reserves (it prices with the observation TWAP, see twap.rs).
 */
const OFF_PROTOCOL_FEES_0 = 341;
const OFF_PROTOCOL_FEES_1 = 349;
const OFF_FUND_FEES_0 = 357;
const OFF_FUND_FEES_1 = 365;

export interface PoolSide {
  mint: PublicKey;
  /** Vault amount minus fee accumulators; undefined when the vault is unreadable. */
  reserve: bigint | undefined;
}

export interface PoolSnapshot {
  side0: PoolSide;
  side1: PoolSide;
}

/** Fee accumulators (token0, token1) held in the pool vaults. */
export function readPoolFees(data: Uint8Array): { fees0: bigint; fees1: bigint } {
  readPool(data); // length and discriminator check
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (o: number) => v.getBigUint64(o, true);
  return {
    fees0: u64(OFF_PROTOCOL_FEES_0) + u64(OFF_FUND_FEES_0),
    fees1: u64(OFF_PROTOCOL_FEES_1) + u64(OFF_FUND_FEES_1),
  };
}

/** Vault amount net of fees, never below zero. */
export function netReserve(vaultAmount: bigint | undefined, fees: bigint): bigint | undefined {
  if (vaultAmount === undefined) return undefined;
  return vaultAmount > fees ? vaultAmount - fees : 0n;
}

/**
 * Value of `balance` raw units of `target` in raw quote units, from the
 * pool's spot price, or undefined when the pool does not pair the two mints,
 * a reserve is unknown, or the target side is empty.
 */
export function valueInQuote(balance: bigint, target: PublicKey, quote: PublicKey, pool: PoolSnapshot): bigint | undefined {
  let t: PoolSide;
  let q: PoolSide;
  if (pool.side0.mint.equals(target) && pool.side1.mint.equals(quote)) [t, q] = [pool.side0, pool.side1];
  else if (pool.side1.mint.equals(target) && pool.side0.mint.equals(quote)) [t, q] = [pool.side1, pool.side0];
  else return undefined;
  if (t.reserve === undefined || q.reserve === undefined || t.reserve === 0n) return undefined;
  return (balance * q.reserve) / t.reserve;
}

export interface HoldingRow {
  mint: MintMeta;
  isQuote: boolean;
  /** Raw balance; undefined when the vault account is missing. */
  balance: bigint | undefined;
  /** Raw quote units; undefined when it cannot be estimated. */
  value: bigint | undefined;
  /**
   * Transfer fee in basis points in force at the valuation's epoch (0 when
   * none). Without an epoch, the larger of the mint's two scheduled rates.
   */
  transferFeeBps: number;
  /** Fee, in this token's raw units, on withdrawing the whole balance (rate and maximum-fee cap applied). */
  withdrawFee: bigint;
}

export interface Valuation {
  rows: HoldingRow[];
  /** Sum of the known values, raw quote units. */
  total: bigint;
  /** False when any held token could not be priced; the total is then a lower bound. */
  complete: boolean;
  /** Quote vault balance, raw; undefined when the quote vault is missing. */
  quoteBalance: bigint | undefined;
}

export interface ValuationInput {
  quote: MintMeta;
  vaults: FundView["vaults"];
  /** Target mint (base58) to its pinned pool snapshot, or undefined when unreadable. */
  pools: Record<string, PoolSnapshot | undefined>;
  /** Current epoch, to pick the transfer-fee schedule in force; undefined = assume the higher of the two. */
  epoch?: bigint;
}

/** Transfer fee rate in force at `epoch` (same rule as transferFeeFor); without an epoch, the higher scheduled rate. */
export function feeBps(mint: MintMeta, epoch?: bigint): number {
  const c = mint.transferFee;
  if (!c) return 0;
  if (epoch === undefined) return Math.max(c.older.basisPoints, c.newer.basisPoints);
  return (epoch >= c.newer.epoch ? c.newer : c.older).basisPoints;
}

/** Fee on transferring `amount` at `epoch`; without an epoch, the higher of the two schedules. */
export function withdrawFeeFor(mint: MintMeta, amount: bigint, epoch?: bigint): bigint {
  const c = mint.transferFee;
  if (!c || amount === 0n) return 0n;
  if (epoch !== undefined) return transferFeeFor(c, amount, epoch);
  // Unknown epoch: the larger of the two schedules, each as transferFeeFor computes it.
  const only = (f: typeof c.older) => transferFeeFor({ older: f, newer: f }, amount, f.epoch);
  const x = only(c.older);
  const y = only(c.newer);
  return x > y ? x : y;
}

/** Pure valuation of a fund's vaults. */
export function valueHoldings({ quote, vaults, pools, epoch }: ValuationInput): Valuation {
  let total = 0n;
  let complete = true;
  let quoteBalance: bigint | undefined;
  const rows = vaults.map((v): HoldingRow => {
    const isQuote = v.mint.address.equals(quote.address);
    let value: bigint | undefined;
    if (isQuote) {
      value = v.balance;
      quoteBalance = v.balance;
    } else if (v.balance === 0n) {
      value = 0n;
    } else if (v.balance !== undefined) {
      const pool = pools[v.mint.address.toBase58()];
      value = pool ? valueInQuote(v.balance, v.mint.address, quote.address, pool) : undefined;
    }
    if (value === undefined) complete = false;
    else total += value;
    return {
      mint: v.mint,
      isQuote,
      balance: v.balance,
      value,
      transferFeeBps: feeBps(v.mint, epoch),
      withdrawFee: v.balance === undefined ? 0n : withdrawFeeFor(v.mint, v.balance, epoch),
    };
  });
  return { rows, total, complete, quoteBalance };
}

/** Share of `part` in `total` as a percentage with one decimal (0 when total is 0). */
export function sharePercent(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 1000n) / total) / 10;
}

/**
 * Holding rows for display: by value, highest first; unknown values last
 * (in vault order).
 */
export function sortByValue(rows: HoldingRow[]): HoldingRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      if (a.r.value === undefined || b.r.value === undefined) {
        if (a.r.value === b.r.value) return a.i - b.i;
        return a.r.value === undefined ? 1 : -1;
      }
      return a.r.value === b.r.value ? a.i - b.i : a.r.value > b.r.value ? -1 : 1;
    })
    .map((x) => x.r);
}

/** Read each non-cash target's pinned pool and its two vaults (one RPC round trip). */
export async function loadPoolSnapshots(connection: Connection, view: FundView): Promise<Record<string, PoolSnapshot | undefined>> {
  const seen = new Set<string>();
  const targets = view.targets.filter((t) => {
    const k = t.mint.toBase58();
    if (t.cash || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const out: Record<string, PoolSnapshot | undefined> = {};
  if (targets.length === 0) return out;
  const poolInfos = await connection.getMultipleAccountsInfo(targets.map((t) => t.pool));
  const parsed = targets.map((t, i) => {
    const info = poolInfos[i];
    if (!info) return undefined;
    try {
      return { accounts: readPool(info.data), fees: readPoolFees(info.data) };
    } catch {
      return undefined;
    }
  });
  const vaultKeys = parsed.flatMap((p) => (p ? [p.accounts.token0Vault, p.accounts.token1Vault] : []));
  const vaultInfos = vaultKeys.length ? await connection.getMultipleAccountsInfo(vaultKeys) : [];
  let k = 0;
  const amount = (data: Uint8Array | undefined) => {
    if (!data) return undefined;
    try {
      return tokenAmount(data);
    } catch {
      return undefined;
    }
  };
  targets.forEach((t, i) => {
    const p = parsed[i];
    if (!p) return void (out[t.mint.toBase58()] = undefined);
    const v0 = amount(vaultInfos[k++]?.data);
    const v1 = amount(vaultInfos[k++]?.data);
    out[t.mint.toBase58()] = {
      side0: { mint: p.accounts.token0Mint, reserve: netReserve(v0, p.fees.fees0) },
      side1: { mint: p.accounts.token1Mint, reserve: netReserve(v1, p.fees.fees1) },
    };
  });
  return out;
}

export async function loadValuation(connection: Connection, view: FundView): Promise<Valuation> {
  const [pools, epoch] = await Promise.all([
    loadPoolSnapshots(connection, view),
    connection.getEpochInfo().then(
      (e) => BigInt(e.epoch),
      () => undefined,
    ),
  ]);
  return valueHoldings({ quote: view.quote, vaults: view.vaults, pools, epoch });
}
