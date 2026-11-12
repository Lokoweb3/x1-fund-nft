import { useEffect, useState } from "react";
import type { PublicKey } from "@solana/web3.js";
import type { FundView } from "@core/rpc.js";
import { readFundMetadata } from "@core/rpc.js";
import type { StoredMetadata } from "@core/metadata.js";
import type { NetworkInfo } from "../lib/network";
import type { TokenLabel } from "../lib/tokens";
import { formatApprox } from "../lib/value";
import { resolvePicture, type PictureState } from "../lib/nft_picture";
import type { ValuationState } from "./Holdings";

/**
 * The picture for a metadata uri. Auto-fetches only X1 Inscriptions hosts;
 * other hosts wait for `allow(host)`, which lasts for this component's
 * life (one page view). `key` carries network generation, fund and send
 * tick, so a change drops the old answer; requests in flight are aborted.
 */
export function usePicture(uri: string | undefined, key: string): { picture: PictureState; allow: (host: string) => void } {
  const [allowed, setAllowed] = useState<{ key: string; hosts: Set<string> }>({ key, hosts: new Set() });
  const hosts = allowed.key === key ? allowed.hosts : new Set<string>();
  const runKey = `${key}|${uri ?? ""}|${[...hosts].sort().join(",")}`;
  const [state, setState] = useState<{ key: string; picture: PictureState } | null>(null);
  useEffect(() => {
    if (uri === undefined) return;
    const ac = new AbortController();
    setState({ key: runKey, picture: { status: "loading" } });
    resolvePicture(uri, hosts, ac.signal).then(
      (picture) => !ac.signal.aborted && setState({ key: runKey, picture }),
      () => !ac.signal.aborted && setState({ key: runKey, picture: { status: "error" } }),
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey]);
  const picture: PictureState = uri === undefined ? { status: "none" } : state && state.key === runKey ? state.picture : { status: "loading" };
  return {
    picture,
    allow: (host) => setAllowed({ key, hosts: new Set([...hosts, host]) }),
  };
}

/** Stored on-chain metadata for an NFT mint, tagged with `key`; undefined until read or when absent. */
export function useStoredMetadata(net: NetworkInfo | null, nftMint: PublicKey, key: string): { loaded: boolean; stored: StoredMetadata | undefined } {
  const [md, setMd] = useState<{ key: string; stored: StoredMetadata | undefined } | null>(null);
  useEffect(() => {
    if (!net) return;
    let cancelled = false;
    readFundMetadata(net.connection, nftMint).then(
      (r) => !cancelled && setMd({ key, stored: r.stored }),
      () => !cancelled && setMd({ key, stored: undefined }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const cur = md && md.key === key ? md : null;
  return { loaded: !!cur, stored: cur?.stored };
}

/** The picture, or a generated placeholder; never a broken image. */
export function NftPicture({
  picture,
  name,
  onAllow,
  compact = false,
}: {
  picture: PictureState;
  name: string;
  onAllow: (host: string) => void;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (picture.status === "ok" && failed !== picture.image) {
    return (
      <img
        className="nft-img"
        src={picture.image}
        alt={`Picture of ${name}`}
        referrerPolicy="no-referrer"
        crossOrigin="anonymous"
        loading="lazy"
        decoding="async"
        onError={() => setFailed(picture.image)}
        data-testid="nft-image"
      />
    );
  }
  const initials = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase() || "NFT";
  return (
    <div className="nft-placeholder" data-testid="nft-placeholder">
      <span className="nft-initials" aria-hidden="true">
        {initials}
      </span>
      {!compact && <span className="nft-ph-name">{name}</span>}
      {picture.status === "loading" && !compact && <span className="small">loading picture…</span>}
      {picture.status === "ask" && (
        <button type="button" className="nft-allow small" onClick={() => onAllow(picture.host)} data-testid="nft-load-picture">
          {compact ? "Load picture" : `Load picture (contacts ${picture.host})`}
        </button>
      )}
    </div>
  );
}

const symOf = (labels: Record<string, TokenLabel>, mint: string) => labels[mint]?.symbol ?? `${mint.slice(0, 4)}…`;

/** Presentational NFT card: picture, name, and what the fund holds "inside" it. */
export function NftCardView({
  stored,
  picture,
  onAllow,
  holdings,
  view,
  labels,
}: {
  stored: StoredMetadata | undefined;
  picture: PictureState;
  onAllow: (host: string) => void;
  holdings: ValuationState;
  view: FundView;
  labels: Record<string, TokenLabel>;
}) {
  const name = stored?.name || "Unnamed fund";
  const q = symOf(labels, view.account.quoteMint.toBase58());
  const qd = view.quote.decimals;
  const v = holdings.status === "ok" ? holdings.valuation : undefined;
  return (
    <figure className="nft-card" data-testid="nft-card">
      <div className="nft-frame">
        <NftPicture picture={picture} name={name} onAllow={onAllow} />
        <div className="nft-total" data-testid="nft-total">
          <span className="nft-total-label">Inside</span>
          <span className="nft-total-value">
            {holdings.status === "loading" && "…"}
            {holdings.status === "error" && "value unknown"}
            {v && `≈ ${formatApprox(v.total, qd)} ${q}${v.complete ? "" : " + unknown"}`}
          </span>
        </div>
      </div>
      <figcaption className="nft-body">
        <div className="nft-title">
          <strong data-testid="nft-name">{name}</strong>
          {stored?.symbol && <span className="tag">{stored.symbol}</span>}
        </div>
        <ul className="nft-tokens" data-testid="nft-tokens">
          {view.vaults.map((x) => {
            const mint = x.mint.address.toBase58();
            const row = v?.rows.find((r) => r.mint.address.equals(x.mint.address));
            return (
              <li key={mint} className="chip-token nft-token" title={mint}>
                <span className="dot" aria-hidden="true" />
                <span className="nft-token-sym">{symOf(labels, mint)}</span>
                <span className="mono">{x.balance === undefined ? "missing" : formatApprox(x.balance, x.mint.decimals)}</span>
                {row?.value !== undefined && !row.isQuote && <span className="muted">≈ {formatApprox(row.value, qd)}</span>}
              </li>
            );
          })}
        </ul>
        {picture.status === "ok" && picture.animationUrl && (
          <a className="small" href={picture.animationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
            Open animation (external link)
          </a>
        )}
        <span className="small muted">Estimate, display only.</span>
      </figcaption>
    </figure>
  );
}

/** NFT card for the fund page: reads metadata, finds the picture, shows the shared valuation. */
export function NftCard({
  net,
  view,
  sendTick,
  holdings,
  labels,
}: {
  net: NetworkInfo;
  view: FundView;
  sendTick: number;
  holdings: ValuationState;
  labels: Record<string, TokenLabel>;
}) {
  const key = `${net.generation}|${net.rpcUrl}|${view.fund.toBase58()}|${view.account.nftMint.toBase58()}|${sendTick}`;
  const md = useStoredMetadata(net, view.account.nftMint, key);
  const { picture, allow } = usePicture(md.loaded ? md.stored?.uri : undefined, key);
  return <NftCardView stored={md.stored} picture={md.loaded ? picture : { status: "loading" }} onAllow={allow} holdings={holdings} view={view} labels={labels} />;
}

/** Small picture for a fund list item. */
export function NftThumb({ uri, name, pictureKey }: { uri: string | undefined; name: string; pictureKey: string }) {
  const { picture, allow } = usePicture(uri, pictureKey);
  return (
    <div className="nft-thumb" data-testid="nft-thumb">
      <NftPicture picture={picture} name={name} onAllow={allow} compact />
    </div>
  );
}
