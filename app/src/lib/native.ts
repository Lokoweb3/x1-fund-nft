/**
 * Native XNT on a Fund account (reflections, direct transfers), as the
 * shared core reads it (readNativeBalance) and withdraw_native moves it:
 * only the lamports above the account's rent-exempt minimum. Pure helpers
 * for the fund page; the plan itself comes from prepareWithdrawNative.
 *
 * Above 2^53 - 1 lamports the RPC number may be rounded, so the core
 * returns an inexact balance: nothing is computed from it, "all" is
 * refused, and a typed amount goes to the program, which enforces the
 * rent floor itself.
 */
import { formatUi, parseUi } from "@core/owner.js";
import type { InexactNativeBalance, NativeBalance } from "@core/rpc.js";

export type AnyNativeBalance = NativeBalance | InexactNativeBalance;

/** XNT has 9 decimals (lamports). */
export const XNT_DECIMALS = 9;

export const NATIVE_NOT_HOLDER = "Only the wallet that holds the fund NFT can withdraw native XNT.";
export const NATIVE_NOTHING =
  "Nothing to withdraw yet. Native XNT arrives here from reflection tokens like Test or from direct transfers.";
export const NATIVE_INEXACT_NOTE =
  'The balance is too large to compute exactly here, so "all" is off and a typed amount is not checked in the app. The program enforces the rent floor: it refuses any amount that would take the fund account below its rent-exempt minimum.';

export const xntUi = (lamports: bigint) => formatUi(lamports, XNT_DECIMALS);

/** A possibly rounded lamport number as approximate XNT, display only. */
export function approxXnt(lamports: number): string {
  return (lamports / 1e9).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

/** "Native XNT on the fund: X (available to withdraw: Y; Z stays for rent)", or the inexact form. */
export function nativeLine(b: AnyNativeBalance): string {
  if (!b.exact) return `Native XNT on the fund: balance too large to display exactly (~${approxXnt(b.approxLamports)} XNT)`;
  return `Native XNT on the fund: ${xntUi(b.lamports)} (available to withdraw: ${xntUi(b.available)}; ${xntUi(b.rentMinimum)} stays for rent)`;
}

/** Exact withdrawable lamports, or undefined when the balance is inexact (never priced or totalled then). */
export function exactAvailable(b: AnyNativeBalance | undefined): bigint | undefined {
  return b?.exact ? b.available : undefined;
}

/**
 * The amount a native withdraw review is built for: "all", or the XNT
 * decimal input as exact lamports. Refuses empty, zero, more than 9
 * decimals, and (exact balance) more than is available; with an inexact
 * balance refuses "all" and leaves the upper bound to the program. The core
 * and the program check again; this only catches it before any RPC call.
 */
export function parseNativeAmount(input: string, all: boolean, b: AnyNativeBalance): bigint | "all" {
  if (all) {
    if (!b.exact) throw new Error('"all" is not available: the balance is too large to compute exactly. Type an amount.');
    return "all";
  }
  const raw = parseUi(input, XNT_DECIMALS, "amount");
  if (raw === 0n) throw new Error("amount must be greater than zero");
  if (b.exact && raw > b.available) throw new Error(`amount ${xntUi(raw)} XNT is more than the ${xntUi(b.available)} XNT available to withdraw`);
  return raw;
}

/** Why "Review native withdraw" is disabled, or undefined when it may be built. */
export function nativeBlocker(o: { holder: boolean; balance: AnyNativeBalance | undefined; readError?: string }): string | undefined {
  if (o.readError) return `The fund's native XNT balance could not be read: ${o.readError}`;
  if (o.balance === undefined) return "Reading the fund's native XNT balance...";
  if (!o.holder) return NATIVE_NOT_HOLDER;
  if (o.balance.exact && o.balance.available === 0n) return NATIVE_NOTHING;
  return undefined;
}
