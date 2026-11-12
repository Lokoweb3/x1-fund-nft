/**
 * Display formatting for the holdings and NFT cards. Truncates (never
 * rounds up), so a shown amount is never more than what is held. Display
 * only; exact amounts go in a title tooltip via `exactUi`.
 */
import { formatUi } from "@core/owner.js";

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";
const sep = (n: bigint) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const sub = (n: number) => [...String(n)].map((d) => SUBSCRIPT[Number(d)]).join("");

/** The exact amount, for a tooltip. */
export function exactUi(raw: bigint, decimals: number): string {
  return formatUi(raw, decimals);
}

/**
 * A token amount:
 * - at least 1,000: separators, no decimals ("3,036");
 * - 1 to 1,000: at most 2 decimals ("9.5", "12.34");
 * - below 1: 4 significant digits; 3 or more leading zeros collapse into a
 *   subscript count ("0.00005024" -> "0.0₄5024").
 */
export function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0");
  if (whole >= 1000n) return sep(whole);
  if (whole >= 1n) {
    const f = frac.slice(0, 2).replace(/0+$/, "");
    return f ? `${sep(whole)}.${f}` : sep(whole);
  }
  const zeros = frac.search(/[1-9]/);
  const digits = frac.slice(zeros, zeros + 4).replace(/0+$/, "");
  return zeros >= 3 ? `0.0${sub(zeros)}${digits}` : `0.${"0".repeat(zeros)}${digits}`;
}

/**
 * A value in the quote token: 2 decimals at 1 and above ("9.97",
 * "1,234.50"), 4 decimals below 1 ("0.2251"), "<0.0001" for a positive
 * value under that.
 */
export function formatValue(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").padEnd(4, "0");
  if (whole >= 1n) return `${sep(whole)}.${frac.slice(0, 2)}`;
  const f = frac.slice(0, 4);
  return /^0+$/.test(f) ? "<0.0001" : `0.${f}`;
}

/** A share for a legend or table: whole percent, "<1%" for a positive share under 0.5%. */
export function formatShare(percent: number): string {
  if (percent <= 0) return "0%";
  const r = Math.round(percent);
  return r === 0 ? "<1%" : `${r}%`;
}
