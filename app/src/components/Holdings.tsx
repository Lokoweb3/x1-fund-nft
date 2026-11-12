import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import type { FundView } from "@core/rpc.js";
import type { TokenLabel } from "../lib/tokens";
import { bpsToPercent } from "../lib/wizard";
import { formatApprox, loadValuation, sharePercent, type Valuation } from "../lib/value";

export type ValuationState = { status: "loading" } | { status: "error" } | { status: "ok"; valuation: Valuation };

/** Valuation of a loaded view, refetched whenever the view object changes. Display only. */
export function useValuation(connection: Connection | undefined, view: FundView | null): ValuationState {
  const [state, setState] = useState<{ view: FundView; value: ValuationState } | null>(null);
  useEffect(() => {
    if (!connection || !view) return;
    let cancelled = false;
    loadValuation(connection, view).then(
      (valuation) => !cancelled && setState({ view, value: { status: "ok", valuation } }),
      () => !cancelled && setState({ view, value: { status: "error" } }),
    );
    return () => {
      cancelled = true;
    };
  }, [connection, view]);
  if (!view || !state) return { status: "loading" };
  // Keep the previous numbers on screen while a poll refetches.
  return state.value;
}

const symOf = (labels: Record<string, TokenLabel>, mint: string) => labels[mint]?.symbol ?? `${mint.slice(0, 4)}…`;

/** The fund's worth at the pools' current prices, per token. */
export function HoldingsCard({ state, view, labels }: { state: ValuationState; view: FundView; labels: Record<string, TokenLabel> }) {
  const q = symOf(labels, view.account.quoteMint.toBase58());
  const qd = view.quote.decimals;
  const v = state.status === "ok" ? state.valuation : undefined;
  const fees = v?.rows.filter((r) => r.withdrawFee > 0n) ?? [];
  return (
    <div className="holdings" data-testid="holdings">
      <div className="stats">
        <div className="stat stat-main">
          <span className="stat-label">Estimated value</span>
          <span className="stat-value" data-testid="holdings-total">
            {state.status === "loading" && "…"}
            {state.status === "error" && "unknown"}
            {v && (
              <>
                ≈ {formatApprox(v.total, qd)} <span className="stat-unit">{q}</span>
                {!v.complete && <span className="stat-unit"> + unknown</span>}
              </>
            )}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{q} left to spend</span>
          <span className="stat-value small-value">
            {view.vaults[0]?.balance === undefined ? "unknown" : formatApprox(view.vaults[0].balance, qd)}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Tokens held</span>
          <span className="stat-value small-value">{view.vaults.filter((x) => (x.balance ?? 0n) > 0n).length}</span>
        </div>
      </div>
      {v && (
        <ul className="holding-list">
          {v.rows.map((r) => {
            const mint = r.mint.address.toBase58();
            const share = r.value !== undefined ? sharePercent(r.value, v.total) : 0;
            return (
              <li key={mint} className="holding" data-testid={`holding-${mint}`}>
                <span className="chip-token" title={mint}>
                  <span className="dot" aria-hidden="true" />
                  {symOf(labels, mint)}
                  {r.isQuote && <span className="tag">quote</span>}
                </span>
                <span className="holding-balance mono">{r.balance === undefined ? "missing" : formatApprox(r.balance, r.mint.decimals)}</span>
                <span className="holding-value">
                  {r.value === undefined ? <span className="muted">value unknown</span> : `≈ ${formatApprox(r.value, qd)} ${q}`}
                </span>
                <span className="holding-share" aria-label={`${share}% of the total`}>
                  <span className="bar" aria-hidden="true">
                    <span style={{ width: `${Math.min(100, share)}%` }} />
                  </span>
                  <span className="small muted">{r.value === undefined ? "–" : `${share}%`}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {fees.map((r) => (
        <p key={r.mint.address.toBase58()} className="small warn-text" data-testid="holding-fee-note">
          {symOf(labels, r.mint.address.toBase58())}: withdrawing pays its {bpsToPercent(r.transferFeeBps)}% transfer fee (about{" "}
          {formatApprox(r.withdrawFee, r.mint.decimals)} {symOf(labels, r.mint.address.toBase58())} on the whole balance).
        </p>
      ))}
      <p className="small muted">
        Estimate at each pool's current price, before transfer fees and price impact. Display only: it is not what a swap or withdrawal
        would pay.
      </p>
    </div>
  );
}

/** One-line value for a fund list item: "≈ 10.4 WXNT · 9.8 WXNT left to spend". */
export function ValueLine({ state, view, quoteSymbol }: { state: ValuationState | { status: "error" }; view: FundView | null; quoteSymbol: string }) {
  if (state.status === "error") return <span className="value-line muted" data-testid="fund-value">value unknown</span>;
  if (state.status === "loading" || !view) return <span className="value-line muted" data-testid="fund-value">valuing…</span>;
  const v = state.valuation;
  const d = view.quote.decimals;
  return (
    <span className="value-line" data-testid="fund-value">
      <strong>
        ≈ {formatApprox(v.total, d)} {quoteSymbol}
        {!v.complete && " + unknown"}
      </strong>
      {v.quoteBalance !== undefined && (
        <span className="muted">
          {" "}
          · {formatApprox(v.quoteBalance, d)} {quoteSymbol} left to spend
        </span>
      )}
    </span>
  );
}
