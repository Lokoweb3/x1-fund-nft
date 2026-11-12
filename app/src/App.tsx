import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import type { Cluster, DetectedCluster } from "@core/cluster.js";
import { PlanSendError, PROGRAM_ID } from "@core/owner.js";
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
import { signAndSend, type Review } from "./lib/actions";
import { InscriptionRegistry, localMarkerStore, reviewUploadKey, staleResumeReason, trackInscriptionSend } from "./lib/inscriptions";
import { signerId, type SessionKey } from "./lib/session";
import { createLocalTestWallet, walletSigner, type AppSigner } from "./lib/signer";
import { CreateWizard } from "./components/CreateWizard";
import { HowItWorks } from "./components/HowItWorks";
import { FundDetail } from "./components/FundDetail";
import { MyFunds } from "./components/MyFunds";
import { SendLog, type SendRecord } from "./components/SendLog";
import { errMsg, Short } from "./components/ui";

export type View = { name: "funds" } | { name: "fund"; fund: string } | { name: "create" } | { name: "settings" };

/** Everything a page needs; passed down as one prop. */
export interface AppState {
  net: NetworkInfo | null;
  signer: AppSigner | null;
  mainnetAck: boolean;
  explorer: Record<Cluster, string>;
  /** Navigate. Refused while a send is pending. */
  go: (v: View) => void;
  /** True while a send is in flight: navigation, network changes and new reviews are blocked. */
  sendPending: boolean;
  /** Start sending a reviewed plan. The record lives in app state until dismissed. */
  startSend: (review: Review) => void;
  sends: SendRecord[];
  /** Increases whenever a send finishes, so pages can refresh. */
  sendTick: number;
  /** The live session, read at call time (for guards on async work). */
  live: () => SessionKey;
  /**
   * Review ids that were handed to a send, ever. Never cleared: dismissing a
   * receipt does not remove an id, so a used review can never send again.
   */
  attempted: ReadonlySet<number>;
  /** Sends whose failed transaction has unknown status; shown on later reviews of the same action. */
  unresolved: Unresolved[];
  /** Switch the network (refused while a send is pending), e.g. from a friendly error. */
  switchNetwork: (choice: RpcSettings["choice"]) => void;
  /**
   * Every inscription transaction this page broadcast, by upload, recorded
   * from sendPlan's onSubmit. Never cleared (like `attempted`); Resume builds
   * its priorAttempts only from here (lib/inscriptions.ts).
   */
  inscriptions: InscriptionRegistry;
  /** Increases on every registry change, so pages re-render. */
  inscriptionsTick: number;
}

export interface Unresolved {
  rpcUrl: string;
  title: string;
  fund: string | undefined;
  signature: string;
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

let sendCounter = 0;

function Shell() {
  const wallet = useWallet();
  const [rpc, setRpc] = useState<RpcSettings>(() => loadSetting("rpc", DEFAULT_RPC_SETTINGS));
  const [net, setNet] = useState<NetworkInfo | null>(null);
  const [netError, setNetError] = useState<string>("");
  const [detecting, setDetecting] = useState(false);
  const [mainnetAck, setMainnetAckState] = useState(false);
  const [testWallet, setTestWalletState] = useState<AppSigner | null>(null);
  const [testWalletError, setTestWalletError] = useState("");
  const [explorer, setExplorer] = useState<Record<Cluster, string>>(() => loadSetting("explorer", DEFAULT_EXPLORER));
  const [view, setView] = useState<View>({ name: "funds" });
  const [sends, setSends] = useState<SendRecord[]>([]);
  const [sendTick, setSendTick] = useState(0);
  const sendPending = sends.some((r) => r.status === "pending");
  const pendingRef = useRef(false);
  pendingRef.current = sendPending;
  const testWalletRef = useRef<AppSigner | null>(null);
  testWalletRef.current = testWallet;

  const [unresolved, setUnresolved] = useState<Unresolved[]>([]);
  const attemptedRef = useRef(new Set<number>());
  // Never replaced or cleared for the life of the page.
  const [inscriptions] = useState(() => new InscriptionRegistry(localMarkerStore));
  const [inscriptionsTick, setInscriptionsTick] = useState(0);
  useEffect(() => inscriptions.subscribe(() => setInscriptionsTick((t) => t + 1)), [inscriptions]);

  // The signer is bound to one adapter object; it signs through that adapter only.
  const adapter = wallet.wallet?.adapter ?? null;
  const walletAppSigner = useMemo<AppSigner | null>(() => {
    if (!adapter || !wallet.publicKey || !("signTransaction" in adapter)) return null;
    const signerAdapter = adapter as typeof adapter & { signTransaction: <T>(tx: T) => Promise<T> };
    return walletSigner(adapter.name, wallet.publicKey, (tx) => signerAdapter.signTransaction(tx));
  }, [wallet.publicKey, adapter]);
  const signer = testWallet ?? walletAppSigner;

  // Signer epoch: bumped synchronously from the adapter's own events (not on
  // render), from adapter changes, and from the test wallet. A send captures
  // it and stops if it moves, even if the same public key comes back.
  const epochRef = useRef(0);
  const [, setEpochTick] = useState(0);
  const bumpSigner = useCallback(() => {
    epochRef.current += 1;
    liveRef.current = { ...liveRef.current, signerEpoch: epochRef.current };
    setEpochTick(epochRef.current);
  }, []);

  // The live session. Updated on every render AND synchronously by every
  // setter below, so a guard that runs between a state change and the next
  // render already sees the change.
  const liveRef = useRef<SessionKey>({
    generation: 0,
    rpcUrl: "",
    cluster: "unknown",
    signerId: null,
    signer: null,
    signerEpoch: 0,
    mainnetAck: false,
  });
  liveRef.current = {
    generation: net?.generation ?? liveRef.current.generation,
    rpcUrl: net?.rpcUrl ?? "",
    cluster: net?.cluster ?? "unknown",
    signerId: signerId(signer),
    signer,
    signerEpoch: epochRef.current,
    mainnetAck,
  };

  // Direct listeners on the active adapter. Attaching or detaching (adapter
  // or wallet change) also bumps the epoch.
  useEffect(() => {
    if (!adapter) return;
    bumpSigner();
    const onEvent = () => bumpSigner();
    adapter.on("connect", onEvent);
    adapter.on("disconnect", onEvent);
    adapter.on("readyStateChange", onEvent);
    return () => {
      adapter.off("connect", onEvent);
      adapter.off("disconnect", onEvent);
      adapter.off("readyStateChange", onEvent);
      bumpSigner();
    };
  }, [adapter, bumpSigner]);
  const live = useCallback(() => liveRef.current, []);

  const setMainnetAck = (v: boolean) => {
    liveRef.current = { ...liveRef.current, mainnetAck: v };
    setMainnetAckState(v);
  };
  const setTestWallet = (w: AppSigner | null) => {
    const next = w ?? walletAppSigner;
    liveRef.current = { ...liveRef.current, signerId: signerId(next), signer: next };
    bumpSigner();
    setTestWalletState(w);
  };

  // Every Connect starts a new network generation. Only the latest may set
  // the network: a slower, older detection never overwrites a newer choice.
  const generation = useRef(0);
  const connect = useCallback(async (settings: RpcSettings) => {
    if (pendingRef.current) return;
    const gen = ++generation.current;
    // Invalidate the session now: drop the network, the mainnet tick and the test wallet.
    liveRef.current = { ...liveRef.current, generation: gen, rpcUrl: "", cluster: "unknown", mainnetAck: false };
    setNet(null);
    setMainnetAckState(false);
    if (testWalletRef.current) {
      // Dropping the test wallet is a signer change.
      testWalletRef.current = null;
      epochRef.current += 1;
      liveRef.current = { ...liveRef.current, signer: null, signerId: null, signerEpoch: epochRef.current };
    }
    setTestWalletState(null);
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
      const detected = await detectNetwork(url, gen);
      if (gen === generation.current) setNet(detected);
    } catch (err) {
      if (gen === generation.current) setNetError(`could not read the genesis hash from ${url}: ${errMsg(err)}`);
    } finally {
      if (gen === generation.current) setDetecting(false);
    }
  }, []);

  useEffect(() => {
    void connect(rpc);
    // Detect once on load with the saved settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the page while a send is pending would lose its receipt.
  useEffect(() => {
    if (!sendPending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [sendPending]);

  const updateRpc = (patch: Partial<RpcSettings>) => {
    if (pendingRef.current) return;
    const next = { ...rpc, ...patch };
    setRpc(next);
    saveSetting("rpc", next);
    if (patch.choice !== undefined) void connect(next);
  };

  const go = useCallback((v: View) => {
    if (pendingRef.current) return;
    setView(v);
  }, []);

  const startTestWallet = () => {
    if (pendingRef.current) return;
    setTestWalletError("");
    try {
      setTestWallet(createLocalTestWallet(liveRef.current.cluster, () => liveRef.current.cluster));
    } catch (err) {
      setTestWalletError(errMsg(err));
    }
  };

  const update = (id: number, patch: Partial<SendRecord>) =>
    setSends((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const startSend = (review: Review) => {
    if (pendingRef.current || !net || !signer || attemptedRef.current.has(review.id)) return;
    // A resume planned before more attempts of its upload were sent is stale.
    if (staleResumeReason(inscriptions, review, net.genesisHash)) return;
    pendingRef.current = true;
    // Consumed for good: dismissing the receipt does not make it sendable again.
    attemptedRef.current.add(review.id);
    const id = ++sendCounter;
    const record: SendRecord = {
      id,
      reviewId: review.id,
      title: review.title,
      cluster: review.cluster,
      rpcUrl: review.rpcUrl,
      status: "pending",
      lines: [],
      outcomes: [],
      created: review.created,
      total: review.sims.length,
    };
    setSends((rs) => [record, ...rs]);
    const lines: string[] = [];
    const run = (onSubmit?: Parameters<typeof signAndSend>[0]["onSubmit"]) =>
      signAndSend({
        net,
        review,
        signer,
        mainnetAck,
        getLive: live,
        log: (line) => {
          lines.push(line.trim());
          update(id, { lines: [...lines] });
        },
        onSubmit,
      });
    // An inscription send records every broadcast in the registry, whatever happens to the page.
    const uploadKey = reviewUploadKey(review, net.genesisHash);
    const sending =
      uploadKey && review.inscribe
        ? trackInscriptionSend(inscriptions, { key: uploadKey, content: review.inscribe.content, uri: review.inscribe.uri }, run)
        : run();
    sending.then(
      (outcomes) => update(id, { status: "done", outcomes }),
      (err: unknown) => {
        if (err instanceof PlanSendError) {
          update(id, { status: "failed", outcomes: err.done, error: err.message, failedSig: err.signature, failState: err.state, failedIndex: err.failedIndex, failedLastValid: err.lastValidBlockHeight });
          if (err.state === "unknown" && err.signature) {
            const signature = err.signature;
            setUnresolved((u) => [...u, { rpcUrl: review.rpcUrl, title: review.title, fund: review.plan.fund?.toBase58(), signature }]);
          }
        } else {
          update(id, { status: "failed", error: `${errMsg(err)}. Nothing was sent.` });
        }
      },
    ).finally(() => {
      pendingRef.current = false;
      setSendTick((t) => t + 1);
    });
  };

  const state: AppState = {
    net,
    signer,
    mainnetAck,
    explorer,
    go,
    sendPending,
    startSend,
    sends,
    sendTick,
    live,
    attempted: attemptedRef.current,
    unresolved,
    switchNetwork: (choice) => updateRpc({ choice }),
    inscriptions,
    inscriptionsTick,
  };
  const cluster = net?.cluster;
  const lock = sendPending ? "A send is in progress; wait for it to finish." : undefined;

  return (
    <div className="app">
      <header className="top">
        <h1>Fund NFT owner</h1>
        <nav>
          <button disabled={sendPending} title={lock} className={view.name === "funds" || view.name === "fund" ? "tab on" : "tab"} onClick={() => go({ name: "funds" })}>
            My funds
          </button>
          <button disabled={sendPending} title={lock} className={view.name === "create" ? "tab on" : "tab"} onClick={() => go({ name: "create" })}>
            Create fund
          </button>
          <button disabled={sendPending} title={lock} className={view.name === "settings" ? "tab on" : "tab"} onClick={() => go({ name: "settings" })}>
            Settings
          </button>
        </nav>
      </header>

      <section className="panel network">
        <div className="row wrap">
          <label>
            Network{" "}
            <select aria-label="Network" disabled={sendPending} value={rpc.choice} onChange={(e) => updateRpc({ choice: e.target.value as RpcSettings["choice"] })}>
              <option value="mainnet">X1 mainnet</option>
              <option value="testnet">X1 testnet</option>
              <option value="local">Local validator</option>
              <option value="custom">Custom URL</option>
            </select>
          </label>
          {rpc.choice === "local" && (
            <label>
              Port{" "}
              <input aria-label="Local port" disabled={sendPending} className="port" inputMode="numeric" value={rpc.localPort} onChange={(e) => updateRpc({ localPort: e.target.value.trim() })} />
            </label>
          )}
          {rpc.choice === "custom" && (
            <label className="grow">
              URL{" "}
              <input aria-label="Custom RPC URL" disabled={sendPending} value={rpc.customUrl} placeholder="https://..." onChange={(e) => updateRpc({ customUrl: e.target.value })} />
            </label>
          )}
          <button onClick={() => void connect(rpc)} disabled={detecting || sendPending} title={lock}>
            {detecting ? "Detecting..." : "Connect"}
          </button>
        </div>
        {lock && <p className="warn small" data-testid="send-lock">{lock} Network changes and navigation are blocked.</p>}
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
            <input type="checkbox" checked={mainnetAck} disabled={sendPending} onChange={(e) => setMainnetAck(e.target.checked)} /> I understand
            this is X1 mainnet and uses real funds
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
            <button onClick={startTestWallet} disabled={sendPending} data-testid="use-test-wallet">
              Use local test wallet
            </button>
          )}
          {testWallet && (
            <button onClick={() => !pendingRef.current && setTestWallet(null)} disabled={sendPending} data-testid="drop-test-wallet">
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
        {sendPending && (
          <p className="small muted">
            If the wallet disconnects or switches account now, the remaining transactions are not sent.
          </p>
        )}
      </section>

      <SendLog
        sends={sends}
        explorer={explorer}
        onDismiss={(id) => setSends((rs) => rs.filter((r) => r.id !== id || r.status === "pending"))}
        onOpenFund={(fund) => go({ name: "fund", fund })}
        locked={sendPending}
      />

      <main>
        {(view.name === "funds" || view.name === "create") && <HowItWorks />}
        {!net && !netError && <p className="muted">Connecting...</p>}
        {view.name === "funds" && <MyFunds key={`${net?.generation ?? 0}|${signerId(signer)}`} s={state} />}
        {view.name === "fund" && <FundDetail key={`${view.fund}|${net?.generation ?? 0}`} s={state} fund={view.fund} />}
        {view.name === "create" && <CreateWizard s={state} />}
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
