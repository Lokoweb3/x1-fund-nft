/**
 * The canary app inscribes only single-transaction content (<= 600 bytes):
 * a larger JSON is refused when the review is planned and again at send.
 * Mock RPCs and server rendering only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Connection, Keypair } from "@solana/web3.js";
import { FIRST_CHUNK_MAX, planInscribe, type InscriptionConfig } from "@core/inscribe.js";
import type { AppState } from "../src/App.js";
import { ReviewPanel } from "../src/components/ReviewPanel.js";
import { assertSingleTxInscription, INSCRIBE_MAX_BYTES, inscribeTooLarge, reviewInscribe, signAndSend, type Review } from "../src/lib/actions.js";
import type { NetworkInfo } from "../src/lib/network.js";
import { signerId, type SessionKey } from "../src/lib/session.js";
import { createLocalTestWallet } from "../src/lib/signer.js";

const LOCAL = "http://127.0.0.1:8899";
const signer = createLocalTestWallet("localnet", () => "localnet");
const config: InscriptionConfig = {
  admin: Keypair.generate().publicKey,
  treasury: Keypair.generate().publicKey,
  fees: { inscribe: 500_000_000n, claim: 0n, deploy: 0n, premium: [0n, 0n, 0n], mint: 0n, marketBps: 0 },
  nextInscription: 70n,
  paused: false,
  bump: 255,
  unknownTail: new Uint8Array(),
};
/** Valid JSON of exactly `n` bytes. */
const json = (n: number) => new TextEncoder().encode(`{"p":"${"x".repeat(n - 8)}"}`);
const plan = (content: Uint8Array) => planInscribe({ payer: signer.publicKey, content, contentType: "application/json", maxFee: config.fees.inscribe, config });

function mockNet(): NetworkInfo & { sent: number; calls: number } {
  const net = {
    generation: 1,
    rpcUrl: LOCAL,
    genesisHash: "localgenesis",
    cluster: "localnet" as const,
    loopback: true,
    sent: 0,
    calls: 0,
    connection: {
      getGenesisHash: async () => "localgenesis",
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 10 }),
      sendRawTransaction: async () => {
        net.sent += 1;
        return "sig";
      },
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: null } }),
    } as unknown as Connection,
  };
  return net;
}

function review(net: NetworkInfo, content: Uint8Array): Review {
  const p = plan(content);
  return {
    id: content.length,
    title: "Inscribe metadata",
    generation: 1,
    signerEpoch: 3,
    rpcUrl: LOCAL,
    cluster: "localnet",
    payer: signer.publicKey,
    plan: p,
    rows: [],
    sentences: [],
    warnings: [],
    sims: p.txs.map((t) => ({ label: t.label, size: 1, signers: [signer.publicKey], logs: [], err: null, unitsConsumed: 1 })),
    accounts: [],
    simOk: true,
    nothingToDo: false,
    inscribe: { number: p.number, uri: p.uri, content, contentType: "application/json" },
  };
}

const live: SessionKey = { generation: 1, rpcUrl: LOCAL, cluster: "localnet", signerId: signerId(signer), signer, signerEpoch: 3, mainnetAck: false };

test("600 bytes plans as exactly one transaction (inscribe only, no append, no thaw); 601 does not", () => {
  assert.equal(INSCRIBE_MAX_BYTES, FIRST_CHUNK_MAX);
  assert.equal(INSCRIBE_MAX_BYTES, 600);
  const one = plan(json(600));
  assert.equal(one.txs.length, 1);
  assert.match(one.txs[0]!.label, /^inscribe #70 \(600 of 600 bytes\)$/);
  assert.doesNotThrow(() => assertSingleTxInscription(one, json(600)));
  assert.equal(inscribeTooLarge(600), undefined);
  const two = plan(json(601));
  assert.equal(two.txs.length, 2);
  assert.throws(() => assertSingleTxInscription(two, json(601)), /Too large to inscribe in one transaction \(601 bytes, max 600\)/);
  assert.equal(
    inscribeTooLarge(1234),
    "Too large to inscribe in one transaction (1234 bytes, max 600). Turn on Compact, shorten the description, or use Upload/Paste link.",
  );
  // Even small content is refused if the plan somehow has more than one transaction.
  assert.throws(() => assertSingleTxInscription({ txs: [...one.txs, ...one.txs] }, json(600)), /only sends single-transaction inscriptions/);
});

test("planning refuses content over 600 bytes before any RPC call", async () => {
  const touched: string[] = [];
  const net = {
    ...mockNet(),
    connection: new Proxy({}, { get: (_t, k) => (touched.push(String(k)), () => Promise.reject(new Error("no RPC expected"))) }) as unknown as Connection,
  };
  await assert.rejects(reviewInscribe(net, signer.publicKey, json(601), 500_000_000n), /Too large to inscribe in one transaction \(601 bytes, max 600\)/);
  assert.deepEqual(touched, []);
});

test("sending refuses a multi-transaction inscription review; a one-transaction review sends", async () => {
  const net = mockNet();
  await assert.rejects(
    signAndSend({ net, review: review(net, json(601)), signer, mainnetAck: false, getLive: () => live }),
    /Too large to inscribe in one transaction/,
  );
  assert.equal(net.sent, 0);
  const done = await signAndSend({ net, review: review(net, json(600)), signer, mainnetAck: false, getLive: () => live });
  assert.equal(done.length, 1);
  assert.equal(net.sent, 1);
});

test("the review panel blocks Sign & send for a multi-transaction inscription", () => {
  const net = mockNet();
  const s = {
    net,
    signer,
    mainnetAck: false,
    explorer: { mainnet: "", testnet: "", localnet: "" },
    go: () => {},
    sendPending: false,
    startSend: () => {},
    sends: [],
    sendTick: 0,
    live: () => live,
    attempted: new Set<number>(),
    unresolved: [],
    switchNetwork: () => {},
  } as AppState;
  const big = renderToString(<ReviewPanel s={s} review={review(net, json(601))} onClose={() => {}} />);
  assert.match(big, /Too large to inscribe in one transaction/);
  assert.match(big, /<button class="primary" disabled=""[^>]*data-testid="sign-and-send"/);
  const small = renderToString(<ReviewPanel s={s} review={review(net, json(600))} onClose={() => {}} />);
  assert.doesNotMatch(small, /Too large/);
  assert.doesNotMatch(small, /<button class="primary" disabled=""/);
});
