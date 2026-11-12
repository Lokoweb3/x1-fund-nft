import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { formatUi, parseUi, shellQuote } from "@core/owner.js";
import { loadFundView, type FundView } from "@core/rpc.js";
import type { AppState } from "../App";
import { makeProgram, reviewDeposit, reviewEnsureVaults, reviewWithdraw, type Review } from "../lib/actions";
import { createLatest, sameView, type ViewIdentity } from "../lib/latest";
import { signerId } from "../lib/session";
import { ReviewPanel } from "./ReviewPanel";
import { CopyButton, errMsg, Short } from "./ui";

/** Light polling: at most every 30 s, only while the tab is visible. */
const POLL_MS = 30_000;

function iso(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString().replace(".000Z", "Z");
}

export function FundDetail({ s, fund }: { s: AppState; fund: string }) {
  // The loaded view carries the identity it was read under; a reply for an
  // older network generation, RPC or fund is dropped, never shown.
  const [loaded, setLoaded] = useState<{ identity: ViewIdentity; view: FundView } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState("");
  const [actionError, setActionError] = useState("");
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
      const r = await loads.run(loadFundView(net.connection, makeProgram(net), new PublicKey(fund), now));
      if (r.stale || !sameView(identity, currentRef.current)) return;
      setLoaded({ identity, view: r.value });
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
    setActionError("");
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

  const view = loaded && sameView(loaded.identity, current) ? loaded.view : null;
  // Actions only for a view loaded under the current network and fund, with a signer, and no send in flight.
  const actionsEnabled = !!view && !!payer && !s.sendPending && busy === "";

  const run = async (name: string, build: () => Promise<Review>) => {
    if (s.sendPending || !current) return;
    const identity = current;
    const builtFor = signerKey;
    setActionError("");
    setReview(null);
    setBusy(name);
    try {
      const r = await builds.run(build());
      if (r.stale || !sameView(identity, currentRef.current) || s.live().signerId !== builtFor) return;
      setReview(r.value);
    } catch (err) {
      if (sameView(identity, currentRef.current)) setActionError(errMsg(err));
    } finally {
      setBusy("");
    }
  };

  const decimals = view?.quote.decimals ?? 0;

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
          <DepositForm
            decimals={decimals}
            disabled={!actionsEnabled}
            onReview={(amount) => run("deposit", () => reviewDeposit(net, payer!, fundKey, amount))}
          />
          <WithdrawForm
            view={view}
            disabled={!actionsEnabled}
            onReview={(mint, amount) => run("withdraw", () => reviewWithdraw(net, payer!, fundKey, mint, amount))}
          />
          <div className="row wrap">
            <button disabled={!actionsEnabled} onClick={() => void run("ensure", () => reviewEnsureVaults(net, payer!, fundKey))} data-testid="ensure-vaults">
              Ensure vaults
            </button>
            <span className="small muted">Creates any missing quote/target vault account. Idempotent.</span>
          </div>
          {busy && <p className="muted">Building and simulating {busy}...</p>}
          {actionError && (
            <p className="error" data-testid="action-error">
              {actionError}
            </p>
          )}
        </section>
      )}

      {review && (
        <ReviewPanel
          s={s}
          review={review}
          onClose={() => setReview(null)}
        />
      )}

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
