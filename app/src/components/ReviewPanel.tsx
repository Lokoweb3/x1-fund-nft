import type { AppState } from "../App";
import type { Review } from "../lib/actions";

/**
 * Human-readable review of a simulated plan, then "Sign & send". The button
 * exists only after every transaction simulated successfully, and is enabled
 * only when the network generation, cluster, mainnet acknowledgement and
 * signer still match. The send itself runs in app state (App.startSend), so
 * closing this panel or navigating cannot orphan it; while it is pending,
 * this panel cannot be closed and no other review can start.
 */
export function ReviewPanel({ s, review, onClose }: { s: AppState; review: Review; onClose: () => void }) {
  const cluster = s.net?.cluster ?? "unknown";
  const record = s.sends.find((r) => r.reviewId === review.id);
  const mine = record?.status === "pending";

  const blockers: string[] = [];
  if (!s.net || s.net.rpcUrl !== review.rpcUrl || s.net.generation !== review.generation) {
    blockers.push("The network changed since this review was built. Build it again.");
  }
  if (cluster === "unknown") blockers.push("This RPC is not X1 mainnet, X1 testnet, or a loopback localnet. Sending is impossible.");
  if (cluster === "mainnet" && !s.mainnetAck) blockers.push('Tick "I understand this is X1 mainnet and uses real funds" above to send.');
  if (!s.signer) blockers.push("Connect a wallet to sign. Simulation needed no signature.");
  else if (!s.signer.publicKey.equals(review.payer)) {
    blockers.push(`The active signer is not the payer this review was built for (${review.payer.toBase58()}). Build it again.`);
  }
  if (s.sendPending && !mine) blockers.push("Another send is in progress.");
  if (review.signerEpoch === undefined || review.signerEpoch !== s.live().signerEpoch) {
    blockers.push("The wallet connection changed since this review was built (connect, disconnect, account or wallet). Build it again.");
  }

  return (
    <section className="panel review" data-testid="review">
      <div className="row between">
        <h3>Review: {review.title}</h3>
        <button className="link" onClick={onClose} disabled={mine} title={mine ? "Wait for the send to finish" : undefined} data-testid="close-review">
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
          {review.simOk && !record && (
            <>
              {blockers.map((b, i) => (
                <p key={i} className="warn">
                  {b}
                </p>
              ))}
              <button className="primary" disabled={blockers.length > 0} onClick={() => s.startSend(review)} data-testid="sign-and-send">
                Sign &amp; send{review.sims.length > 1 ? ` (${review.sims.length} transactions, in order)` : ""}
              </button>
            </>
          )}
        </>
      )}

      {record && (
        <p className="small" data-testid="review-send-status">
          {record.status === "pending"
            ? "Sending... see Transactions above. Your wallet may ask you to approve each transaction."
            : `Send ${record.status === "done" ? "confirmed" : "stopped"}; the receipt is under Transactions above.`}
        </p>
      )}
    </section>
  );
}
