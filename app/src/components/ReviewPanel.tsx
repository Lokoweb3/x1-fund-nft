import { useState } from "react";
import { PlanSendError, type TxOutcome } from "@core/owner.js";
import type { AppState } from "../App";
import { signAndSend, type Review } from "../lib/actions";
import { errMsg, SigLink } from "./ui";

type SendState =
  | { phase: "idle" }
  | { phase: "sending"; lines: string[] }
  | { phase: "done"; outcomes: TxOutcome[] }
  | { phase: "failed"; message: string; done: TxOutcome[]; failedSig?: string; state?: string };

/**
 * Human-readable review of a simulated plan, then "Sign & send". The button
 * exists only after every transaction simulated successfully, and is enabled
 * only when the cluster, the mainnet acknowledgement, and the signer allow it.
 */
export function ReviewPanel({
  s,
  review,
  onClose,
  onSent,
}: {
  s: AppState;
  review: Review;
  onClose: () => void;
  onSent?: (outcomes: TxOutcome[]) => void;
}) {
  const [send, setSend] = useState<SendState>({ phase: "idle" });
  const cluster = s.net?.cluster ?? "unknown";

  const blockers: string[] = [];
  if (!s.net || s.net.rpcUrl !== review.rpcUrl) blockers.push("The RPC changed since this review was built. Build it again.");
  if (cluster === "unknown") blockers.push("This RPC is not X1 mainnet, X1 testnet, or a loopback localnet. Sending is impossible.");
  if (cluster === "mainnet" && !s.mainnetAck) blockers.push('Tick "I understand this is X1 mainnet and uses real funds" above to send.');
  if (!s.signer) blockers.push("Connect a wallet to sign. Simulation needed no signature.");
  else if (!s.signer.publicKey.equals(review.payer)) {
    blockers.push(`The active signer is not the payer this review was built for (${review.payer.toBase58()}). Build it again.`);
  }

  const doSend = async () => {
    if (!s.net || !s.signer) return;
    const lines: string[] = [];
    setSend({ phase: "sending", lines });
    try {
      const outcomes = await signAndSend({
        net: s.net,
        review,
        signer: s.signer,
        mainnetAck: s.mainnetAck,
        log: (line) => {
          lines.push(line.trim());
          setSend({ phase: "sending", lines: [...lines] });
        },
      });
      setSend({ phase: "done", outcomes });
      onSent?.(outcomes);
    } catch (err) {
      if (err instanceof PlanSendError) {
        setSend({ phase: "failed", message: err.message, done: err.done, failedSig: err.signature, state: err.state });
        if (err.done.length > 0) onSent?.(err.done);
      } else {
        setSend({ phase: "failed", message: errMsg(err), done: [] });
      }
    }
  };

  return (
    <section className="panel review" data-testid="review">
      <div className="row between">
        <h3>Review: {review.title}</h3>
        <button className="link" onClick={onClose}>
          close
        </button>
      </div>
      <p className="small muted">
        {review.cluster} · <span className="mono">{review.rpcUrl}</span> · payer <span className="mono">{review.payer.toBase58()}</span>
      </p>
      <dl className="kv">
        {review.rows.map(([k, v], i) => (
          <div key={i}>
            <dt>{k}</dt>
            <dd className="mono">{v}</dd>
          </div>
        ))}
      </dl>
      {review.warnings.map((w, i) => (
        <p key={i} className="warn">
          {w}
        </p>
      ))}

      {review.nothingToDo ? (
        <p className="ok" data-testid="nothing-to-do">
          Nothing to do: no transaction is needed.
        </p>
      ) : (
        <>
          <h4>Transactions ({review.sims.length})</h4>
          {review.sims.map((sim, i) => (
            <div key={i} className={`sim ${sim.err ? "bad" : "good"}`} data-testid="sim">
              <div>
                <strong>
                  tx {i + 1}/{review.sims.length} ({sim.label})
                </strong>{" "}
                {sim.size} bytes · {sim.unitsConsumed ?? "?"} compute units ·{" "}
                <span data-testid="sim-status">{sim.err ? `simulation FAILED ${JSON.stringify(sim.err)}` : "simulation ok"}</span>
              </div>
              <div className="small">
                signers: {sim.signers.map((k) => k.toBase58()).join(", ")}
              </div>
              <details>
                <summary>Simulation logs ({sim.logs.length} lines)</summary>
                <pre className="logs">{sim.logs.join("\n")}</pre>
              </details>
            </div>
          ))}
          <details>
            <summary>Accounts touched ({review.accounts.length})</summary>
            <ul className="accounts mono small">
              {review.accounts.map((a) => (
                <li key={a.pubkey.toBase58()}>
                  {a.pubkey.toBase58()} {a.isSigner ? "signer " : ""}
                  {a.isWritable ? "writable" : "read-only"}
                </li>
              ))}
            </ul>
          </details>
          {!review.simOk && <p className="error">A simulation failed, so nothing can be sent. Nothing was signed or sent.</p>}
          {review.simOk && send.phase === "idle" && (
            <>
              {blockers.map((b, i) => (
                <p key={i} className="warn">
                  {b}
                </p>
              ))}
              <button className="primary" disabled={blockers.length > 0} onClick={() => void doSend()} data-testid="sign-and-send">
                Sign &amp; send{review.sims.length > 1 ? ` (${review.sims.length} transactions, in order)` : ""}
              </button>
            </>
          )}
        </>
      )}

      {send.phase === "sending" && (
        <div className="small">
          <p>Sending... your wallet may ask you to approve each transaction.</p>
          <pre className="logs">{send.lines.join("\n")}</pre>
        </div>
      )}
      {send.phase === "done" && (
        <div className="ok" data-testid="send-ok">
          <p>All {send.outcomes.length} transaction(s) confirmed.</p>
          <ul>
            {send.outcomes.map((o, i) => (
              <li key={o.signature}>
                tx {i + 1} ({o.label}): <SigLink sig={o.signature} cluster={review.cluster} explorer={s.explorer} />
              </li>
            ))}
          </ul>
          {review.created && (
            <p data-testid="created">
              New fund PDA <span className="mono" data-testid="created-fund">{review.created.fund.toBase58()}</span>, NFT mint{" "}
              <span className="mono" data-testid="created-nft">{review.created.nftMint.toBase58()}</span>{" "}
              <button onClick={() => s.go({ name: "fund", fund: review.created!.fund.toBase58() })}>Open fund</button>
            </p>
          )}
        </div>
      )}
      {send.phase === "failed" && (
        <div className="error" data-testid="send-failed">
          <pre className="logs">{send.message}</pre>
          {send.done.length > 0 && (
            <ul>
              {send.done.map((o, i) => (
                <li key={o.signature}>
                  confirmed tx {i + 1} ({o.label}): <SigLink sig={o.signature} cluster={review.cluster} explorer={s.explorer} />
                </li>
              ))}
            </ul>
          )}
          {send.failedSig && (
            <p>
              {send.state === "unknown" ? "Check this signature before retrying: " : "Failed transaction: "}
              <SigLink sig={send.failedSig} cluster={review.cluster} explorer={s.explorer} />
            </p>
          )}
        </div>
      )}
    </section>
  );
}
