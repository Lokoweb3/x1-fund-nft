import { useCallback, useEffect, useState } from "react";
import { fundPda, parsePubkey, PROGRAM_ID } from "@core/owner.js";
import { findFundsHeldBy, type HeldFund } from "@core/rpc.js";
import type { AppState } from "../App";
import { makeProgram } from "../lib/actions";
import { errMsg, Short } from "./ui";

export function MyFunds({ s }: { s: AppState }) {
  const [funds, setFunds] = useState<HeldFund[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const owner = s.signer?.publicKey ?? null;
  const net = s.net;

  const load = useCallback(async () => {
    if (!net || !owner) return;
    setLoading(true);
    setError("");
    try {
      setFunds(await findFundsHeldBy(net.connection, makeProgram(net), owner));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, [net, owner?.toBase58()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setFunds(null);
    void load();
  }, [load]);

  return (
    <>
      <section className="panel">
        <div className="row between">
          <h2>My funds</h2>
          <button onClick={() => void load()} disabled={!net || !owner || loading}>
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
        {!owner && <p className="muted">Connect a wallet to list the funds whose NFT it holds.</p>}
        {error && <p className="error">{error}</p>}
        {owner && funds && funds.length === 0 && <p className="muted">No fund NFTs held by this wallet on this network.</p>}
        {funds && funds.length > 0 && (
          <ul className="funds" data-testid="my-funds">
            {funds.map((f) => (
              <li key={f.fund.toBase58()}>
                <button className="link mono" disabled={s.sendPending} onClick={() => s.go({ name: "fund", fund: f.fund.toBase58() })} data-testid="fund-link">
                  {f.fund.toBase58()}
                </button>
                <span className="small muted">
                  {" "}
                  quote <Short value={f.account.quoteMint.toBase58()} /> · {f.account.targets.length} target(s) · NFT{" "}
                  <Short value={f.nftMint.toBase58()} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Lookup s={s} />
    </>
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
      if (!s.net) throw new Error("not connected to an RPC");
      const info = await s.net.connection.getAccountInfo(key);
      if (info && info.owner.equals(PROGRAM_ID)) return s.go({ name: "fund", fund: key.toBase58() });
      const viaMint = fundPda(key);
      const pdaInfo = await s.net.connection.getAccountInfo(viaMint);
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
