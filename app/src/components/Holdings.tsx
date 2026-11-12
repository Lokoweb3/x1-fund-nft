import { useEffect, useState } from "react";
import type { Connection } from "@solana/web3.js";
import type { FundView } from "@core/rpc.js";
import type { TokenLabel } from "../lib/tokens";
import { bpsToPercent } from "../lib/wizard";
import { exactUi, formatAmount, formatShare, formatValue } from "../lib/format";
import { loadValuation, sharePercent, sortByValue, type HoldingRow, type Valuation } from "../lib/value";

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

export const symOf = (labels: Record<string, TokenLabel>, mint: string) => labels[mint]?.symbol ?? `${mint.slice(0, 4)}…`;

/** Token name for a row: the quote token reads "<symbol> (unspent)". */
export function rowName(r: HoldingRow, labels: Record<string, TokenLabel>): string {
  const s = symOf(labels, r.mint.address.toBase58());
  return r.isQuote ? `${s} (unspent)` : s;
}

/** The fund's worth at the pools' current prices, per token, as one table. */
export function HoldingsCard({ state, view, labels }: { state: ValuationState; view: FundView; labels: Record<string, TokenLabel> }) {
  const q = symOf(labels, view.account.quoteMint.toBase58());
  const qd = view.quote.decimals;
  const v = state.status === "ok" ? state.valuation : undefined;
  const fees = v?.rows.filter((r) => r.withdrawFee > 0n) ?? [];
  return (
    <div className="holdings" data-testid="holdings">
      <div className="holdings-head">
        <span className="stat-label">Estimated value</span>
        <span className="stat-value" data-testid="holdings-total" title={v ? `${exactUi(v.total, qd)} ${q}` : undefined}>
          {state.status === "loading" && "…"}
          {state.status === "error" && "unknown"}
          {v && (
            <>
              ≈ {formatValue(v.total, qd)} <span className="stat-unit">{q}</span>
              {!v.complete && <span className="stat-unit"> + unknown</span>}
            </>
          )}
        </span>
      </div>
      {v && (
        <div className="table-wrap holdings-table-wrap">
          <table className="holdings-table" data-testid="holdings-table">
            <thead>
              <tr>
                <th scope="col">Token</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" className="num">
                  Value ({q})
                </th>
                <th scope="col" className="num">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {sortByValue(v.rows).map((r) => {
                const mint = r.mint.address.toBase58();
                const share = r.value !== undefined ? sharePercent(r.value, v.total) : 0;
                return (
                  <tr key={mint} className="holding" data-testid={`holding-${mint}`}>
                    <th scope="row" title={mint}>
                      <span className="chip-token">
                        <span className="dot" aria-hidden="true" />
                        {rowName(r, labels)}
                      </span>
                    </th>
                    <td className="num" title={r.balance === undefined ? undefined : exactUi(r.balance, r.mint.decimals)}>
                      {r.balance === undefined ? <span className="muted">missing</span> : formatAmount(r.balance, r.mint.decimals)}
                    </td>
                    <td className="num" title={r.value === undefined ? undefined : `${exactUi(r.value, qd)} ${q}`}>
                      {r.value === undefined ? <span className="muted">unknown</span> : formatValue(r.value, qd)}
                    </td>
                    <td className="num share-cell">
                      {r.value === undefined ? (
                        <span className="muted">–</span>
                      ) : (
                        <>
                          <span className="bar" aria-hidden="true">
                            <span style={{ width: `${Math.min(100, share)}%` }} />
                          </span>
                          {formatShare(share)}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {v.native && (
                <tr className="holding" data-testid="holding-native">
                  <th scope="row" title="Native XNT on the fund account above its rent reserve (withdraw it with Withdraw native XNT)">
                    <span className="chip-token">
                      <span className="dot" aria-hidden="true" />
                      XNT (native, e.g. reflections)
                    </span>
                  </th>
                  <td className="num" title={v.native.amount === undefined ? "balance too large to value exactly" : exactUi(v.native.amount, 9)}>
                    {v.native.amount === undefined ? <span className="muted">too large to read exactly</span> : formatAmount(v.native.amount, 9)}
                  </td>
                  <td className="num" title={v.native.value === undefined ? "not priced in " + q : `${exactUi(v.native.value, qd)} ${q} (1 XNT = 1 WXNT)`}>
                    {v.native.value === undefined ? <span className="muted">unknown</span> : formatValue(v.native.value, qd)}
                  </td>
                  <td className="num share-cell">
                    {v.native.value === undefined ? (
                      <span className="muted">–</span>
                    ) : (
                      <>
                        <span className="bar" aria-hidden="true">
                          <span style={{ width: `${Math.min(100, sharePercent(v.native.value, v.total))}%` }} />
                        </span>
                        {formatShare(sharePercent(v.native.value, v.total))}
                      </>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {fees.map((r) => {
        const s = symOf(labels, r.mint.address.toBase58());
        return (
          <p key={r.mint.address.toBase58()} className="small warn-text" data-testid="holding-fee-note">
            {s} has a {bpsToPercent(r.transferFeeBps)}% transfer fee: withdrawing all of it pays ≈ {formatAmount(r.withdrawFee, r.mint.decimals)} {s}.
          </p>
        );
      })}
      {v?.native && (
        <p className="small muted" data-testid="holding-native-note">
          {v.native.inexact
            ? "XNT (native): balance too large to value exactly, so it is not in the total."
            : v.native.value === undefined
            ? `Native XNT is not priced in ${q}, so it is not in the total.`
            : "Native XNT counts 1:1 as WXNT (the same asset); only the part above the fund account's rent reserve is counted."}
        </p>
      )}
      <p className="small muted">Estimate at each pool's current price, before transfer fees and price impact. Display only: not what a swap or withdrawal would pay.</p>
    </div>
  );
}

/** One-line value for a fund list item: "≈ 10.40 WXNT · 9.80 WXNT left to spend". */
export function ValueLine({ state, view, quoteSymbol }: { state: ValuationState | { status: "error" }; view: FundView | null; quoteSymbol: string }) {
  if (state.status === "error") return <span className="value-line muted" data-testid="fund-value">value unknown</span>;
  if (state.status === "loading" || !view) return <span className="value-line muted" data-testid="fund-value">valuing…</span>;
  const v = state.valuation;
  const d = view.quote.decimals;
  return (
    <span className="value-line" data-testid="fund-value">
      <strong>
        ≈ {formatValue(v.total, d)} {quoteSymbol}
        {!v.complete && " + unknown"}
      </strong>
      {v.quoteBalance !== undefined && (
        <span className="muted">
          {" "}
          · {formatValue(v.quoteBalance, d)} {quoteSymbol} left to spend
        </span>
      )}
    </span>
  );
}
