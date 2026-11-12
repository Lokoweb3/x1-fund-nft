/**
 * Plain-language helpers for the Create Fund wizard. Pure functions, unit
 * tested in app/test/wizard.test.ts. Nothing here builds a transaction: the
 * wizard turns its answers into CreateFundArgs and the shared planners do the
 * rest.
 */
import { PublicKey } from "@solana/web3.js";
import { BPS_SUM, I64_MAX, MAX_DEV_BPS, MIN_INTERVAL_SECS, parseUint, type TargetSpec } from "@core/owner.js";

/**
 * "80", "80.5", "33.33" -> basis points (8000, 8050, 3333), exactly, with
 * no floating point. At most two decimals; 0 to 100.
 */
export function percentToBps(value: string): number {
  const v = value.trim().replace(/%$/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{0,2}))?$/.exec(v);
  if (!m) throw new Error(`"${value}" is not a percentage (use up to two decimals, like 33.33)`);
  const bps = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bps > BPS_SUM) throw new Error(`${value}% is more than 100%`);
  return bps;
}

export function bpsToPercent(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}

export interface Slice {
  mint: PublicKey;
  pool: PublicKey;
  percent: string;
}

export interface Split {
  targets: TargetSpec[];
  /** The "keep as cash" share, the remainder to 100%. 0 means no cash slice. */
  cashBps: number;
  /** Basis points per buy row, in input order. */
  rowBps: number[];
}

/**
 * Turn the buy rows plus "keep as cash" into on-chain targets whose bps sum
 * to exactly 10000. The cash slice is whatever the rows leave (it is the
 * quote mint with the default pool) and comes first, as in the CLI examples.
 */
export function splitToTargets(quote: PublicKey, rows: Slice[]): Split {
  const rowBps = rows.map((r, i) => {
    const bps = percentToBps(r.percent);
    if (bps === 0) throw new Error(`buy ${i + 1}: the share must be more than 0%`);
    return bps;
  });
  const sum = rowBps.reduce((a, b) => a + b, 0);
  if (sum > BPS_SUM) throw new Error(`the shares add up to ${bpsToPercent(sum)}%, more than 100%`);
  const cashBps = BPS_SUM - sum;
  const targets: TargetSpec[] = [];
  if (cashBps > 0) targets.push({ mint: quote, pool: PublicKey.default, bps: cashBps });
  rows.forEach((r, i) => targets.push({ mint: r.mint, pool: r.pool, bps: rowBps[i]! }));
  const total = targets.reduce((a, t) => a + t.bps, 0);
  if (total !== BPS_SUM) throw new Error(`internal: shares sum to ${total} bps`);
  return { targets, cashBps, rowBps };
}

export interface Frequency {
  label: string;
  secs: number;
}

export const FREQUENCIES: readonly Frequency[] = [
  { label: "Every 5 minutes", secs: 300 },
  { label: "Every 15 minutes", secs: 900 },
  { label: "Every hour", secs: 3600 },
  { label: "Every 4 hours", secs: 14_400 },
  { label: "Every day", secs: 86_400 },
  { label: "Every week", secs: 604_800 },
];

export const MIN_CUSTOM_SECS = Number(MIN_INTERVAL_SECS);

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** 3600 -> "1 hour", 90 -> "90 seconds", 14400 -> "4 hours", 604800 -> "1 week". */
export function humanInterval(secs: number | bigint): string {
  const s = Number(secs);
  if (s % 604_800 === 0) return plural(s / 604_800, "week");
  if (s % 86_400 === 0) return plural(s / 86_400, "day");
  if (s % 3600 === 0) return plural(s / 3600, "hour");
  if (s % 60 === 0) return plural(s / 60, "minute");
  return plural(s, "second");
}

/** Rough duration for projections: "about 4 days", "about 10 hours", "about 3 weeks". */
export function humanDuration(secs: number): string {
  if (secs < 90) return "less than 2 minutes";
  if (secs < 5400) return `about ${plural(Math.round(secs / 60), "minute")}`;
  if (secs < 2 * 86_400) return `about ${plural(Math.round(secs / 3600), "hour")}`;
  if (secs < 21 * 86_400) return `about ${plural(Math.round(secs / 86_400), "day")}`;
  if (secs < 120 * 86_400) return `about ${plural(Math.round(secs / 604_800), "week")}`;
  if (secs < 730 * 86_400) return `about ${plural(Math.round(secs / (30 * 86_400)), "month")}`;
  return `about ${plural(Math.round(secs / (365 * 86_400)), "year")}`;
}

/** Countdown for "Next buy in ...": "now", "23 min", "2 h 5 min", "3 days". */
export function countdown(secs: bigint | number): string {
  const s = Number(secs);
  if (s <= 0) return "now";
  if (s < 60) return "under a minute";
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  return plural(Math.round(s / 86_400), "day");
}

export interface Projection {
  /** Buys each non-cash target makes before its budget runs out. */
  buys: number;
  /** Seconds from the first buy to the last. The first buy is due as soon as the deposit lands. */
  seconds: number;
  /** Quote spent on swaps per round, all targets together. */
  spentPerRound: bigint;
}

/**
 * How long a deposit lasts, by the program's arithmetic (accounting.rs):
 * each target's budget is deposit x bps / 10000 and each buy takes
 * per_run x bps / 10000 of it, so every non-cash target lasts about
 * deposit / per_run buys. Transfer fees and rounding make it approximate.
 */
export function project(deposit: bigint, perRun: bigint, intervalSecs: bigint, targets: Array<{ bps: number; cash: boolean }>): Projection | undefined {
  const spend = targets.filter((t) => !t.cash);
  if (deposit <= 0n || perRun <= 0n || spend.length === 0) return undefined;
  let buys = 0;
  let spentPerRound = 0n;
  for (const t of spend) {
    const budget = (deposit * BigInt(t.bps)) / 10_000n;
    const slice = (perRun * BigInt(t.bps)) / 10_000n;
    spentPerRound += slice;
    if (slice === 0n || budget === 0n) continue;
    const n = Number((budget + slice - 1n) / slice);
    buys = Math.max(buys, n);
  }
  if (buys === 0) return undefined;
  return { buys, seconds: (buys - 1) * Number(intervalSecs), spentPerRound };
}

/**
 * The schedule text ("3600", or the custom seconds) as a validated interval:
 * a whole number of seconds, at least MIN_INTERVAL_SECS, that fits an i64.
 * undefined for anything else ("60.5", "Infinity", "", "-1", "1e3"). The
 * wizard renders only from this, never from the raw text.
 */
export function parseIntervalSecs(text: string): bigint | undefined {
  try {
    const v = parseUint(text.trim(), "how often", I64_MAX);
    return v >= MIN_INTERVAL_SECS ? v : undefined;
  } catch {
    return undefined;
  }
}

export const INTERVAL_INVALID = `Enter a whole number of seconds, at least ${MIN_INTERVAL_SECS} (no decimals).`;

/** Max deviation text as validated basis points: a whole number from 0 to MAX_DEV_BPS, else undefined. */
export function parseMaxDevBps(text: string): number | undefined {
  try {
    return Number(parseUint(text.trim(), "the max deviation", BigInt(MAX_DEV_BPS)));
  } catch {
    return undefined;
  }
}

export const MAX_DEV_INVALID = `Enter a whole number of basis points from 0 to ${MAX_DEV_BPS} (300 bps = 3%).`;
