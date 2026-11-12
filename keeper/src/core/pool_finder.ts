/**
 * Find the XDEX pool for a quote/target pair from chain data alone: two
 * getProgramAccounts calls on the XDEX program (dataSize 637, memcmp on
 * token_0_mint at 168 and token_1_mint at 200, in both orders), then one
 * getMultipleAccountsInfo for the pools' vaults. Candidates are ranked by
 * the quote-side vault balance, the side a fund spends into.
 *
 * Every candidate also passes the same checkPool the create-fund planner
 * runs (owned by XDEX, trades exactly quote/target), so the pool picked here
 * is one prepareCreateFund accepts. A pinned pool is permanent: the fund can
 * never switch pools, so the app shows the depth and lets the owner change it.
 *
 * Browser-safe: no node: imports.
 */
import { PublicKey } from "@solana/web3.js";
import { checkPool } from "./owner.js";
import { POOL_LEN, readPool, type PoolAccounts } from "./pool.js";

export const OFF_TOKEN_0_MINT = 168;
export const OFF_TOKEN_1_MINT = 200;

/** The RPC calls the finder makes; `Connection` satisfies it. */
export interface PoolFinderConnection {
  getProgramAccounts(
    programId: PublicKey,
    config: {
      commitment?: "confirmed";
      filters: Array<{ dataSize: number } | { memcmp: { offset: number; bytes: string } }>;
    },
  ): Promise<ReadonlyArray<{ pubkey: PublicKey; account: { owner: PublicKey; data: Uint8Array } }>>;
  getMultipleAccountsInfo(
    keys: PublicKey[],
    commitment?: "confirmed",
  ): Promise<Array<{ owner: PublicKey; data: Uint8Array } | null>>;
}

export interface PoolCandidate {
  pool: PublicKey;
  accounts: PoolAccounts;
  /** True when the quote mint is token 1 (the reverse direction). */
  quoteIsToken1: boolean;
  quoteVault: PublicKey;
  targetVault: PublicKey;
  /** Raw balances of the pool's vaults; undefined when a vault could not be read. */
  quoteReserve: bigint | undefined;
  targetReserve: bigint | undefined;
}

/** Filters for pools whose token 0 is `a` and token 1 is `b`. */
export function pairFilters(a: PublicKey, b: PublicKey) {
  return [
    { dataSize: POOL_LEN },
    { memcmp: { offset: OFF_TOKEN_0_MINT, bytes: a.toBase58() } },
    { memcmp: { offset: OFF_TOKEN_1_MINT, bytes: b.toBase58() } },
  ];
}

function amountOf(data: Uint8Array | undefined): bigint | undefined {
  if (!data || data.length < 72) return undefined;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/**
 * Every XDEX pool trading quote/target, best first (largest quote-side
 * reserve; an unreadable reserve sorts last). An empty list means no pool
 * exists for the pair on this network.
 */
export async function findPools(
  connection: PoolFinderConnection,
  xdex: PublicKey,
  quote: PublicKey,
  target: PublicKey,
): Promise<PoolCandidate[]> {
  if (quote.equals(target)) throw new Error("the target is the same token as the pay-with token");
  const [forward, reverse] = await Promise.all([
    connection.getProgramAccounts(xdex, { commitment: "confirmed", filters: pairFilters(quote, target) }),
    connection.getProgramAccounts(xdex, { commitment: "confirmed", filters: pairFilters(target, quote) }),
  ]);
  const seen = new Set<string>();
  const parsed: Array<Omit<PoolCandidate, "quoteReserve" | "targetReserve">> = [];
  for (const { pubkey, account } of [...forward, ...reverse]) {
    const key = pubkey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    let accounts: PoolAccounts;
    try {
      accounts = readPool(account.data);
      // The planner's own check: XDEX-owned, and exactly quote/target in either order.
      checkPool(0, { mint: target, pool: pubkey, bps: 1 }, quote, account.owner, accounts, xdex);
    } catch {
      continue;
    }
    const quoteIsToken1 = accounts.token1Mint.equals(quote);
    parsed.push({
      pool: pubkey,
      accounts,
      quoteIsToken1,
      quoteVault: quoteIsToken1 ? accounts.token1Vault : accounts.token0Vault,
      targetVault: quoteIsToken1 ? accounts.token0Vault : accounts.token1Vault,
    });
  }
  if (parsed.length === 0) return [];
  const vaultKeys = parsed.flatMap((p) => [p.quoteVault, p.targetVault]);
  const infos: Array<{ owner: PublicKey; data: Uint8Array } | null> = [];
  for (let i = 0; i < vaultKeys.length; i += 100) {
    infos.push(...(await connection.getMultipleAccountsInfo(vaultKeys.slice(i, i + 100), "confirmed")));
  }
  const out: PoolCandidate[] = parsed.map((p, i) => ({
    ...p,
    quoteReserve: amountOf(infos[2 * i]?.data),
    targetReserve: amountOf(infos[2 * i + 1]?.data),
  }));
  out.sort((a, b) => {
    const qa = a.quoteReserve ?? -1n;
    const qb = b.quoteReserve ?? -1n;
    if (qa !== qb) return qa > qb ? -1 : 1;
    return a.pool.toBase58() < b.pool.toBase58() ? -1 : 1;
  });
  return out;
}

export type Depth = "ok" | "thin" | "too thin" | "empty";

/**
 * How a pool's quote-side reserve compares with one buy. A buy of x into a
 * reserve R moves the price by roughly x / R, and execute_dca refuses a swap
 * whose output is more than max_dev_bps below the TWAP. So:
 *   empty     no quote reserve (or unreadable)
 *   too thin  one buy is more than half of the fund's max deviation of the
 *             reserve: the price impact alone can make every buy fail
 *   thin      one buy is more than 0.5% of the reserve
 *   ok        otherwise
 * `slice` is the largest single buy (per round x target share), raw units.
 */
export function poolDepth(quoteReserve: bigint | undefined, slice: bigint, maxDevBps: number): Depth {
  // A clear error instead of BigInt's RangeError for 3.5, NaN or Infinity. Callers pass a parsed integer.
  if (!Number.isSafeInteger(maxDevBps) || maxDevBps < 0) throw new Error(`max deviation must be a non-negative whole number of bps, got ${maxDevBps}`);
  if (quoteReserve === undefined || quoteReserve === 0n) return "empty";
  if (slice <= 0n) return "ok";
  // slice / reserve > maxDev / 2 / 10_000  <=>  slice * 20_000 > reserve * maxDev
  if (maxDevBps > 0 && slice * 20_000n > quoteReserve * BigInt(maxDevBps)) return "too thin";
  if (slice * 200n > quoteReserve) return "thin";
  return "ok";
}
