/**
 * Friendly error messages: plain words plus one action, with the original
 * text kept for the technical details. Matching is on the shared core's own
 * error text, so the CLI and the app stay in step.
 */
import { PROGRAM_ID } from "@core/owner.js";

export type ErrorAction = "switch-local" | "connect-wallet" | "fewer-tokens" | "change-token" | "add-funds";

export interface Friendly {
  title: string;
  action?: { kind: ErrorAction; label: string };
  /** The original message, always shown under "details". */
  raw: string;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Where a multi-transaction send stopped: the PlanSendError's fields (or the
 * same fields kept on a send record). It scopes "nothing was sent" and
 * "nothing was changed" to what is actually true.
 */
export interface SendScope {
  /** Confirmed transactions, in order (they are transactions 1..done.length). */
  done: ReadonlyArray<{ signature: string }>;
  failedIndex: number;
  total: number;
}

function scopeOf(err: unknown, given: SendScope | undefined): SendScope | undefined {
  if (given) return given;
  const e = err as Partial<{ name: string; done: { signature: string }[]; failedIndex: number; total: number }> | null;
  if (e && typeof e === "object" && e.name === "PlanSendError" && Array.isArray(e.done) && typeof e.failedIndex === "number") {
    return { done: e.done, failedIndex: e.failedIndex, total: typeof e.total === "number" ? e.total : e.failedIndex + 1 };
  }
  return undefined;
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const range = (from: number, to: number) => (from === to ? `transaction ${from} was` : `transactions ${from}–${to} were`);

/** "Transaction 1 had already confirmed (signature X)." for the confirmed part, or "" if none. */
function confirmedPart(sc: SendScope): string {
  const n = sc.done.length;
  if (n === 0) return "";
  const which = n === 1 ? "Transaction 1 had" : `Transactions 1–${n} had`;
  const sigs = sc.done.map((d) => d.signature).join(", ");
  return `${which} already confirmed (signature${n === 1 ? "" : "s"} ${sigs})`;
}

/** The wallet declined transaction failedIndex: it and every later one were not sent. */
function declined(sc: SendScope | undefined, raw: string): string {
  if (!sc) {
    // Without the send's fields, only the message says whether anything confirmed first.
    return /confirmed before the failure/.test(raw)
      ? "You declined in the wallet. Earlier transactions of this send had already confirmed (listed below); the rest were not sent."
      : "You declined in the wallet. Nothing was sent.";
  }
  const no = sc.failedIndex + 1;
  if (sc.done.length === 0) return sc.total > 1 ? `You declined transaction ${no} of ${sc.total} in the wallet. Nothing was sent.` : "You declined in the wallet. Nothing was sent.";
  return `You declined transaction ${no} of ${sc.total} in the wallet. ${confirmedPart(sc)}; ${range(no, sc.total)} not sent.`;
}

/** An on-chain refusal of transaction failedIndex: that one changed nothing; earlier ones may have. */
function refusedOnChain(sc: SendScope | undefined, raw: string, what: string): string {
  if (!sc) {
    return /confirmed before the failure/.test(raw)
      ? `${what} That transaction changed nothing, but earlier transactions of this send had already confirmed (listed below).`
      : `${what} Nothing was changed.`;
  }
  if (sc.done.length === 0 && sc.total === 1) return `${what} Nothing was changed.`;
  const no = sc.failedIndex + 1;
  const parts = [`${what} Transaction ${no} of ${sc.total} changed nothing.`];
  if (sc.done.length > 0) parts.push(`${confirmedPart(sc)}.`);
  if (no < sc.total) parts.push(`${cap(range(no + 1, sc.total))} not sent.`);
  return parts.join(" ");
}

export const NATIVE_WITHDRAW_MISSING =
  "This program version has no native withdraw yet. The owner must upgrade the program first (docs/UPGRADE_WITHDRAW_NATIVE.md).";

/** The action an error came from, when the message depends on it. */
export type FailingAction = "withdraw-native";

/**
 * Anchor error 101 (InstructionFallbackNotFound): the deployed program has no
 * handler for the instruction. Of the app's instructions only withdraw_native
 * is newer than the first mainnet build, so this means "upgrade first", but
 * ONLY for the native withdraw action and only when the program that failed
 * is the fund program: inscriptions, Token Metadata, Core and others have
 * their own 101s, and a fallback error from create_fund or another action
 * is not about native withdraw. When the text names failing programs
 * ("Program X failed"), the fund program must be one of them. Without such a
 * line, the named form must mention the fund program id; a bare code
 * (Custom 101 / 0x65) is accepted, because the native withdraw transaction
 * holds only the compute budget instructions and withdraw_native.
 */
function isFallbackNotFound(raw: string, action: FailingAction | undefined): boolean {
  if (action !== "withdraw-native") return false;
  const named = /InstructionFallbackNotFound/.test(raw);
  const bare = /"Custom":101\b|custom program error: 0x65\b|Error Number: 101\./.test(raw);
  if (!named && !bare) return false;
  const fund = PROGRAM_ID.toBase58();
  const failed = [...raw.matchAll(/Program ([1-9A-HJ-NP-Za-km-z]{32,44}) failed/g)].map((m) => m[1]);
  if (failed.length > 0) return failed.includes(fund);
  return named ? raw.includes(fund) : true;
}

export function friendlyError(err: unknown, opts: { cluster?: string; send?: SendScope; action?: FailingAction } = {}): Friendly {
  const raw = errText(err);
  const sc = scopeOf(err, opts.send);
  if (isFallbackNotFound(raw, opts.action)) return { title: NATIVE_WITHDRAW_MISSING, raw };
  if (/NativeAboveAvailable|0x17a6\b|"Custom":6054\b/.test(raw)) {
    return {
      title: refusedOnChain(
        sc,
        raw,
        "The fund no longer has that much native XNT above its rent reserve, so the program refused. Refresh the page and try a smaller amount or \"all\".",
      ),
      raw,
    };
  }
  if (/is not deployed on this RPC/.test(raw)) {
    return {
      title:
        opts.cluster === "localnet"
          ? "The fund program is not loaded on this local validator. Start it with scripts/local-validator.sh."
          : "The fund program is not deployed on this network yet, so nothing can be created here. You can try the whole flow on a local validator.",
      action: opts.cluster === "localnet" ? undefined : { kind: "switch-local", label: "Switch to Local validator to try it" },
      raw,
    };
  }
  if (/Token Metadata .* is not deployed/.test(raw)) {
    return { title: "This network has no Metaplex Token Metadata program, so the NFT cannot get an image here.", raw };
  }
  if (/X1 Inscriptions config|no X1 Inscriptions config|X1 Inscriptions is not/.test(raw)) {
    return { title: "X1 Inscriptions is not available on this network. Host the JSON yourself (option b) or paste a link (option c).", raw };
  }
  if (/Connect a wallet|no signer|wallet not connected/i.test(raw)) {
    return { title: "Connect a wallet first.", action: { kind: "connect-wallet", label: "Connect a wallet" }, raw };
  }
  if (/is below the deposit|insufficient funds|insufficient lamports|0x1\b|Attempt to debit an account but found no record of a prior credit/i.test(raw)) {
    return {
      title: "Your wallet does not have enough for this: the token amount, or XNT for fees and rent.",
      action: { kind: "add-funds", label: "Lower the amount or add funds" },
      raw,
    };
  }
  if (/the limit is 1232|do not fit in one transaction/.test(raw)) {
    return { title: "Too many tokens for one transaction. Remove a token and try again.", action: { kind: "fewer-tokens", label: "Remove a token" }, raw };
  }
  if (/pool .* does not exist|no XDEX pool|is owned by .* not XDEX|trades .* not quote/.test(raw)) {
    return { title: "The pool for one of the tokens could not be used. Pick the token again so the app can find its pool.", action: { kind: "change-token", label: "Change the token" }, raw };
  }
  if (/PayerNotWallet|0x17a4\b|"Custom":6052/.test(raw)) {
    return { title: "Pay for the image from an ordinary wallet. The paying account must be a plain wallet account, so the program refused.", raw };
  }
  if (/PayerChanged|0x17a5\b|"Custom":6053/.test(raw)) {
    return { title: refusedOnChain(sc, raw, "Token Metadata changed your wallet account, transaction refused."), raw };
  }
  if (/AttachCostTooHigh|0x17a3\b|"Custom":6051/.test(raw)) {
    return { title: "Attaching the NFT metadata would cost more than the program allows (0.03 XNT), so it refused.", raw };
  }
  if (/only sends single-transaction inscriptions|Too large to inscribe in one transaction/.test(raw)) {
    return { title: "This JSON is too large to inscribe in one transaction (max 600 bytes). Turn on Compact, shorten the description, or use Upload/Paste link.", raw };
  }
  if (/FeeChanged|6069|above the max fee/.test(raw)) {
    return { title: "The inscription fee is higher than your maximum. Read the fee again and decide.", raw };
  }
  if (/User rejected|rejected the request/i.test(raw)) {
    return { title: declined(sc, raw), raw };
  }
  return { title: raw.split("\n")[0]!, raw };
}

/**
 * A friendly reading of a failed simulation (error plus logs), or undefined
 * when no mapping applies and the raw status is the best text. `action` is
 * the review's action (see FailingAction).
 */
export function friendlySim(sim: { label: string; err: unknown; logs: string[] }, opts: { action?: FailingAction } = {}): Friendly | undefined {
  if (sim.err === null || sim.err === undefined) return undefined;
  const raw = [`${sim.label}: simulation failed ${JSON.stringify(sim.err)}`, ...sim.logs].join("\n");
  const f = friendlyError(raw, { action: opts.action });
  return f.title === raw.split("\n")[0] ? undefined : f;
}
