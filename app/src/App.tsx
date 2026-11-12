import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { Cluster, DetectedCluster } from "@core/cluster.js";
import { PROGRAM_ID } from "@core/owner.js";
import {
  DEFAULT_EXPLORER,
  DEFAULT_RPC_SETTINGS,
  detectNetwork,
  loadSetting,
  rpcUrlFor,
  saveSetting,
  type NetworkInfo,
  type RpcSettings,
} from "./lib/network";
import { createLocalTestWallet, walletSigner, type AppSigner } from "./lib/signer";
import { CreateFund } from "./components/CreateFund";
import { FundDetail } from "./components/FundDetail";
import { MyFunds } from "./components/MyFunds";
import { errMsg, Short } from "./components/ui";

export type View = { name: "funds" } | { name: "fund"; fund: string } | { name: "create" } | { name: "settings" };

/** Everything a page needs; passed down as one prop. */
export interface AppState {
  net: NetworkInfo | null;
  signer: AppSigner | null;
  mainnetAck: boolean;
  explorer: Record<Cluster, string>;
  go: (v: View) => void;
}

export function App() {
  // Empty list: Wallet Standard wallets (Backpack and others) register themselves.
  const wallets = useMemo(() => [], []);
  return (
    <WalletProvider wallets={wallets} autoConnect={false}>
      <WalletModalProvider>
        <Shell />
      </WalletModalProvider>
    </WalletProvider>
  );
}

const CLUSTER_TEXT: Record<DetectedCluster, string> = {
  mainnet: "X1 MAINNET: real funds",
  testnet: "X1 testnet",
  localnet: "Local validator (loopback)",
  unknown: "UNKNOWN chain: sending is disabled",
};

function Shell() {
  const wallet = useWallet();
  const [rpc, setRpc] = useState<RpcSettings>(() => loadSetting("rpc", DEFAULT_RPC_SETTINGS));
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [netError, setNetError] = useState<string>("");
  const [detecting, setDetecting] = useState(false);
  const [mainnetAck, setMainnetAck] = useState(false);
  const [testWallet, setTestWallet] = useState<AppSigner | null>(null);
  const [testWalletError, setTestWalletError] = useState("");
  const [explorer, setExplorer] = useState<Record<Cluster, string>>(() => loadSetting("explorer", DEFAULT_EXPLORER));
  const [view, setView] = useState<View>({ name: "funds" });
  const clusterRef = useRef<DetectedCluster>("unknown");
  clusterRef.current = net?.cluster ?? "unknown";

  // Only the latest Connect may set the network: a slower, older detection
  // must never overwrite a newer choice.
  const connectSeq = useRef(0);
  const connect = useCallback(async (settings: RpcSettings) => {
    const seq = ++connectSeq.current;
    // Any network change drops the mainnet acknowledgement and the test wallet.
    setNet(null);
    setMainnetAck(false);
    setTestWallet(null);
    setNetError("");
    let url: string;
    try {
      url = rpcUrlFor(settings);
    } catch (err) {
      setNetError(errMsg(err));
      return;
    }
    setDetecting(true);
    try {
      const detected = await detectNetwork(url);
      if (seq === connectSeq.current) setNet(detected);
    } catch (err) {
      if (seq === connectSeq.current) setNetError(`could not read the genesis hash from ${url}: ${errMsg(err)}`);
    } finally {
      if (seq === connectSeq.current) setDetecting(false);
    }
  }, []);

  useEffect(() => {
    void connect(rpc);
    // Detect once on load with the saved settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateRpc = (patch: Partial<RpcSettings>) => {
    const next = { ...rpc, ...patch };
    setRpc(next);
    saveSetting("rpc", next);
    if (patch.choice !== undefined) void connect(next);
  };

  const walletAppSigner = useMemo<AppSigner | null>(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    return walletSigner(wallet.wallet?.adapter.name ?? "wallet", wallet.publicKey, wallet.signTransaction);
  }, [wallet.publicKey, wallet.signTransaction, wallet.wallet]);

  const signer = testWallet ?? walletAppSigner;

  const startTestWallet = () => {
    setTestWalletError("");
    try {
      setTestWallet(createLocalTestWallet(clusterRef.current, () => clusterRef.current));
    } catch (err) {
      setTestWalletError(errMsg(err));
    }
  };

  const state: AppState = { net, signer, mainnetAck, explorer, go: setView };
  const cluster = net?.cluster;

  return (
    <div className="app">
      <header className="top">
        <h1>Fund NFT owner</h1>
        <nav>
          <button className={view.name === "funds" || view.name === "fund" ? "tab on" : "tab"} onClick={() => setView({ name: "funds" })}>
            My funds
          </button>
          <button className={view.name === "create" ? "tab on" : "tab"} onClick={() => setView({ name: "create" })}>
            Create fund
          </button>
          <button className={view.name === "settings" ? "tab on" : "tab"} onClick={() => setView({ name: "settings" })}>
            Settings
          </button>
        </nav>
      </header>

      <section className="panel network">
        <div className="row wrap">
          <label>
            Network{" "}
            <select aria-label="Network" value={rpc.choice} onChange={(e) => updateRpc({ choice: e.target.value as RpcSettings["choice"] })}>
              <option value="mainnet">X1 mainnet</option>
              <option value="testnet">X1 testnet</option>
              <option value="local">Local validator</option>
              <option value="custom">Custom URL</option>
            </select>
          </label>
          {rpc.choice === "local" && (
            <label>
              Port{" "}
              <input aria-label="Local port" className="port" inputMode="numeric" value={rpc.localPort} onChange={(e) => updateRpc({ localPort: e.target.value.trim() })} />
            </label>
          )}
          {rpc.choice === "custom" && (
            <label className="grow">
              URL{" "}
              <input aria-label="Custom RPC URL" value={rpc.customUrl} placeholder="https://..." onChange={(e) => updateRpc({ customUrl: e.target.value })} />
            </label>
          )}
          <button onClick={() => void connect(rpc)} disabled={detecting}>
            {detecting ? "Detecting..." : "Connect"}
          </button>
        </div>
        {netError && <p className="error">{netError}</p>}
        {net && (
          <div className={`banner cluster-${net.cluster}`} data-testid="cluster-banner" data-cluster={net.cluster}>
            <strong>{CLUSTER_TEXT[net.cluster]}</strong>
            <span className="mono small">
              {net.rpcUrl} · genesis <Short value={net.genesisHash} />
            </span>
          </div>
        )}
        {cluster === "mainnet" && (
          <label className="ack">
            <input type="checkbox" checked={mainnetAck} onChange={(e) => setMainnetAck(e.target.checked)} /> I understand this is X1
            mainnet and uses real funds
          </label>
        )}
        <p className="small muted">
          Program <span className="mono">{PROGRAM_ID.toBase58()}</span>
        </p>
      </section>

      <section className="panel wallet">
        <div className="row wrap">
          <WalletMultiButton />
          {cluster === "localnet" && !testWallet && (
            <button onClick={startTestWallet} data-testid="use-test-wallet">
              Use local test wallet
            </button>
          )}
          {testWallet && (
            <button onClick={() => setTestWallet(null)} data-testid="drop-test-wallet">
              Discard test wallet
            </button>
          )}
        </div>
        {testWalletError && <p className="error">{testWalletError}</p>}
        <p className="small" data-testid="signer">
          {signer ? (
            <>
              Signing as <strong>{signer.label}</strong>: <span className="mono" data-testid="signer-pubkey">{signer.publicKey.toBase58()}</span>
              {signer.kind === "local-test" && <span className="tag">localnet only</span>}
            </>
          ) : (
            "No signer connected. Reading and simulating still work."
          )}
        </p>
      </section>

      <main>
        {!net && !netError && <p className="muted">Connecting...</p>}
        {view.name === "funds" && <MyFunds s={state} />}
        {view.name === "fund" && <FundDetail key={view.fund} s={state} fund={view.fund} />}
        {view.name === "create" && <CreateFund s={state} />}
        {view.name === "settings" && (
          <Settings
            explorer={explorer}
            onChange={(next) => {
              setExplorer(next);
              saveSetting("explorer", next);
            }}
          />
        )}
      </main>
      <footer className="small muted">
        Local app: no analytics, no external fonts or CDNs. The app never asks for a secret key; your wallet signs.
      </footer>
    </div>
  );
}

function Settings({ explorer, onChange }: { explorer: Record<Cluster, string>; onChange: (e: Record<Cluster, string>) => void }) {
  return (
    <section className="panel">
      <h2>Explorer links</h2>
      <p className="small muted">
        Transaction link template per cluster; <span className="mono">{"{sig}"}</span> is replaced by the signature. Leave empty for no
        link.
      </p>
      {(["mainnet", "testnet", "localnet"] as const).map((c) => (
        <label key={c} className="field">
          {c}
          <input value={explorer[c]} onChange={(e) => onChange({ ...explorer, [c]: e.target.value })} />
        </label>
      ))}
      <button onClick={() => onChange(DEFAULT_EXPLORER)}>Reset to defaults</button>
    </section>
  );
}
