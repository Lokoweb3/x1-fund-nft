import { useState } from "react";
import type { Cluster } from "@core/cluster.js";
import { explorerLink } from "../lib/network";
import { friendlyError, type ErrorAction } from "../lib/errors";
import { GLOSSARY, type GlossaryTerm } from "../lib/glossary";

/** "What is this?" button: toggles a one-paragraph answer inline (works on touch screens too). */
export function Help({ term, label }: { term: GlossaryTerm; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="help">
      <button
        type="button"
        className="help-btn"
        aria-expanded={open}
        aria-label={`What is ${label ?? term}?`}
        title={GLOSSARY[term]}
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <span className="help-text small" role="note" data-testid={`help-${term}`}>
          {GLOSSARY[term]}
        </span>
      )}
    </span>
  );
}

/** A friendly error: plain words, one action button when there is one, and the original text under "details". */
export function FriendlyError({
  err,
  cluster,
  onAction,
  testId,
}: {
  err: unknown;
  cluster?: string;
  onAction?: (kind: ErrorAction) => void;
  testId?: string;
}) {
  const f = friendlyError(err, { cluster });
  return (
    <div className="error friendly" data-testid={testId}>
      <p>{f.title}</p>
      {f.action && onAction && (
        <button type="button" onClick={() => onAction(f.action!.kind)} data-testid="error-action">
          {f.action.label}
        </button>
      )}
      {f.raw !== f.title && (
        <details>
          <summary>details</summary>
          <pre className="logs">{f.raw}</pre>
        </details>
      )}
    </div>
  );
}

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
