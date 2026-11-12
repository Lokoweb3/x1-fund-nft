import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { formatUi, parseUi, shellQuote } from "@core/owner.js";
import { loadFundView, readNativeBalance, type FundView } from "@core/rpc.js";
import type { AppState } from "../App";
import { makeProgram, reviewDeposit, reviewEnsureVaults, reviewWithdraw, reviewWithdrawNative, type Review } from "../lib/actions";
import { NATIVE_INEXACT_NOTE, nativeForValuation, nativeBlocker, nativeLine, parseNativeAmount, type AnyNativeBalance } from "../lib/native";
import { withNative } from "../lib/value";
import { createLatest, sameView, type ViewIdentity } from "../lib/latest";
import { signerId } from "../lib/session";
import { ReviewPanel } from "./ReviewPanel";
import { CopyButton, errMsg, FriendlyError, Help, Short } from "./ui";
import { readFundMetadata } from "@core/rpc.js";
import type { MetadataUpdate, StoredMetadata } from "@core/metadata.js";
import { reviewSetMetadata, type Labels } from "../lib/actions";
import { useTokenLabels } from "../lib/lookups";
import { bpsToPercent, countdown, humanInterval } from "../lib/wizard";
import { ArtStep, type ArtResult } from "./ArtStep";
import { HoldingsCard, useValuation, type ValuationState } from "./Holdings";
import { NftCard, NftCardActions } from "./NftCard";
import { CARD_ACTION_LABEL, cardActionForRun, cardActionStates, DEPOSIT_NOTE, heldByProgram, statusOnCard, type CardAction } from "../lib/card_actions";

/** Light polling: at most every 30 s, only while the tab is visible. */
const POLL_MS = 30_000;

function iso(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString().replace(".000Z", "Z");
}

export function FundDetail({ s, fund }: { s: AppState; fund: string }) {
  // The loaded view carries the identity it was read under; a reply for an
  // older network generation, RPC or fund is dropped, never shown.
  // The native XNT balance is read with the view, under the same identity.
  const [loaded, setLoaded] = useState<{ identity: ViewIdentity; view: FundView; native: NativeRead } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState<unknown>(null);
  // The last run() name: decides whether its progress and error show on the card or under Actions.
  const [lastRun, setLastRun] = useState("");
  const [cardOpen, setCardOpen] = useState<CardAction | null>(null);
  const net = s.net;
  const fundKey = useMemo(() => new PublicKey(fund), [fund]);
  const loads = useRef(createLatest()).current;
  const builds = useRef(createLatest()).current;
  const current: ViewIdentity | undefined = net ? { generation: net.generation, rpcUrl: net.rpcUrl, fund } : undefined;
  const currentRef = useRef(current);
  currentRef.current = current;

  const load = useCallback(async () => {
    if (!net) return;
    const identity: ViewIdentity = { generation: net.generation, rpcUrl: net.rpcUrl, fund };
    setLoading(true);
    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const key = new PublicKey(fund);
      const r = await loads.run(
        Promise.all([
          loadFundView(net.connection, makeProgram(net), key, now),
          // A failed native read (e.g. a balance a JS number cannot hold exactly) must not hide the fund.
          readNativeBalance(net.connection, key).then(
            (balance): NativeRead => ({ balance }),
            (err: unknown): NativeRead => ({ error: errMsg(err) }),
          ),
        ]),
      );
      if (r.stale || !sameView(identity, currentRef.current)) return;
      setLoaded({ identity, view: r.value[0], native: r.value[1] });
      setError("");
    } catch (err) {
      if (!sameView(identity, currentRef.current)) return;
      // A failed read must not leave older balances on screen.
      setLoaded(null);
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, [net, fund, loads]);

  // Network or fund change: drop the view, any review, and every load or
  // review build still in flight.
  useEffect(() => {
    loads.invalidate();
    builds.invalidate();
    setLoaded(null);
    setReview(null);
    setError("");
    setActionError(null);
    setCardOpen(null);
  }, [net, fund, loads, builds]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Refresh after a send finishes (its receipt stays under Transactions).
  useEffect(() => {
    if (s.sendTick > 0) void load();
  }, [s.sendTick, load]);

  const payer = s.signer?.publicKey;
  const signerKey = signerId(s.signer);
  // A signer change makes any built review and any build in flight stale.
  useEffect(() => {
    builds.invalidate();
    setReview(null);
    setBusy("");
  }, [signerKey, builds]);

  const fresh = loaded && sameView(loaded.identity, current) ? loaded : null;
  const view = fresh?.view ?? null;
  const native = fresh?.native;
  // Actions only for a view loaded under the current network and fund, with a signer, and no send in flight.
  const actionsEnabled = !!view && !!payer && !s.sendPending && busy === "";

  const run = async (name: string, build: () => Promise<Review>) => {
    if (s.sendPending || !current) return;
    const identity = current;
    const builtFor = signerKey;
    const epoch = s.live().signerEpoch;
    setActionError(null);
    setReview(null);
    setBusy(name);
    setLastRun(name);
    try {
      const r = await builds.run(build());
      const now = s.live();
      if (r.stale || !sameView(identity, currentRef.current) || now.signerId !== builtFor || now.signerEpoch !== epoch) return;
      setReview({ ...r.value, signerEpoch: epoch });
    } catch (err) {
      if (sameView(identity, currentRef.current)) setActionError(err);
    } finally {
      setBusy("");
    }
  };

  const decimals = view?.quote.decimals ?? 0;
  const labels = useTokenLabels(net, view ? [view.account.quoteMint, ...view.account.targets.map((t) => t.mint)] : []);
  // Display only: never passed to a review, a simulation or a transaction.
  const valuation = useValuation(net?.connection, view);
  // An inexact or unreadable balance is never priced or totalled; it marks the total incomplete.
  const nativeAvailable = nativeForValuation(native?.balance, native?.error);
  const holdings = useMemo<ValuationState>(
    () => (valuation.status === "ok" && view ? { status: "ok", valuation: withNative(valuation.valuation, view.account.quoteMint, nativeAvailable) } : valuation),
    [valuation, view, nativeAvailable],
  );
  const holder = !!payer && !!view?.nftAccount && view.nftAccount.owner.equals(payer);
  const escrow = heldByProgram(view?.nftAccount);
  const cardStates = cardActionStates({ wallet: payer, holder: view?.nftAccount?.owner, heldByProgram: escrow });
  // A form whose button is off (wallet gone, holder changed, NFT listed) closes.
  const openAction = cardOpen && cardStates[cardOpen].enabled ? cardOpen : null;
  // A run's status shows in its own action's panel only; a late result never lands in another action's panel.
  const onCard = statusOnCard(lastRun, openAction);
  const runAction = cardActionForRun(lastRun);
  const status = net && (
    <>
      {busy && <p className="muted">Building and simulating {busy}...</p>}
      {actionError !== null && !onCard && runAction && (
        <p className="small" data-testid="action-error-for">
          <strong>{CARD_ACTION_LABEL[runAction]}:</strong>
        </p>
      )}
      {actionError !== null && <FriendlyError err={actionError} cluster={net.cluster} testId="action-error" />}
    </>
  );

  // A review built from the card lands below the Actions panel; bring it into view.
  useEffect(() => {
    if (review && runAction) document.querySelector('[data-testid="review"]')?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  return (
    <>
      <section className="panel" data-testid="fund-detail">
        <div className="row between wrap">
          <h2>
            Fund <Short value={fund} copy />
          </h2>
          <span className="row">
            <button onClick={() => s.go({ name: "funds" })} className="link">
              back
            </button>
            <button onClick={() => void load()} disabled={loading} data-testid="refresh">
              {loading ? "Loading..." : "Refresh"}
            </button>
          </span>
        </div>
        {error && <p className="error">{error}</p>}
        {view && (
          <>
            <div className="fund-hero">
              {net && (
                <NftCard
                  net={net}
                  view={view}
                  sendTick={s.sendTick}
                  holdings={holdings}
                  labels={labels}
                  actions={
                    <NftCardActions states={cardStates} open={openAction} onToggle={setCardOpen} heldByProgram={escrow}>
                      {openAction === "deposit" && (
                        <DepositForm
                          decimals={decimals}
                          disabled={!actionsEnabled}
                          onReview={(amount) => run("deposit", () => reviewDeposit(net, payer!, fundKey, amount, labels))}
                        />
                      )}
                      {openAction === "withdraw" && (
                        <WithdrawForm
                          view={view}
                          disabled={!actionsEnabled}
                          onReview={(mint, amount) => run("withdraw", () => reviewWithdraw(net, payer!, fundKey, mint, amount, labels))}
                        />
                      )}
                      {openAction === "native" && native && (
                        <NativeWithdrawForm
                          native={native}
                          holder={holder}
                          disabled={!actionsEnabled}
                          onReview={(amount) => run("native withdraw", () => reviewWithdrawNative(net, payer!, fundKey, amount))}
                        />
                      )}
                      {onCard && status}
                    </NftCardActions>
                  }
                />
              )}
              <HoldingsCard state={holdings} view={view} labels={labels} />
            </div>
            <FundSummary view={view} labels={labels} />
            <dl className="kv">
              <div>
                <dt>Fund PDA</dt>
                <dd className="mono">{fund}</dd>
              </div>
              <div>
                <dt>NFT mint</dt>
                <dd className="mono">{view.account.nftMint.toBase58()}</dd>
              </div>
              <div>
                <dt>NFT holder</dt>
                <dd className="mono" data-testid="nft-holder">
                  {view.nftAccount ? view.nftAccount.owner.toBase58() : "unknown"}
                  {view.nftAccount && payer && view.nftAccount.owner.equals(payer) && <span className="tag">you</span>}
                </dd>
              </div>
              <div>
                <dt>Quote mint</dt>
                <dd className="mono">
                  {view.account.quoteMint.toBase58()} ({decimals} decimals
                  {view.quote.transferFee ? `, transfer fee ${view.quote.transferFee.newer.basisPoints} bps` : ""})
                </dd>
              </div>
              <div>
                <dt>Per run</dt>
                <dd>
                  {formatUi(view.perRun, decimals)} quote <span className="muted small">(raw {view.perRun.toString()})</span>
                </dd>
              </div>
              <div>
                <dt>Interval</dt>
                <dd>{view.interval.toString()} s</dd>
              </div>
              <div>
                <dt>TWAP window</dt>
                <dd>{view.account.twapWindowSecs} s</dd>
              </div>
              <div>
                <dt>Max deviation</dt>
                <dd>{view.account.maxDevBps} bps</dd>
              </div>
              <div>
                <dt>Budget total</dt>
                <dd data-testid="budget-total">
                  {formatUi(view.budgetTotal, decimals)} quote <span className="muted small">(raw {view.budgetTotal.toString()})</span>
                </dd>
              </div>
            </dl>

            <h3>Targets</h3>
            <div className="table-wrap">
              <table data-testid="targets">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Mint</th>
                    <th>Pool</th>
                    <th>Weight</th>
                    <th>Budget</th>
                    <th>Last run</th>
                    <th>Next due</th>
                  </tr>
                </thead>
                <tbody>
                  {view.targets.map((t) => (
                    <tr key={t.index} data-testid={`target-${t.index}`}>
                      <td>{t.index}</td>
                      <td>
                        <Short value={t.mint.toBase58()} />
                      </td>
                      <td>{t.cash ? "cash slice" : <Short value={t.pool.toBase58()} />}</td>
                      <td>{(t.bps / 100).toFixed(2)}%</td>
                      <td data-testid={`budget-${t.index}`} data-raw={t.budget.toString()}>
                        {formatUi(t.budget, decimals)}
                      </td>
                      <td>{t.lastRun === 0n ? "never" : iso(t.lastRun)}</td>
                      <td>
                        {t.due === "cash"
                          ? "never (cash)"
                          : t.due === "no budget"
                            ? "no budget"
                            : t.due === "due"
                              ? "due now"
                              : `${iso(t.nextDue)} (in ${(t.nextDue - view.now).toString()} s)`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>Vaults</h3>
            <div className="table-wrap">
              <table data-testid="vaults">
                <thead>
                  <tr>
                    <th>Mint</th>
                    <th>Vault</th>
                    <th>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {view.vaults.map((v) => (
                    <tr key={v.vault.toBase58()} data-testid={`vault-${v.mint.address.toBase58()}`}>
                      <td>
                        <Short value={v.mint.address.toBase58()} />
                      </td>
                      <td>
                        <Short value={v.vault.toBase58()} />
                      </td>
                      <td data-testid="vault-balance" data-raw={v.balance?.toString() ?? ""}>
                        {v.balance === undefined ? "missing" : formatUi(v.balance, v.mint.decimals)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {view && net && (
        <section className="panel actions">
          <h3>Actions</h3>
          {!payer && <p className="muted small">Connect a wallet: each action builds and simulates with it as the fee payer.</p>}
          <p className="small muted">Deposit and withdraw are on the NFT card above.</p>
          <div className="row wrap">
            <button disabled={!actionsEnabled} onClick={() => void run("ensure", () => reviewEnsureVaults(net, payer!, fundKey))} data-testid="ensure-vaults">
              Ensure vaults
            </button>
            <span className="small muted">Creates any missing quote/target vault account. Idempotent.</span>
          </div>
          {!onCard && status}
        </section>
      )}

      {review && (
        <ReviewPanel
          s={s}
          review={review}
          onClose={() => setReview(null)}
        />
      )}

      {view && net && <MetadataPanel s={s} view={view} fundKey={fundKey} labels={labels} disabled={!actionsEnabled} run={run} />}
      {view && net && <KeeperStatus view={view} rpcUrl={net.rpcUrl} />}
    </>
  );
}

function DepositForm({ decimals, disabled, onReview }: { decimals: number; disabled: boolean; onReview: (raw: bigint) => void }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const submit = () => {
    setError("");
    try {
      const raw = parseUi(amount, decimals, "amount");
      if (raw === 0n) throw new Error("amount must be greater than zero");
      onReview(raw);
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <div className="form-row">
      <p className="small muted form-note" data-testid="deposit-note">
        {DEPOSIT_NOTE}
      </p>
      <label>
        Deposit (quote, UI units){" "}
        <input aria-label="Deposit amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1.5" />
      </label>
      <button disabled={disabled || !amount} onClick={submit} data-testid="deposit-review">
        Review deposit
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

function WithdrawForm({
  view,
  disabled,
  onReview,
}: {
  view: FundView;
  disabled: boolean;
  onReview: (mint: PublicKey, amount: bigint | "all") => void;
}) {
  const [mint, setMint] = useState(view.vaults[0]?.mint.address.toBase58() ?? "");
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [error, setError] = useState("");
  const meta = view.vaults.find((v) => v.mint.address.toBase58() === mint);
  const submit = () => {
    setError("");
    try {
      if (!meta) throw new Error("pick a vault mint");
      if (all) return onReview(meta.mint.address, "all");
      const raw = parseUi(amount, meta.mint.decimals, "amount");
      if (raw === 0n) throw new Error("amount must be greater than zero");
      onReview(meta.mint.address, raw);
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <div className="form-row">
      <label>
        Withdraw mint{" "}
        <select aria-label="Withdraw mint" value={mint} onChange={(e) => setMint(e.target.value)}>
          {view.vaults.map((v) => (
            <option key={v.mint.address.toBase58()} value={v.mint.address.toBase58()}>
              {v.mint.address.toBase58().slice(0, 8)}… {v.mint.address.equals(view.account.quoteMint) ? "(quote)" : ""} balance{" "}
              {v.balance === undefined ? "missing" : formatUi(v.balance, v.mint.decimals)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Amount{" "}
        <input
          aria-label="Withdraw amount"
          inputMode="decimal"
          value={all ? "" : amount}
          disabled={all}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={all ? "all" : "0.1"}
        />
      </label>
      <label>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} aria-label="Withdraw all" /> all
      </label>
      <button disabled={disabled || (!all && !amount)} onClick={submit} data-testid="withdraw-review">
        Review withdraw
      </button>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** The native XNT read that comes with a loaded view: the balance, or why it could not be read. */
type NativeRead = { balance: AnyNativeBalance; error?: undefined } | { balance?: undefined; error: string };

/** "Withdraw native XNT": holder only, through the shared withdraw-native planner. */
export function NativeWithdrawForm({
  native,
  holder,
  disabled,
  onReview,
}: {
  native: NativeRead;
  holder: boolean;
  disabled: boolean;
  onReview: (amount: bigint | "all") => void;
}) {
  const [amount, setAmount] = useState("");
  const [all, setAll] = useState(false);
  const [error, setError] = useState("");
  const b = native.balance;
  const blocker = nativeBlocker({ holder, balance: b, readError: native.error });
  const allOff = !!blocker || (b !== undefined && !b.exact);
  const submit = () => {
    setError("");
    try {
      if (!b) throw new Error("the native balance is not loaded");
      onReview(parseNativeAmount(amount, all && b.exact, b));
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <div className="native-withdraw" data-testid="native-withdraw">
      {b && (
        <p className="small" data-testid="native-line" data-available={b.exact ? b.available.toString() : "inexact"}>
          {nativeLine(b)}
        </p>
      )}
      <div className="form-row">
        <label>
          Withdraw native XNT{" "}
          <input
            aria-label="Native XNT amount"
            inputMode="decimal"
            value={all && !allOff ? "" : amount}
            disabled={(all && !allOff) || !!blocker}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={all && !allOff ? "all" : "0.01"}
          />
        </label>
        <label>
          <input type="checkbox" checked={all && !allOff} disabled={allOff} onChange={(e) => setAll(e.target.checked)} aria-label="Withdraw all native XNT" /> all
        </label>
        <button disabled={disabled || !!blocker || (!(all && !allOff) && !amount)} onClick={submit} data-testid="native-withdraw-review">
          Review native withdraw
        </button>
        {error && <span className="error">{error}</span>}
      </div>
      {b && !b.exact && !native.error && (
        <p className="small warn-text" data-testid="native-inexact">
          {NATIVE_INEXACT_NOTE}
        </p>
      )}
      {blocker && (
        <p className="small muted" data-testid="native-blocker">
          {blocker}
        </p>
      )}
    </div>
  );
}

/** Read-only keeper view. Cranking stays in the keeper; there is no crank button. */
function KeeperStatus({ view, rpcUrl }: { view: FundView; rpcUrl: string }) {
  const cmd = `cd keeper && env -u KEYPAIR RPC_URL=${shellQuote(rpcUrl)} npx tsx src/index.ts --dry-run`;
  const due = view.targets.filter((t) => view.keeperDue.includes(t.index));
  return (
    <section className="panel" data-testid="keeper-status">
      <h3>Keeper status (read-only)</h3>
      {due.length === 0 ? (
        <p className="muted" data-testid="keeper-due">
          No target is due now.
        </p>
      ) : (
        <p data-testid="keeper-due">
          Due now: {due.map((t) => `target ${t.index} (${t.mint.toBase58().slice(0, 8)}…)`).join(", ")}
        </p>
      )}
      <p className="small muted">
        The keeper cranks due targets permissionlessly. To see what it would do, run its dry run (it prints the execute_dca accounts
        and sends nothing):
      </p>
      <pre className="cmd" data-testid="keeper-cmd">
        {cmd}
      </pre>
      <CopyButton text={cmd} label="copy command" />
    </section>
  );
}

/** The fund in words: what it pays with, what it buys, and when the next buy is. */
function FundSummary({ view, labels }: { view: FundView; labels: Labels }) {
  const d = view.quote.decimals;
  const sym = (m: PublicKey) => labels[m.toBase58()]?.symbol ?? `${m.toBase58().slice(0, 4)}…`;
  const q = sym(view.account.quoteMint);
  const buys = view.targets.filter((t) => !t.cash);
  const cash = view.targets.find((t) => t.cash);
  const quoteVault = view.vaults[0]?.balance;
  return (
    <div className="summary" data-testid="fund-summary">
      <p>
        Pays with <strong>{q}</strong> <Help term="pay-with" label="pay-with" />. Every {humanInterval(view.interval)} it spends{" "}
        {buys.map((t) => `${formatUi((view.perRun * BigInt(t.bps)) / 10_000n, d)} ${q} on ${sym(t.mint)}`).join(", ")}
        {cash ? ` and keeps ${bpsToPercent(cash.bps)}% of deposits as cash` : ""}.
        {quoteVault !== undefined && ` The fund holds ${formatUi(quoteVault, d)} ${q} right now.`}
      </p>
      <ul className="next-buys">
        {buys.map((t) => {
          const slice = (view.perRun * BigInt(t.bps)) / 10_000n;
          const left = slice > 0n ? (t.budget + slice - 1n) / slice : 0n;
          return (
            <li key={t.index} data-testid={`next-${t.index}`}>
              {t.due === "no budget"
                ? `${sym(t.mint)}: nothing left to spend. Deposit ${q} to start buying again.`
                : t.due === "due"
                  ? `Next buy of ${sym(t.mint)}: now, as soon as a keeper runs it. ${formatUi(t.budget, d)} ${q} left (${left} buys).`
                  : `Next buy of ${sym(t.mint)} in ${countdown(t.nextDue - view.now)}. ${formatUi(t.budget, d)} ${q} left (${left} buys).`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** "Set image / edit metadata": holder only, through the shared set-metadata planner. */
function MetadataPanel({
  s,
  view,
  fundKey,
  labels,
  disabled,
  run,
}: {
  s: AppState;
  view: FundView;
  fundKey: PublicKey;
  labels: Labels;
  disabled: boolean;
  run: (name: string, build: () => Promise<Review>) => Promise<void>;
}) {
  const net = s.net!;
  const [md, setMd] = useState<{ key: string; stored: StoredMetadata | undefined; error?: string } | null>(null);
  const key = `${net.generation}|${view.account.nftMint.toBase58()}|${s.sendTick}`;
  useEffect(() => {
    let cancelled = false;
    readFundMetadata(net.connection, view.account.nftMint).then(
      (r) => !cancelled && setMd({ key, stored: r.stored }),
      (err: unknown) => !cancelled && setMd({ key, stored: undefined, error: errMsg(err) }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const stored = md && md.key === key ? md.stored : undefined;
  const [open, setOpen] = useState(false);
  const [builder, setBuilder] = useState(false);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (stored) {
      setName(stored.name);
      setSymbol(stored.symbol);
      setUri(stored.uri);
    }
  }, [stored?.name, stored?.symbol, stored?.uri]); // eslint-disable-line react-hooks/exhaustive-deps
  const holder = !!s.signer && !!view.nftAccount && view.nftAccount.owner.equals(s.signer.publicKey);
  const onArt = (r: ArtResult) => {
    if (r.state === "ready") {
      setName(r.metadata.name);
      setSymbol(r.metadata.symbol);
      setUri(r.metadata.uri);
    }
  };
  const submit = () => {
    setError(null);
    const update: MetadataUpdate = stored
      ? {
          ...(name !== stored.name ? { name } : {}),
          ...(symbol !== stored.symbol ? { symbol } : {}),
          ...(uri !== stored.uri ? { uri } : {}),
        }
      : { name, symbol, uri };
    if (Object.keys(update).length === 0) {
      setError(new Error("nothing changed"));
      return;
    }
    void run("metadata", () => reviewSetMetadata(net, s.signer!.publicKey, fundKey, update));
  };
  const sym = (m: PublicKey) => labels[m.toBase58()]?.symbol ?? m.toBase58().slice(0, 4);
  const artCtx = {
    fund: fundKey,
    quote: { mint: view.account.quoteMint, label: sym(view.account.quoteMint) },
    targets: view.targets.map((t) => ({ mint: t.mint, bps: t.bps, cash: t.cash, label: sym(t.mint) })),
  };
  return (
    <section className="panel" data-testid="metadata-panel">
      <div className="row between wrap">
        <h3>
          NFT name and picture <Help term="nft" label="the fund NFT" />
        </h3>
        <button onClick={() => setOpen((o) => !o)} disabled={!holder || disabled} data-testid="edit-metadata">
          Set image / edit metadata
        </button>
      </div>
      {md?.error && <p className="error small">{md.error}</p>}
      <p className="small" data-testid="current-metadata">
        {stored ? (
          <>
            <strong>{stored.name}</strong> ({stored.symbol}) · metadata <span className="mono">{stored.uri}</span>
          </>
        ) : (
          "This NFT has no name or picture yet."
        )}
      </p>
      {!holder && <p className="small muted">Only the wallet that holds the fund NFT can change this.</p>}
      {open && holder && (
        <>
          <div className="grid2">
            <label className="field">
              Name
              <input aria-label="Metadata name" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="field">
              Symbol
              <input aria-label="Metadata symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            </label>
          </div>
          <label className="field">
            Metadata link (uri)
            <input aria-label="Metadata link" className="mono" value={uri} onChange={(e) => setUri(e.target.value)} placeholder="https://.../fund.json" />
          </label>
          <label className="ack small">
            <input type="checkbox" checked={builder} onChange={(e) => setBuilder(e.target.checked)} aria-label="Build a new picture and link" /> Build a new picture and
            metadata link here
          </label>
          {builder && <ArtStep s={s} ctx={artCtx} initial={{ name, symbol }} allowNone={false} onChange={onArt} />}
          <button className="primary" disabled={disabled || !name || !symbol || !uri} onClick={submit} data-testid="metadata-review">
            Review metadata change
          </button>
          {error !== null && <FriendlyError err={error} cluster={net.cluster} />}
        </>
      )}
    </section>
  );
}
