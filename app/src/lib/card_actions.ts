/**
 * Which action buttons on the fund NFT card are enabled, and why not.
 * Display gating only: the program and the review/simulation path enforce
 * the real rules (deposit is open to anyone; withdrawals need the holder's
 * signature).
 */
import { PublicKey } from "@solana/web3.js";

export type CardAction = "deposit" | "withdraw" | "native";
export const CARD_ACTIONS: readonly CardAction[] = ["deposit", "withdraw", "native"];
export const CARD_ACTION_LABEL: Record<CardAction, string> = { deposit: "Deposit", withdraw: "Withdraw", native: "Withdraw XNT" };

/** The fund page's run() names for the card actions. */
const RUN_TO_ACTION: Record<string, CardAction> = { deposit: "deposit", withdraw: "withdraw", "native withdraw": "native" };

/** Which card action a run() name belongs to, or undefined for other actions (ensure vaults, metadata). */
export function cardActionForRun(name: string): CardAction | undefined {
  return Object.prototype.hasOwnProperty.call(RUN_TO_ACTION, name) ? RUN_TO_ACTION[name] : undefined;
}

/**
 * Where a run's progress and error show: inside the card panel only when
 * that run's own action is the open one; otherwise under Actions. Never both.
 */
export function statusOnCard(lastRun: string, open: CardAction | null): boolean {
  const a = cardActionForRun(lastRun);
  return a !== undefined && a === open;
}

export interface CardActionState {
  enabled: boolean;
  /** Why the button is disabled; undefined when enabled. */
  hint?: string;
}

export const HINT_CONNECT = "Connect a wallet";
export const HINT_HOLDER_ONLY = "Only the NFT holder can withdraw";
export const HINT_HELD_BY_PROGRAM = "Withdrawals are blocked while a program holds the NFT";
export const HELD_BY_PROGRAM_NOTE =
  "NFT is held by a program (e.g. listed for sale). Withdrawals are blocked until it returns to a wallet. If it sells, the buyer gets everything in the fund.";
export const DEPOSIT_NOTE = "Deposits become part of the fund and belong to whoever holds the NFT.";

/**
 * True when the NFT's token account is not owned by a wallet: its owner is
 * off the ed25519 curve (a PDA, so no private key can sign for it), or the
 * account owns itself (an escrow account set as its own authority).
 */
export function heldByProgram(nft: { address: PublicKey; owner: PublicKey } | undefined): boolean {
  if (!nft) return false;
  return nft.owner.equals(nft.address) || !PublicKey.isOnCurve(nft.owner.toBytes());
}

/** Button states from the connected wallet, the NFT holder shown on the page, and the escrow check. */
export function cardActionStates(o: { wallet: PublicKey | undefined; holder: PublicKey | undefined; heldByProgram: boolean }): Record<CardAction, CardActionState> {
  if (!o.wallet) {
    const off = { enabled: false, hint: HINT_CONNECT };
    return { deposit: off, withdraw: off, native: off };
  }
  const withdraw: CardActionState = o.heldByProgram
    ? { enabled: false, hint: HINT_HELD_BY_PROGRAM }
    : o.holder && o.holder.equals(o.wallet)
      ? { enabled: true }
      : { enabled: false, hint: HINT_HOLDER_ONLY };
  return { deposit: { enabled: true }, withdraw, native: withdraw };
}
