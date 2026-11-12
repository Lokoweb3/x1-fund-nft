/**
 * Friendly error messages: plain words plus one action, with the original
 * text kept for the technical details. Matching is on the shared core's own
 * error text, so the CLI and the app stay in step.
 */
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

export function friendlyError(err: unknown, opts: { cluster?: string } = {}): Friendly {
  const raw = errText(err);
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
    return { title: "Token Metadata changed your wallet account, transaction refused. Nothing was changed.", raw };
  }
  if (/AttachCostTooHigh|0x17a3\b|"Custom":6051/.test(raw)) {
    return { title: "Attaching the NFT metadata would cost more than the program allows (0.03 XNT), so it refused.", raw };
  }
  if (/not resuming yet/.test(raw)) {
    return {
      title: "An earlier transaction of this inscription may still land. Try Resume again in about a minute, once it has confirmed or expired.",
      raw,
    };
  }
  if (/FeeChanged|6069|above the max fee/.test(raw)) {
    return { title: "The inscription fee is higher than your maximum. Read the fee again and decide.", raw };
  }
  if (/User rejected|rejected the request/i.test(raw)) {
    return { title: "You declined in the wallet. Nothing was sent.", raw };
  }
  return { title: raw.split("\n")[0]!, raw };
}
