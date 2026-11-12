import { useState } from "react";
import type { Cluster } from "@core/cluster.js";
import { explorerLink } from "../lib/network";

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Shortened base58 value with the full value in the tooltip and a copy button. */
export function Short({ value, copy = false }: { value: string; copy?: boolean }) {
  const short = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value;
  return (
    <span className="mono" title={value}>
      {short}
      {copy && <CopyButton text={value} />}
    </span>
  );
}

export function CopyButton({ text, label = "copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="link small"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
    >
      {done ? "copied" : label}
    </button>
  );
}

/** Signature, linked when the cluster has an explorer template. */
export function SigLink({ sig, cluster, explorer }: { sig: string; cluster: Cluster | "unknown"; explorer: Record<Cluster, string> }) {
  const href = cluster === "unknown" ? undefined : explorerLink(explorer[cluster], sig);
  return (
    <span className="mono sig" data-testid="signature">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {sig}
        </a>
      ) : (
        sig
      )}
    </span>
  );
}
