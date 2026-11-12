import { formatUi } from "@core/owner.js";
import { TOKEN_2022_PROGRAM_ID } from "@core/pool.js";
import type { MintLookup } from "../lib/lookups";
import { CURATED_TOKENS, curatedNote } from "../lib/tokens";
import type { DetectedCluster } from "@core/cluster.js";
import { Short } from "./ui";

const SOURCE_TEXT = {
  "token-2022": "name from the token's own metadata",
  metaplex: "name from Metaplex metadata",
  curated: "name from this app's list",
  address: "no name found",
} as const;

/** Paste-a-mint field (the main input) with the curated list as a shortcut, and what the chain says about it. */
export function MintInput({
  label,
  testId,
  value,
  onChange,
  lookup,
  cluster,
  exclude = [],
  showBalance = true,
}: {
  label: string;
  testId: string;
  value: string;
  onChange: (v: string) => void;
  lookup: MintLookup;
  cluster: DetectedCluster | undefined;
  exclude?: string[];
  showBalance?: boolean;
}) {
  const shortcuts = CURATED_TOKENS.filter((t) => !exclude.includes(t.mint));
  return (
    <div className="mint-input" data-testid={testId}>
      <label className="field">
        {label}
        <input
          aria-label={label}
          className="mono"
          value={value}
          placeholder="paste a token mint address"
          onChange={(e) => onChange(e.target.value.trim())}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <div className="chips small" aria-label={`${label}: shortcuts`}>
        <span className="muted">or pick:</span>
        {shortcuts.map((t) => (
          <button key={t.mint} type="button" className={`chip${value === t.mint ? " on" : ""}`} onClick={() => onChange(t.mint)} title={`${t.mint} (X1 mainnet)`}>
            {t.symbol}
          </button>
        ))}
        <span className="muted"> {curatedNote(cluster)}</span>
      </div>
      <MintFacts lookup={lookup} showBalance={showBalance} />
    </div>
  );
}

export function MintFacts({ lookup, showBalance }: { lookup: MintLookup; showBalance: boolean }) {
  if (lookup.status === "empty") return null;
  if (lookup.status === "loading") return <p className="small muted">Reading this token from the network...</p>;
  if (lookup.status === "invalid" || lookup.status === "error") {
    return (
      <p className="error small" data-testid="mint-error">
        {lookup.message}
      </p>
    );
  }
  const { info, label, balance } = lookup;
  return (
    <p className="ok small mint-facts" data-testid="mint-facts">
      <strong data-testid="mint-symbol">{label.symbol}</strong>
      {label.name !== label.symbol && <> ({label.name})</>} <span className="muted">· {SOURCE_TEXT[label.source]}</span> · {info.decimals} decimals ·{" "}
      {info.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL Token"}
      {info.transferFee && info.transferFee.newer.basisPoints > 0 ? ` · ${info.transferFee.newer.basisPoints / 100}% transfer fee` : ""} · allowed by the
      fund program
      {showBalance && balance !== undefined && (
        <>
          {" "}
          · your wallet holds <span data-testid="mint-balance">{formatUi(balance, info.decimals)}</span>
        </>
      )}{" "}
      · <Short value={info.address.toBase58()} />
    </p>
  );
}
