/**
 * Native XNT on a Fund account (reflections, direct transfers), as the
 * shared core reads it (readNativeBalance) and withdraw_native moves it:
 * only the lamports above the account's rent-exempt minimum. Pure helpers
 * for the fund page; the plan itself comes from prepareWithdrawNative.
 */
import { formatUi, parseUi } from "@core/owner.js";
import type { NativeBalance } from "@core/rpc.js";

/** XNT has 9 decimals (lamports). */
export const XNT_DECIMALS = 9;

export const NATIVE_NOT_HOLDER = "Only the wallet that holds the fund NFT can withdraw native XNT.";
export const NATIVE_NOTHING =
  "Nothing to withdraw yet. Native XNT arrives here from reflection tokens like Test or from direct transfers.";

export const xntUi = (lamports: bigint) => formatUi(lamports, XNT_DECIMALS);

/** "Native XNT on the fund: X (available to withdraw: Y; Z stays for rent)". */
export function nativeLine(b: NativeBalance): string {
  return `Native XNT on the fund: ${xntUi(b.lamports)} (available to withdraw: ${xntUi(b.available)}; ${xntUi(b.rentMinimum)} stays for rent)`;
}

/**
 * The amount a native withdraw review is built for: "all", or the XNT
 * decimal input as exact lamports. Refuses empty, zero, more than 9
 * decimals, and more than is available (the core and the program check
 * again; this only catches it before any RPC call).
 */
export function parseNativeAmount(input: string, all: boolean, available: bigint): bigint | "all" {
  if (all) return "all";
  const raw = parseUi(input, XNT_DECIMALS, "amount");
  if (raw === 0n) throw new Error("amount must be greater than zero");
  if (raw > available) throw new Error(`amount ${xntUi(raw)} XNT is more than the ${xntUi(available)} XNT available to withdraw`);
  return raw;
}

/** Why "Review native withdraw" is disabled, or undefined when it may be built. */
export function nativeBlocker(o: { holder: boolean; available: bigint | undefined; readError?: string }): string | undefined {
  if (o.readError) return `The fund's native XNT balance could not be read: ${o.readError}`;
  if (o.available === undefined) return "Reading the fund's native XNT balance...";
  if (!o.holder) return NATIVE_NOT_HOLDER;
  if (o.available === 0n) return NATIVE_NOTHING;
  return undefined;
}
