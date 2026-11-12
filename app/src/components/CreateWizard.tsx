/**
 * Create Fund, as plain-language steps:
 *   1 Pay with   2 Buy   3 Shares (with "keep as cash")   4 How much and how often
 *   5 Advanced (collapsed)   6 The NFT (name, picture, metadata link)   7 Review
 *
 * The wizard only collects answers. They become CreateFundArgs, go through
 * the shared bounds check (validateCreateFund, state.rs) and the shared
 * planner (prepareCreateFund) like the CLI, then the usual review ->
 * Sign & send path. Pools are auto-found from chain data (pool_finder.ts)
 * and checked again by the planner's checkPool when the review is built.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  formatUi,
  fundPda,
  MAX_DEV_BPS,
  MAX_TARGETS,
  MAX_TWAP_WINDOW_SECS,
  MIN_TWAP_WINDOW_SECS,
  parsePubkey,
  parseUi,
  parseUint,
  validateCreateFund,
  type CreateFundArgs,
} from "@core/owner.js";
import { poolDepth, type Depth } from "@core/pool_finder.js";
import { maxTargetsThatFit } from "@core/rpc.js";
import type { TokenInfo } from "@core/token_info.js";
import type { AppState } from "../App";
import { BUDGET, makeProgram, reviewCreateFund, type Labels, type Review } from "../lib/actions";
import type { ErrorAction } from "../lib/errors";
import { createLatest } from "../lib/latest";
import { useMintLookup, usePools } from "../lib/lookups";
import type { NetworkInfo } from "../lib/network";
import { signerId } from "../lib/session";
import { labelFor, type TokenLabel } from "../lib/tokens";
import { bpsToPercent, FREQUENCIES, humanDuration, humanInterval, MIN_CUSTOM_SECS, percentToBps, project, splitToTargets } from "../lib/wizard";
import { ArtStep, type ArtResult } from "./ArtStep";
import { MintInput } from "./MintInput";
import { ReviewPanel } from "./ReviewPanel";
import { errMsg, FriendlyError, Help, Short } from "./ui";

const EXAMPLE = {
  quote: "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq",
  test: "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz",
};

interface BuyRow {
  id: number;
  mint: string;
  percent: string;
  /** Pool picked with "change pool"; undefined = the best one found. */
  pool?: string;
}

interface RowReport {
  mint?: PublicKey;
  pool?: PublicKey;
  label?: TokenLabel;
  error?: string;
}

let nextId = 1;

/** The friendly validator speaks in CLI flags; say it in the wizard's words. */
function friendly(message: string): string {
  return message
    .replace("--per-run must be greater than zero", "the amount per buy must be more than 0")
    .replace("--interval", "how often")
    .replace("--window", "the TWAP window")
    .replace("--max-dev-bps", "the max deviation")
    .replace(/target (\d+): duplicate mint .*/, "the same token is listed twice")
    .replace(/target (\d+):/, (_m, i: string) => `token ${i}:`);
}

export function CreateWizard({ s }: { s: AppState }) {
  const net = s.net;
  const owner = s.signer?.publicKey ?? null;
  const [quote, setQuote] = useState("");
  const [rows, setRows] = useState<BuyRow[]>([{ id: nextId++, mint: "", percent: "100" }]);
  const [reports, setReports] = useState<Record<number, RowReport>>({});
  const [perRun, setPerRun] = useState("0.1");
  const [freq, setFreq] = useState<string>("3600");
  const [customSecs, setCustomSecs] = useState("600");
  const [window, setWindow] = useState("3600");
  const [maxDev, setMaxDev] = useState("300");
  const [deposit, setDeposit] = useState("10");
  const [simPayer, setSimPayer] = useState("");
  const [art, setArt] = useState<ArtResult>({ state: "none" });
  const [fit, setFit] = useState<{ key: string; withCash: number; withoutCash: number } | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const builds = useRef(createLatest()).current;
  const signerKey = signerId(s.signer);
  // The NFT mint is chosen first so the fund PDA can go into the metadata JSON. In memory only.
  const [nft, setNft] = useState(() => Keypair.generate());
  const fund = fundPda(nft.publicKey);

  useEffect(() => {
    builds.invalidate();
    setReview(null);
    setBusy(false);
    setError(null);
  }, [net, signerKey, builds]);

  // Once a create with this NFT key has landed (even partly), the key is used up: pick a new one.
  useEffect(() => {
    const used = s.sends.some((r) => r.created?.nftMint.equals(nft.publicKey) && (r.outcomes.length > 0 || r.failState === "unknown"));
    if (used) setNft(Keypair.generate());
  }, [s.sends, nft]);

  const quoteLookup = useMintLookup(net, quote, owner);
  const quoteInfo = quoteLookup.status === "ok" ? quoteLookup.info : null;
  const quoteLabel = quoteLookup.status === "ok" ? quoteLookup.label : null;
  const q = quoteLabel?.symbol ?? "the pay-with token";

  // The honest size limit for this pay-with token (built with the real builders).
  const fitKey = `${net?.generation}|${quoteInfo?.address.toBase58() ?? ""}`;
  useEffect(() => {
    if (!net || !quoteInfo) return;
    let cancelled = false;
    (async () => {
      try {
        const program = makeProgram(net);
        const payer = owner ?? PublicKey.default;
        const [a, b] = await Promise.all([
          maxTargetsThatFit(program, payer, quoteInfo, true, BUDGET.instructions),
          maxTargetsThatFit(program, payer, quoteInfo, false, BUDGET.instructions),
        ]);
        if (!cancelled) setFit({ key: fitKey, withCash: a.maxNonCash, withoutCash: b.maxNonCash });
      } catch {
        if (!cancelled) setFit(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);
  const fitNow = fit && fit.key === fitKey ? fit : null;

  const interval = freq === "custom" ? customSecs.trim() : freq;
  const perRunRaw = useMemo(() => {
    if (!quoteInfo) return undefined;
    try {
      return parseUi(perRun, quoteInfo.decimals, "Amount per buy");
    } catch {
      return undefined;
    }
  }, [perRun, quoteInfo]);
  const maxDevNum = Number(maxDev) || 0;

  const split = useMemo(() => {
    if (!quoteInfo) return { error: "choose the pay-with token" };
    try {
      const pairs = rows.map((r) => {
        const rep = reports[r.id];
        if (!r.mint.trim()) throw new Error("paste a token to buy (or remove the empty row)");
        if (!rep || rep.error) throw new Error(rep?.error ?? "still reading the token to buy");
        if (!rep.mint || !rep.pool) throw new Error("still looking for a pool");
        return { mint: rep.mint, pool: rep.pool, percent: r.percent };
      });
      return { value: splitToTargets(quoteInfo.address, pairs) };
    } catch (err) {
      return { error: errMsg(err) };
    }
  }, [quoteInfo, rows, reports]);

  const built = useMemo((): { args?: CreateFundArgs; error?: string } => {
    try {
      if (!quoteInfo) throw new Error(quoteLookup.status === "error" || quoteLookup.status === "invalid" ? quoteLookup.message : "choose the token you pay with");
      if (split.error || !split.value) throw new Error(split.error);
      if (freq === "custom" && !(Number(customSecs) >= MIN_CUSTOM_SECS)) throw new Error(`a custom schedule must be at least ${MIN_CUSTOM_SECS} seconds`);
      const args: CreateFundArgs = {
        quote: quoteInfo.address,
        targets: split.value.targets,
        perRun: parseUi(perRun, quoteInfo.decimals, "the amount per buy"),
        interval: parseUint(interval, "how often", (1n << 63n) - 1n),
        window: Number(parseUint(window.trim(), "the TWAP window", 0xffff_ffffn)),
        maxDevBps: Number(parseUint(maxDev.trim(), "the max deviation", 0xffffn)),
      };
      validateCreateFund(args);
      if (fitNow) {
        const limit = split.value.cashBps > 0 ? fitNow.withCash : fitNow.withoutCash;
        if (rows.length > limit) throw new Error(`${rows.length} tokens do not fit in one transaction with this pay-with token; at most ${limit}`);
      }
      return { args };
    } catch (err) {
      return { error: friendly(errMsg(err)) };
    }
  }, [quoteInfo, quoteLookup, split, freq, customSecs, perRun, interval, window, maxDev, fitNow, rows.length]);

  const labels: Labels = useMemo(() => {
    const l: Labels = {};
    if (quoteInfo && quoteLabel) l[quoteInfo.address.toBase58()] = quoteLabel;
    for (const r of Object.values(reports)) if (r.mint && r.label) l[r.mint.toBase58()] = r.label;
    return l;
  }, [quoteInfo, quoteLabel, reports]);

  const artCtx = useMemo(
    () => ({
      fund,
      quote: quoteInfo && quoteLabel ? { mint: quoteInfo.address, label: quoteLabel.symbol } : null,
      targets:
        split.value && quoteInfo
          ? split.value.targets.map((t) => ({ mint: t.mint, bps: t.bps, cash: t.mint.equals(quoteInfo.address), label: (labels[t.mint.toBase58()] ?? labelFor(t.mint)).symbol }))
          : [],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fund.toBase58(), quoteInfo, quoteLabel, split, labels],
  );

  const projection = useMemo(() => {
    if (!quoteInfo || !perRunRaw || !split.value) return undefined;
    try {
      const d = parseUi(deposit, quoteInfo.decimals, "deposit");
      const p = project(d, perRunRaw, BigInt(Number(interval) || 0), split.value.targets.map((t) => ({ bps: t.bps, cash: t.mint.equals(quoteInfo.address) })));
      return p ? { ...p, deposit: d } : undefined;
    } catch {
      return undefined;
    }
  }, [quoteInfo, perRunRaw, split, deposit, interval]);

  const onErrorAction = (kind: ErrorAction) => {
    if (kind === "switch-local") s.switchNetwork("local");
  };

  const payer = s.signer?.publicKey ?? null;
  const doReview = async () => {
    setError(null);
    setReview(null);
    if (!net || !built.args || art.state === "pending") return;
    let p: PublicKey;
    try {
      p = payer ?? parsePubkey(simPayer.trim(), "simulation payer");
    } catch (err) {
      setError(err);
      return;
    }
    if (s.sendPending) return;
    const gen = net.generation;
    const builtFor = signerKey;
    const epoch = s.live().signerEpoch;
    const fresh = () => s.live().generation === gen && s.live().signerId === builtFor && s.live().signerEpoch === epoch;
    setBusy(true);
    try {
      const r = await builds.run(reviewCreateFund(net, p, built.args, { metadata: art.state === "ready" ? art.metadata : undefined, nft, labels }));
      if (!r.stale && fresh()) setReview({ ...r.value, signerEpoch: epoch });
    } catch (err) {
      if (fresh()) setError(err);
    } finally {
      if (fresh()) setBusy(false);
    }
  };

  const cashBps = split.value?.cashBps ?? null;
  const sumBps = rows.reduce((a, r) => {
    try {
      return a + percentToBps(r.percent);
    } catch {
      return a;
    }
  }, 0);

  return (
    <>
      <section className="panel wizard" data-testid="create-form">
        <div className="row between wrap">
          <h2>
            Create a fund <Help term="fund" />
          </h2>
          <button
            className="link"
            onClick={() => {
              setQuote(EXAMPLE.quote);
              setRows([{ id: nextId++, mint: EXAMPLE.test, percent: "80" }]);
              setPerRun("0.1");
              setFreq("3600");
            }}
          >
            fill example: pay with USDC.X, buy 80% TEST, keep 20%
          </button>
        </div>

        <h3>
          1. Pay with <Help term="pay-with" label="pay-with" />
        </h3>
        <p className="small muted">The token you will deposit. The fund spends it on the tokens you pick next.</p>
        <MintInput label="Pay-with token" testId="quote-input" value={quote} onChange={setQuote} lookup={quoteLookup} cluster={net?.cluster} />
        {fitNow && (
          <p className="small" data-testid="fit">
            Up to <strong>{fitNow.withCash}</strong> tokens to buy with this pay-with token while keeping some as cash, or <strong>{fitNow.withoutCash}</strong> if you keep
            none (one transaction holds at most 1232 bytes; the program allows {MAX_TARGETS} entries in total).
          </p>
        )}

        <h3>
          2. Buy <Help term="target" label="a token to buy" />
        </h3>
        {rows.map((r, i) => (
          <TargetRow
            key={r.id}
            index={i}
            net={net}
            owner={owner}
            quote={quoteInfo}
            quoteSymbol={q}
            row={r}
            slice={perRunRaw !== undefined ? (perRunRaw * BigInt(safeBps(r.percent))) / 10_000n : undefined}
            maxDevBps={maxDevNum}
            onChange={(patch) => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, ...patch } : x)))}
            onRemove={rows.length > 1 ? () => setRows((rs) => rs.filter((x) => x.id !== r.id)) : undefined}
            onReport={(rep) => setReports((m) => ({ ...m, [r.id]: rep }))}
            exclude={[quote, ...rows.filter((x) => x.id !== r.id).map((x) => x.mint)]}
          />
        ))}
        <button
          onClick={() => setRows((rs) => [...rs, { id: nextId++, mint: "", percent: "" }])}
          disabled={rows.length >= (fitNow?.withCash ?? MAX_TARGETS - 1)}
          data-testid="add-target"
        >
          Add another token
        </button>

        <h3>
          3. Shares <Help term="cash" label="keep as cash" />
        </h3>
        <p className="small" data-testid="shares">
          {rows.map((r, i) => (
            <span key={r.id}>
              {(reports[r.id]?.label?.symbol ?? `token ${i + 1}`) + " " + (safeBps(r.percent) ? `${bpsToPercent(safeBps(r.percent))}%` : "?")}
              {" + "}
            </span>
          ))}
          <span data-testid="cash-share">
            keep as cash {sumBps <= 10_000 ? `${bpsToPercent(10_000 - sumBps)}%` : "-"}
          </span>{" "}
          = {sumBps <= 10_000 ? "100%" : `${bpsToPercent(sumBps)}%, too much`}
        </p>
        {cashBps !== null && cashBps > 0 && <p className="small muted">The cash share stays in {q} and is never spent. You can withdraw it any time.</p>}

        <h3>4. How much and how often</h3>
        <div className="grid2">
          <label className="field">
            Amount per buy ({q})
            <input aria-label="Amount per buy" inputMode="decimal" value={perRun} onChange={(e) => setPerRun(e.target.value)} />
          </label>
          <label className="field">
            How often
            <select aria-label="How often" value={freq} onChange={(e) => setFreq(e.target.value)}>
              {FREQUENCIES.map((f) => (
                <option key={f.secs} value={String(f.secs)}>
                  {f.label}
                </option>
              ))}
              <option value="custom">Custom...</option>
            </select>
          </label>
          {freq === "custom" && (
            <label className="field">
              Every N seconds (at least {MIN_CUSTOM_SECS})
              <input aria-label="Custom seconds" inputMode="numeric" value={customSecs} onChange={(e) => setCustomSecs(e.target.value)} />
            </label>
          )}
        </div>
        {perRunRaw !== undefined && split.value && quoteInfo && (
          <p className="small" data-testid="per-round">
            Every {humanInterval(BigInt(Number(interval) || 60))} the fund spends{" "}
            {split.value.targets
              .filter((t) => !t.mint.equals(quoteInfo.address))
              .map((t) => `${formatUi((perRunRaw * BigInt(t.bps)) / 10_000n, quoteInfo.decimals)} ${q} on ${labels[t.mint.toBase58()]?.symbol ?? "?"}`)
              .join(", ")}
            {split.value.cashBps > 0 ? `; the ${bpsToPercent(split.value.cashBps)}% cash share of each round is not spent` : ""}. A keeper runs each buy for a 0.1% tip{" "}
            <Help term="keeper" />.
          </p>
        )}
        <div className="row wrap small">
          <label>
            If you deposit{" "}
            <input aria-label="Projection deposit" className="bps" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} /> {q}
          </label>
          <span data-testid="projection">
            {projection
              ? `it lasts ${humanDuration(projection.seconds)} (${projection.buys} buys, the first as soon as the deposit lands).`
              : "enter an amount to see how long it lasts."}
          </span>
        </div>

        <details className="advanced">
          <summary>5. Advanced</summary>
          <div className="grid2">
            <label className="field">
              TWAP window, seconds ({MIN_TWAP_WINDOW_SECS}-{MAX_TWAP_WINDOW_SECS}) <Help term="twap" label="TWAP" />
              <input aria-label="TWAP window" inputMode="numeric" value={window} onChange={(e) => setWindow(e.target.value)} />
              <span className="small muted">The fund compares each buy with the pool's average price over this window.</span>
            </label>
            <label className="field">
              Max deviation, bps (at most {MAX_DEV_BPS}) <Help term="slippage" />
              <input aria-label="Max deviation" inputMode="numeric" value={maxDev} onChange={(e) => setMaxDev(e.target.value)} />
              <span className="small muted">A buy is refused if it gets more than this below the average (300 bps = 3%).</span>
            </label>
          </div>
        </details>

        <h3>
          6. The NFT <Help term="nft" label="the fund NFT" />
        </h3>
        <p className="small muted">
          The fund is owned by an NFT that goes to your wallet. Give it a name and a picture now, or later from the fund page. Its address will be{" "}
          <Short value={nft.publicKey.toBase58()} /> and the fund's <Short value={fund.toBase58()} />.
        </p>
        <ArtStep s={s} ctx={artCtx} allowNone onChange={setArt} />

        <h3>7. Review</h3>
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
          <p className="ok small" data-testid="create-valid">
            Everything checks out (the same checks as the program and the CLI). The review checks the pools again and simulates.
          </p>
        )}
        <button
          className="primary"
          disabled={!built.args || busy || s.sendPending || art.state === "pending" || (!payer && !simPayer.trim())}
          onClick={() => void doReview()}
          data-testid="create-review"
        >
          {busy ? "Checking pools and simulating..." : "Review create"}
        </button>
        {error !== null && <FriendlyError err={error} cluster={net?.cluster} onAction={onErrorAction} testId="create-error" />}
      </section>
      {review && <ReviewPanel s={s} review={review} onClose={() => setReview(null)} />}
    </>
  );
}

function safeBps(p: string): number {
  try {
    return percentToBps(p);
  } catch {
    return 0;
  }
}

const DEPTH_TEXT: Record<Depth, string> = {
  ok: "deep enough for this amount",
  thin: "thin: each buy is a noticeable share of the pool, so prices may be worse",
  "too thin": "too thin: one buy moves the price more than the fund allows, so buys would likely be refused. Lower the amount per buy or pick another pool",
  empty: "empty: the pool holds none of the pay-with token",
};

function TargetRow({
  index,
  net,
  owner,
  quote,
  quoteSymbol,
  row,
  slice,
  maxDevBps,
  onChange,
  onRemove,
  onReport,
  exclude,
}: {
  index: number;
  net: NetworkInfo | null;
  owner: PublicKey | null;
  quote: TokenInfo | null;
  quoteSymbol: string;
  row: BuyRow;
  slice: bigint | undefined;
  maxDevBps: number;
  onChange: (patch: Partial<BuyRow>) => void;
  onRemove?: () => void;
  onReport: (r: RowReport) => void;
  exclude: string[];
}) {
  const lookup = useMintLookup(net, row.mint, owner);
  const target = lookup.status === "ok" ? lookup.info.address : undefined;
  const same = !!target && !!quote && target.equals(quote.address);
  const pools = usePools(net, same ? undefined : quote?.address, same ? undefined : target);
  const candidates = pools.status === "ok" ? pools.pools : [];
  const chosen = candidates.find((c) => c.pool.toBase58() === row.pool) ?? candidates[0];
  const label = lookup.status === "ok" ? lookup.label : undefined;

  let error: string | undefined;
  if (lookup.status === "invalid" || lookup.status === "error") error = lookup.message;
  else if (same) error = `This is the same token you pay with. To keep some ${quoteSymbol} unspent, lower the shares: the rest is kept as cash automatically.`;
  else if (!quote && lookup.status === "ok") error = "choose the pay-with token first";
  else if (pools.status === "error") error = pools.message;
  else if (pools.status === "ok" && candidates.length === 0) {
    error = `There is no XDEX pool for ${quoteSymbol} and ${label?.symbol ?? "this token"} on this network, so the fund could not buy it. Pick another token, or pay with a token that has a pool.`;
  }

  const reportKey = `${target?.toBase58() ?? ""}|${chosen?.pool.toBase58() ?? ""}|${error ?? ""}|${label?.symbol ?? ""}|${lookup.status}|${pools.status}`;
  useEffect(() => {
    onReport({ mint: target, pool: chosen?.pool, label, error: lookup.status === "loading" || pools.status === "loading" ? "still reading the token and its pool" : error });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportKey]);

  const depth = chosen && slice !== undefined ? poolDepth(chosen.quoteReserve, slice, maxDevBps) : undefined;
  return (
    <div className="target-card" data-testid="target-row">
      <div className="row between">
        <strong className="small">Token {index + 1}</strong>
        {onRemove && (
          <button className="link small" onClick={onRemove} aria-label={`Remove token ${index + 1}`}>
            remove
          </button>
        )}
      </div>
      <MintInput label={`Token ${index + 1} to buy`} testId={`target-${index}-input`} value={row.mint} onChange={(v) => onChange({ mint: v, pool: undefined })} lookup={lookup} cluster={net?.cluster} exclude={exclude} showBalance={false} />
      {lookup.status === "ok" && same && (
        <p className="error small" data-testid="target-error">
          {error}
        </p>
      )}
      {lookup.status === "ok" && !same && pools.status === "loading" && <p className="small muted">Looking for an XDEX pool...</p>}
      {lookup.status === "ok" && !same && error && (
        <p className="error small" data-testid="target-error">
          {error}
        </p>
      )}
      {chosen && quote && (
        <div className="pool small" data-testid={`target-${index}-pool`}>
          <p>
            Pool <span className="mono" data-testid="pool-address">{chosen.pool.toBase58()}</span> (found on chain
            {candidates.length > 1 ? `, best of ${candidates.length}` : ""}):{" "}
            {chosen.quoteReserve === undefined ? "reserve unknown" : `${formatUi(chosen.quoteReserve, quote.decimals)} ${quoteSymbol}`} on the pay-with side
            {depth && <span className={depth === "ok" ? "" : "warn-text"} data-testid="pool-depth"> · {DEPTH_TEXT[depth]}</span>}
          </p>
          {candidates.length > 1 && (
            <label>
              Change pool{" "}
              <select aria-label={`Token ${index + 1} pool`} value={chosen.pool.toBase58()} onChange={(e) => onChange({ pool: e.target.value })}>
                {candidates.map((c) => (
                  <option key={c.pool.toBase58()} value={c.pool.toBase58()}>
                    {c.pool.toBase58().slice(0, 8)}… · {c.quoteReserve === undefined ? "?" : formatUi(c.quoteReserve, quote.decimals)} {quoteSymbol}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="muted">The pool is fixed forever once the fund exists.</p>
        </div>
      )}
      <label className="field narrow">
        Share of each deposit (%)
        <input aria-label={`Token ${index + 1} share`} inputMode="decimal" value={row.percent} onChange={(e) => onChange({ percent: e.target.value })} placeholder="80" />
      </label>
    </div>
  );
}
