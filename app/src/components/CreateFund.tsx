import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  BPS_SUM,
  formatUi,
  I64_MAX,
  MAX_DEV_BPS,
  MAX_TARGETS,
  MAX_TWAP_WINDOW_SECS,
  MIN_INTERVAL_SECS,
  MIN_TWAP_WINDOW_SECS,
  parsePubkey,
  parseUi,
  parseUint,
  validateCreateFund,
  type CreateFundArgs,
  type MintMeta,
} from "@core/owner.js";
import { TOKEN_2022_PROGRAM_ID } from "@core/pool.js";
import { maxTargetsThatFit, mintInfo } from "@core/rpc.js";
import type { AppState } from "../App";
import { BUDGET, makeProgram, reviewCreateFund, type Review } from "../lib/actions";
import { ReviewPanel } from "./ReviewPanel";
import { errMsg } from "./ui";

interface Row {
  id: number;
  mint: string;
  pool: string;
  bps: string;
}

/** The USDC.X / TEST pair the repo's tests use (README, docs/DEPLOY_MAINNET.md). */
const EXAMPLE = {
  quote: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq",
  test: "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz",
  pool: "7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD",
};

/** The shared validator speaks in CLI flags; show field names instead. */
function friendly(message: string): string {
  return message
    .replace("--per-run", "Per run")
    .replace("--interval", "Interval")
    .replace("--window", "TWAP window")
    .replace("--max-dev-bps", "Max deviation")
    .replace("at least one --target is required", "add at least one target")
    .replace(/target (\d+):/, (_m, i: string) => `target row ${i}:`);
}

let nextId = 1;

export function CreateFund({ s }: { s: AppState }) {
  const [quote, setQuote] = useState("");
  const [cash, setCash] = useState(true);
  const [cashBps, setCashBps] = useState("2000");
  const [rows, setRows] = useState<Row[]>([{ id: nextId++, mint: "", pool: "", bps: "8000" }]);
  const [perRun, setPerRun] = useState("0.1");
  const [interval, setIntervalSecs] = useState("3600");
  const [window, setWindow] = useState("3600");
  const [maxDev, setMaxDev] = useState("300");
  const [simPayer, setSimPayer] = useState("");
  const [quoteMeta, setQuoteMeta] = useState<MintMeta | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [fit, setFit] = useState<{ withCash: number; withoutCash: number } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const net = s.net;

  // Read the quote mint (decimals, token program) and compute the honest size limit.
  useEffect(() => {
    setQuoteMeta(null);
    setFit(null);
    setQuoteError("");
    if (!net || !quote.trim()) return;
    let cancelled = false;
    (async () => {
      try {
        const key = parsePubkey(quote.trim(), "quote mint");
        const meta = await mintInfo(net.connection, key);
        const program = makeProgram(net);
        const payer = s.signer?.publicKey ?? PublicKey.default;
        const [a, b] = await Promise.all([
          maxTargetsThatFit(program, payer, meta, true, BUDGET.instructions),
          maxTargetsThatFit(program, payer, meta, false, BUDGET.instructions),
        ]);
        if (!cancelled) {
          setQuoteMeta(meta);
          setFit({ withCash: a.maxNonCash, withoutCash: b.maxNonCash });
        }
      } catch (err) {
        if (!cancelled) setQuoteError(errMsg(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [net, quote, s.signer]);

  const payer = s.signer?.publicKey ?? null;

  /** Build CreateFundArgs from the form and run the shared state.rs bound checks. */
  const built = useMemo((): { args?: CreateFundArgs; error?: string } => {
    try {
      if (!quoteMeta) throw new Error(quoteError || "enter a quote mint");
      const quoteKey = quoteMeta.address;
      const targets = [];
      if (cash) targets.push({ mint: quoteKey, pool: PublicKey.default, bps: Number(parseUint(cashBps, "cash slice weight", 65_535n)) });
      rows.forEach((r, i) => {
        targets.push({
          mint: parsePubkey(r.mint.trim(), `target row ${i} mint`),
          pool: parsePubkey(r.pool.trim(), `target row ${i} pool`),
          bps: Number(parseUint(r.bps.trim(), `target row ${i} weight`, 65_535n)),
        });
      });
      const args: CreateFundArgs = {
        quote: quoteKey,
        targets,
        perRun: parseUi(perRun, quoteMeta.decimals, "Per run"),
        interval: parseUint(interval.trim(), "Interval", I64_MAX),
        window: Number(parseUint(window.trim(), "TWAP window", 0xffff_ffffn)),
        maxDevBps: Number(parseUint(maxDev.trim(), "Max deviation", 0xffffn)),
      };
      validateCreateFund(args);
      if (fit) {
        const limit = cash ? fit.withCash : fit.withoutCash;
        if (rows.length > limit) {
          throw new Error(
            `${rows.length} non-cash targets do not fit in one transaction with this quote mint; at most ${limit}${cash ? " plus the cash slice" : ""}`,
          );
        }
      }
      return { args };
    } catch (err) {
      return { error: friendly(errMsg(err)) };
    }
  }, [quoteMeta, quoteError, cash, cashBps, rows, perRun, interval, window, maxDev, fit]);

  const weightSum = (cash ? Number(cashBps) || 0 : 0) + rows.reduce((a, r) => a + (Number(r.bps) || 0), 0);

  const doReview = async () => {
    setError("");
    setReview(null);
    if (!net || !built.args) return;
    let p: PublicKey;
    try {
      p = payer ?? parsePubkey(simPayer.trim(), "simulation payer");
    } catch (err) {
      setError(errMsg(err));
      return;
    }
    setBusy(true);
    try {
      setReview(await reviewCreateFund(net, p, built.args));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const setRow = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <>
      <section className="panel" data-testid="create-form">
        <div className="row between wrap">
          <h2>Create fund</h2>
          <button
            className="link"
            onClick={() => {
              setQuote(EXAMPLE.quote);
              setCash(true);
              setCashBps("2000");
              setRows([{ id: nextId++, mint: EXAMPLE.test, pool: EXAMPLE.pool, bps: "8000" }]);
            }}
          >
            fill example: USDC.X 20% cash + TEST 80%
          </button>
        </div>
        <label className="field">
          Quote mint
          <input aria-label="Quote mint" className="mono" value={quote} onChange={(e) => setQuote(e.target.value)} placeholder="base58 mint address" />
        </label>
        {quoteError && <p className="error">{quoteError}</p>}
        {quoteMeta && (
          <p className="small muted" data-testid="quote-meta">
            {quoteMeta.decimals} decimals, {quoteMeta.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL Token"}
            {quoteMeta.transferFee ? `, transfer fee ${quoteMeta.transferFee.newer.basisPoints} bps` : ""}
          </p>
        )}
        {fit && (
          <p className="small" data-testid="fit">
            Size limit with this quote mint: at most <strong>{fit.withCash}</strong> non-cash targets plus a cash slice, or{" "}
            <strong>{fit.withoutCash}</strong> without one (program maximum {MAX_TARGETS} targets in total; the transaction limit is
            1232 bytes).
          </p>
        )}

        <label className="ack">
          <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} aria-label="Cash slice" /> Cash slice (part of
          each deposit stays in the quote mint, never swapped)
        </label>
        {cash && (
          <label className="field narrow">
            Cash slice weight (bps)
            <input aria-label="Cash weight" inputMode="numeric" value={cashBps} onChange={(e) => setCashBps(e.target.value)} />
          </label>
        )}

        <h3>Targets</h3>
        {rows.map((r, i) => (
          <div className="target-row" key={r.id} data-testid="target-row">
            <span className="small muted">#{i}</span>
            <input aria-label={`Target ${i} mint`} className="mono" placeholder="target mint" value={r.mint} onChange={(e) => setRow(r.id, { mint: e.target.value })} />
            <input aria-label={`Target ${i} pool`} className="mono" placeholder="XDEX pool (quote/target)" value={r.pool} onChange={(e) => setRow(r.id, { pool: e.target.value })} />
            <input aria-label={`Target ${i} weight`} className="bps" inputMode="numeric" placeholder="bps" value={r.bps} onChange={(e) => setRow(r.id, { bps: e.target.value })} />
            <button className="link" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))} aria-label={`Remove target ${i}`}>
              remove
            </button>
          </div>
        ))}
        <button onClick={() => setRows((rs) => [...rs, { id: nextId++, mint: "", pool: "", bps: "" }])} disabled={rows.length + (cash ? 1 : 0) >= MAX_TARGETS}>
          Add target
        </button>
        <p className={`small ${weightSum === BPS_SUM ? "muted" : "warn-text"}`}>
          Weights sum to {weightSum} of {BPS_SUM} bps.
        </p>

        <div className="grid2">
          <label className="field">
            Per run (quote, UI units)
            <input aria-label="Per run" inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
            {quoteMeta && built.args && <span className="small muted">raw {built.args.perRun.toString()} ({formatUi(built.args.perRun, quoteMeta.decimals)})</span>}
          </label>
          <label className="field">
            Interval (s, at least {MIN_INTERVAL_SECS.toString()})
            <input aria-label="Interval" inputMode="numeric" value={interval} onChange={(e) => setIntervalSecs(e.target.value)} />
          </label>
          <label className="field">
            TWAP window (s, {MIN_TWAP_WINDOW_SECS}-{MAX_TWAP_WINDOW_SECS})
            <input aria-label="TWAP window" inputMode="numeric" value={window} onChange={(e) => setWindow(e.target.value)} />
          </label>
          <label className="field">
            Max deviation (bps, at most {MAX_DEV_BPS})
            <input aria-label="Max deviation" inputMode="numeric" value={maxDev} onChange={(e) => setMaxDev(e.target.value)} />
          </label>
        </div>

        {!payer && (
          <label className="field">
            Fee payer for a simulate-only review (no wallet connected)
            <input aria-label="Simulation payer" className="mono" placeholder="any base58 address" value={simPayer} onChange={(e) => setSimPayer(e.target.value)} />
          </label>
        )}

        {built.error ? (
          <p className="error" data-testid="create-invalid">
            {built.error}
          </p>
        ) : (
          <p className="ok small">Bounds check passed (same checks as state.rs and the CLI). The pool checks run on review.</p>
        )}
        <button className="primary" disabled={!built.args || busy || (!payer && !simPayer.trim())} onClick={() => void doReview()} data-testid="create-review">
          {busy ? "Checking pools and simulating..." : "Review create"}
        </button>
        {error && (
          <p className="error" data-testid="create-error">
            {error}
          </p>
        )}
      </section>
      {review && <ReviewPanel s={s} review={review} onClose={() => setReview(null)} />}
    </>
  );
}
