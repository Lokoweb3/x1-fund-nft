/**
 * Mounts the real FundDetail with a test signer that holds the fund NFT.
 * The browser test bundles this with mock-rpc.ts and mock-actions.ts in
 * place of @core/rpc.js and src/lib/actions (for FundDetail and NftCard
 * only); every other RPC call hits a connection that always rejects.
 */
import "../../src/polyfills";
import { createRoot } from "react-dom/client";
import { Keypair } from "@solana/web3.js";
import type { AppState } from "../../src/App";
import { FundDetail } from "../../src/components/FundDetail";
import type { AppSigner } from "../../src/lib/signer";
import { signerId } from "../../src/lib/session";

const holder = Keypair.generate().publicKey;
(window as unknown as { __harness: unknown }).__harness = { holder };

// Any method call rejects; `then` stays undefined so the object is not thenable.
const connection = new Proxy(
  {},
  { get: (_t, p) => (p === "then" ? undefined : () => Promise.reject(new Error("offline harness"))) },
);
const rpcUrl = "http://127.0.0.1:1";
const signer = { kind: "local-test", label: "harness", publicKey: holder, sign: async () => [] } as unknown as AppSigner;
const s: AppState = {
  net: { generation: 1, rpcUrl, connection: connection as never, genesisHash: "harness", cluster: "localnet", loopback: true },
  signer,
  mainnetAck: false,
  explorer: {} as never,
  go: () => {},
  sendPending: false,
  startSend: () => {},
  sends: [],
  sendTick: 0,
  live: () => ({ generation: 1, rpcUrl, cluster: "localnet", signerId: signerId(signer), signerEpoch: 0 }) as never,
  attempted: new Set(),
  unresolved: [],
  switchNetwork: () => {},
};

createRoot(document.getElementById("root")!).render(<FundDetail s={s} fund={Keypair.generate().publicKey.toBase58()} />);
