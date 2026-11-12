/**
 * Curated pay-with / buy shortcuts and token labels.
 *
 * The list is a shortcut, not a source of truth: pasting a mint is the main
 * input, and every mint (curated or pasted) is read from the selected RPC and
 * checked the same way. Mints are X1 MAINNET addresses from
 * docs/ASSUMPTIONS.md (and the USDC.X/TEST pool docs). On a local validator
 * only the cloned ones (USDC.X, TEST) exist; on testnet none of them do.
 */
import type { PublicKey } from "@solana/web3.js";
import type { DetectedCluster } from "@core/cluster.js";

export interface CuratedToken {
  symbol: string;
  name: string;
  mint: string;
  network: "mainnet";
  note?: string;
}

export const CURATED_TOKENS: readonly CuratedToken[] = [
  { symbol: "USDC.X", name: "USDC.X", mint: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq", network: "mainnet" },
  { symbol: "TEST", name: "Test", mint: "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz", network: "mainnet", note: "5% transfer fee" },
  { symbol: "JACK", name: "JACK", mint: "54uAdhRHZmbGnD1tATH7F7Qp5us7xsXJQTf6MpMEdFbg", network: "mainnet" },
  { symbol: "GOOGL.X", name: "Alphabet xStock", mint: "E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5", network: "mainnet" },
  { symbol: "PEPE", name: "Pepe", mint: "81LkybSBLvXYMTF6azXohUWyBvDGUXznm4yiXPkYkDTJ", network: "mainnet" },
  { symbol: "WXNT", name: "Wrapped XNT", mint: "So11111111111111111111111111111111111111112", network: "mainnet", note: "wrapped native XNT (classic SPL Token)" },
];

export function curatedFor(mint: string | PublicKey): CuratedToken | undefined {
  const m = typeof mint === "string" ? mint : mint.toBase58();
  return CURATED_TOKENS.find((t) => t.mint === m);
}

/** Where a label came from, shown next to it so nobody mistakes a label for an identity. */
export type LabelSource = "token-2022" | "metaplex" | "curated" | "address";

export interface TokenLabel {
  symbol: string;
  name: string;
  source: LabelSource;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** A symbol may only contain printable characters; anything else falls through to the next source. */
function clean(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return t ? t.slice(0, 24) : undefined;
}

/**
 * Label order: the mint's own on-chain metadata (Token-2022 TokenMetadata,
 * then Metaplex), then the curated list, then the short address.
 */
export function labelFor(
  mint: string | PublicKey,
  onchain?: { symbol?: string; name?: string; nameSource?: "token-2022" | "metaplex" },
): TokenLabel {
  const m = typeof mint === "string" ? mint : mint.toBase58();
  const symbol = clean(onchain?.symbol);
  if (symbol && onchain?.nameSource) return { symbol, name: clean(onchain.name) ?? symbol, source: onchain.nameSource };
  const c = curatedFor(m);
  if (c) return { symbol: c.symbol, name: c.name, source: "curated" };
  return { symbol: shortAddress(m), name: m, source: "address" };
}

/** Note shown above the curated shortcuts for the current network. */
export function curatedNote(cluster: DetectedCluster | undefined): string {
  switch (cluster) {
    case "mainnet":
      return "X1 mainnet tokens.";
    case "localnet":
      return "These are X1 mainnet addresses. A local validator from scripts/local-validator.sh has only USDC.X and TEST.";
    default:
      return "These are X1 mainnet addresses; they may not exist on this network.";
  }
}
