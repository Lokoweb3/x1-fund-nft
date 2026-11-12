import { useCallback, useEffect, useRef, useState } from "react";
import { fundPda, parsePubkey, PROGRAM_ID } from "@core/owner.js";
import { findFundsHeldBy, readFundMetadata, type HeldFund } from "@core/rpc.js";
import type { StoredMetadata } from "@core/metadata.js";
import { useTokenLabels } from "../lib/lookups";
import { bpsToPercent } from "../lib/wizard";
import type { AppState } from "../App";
import { makeProgram } from "../lib/actions";
import { createLatest } from "../lib/latest";
import { signerId } from "../lib/session";
import { errMsg, Short } from "./ui";

/** Identity a fund list was loaded under: network generation, RPC and wallet. */
function listKey(generation: number | undefined, rpcUrl: string | undefined, signer: string | null): string {
  return `${generation ?? -1}|${rpcUrl ?? ""}|${signer ?? ""}`;
}

export function MyFunds({ s }: { s: AppState }) {
  const [funds, setFunds] = useState<{ key: string; list: HeldFund[] } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const owner = s.signer?.publicKey ?? null;
  const net = s.net;
  const key = listKey(net?.generation, net?.rpcUrl, signerId(s.signer));
  const keyRef = useRef(key);
  keyRef.current = key;
  const loads = useRef(createLatest()).current;

  const load = useCallback(async () => {
    if (!net || !owner) return;
    const mine = key;
    setLoading(true);
    setError("");
    try {
      const r = await loads.run(findFundsHeldBy(net.connection, makeProgram(net), owner));
      if (r.stale || keyRef.current !== mine) return;
      setFunds({ key: mine, list: r.value });
    } catch (err) {
      if (keyRef.current !== mine) return;
      setFunds(null);
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, [net, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Network or wallet change: clear the list and drop loads in flight.
  useEffect(() => {
    loads.invalidate();
    setFunds(null);
    setError("");
    void load();
  }, [load, loads]);

  useEffect(() => {
    if (s.sendTick > 0) void load();
  }, [s.sendTick, load]);

  const list = funds && funds.key === key ? funds.list : null;

  return (
    <>
      <section className="panel">
        <div className="row between">
          <h2>My funds</h2>
          <button onClick={() => void load()} disabled={!net || !owner || loading || s.sendPending}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        {!owner && <p className="muted">Connect a wallet to list the funds whose NFT it holds.</p>}
        {error && <p className="error">{error}</p>}
        {(!owner || (list && list.length === 0)) && (
          <div className="empty" data-testid="funds-empty">
            {owner && <p className="muted">This wallet holds no fund NFT on this network yet.</p>}
            <button className="primary" disabled={s.sendPending} onClick={() => s.go({ name: "create" })} data-testid="create-first">
              Create your first fund
            </button>
          </div>
        )}
        {list && list.length > 0 && (
          <ul className="funds" data-testid="my-funds">
            {list.map((f) => (
              <FundItem key={f.fund.toBase58()} s={s} f={f} />
            ))}
          </ul>
        )}
      </section>
      <Lookup s={s} />
    </>
  );
}

/** One fund: the NFT's stored name and symbol (read from chain; the uri is shown, never fetched) and what it buys. */
function FundItem({ s, f }: { s: AppState; f: HeldFund }) {
  const net = s.net;
  const [md, setMd] = useState<{ key: string; stored: StoredMetadata | undefined } | null>(null);
  const key = `${net?.generation}|${f.nftMint.toBase58()}|${s.sendTick}`;
  useEffect(() => {
    if (!net) return;
    let cancelled = false;
    readFundMetadata(net.connection, f.nftMint).then(
      (r) => !cancelled && setMd({ key, stored: r.stored }),
      () => !cancelled && setMd({ key, stored: undefined }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const labels = useTokenLabels(net, [f.account.quoteMint, ...f.account.targets.map((t) => t.mint)]);
  const stored = md && md.key === key ? md.stored : undefined;
  const q = labels[f.account.quoteMint.toBase58()]?.symbol ?? "?";
  const buys = f.account.targets
    .filter((t) => !t.mint.equals(f.account.quoteMint))
    .map((t) => `${labels[t.mint.toBase58()]?.symbol ?? "?"} ${bpsToPercent(t.bps)}%`);
  const cash = f.account.targets.find((t) => t.mint.equals(f.account.quoteMint));
  return (
    <li data-testid="fund-item">
      <div>
        <strong data-testid="fund-name">{stored ? `${stored.name} (${stored.symbol})` : "Unnamed fund"}</strong>{" "}
        <span className="small">
          pays with {q}, buys {buys.join(", ") || "nothing"}
          {cash ? `, keeps ${bpsToPercent(cash.bps)}% as cash` : ""}
        </span>
      </div>
      {stored && (
        <div className="small muted">
          metadata <span className="mono" data-testid="fund-uri">{stored.uri}</span>
        </div>
      )}
      <button className="link mono" disabled={s.sendPending} onClick={() => s.go({ name: "fund", fund: f.fund.toBase58() })} data-testid="fund-link">
        {f.fund.toBase58()}
      </button>
      <span className="small muted">
        {" "}
        NFT <Short value={f.nftMint.toBase58()} />
      </span>
    </li>
  );
}

/** Open a fund by its PDA, or by its NFT mint (mapped with fundPda). */
function Lookup({ s }: { s: AppState }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const open = async () => {
    setError("");
    try {
      const key = parsePubkey(value.trim(), "fund address");
      const net = s.net;
      if (!net) throw new Error("not connected to an RPC");
      // Answers from a network that is no longer current are ignored.
      const stillCurrent = () => s.live().generation === net.generation && s.live().rpcUrl === net.rpcUrl;
      const info = await net.connection.getAccountInfo(key);
      if (!stillCurrent()) return;
      if (info && info.owner.equals(PROGRAM_ID)) return s.go({ name: "fund", fund: key.toBase58() });
      const viaMint = fundPda(key);
      const pdaInfo = await net.connection.getAccountInfo(viaMint);
      if (!stillCurrent()) return;
      if (pdaInfo && pdaInfo.owner.equals(PROGRAM_ID)) return s.go({ name: "fund", fund: viaMint.toBase58() });
      throw new Error(`${key.toBase58()} is neither a fund account nor a fund NFT mint on this network`);
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <section className="panel">
      <h3>Look up a fund</h3>
      <div className="row wrap">
        <input
          aria-label="Fund address"
          className="grow mono"
          placeholder="fund PDA or NFT mint"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void open()}
        />
        <button onClick={() => void open()} disabled={!value.trim() || s.sendPending}>
          Open
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
