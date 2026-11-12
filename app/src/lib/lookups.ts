/**
 * React hooks that read token and pool facts from the SELECTED RPC only.
 * Every result is tagged with the network generation it was read under and
 * dropped when the network, the input or the wallet changes.
 */
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { XDEX_PROGRAM_ID } from "@core/owner.js";
import { findPools, type PoolCandidate, type PoolFinderConnection } from "@core/pool_finder.js";
import { describeMintPolicyError } from "@core/mint_policy.js";
import { describeNotAMint, readTokenInfo, readTokenInfos, walletTokenBalance, type TokenInfo } from "@core/token_info.js";
import type { NetworkInfo } from "./network";
import { labelFor, type TokenLabel } from "./tokens";

export type MintLookup =
  | { status: "empty" }
  | { status: "invalid"; message: string }
  | { status: "loading" }
  | { status: "error"; message: string; label?: TokenLabel; info?: TokenInfo }
  | { status: "ok"; info: TokenInfo; label: TokenLabel; balance: bigint | undefined };

export function parseMintInput(value: string): PublicKey | string {
  const v = value.trim();
  if (!v) return "";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return "this is not a token address (base58, 32-44 characters)";
  try {
    return new PublicKey(v);
  } catch {
    return "this is not a valid address";
  }
}

/** Resolve a pasted mint: validate, read, name it, check the program's extension policy, read the wallet's balance. */
export function useMintLookup(net: NetworkInfo | null, value: string, owner: PublicKey | null): MintLookup {
  const [state, setState] = useState<{ key: string; lookup: MintLookup }>({ key: "", lookup: { status: "empty" } });
  const parsed = parseMintInput(value);
  const key = `${net?.generation ?? -1}|${typeof parsed === "string" ? parsed : parsed.toBase58()}|${owner?.toBase58() ?? ""}`;
  useEffect(() => {
    if (typeof parsed === "string" || !net) return;
    let cancelled = false;
    setState({ key, lookup: { status: "loading" } });
    (async () => {
      try {
        const r = await readTokenInfo(net.connection, parsed);
        if (cancelled) return;
        if (!r.ok) {
          setState({ key, lookup: { status: "error", message: `Not a token mint: ${describeNotAMint(r.why)}.` } });
          return;
        }
        const label = labelFor(parsed, r.info);
        if (!r.info.policy.ok) {
          setState({ key, lookup: { status: "error", info: r.info, label, message: `The fund program refuses this token: ${describeMintPolicyError(r.info.policy)}.` } });
          return;
        }
        let balance: bigint | undefined;
        if (owner) {
          try {
            balance = await walletTokenBalance(net.connection, owner, parsed);
          } catch {
            balance = undefined;
          }
        }
        if (!cancelled) setState({ key, lookup: { status: "ok", info: r.info, label, balance } });
      } catch (err) {
        if (!cancelled) setState({ key, lookup: { status: "error", message: `Could not read this token: ${err instanceof Error ? err.message : String(err)}` } });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (typeof parsed === "string") return parsed ? { status: "invalid", message: parsed } : { status: "empty" };
  if (!net || state.key !== key) return { status: "loading" };
  return state.lookup;
}

export type PoolLookup =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; pools: PoolCandidate[] };

/** Auto-find the XDEX pools for quote/target on the selected RPC (pool_finder.ts). */
export function usePools(net: NetworkInfo | null, quote: PublicKey | undefined, target: PublicKey | undefined): PoolLookup {
  const [state, setState] = useState<{ key: string; lookup: PoolLookup }>({ key: "", lookup: { status: "idle" } });
  const key = `${net?.generation ?? -1}|${quote?.toBase58() ?? ""}|${target?.toBase58() ?? ""}`;
  const ready = !!net && !!quote && !!target && !quote.equals(target);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setState({ key, lookup: { status: "loading" } });
    findPools(net!.connection as unknown as PoolFinderConnection, XDEX_PROGRAM_ID, quote!, target!).then(
      (pools) => !cancelled && setState({ key, lookup: { status: "ok", pools } }),
      (err: unknown) => !cancelled && setState({ key, lookup: { status: "error", message: `Could not search XDEX pools: ${err instanceof Error ? err.message : String(err)}` } }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ready]);
  if (!ready) return { status: "idle" };
  if (state.key !== key) return { status: "loading" };
  return state.lookup;
}

/** Labels for a set of mints (on-chain metadata, then curated list, then short address). */
export function useTokenLabels(net: NetworkInfo | null, mints: PublicKey[]): Record<string, TokenLabel> {
  const list = [...new Set(mints.map((m) => m.toBase58()))].sort();
  const key = `${net?.generation ?? -1}|${list.join(",")}`;
  const fallback = Object.fromEntries(list.map((m) => [m, labelFor(m)]));
  const [state, setState] = useState<{ key: string; labels: Record<string, TokenLabel> }>({ key: "", labels: {} });
  useEffect(() => {
    if (!net || list.length === 0) return;
    let cancelled = false;
    readTokenInfos(net.connection, list.map((m) => new PublicKey(m))).then(
      (rs) => {
        if (cancelled) return;
        const labels: Record<string, TokenLabel> = {};
        rs.forEach((r, i) => (labels[list[i]!] = labelFor(list[i]!, r.ok ? r.info : undefined)));
        setState({ key, labels });
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state.key === key ? { ...fallback, ...state.labels } : fallback;
}
