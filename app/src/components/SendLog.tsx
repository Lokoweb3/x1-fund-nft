import type { Cluster, DetectedCluster } from "@core/cluster.js";
import type { TxOutcome } from "@core/owner.js";
import type { PublicKey } from "@solana/web3.js";
import { SigLink } from "./ui";
import { friendlyError } from "../lib/errors";

/** One send, kept in app state (it survives navigation) until dismissed. */
export interface SendRecord {
  id: number;
  reviewId: number;
  title: string;
  cluster: DetectedCluster;
  rpcUrl: string;
  status: "pending" | "done" | "failed";
  total: number;
  lines: string[];
  outcomes: TxOutcome[];
  error?: string;
  failedSig?: string;
  failState?: string;
  /** For a failed tx that may have been submitted: the last block height it can land at. */
  failedLastValid?: number;
  created?: { fund: PublicKey; nftMint: PublicKey };
}

export function SendLog({
  sends,
  explorer,
  onDismiss,
  onOpenFund,
  locked,
}: {
  sends: SendRecord[];
  explorer: Record<Cluster, string>;
  onDismiss: (id: number) => void;
  onOpenFund: (fund: string) => void;
  locked: boolean;
}) {
  if (sends.length === 0) return null;
  return (
    <section className="panel sends" data-testid="sends">
      <h3>Transactions</h3>
      {sends.map((r) => (
        <div key={r.id} className={`send ${r.status}`} data-testid="send-record" data-status={r.status}>
          <div className="row between wrap">
            <strong>
              {r.title} · {r.cluster}
            </strong>
            {r.status !== "pending" && (
              <button className="link" onClick={() => onDismiss(r.id)} data-testid="dismiss-send">
                dismiss
              </button>
            )}
          </div>
          <p className="small muted mono">{r.rpcUrl}</p>
          {r.status === "pending" && (
            <div className="small" data-testid="send-pending">
              <p>Sending {r.total} transaction(s) in order. Your wallet may ask you to approve each one.</p>
              {r.lines.length > 0 && <pre className="logs">{r.lines.join("\n")}</pre>}
            </div>
          )}
          {r.status === "done" && (
            <div className="ok" data-testid="send-ok">
              <p>All {r.outcomes.length} transaction(s) confirmed.</p>
              <ul>
                {r.outcomes.map((o, i) => (
                  <li key={o.signature}>
                    tx {i + 1} ({o.label}): <SigLink sig={o.signature} cluster={r.cluster} explorer={explorer} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {r.status === "failed" && (
            <div className="error" data-testid="send-failed">
              {r.error && friendlyError(r.error).title !== r.error.split("\n")[0] && <p data-testid="send-failed-friendly">{friendlyError(r.error).title}</p>}
              <pre className="logs">{r.error}</pre>
              {r.outcomes.length > 0 && (
                <ul>
                  {r.outcomes.map((o, i) => (
                    <li key={o.signature}>
                      confirmed tx {i + 1} ({o.label}): <SigLink sig={o.signature} cluster={r.cluster} explorer={explorer} />
                    </li>
                  ))}
                </ul>
              )}
              {r.failedSig && (
                <p>
                  {r.failState === "unknown"
                    ? "Check this signature before retrying: "
                    : r.failState === "not sent"
                      ? "Signed but never broadcast (nothing to check): "
                      : "Failed transaction: "}
                  <SigLink sig={r.failedSig} cluster={r.cluster} explorer={explorer} />
                </p>
              )}
            </div>
          )}
          {r.created && (r.status === "done" || r.outcomes.length > 0) && (
            <p data-testid="created">
              Fund PDA <span className="mono" data-testid="created-fund">{r.created.fund.toBase58()}</span>, NFT mint{" "}
              <span className="mono" data-testid="created-nft">{r.created.nftMint.toBase58()}</span>{" "}
              <button disabled={locked} onClick={() => onOpenFund(r.created!.fund.toBase58())} data-testid="open-created-fund">
                Open fund
              </button>
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
