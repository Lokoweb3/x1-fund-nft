/**
 * The app-level inscription-attempt registry (lib/inscriptions.ts): every
 * broadcast is recorded from sendPlan's onSubmit, so Resume sees the whole
 * history even when the page's review was cleared mid-send; and Resume is
 * off when that history is missing. Mock RPCs and server rendering only.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { PlanSendError, type Plan } from "@core/owner.js";
import type { AppState } from "../src/App.js";
import { ArtStep } from "../src/components/ArtStep.js";
import { reviewInscribeResume, signAndSend, type Review } from "../src/lib/actions.js";
import {
  InscriptionRegistry,
  memoryMarkerStore,
  resumeOptions,
  reviewUploadKey,
  staleResumeReason,
  trackInscriptionSend,
  uploadKey,
  type ResumeContext,
} from "../src/lib/inscriptions.js";
import type { NetworkInfo } from "../src/lib/network.js";
import { signerId, type SessionKey } from "../src/lib/session.js";
import { sha256Hex } from "../src/lib/sha256.js";
import { createLocalTestWallet, type AppSigner } from "../src/lib/signer.js";

const LOCAL = "http://127.0.0.1:8899";
const GENESIS = "localgenesis";
const NUMBER = 70n;
const content = new TextEncoder().encode(JSON.stringify({ name: "Fund", pad: "x".repeat(900) }));
const uri = `https://${NUMBER}.x1ins.xyz/content/${NUMBER}`;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Mock local RPC. Each confirm takes the next behaviour from `confirms`. */
function mockNet(confirms: Array<() => Promise<{ context: { slot: number }; value: { err: unknown } }>>): NetworkInfo & { sent: number } {
  let height = 100;
  const net = {
    generation: 1,
    rpcUrl: LOCAL,
    genesisHash: GENESIS,
    cluster: "localnet" as const,
    loopback: true,
    sent: 0,
    connection: {
      getGenesisHash: async () => GENESIS,
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: (height += 10) }),
      sendRawTransaction: async () => {
        net.sent += 1;
        return "sig";
      },
      confirmTransaction: async () => {
        const next = confirms.shift();
        if (!next) throw new Error("no confirm behaviour left");
        return next();
      },
    } as unknown as Connection,
  };
  return net;
}

function planOf(payer: PublicKey, n: number): Plan {
  const ix = () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  return { txs: Array.from({ length: n }, (_, i) => ({ label: `chunk ${i + 1}`, instructions: [ix()], extraSigners: [], ...(i > 0 ? { dependsOnPrevious: true } : {}) })) };
}

let reviewIds = 100;
function insReview(net: NetworkInfo, payer: PublicKey, txs: number, historyLen?: number): Review {
  return {
    id: ++reviewIds,
    title: historyLen === undefined ? "Inscribe metadata" : "Resume inscription",
    generation: net.generation,
    rpcUrl: net.rpcUrl,
    cluster: net.cluster,
    payer,
    plan: planOf(payer, txs),
    rows: [],
    sentences: [],
    warnings: [],
    sims: [],
    accounts: [],
    simOk: true,
    nothingToDo: false,
    signerEpoch: 7,
    inscribe: { number: NUMBER, uri, content, contentType: "application/json", ...(historyLen === undefined ? {} : { historyLen }) },
  };
}

const liveOf = (net: NetworkInfo, signer: AppSigner, epoch = 7): SessionKey => ({
  generation: net.generation,
  rpcUrl: net.rpcUrl,
  cluster: net.cluster,
  signerId: signerId(signer),
  signer,
  signerEpoch: epoch,
  mainnetAck: false,
});

/** The App's startSend, reduced to its registry wiring (App.tsx does exactly this). */
function startSend(registry: InscriptionRegistry, net: NetworkInfo, review: Review, signer: AppSigner, getLive: () => SessionKey) {
  const key = reviewUploadKey(review, net.genesisHash)!;
  return trackInscriptionSend(registry, { key, content: review.inscribe!.content, uri: review.inscribe!.uri }, (onSubmit) =>
    signAndSend({ net, review, signer, mainnetAck: false, getLive, onSubmit }),
  );
}

function appState(net: NetworkInfo, signer: AppSigner | null, registry: InscriptionRegistry): AppState {
  const live = signer ? liveOf(net, signer) : { ...liveOf(net, createLocalTestWallet("localnet", () => "localnet")), signer: null, signerId: null };
  return {
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
    attempted: new Set(),
    unresolved: [],
    switchNetwork: () => {},
    inscriptions: registry,
    inscriptionsTick: 0,
  };
}

const renderArt = (s: AppState) => renderToString(<ArtStep s={s} ctx={{ fund: null, quote: null, targets: [] }} allowNone onChange={() => {}} />);
const ctxOf = (signer: AppSigner | null, rpcUrl = LOCAL, genesisHash = GENESIS): ResumeContext => ({ rpcUrl, genesisHash, payer: signer?.publicKey.toBase58() ?? null });

test("sha256Hex matches node:crypto", () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000, 16 * 1024]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 0xff);
    assert.equal(sha256Hex(bytes), createHash("sha256").update(bytes).digest("hex"), `length ${n}`);
  }
});

test("upload identity: rpc + genesis + payer + number + content hash", () => {
  const payer = Keypair.generate().publicKey.toBase58();
  const base = uploadKey({ rpcUrl: LOCAL, genesisHash: GENESIS, payer, number: NUMBER, content });
  assert.equal(base.contentHash, sha256Hex(content));
  const registry = new InscriptionRegistry();
  registry.submit(base, { index: 0, label: "x", signature: "S", lastValidBlockHeight: 5 });
  assert.ok(registry.get(base));
  for (const other of [
    { ...base, rpcUrl: "http://127.0.0.1:9999" },
    { ...base, genesisHash: "other" },
    { ...base, payer: Keypair.generate().publicKey.toBase58() },
    { ...base, number: "71" },
    { ...base, contentHash: sha256Hex(new Uint8Array([1])) },
  ]) {
    assert.equal(registry.get(other), undefined);
  }
});

test("review B2: resume B in flight, wallet switched, B returns unknown, reconnect: Resume includes B", async () => {
  const registry = new InscriptionRegistry(memoryMarkerStore());
  const a = createLocalTestWallet("localnet", () => "localnet");
  const other = createLocalTestWallet("localnet", () => "localnet");
  const holdB = deferred<{ context: { slot: number }; value: { err: unknown } }>();
  const net = mockNet([
    async () => ({ context: { slot: 10 }, value: { err: null } }), // inscribe tx 1 confirms
    async () => {
      throw new Error("confirmation timed out"); // tx 2: unknown
    },
    () => holdB.promise, // resume B: still waiting when the wallet switches
  ]);
  let live = liveOf(net, a);

  // The first upload: tx 1 confirmed, tx 2 unknown.
  await assert.rejects(startSend(registry, net, insReview(net, a.publicKey, 2), a, () => live), (e: unknown) => e instanceof PlanSendError && e.state === "unknown");
  let options = resumeOptions(registry, ctxOf(a));
  assert.equal(options.ready.length, 1);
  assert.equal(options.ready[0]!.attempts.length, 2);
  // B1: the confirmed tx carries its real expiry and slot, never 0.
  assert.deepEqual(
    options.ready[0]!.attempts.map((x) => [x.lastValidBlockHeight > 0, x.confirmedSlot]),
    [
      [true, 10],
      [true, undefined],
    ],
  );
  const firstTwo = options.ready[0]!.attempts.map((x) => x.signature);

  // Resume B (one transaction), planned from those two attempts.
  const resumeB = insReview(net, a.publicKey, 1, 2);
  assert.equal(staleResumeReason(registry, resumeB, GENESIS), undefined);
  const sendingB = startSend(registry, net, resumeB, a, () => live);
  await tick();
  assert.equal(net.sent, 3, "B was broadcast");
  // While B is in flight there is nothing to resume.
  assert.equal(resumeOptions(registry, ctxOf(a)).ready.length, 0);

  // The owner switches wallet mid-flight. The page's review state is gone;
  // the registry is not.
  live = liveOf(net, other, 8);
  holdB.reject(new Error("block height exceeded? no: the response was lost"));
  await assert.rejects(sendingB, (e: unknown) => e instanceof PlanSendError && e.state === "unknown");

  // Under the other wallet: Resume is off, and says why.
  options = resumeOptions(registry, ctxOf(other));
  assert.equal(options.ready.length, 0);
  assert.match(options.blocked[0]!.reason, /different wallet/);
  const htmlOther = renderArt(appState(net, other, registry));
  assert.match(htmlOther, /data-testid="resume-blocked"/);
  assert.match(htmlOther, /<button disabled="" data-testid="inscribe-resume-disabled">/);
  assert.doesNotMatch(htmlOther, /data-testid="inscribe-resume"/);

  // Reconnect wallet A: Resume is back and includes B.
  options = resumeOptions(registry, ctxOf(a));
  assert.equal(options.ready.length, 1);
  const sigs = options.ready[0]!.attempts.map((x) => x.signature);
  assert.equal(sigs.length, 3);
  assert.deepEqual(sigs.slice(0, 2), firstTwo);
  assert.ok(options.ready[0]!.attempts[2]!.lastValidBlockHeight > 0);
  const htmlA = renderArt(appState(net, a, registry));
  assert.match(htmlA, /<button data-testid="inscribe-resume">Resume #<!-- -->70<\/button>/);
  assert.doesNotMatch(htmlA, /resume-blocked/);
  assert.match(htmlA, /every one of its <!-- -->3<!-- --> earlier transaction<!-- -->s<!-- --> has confirmed/);

  // The resume review planned before B (historyLen 2) can no longer send.
  assert.match(staleResumeReason(registry, insReview(net, a.publicKey, 1, 2), GENESIS)!, /planned/);
  assert.equal(staleResumeReason(registry, insReview(net, a.publicKey, 1, 3), GENESIS), undefined);
});

test("review B1: a confirmed attempt plus a lagging RPC's null status blocks resume", async () => {
  const registry = new InscriptionRegistry();
  const a = createLocalTestWallet("localnet", () => "localnet");
  const net = mockNet([
    async () => ({ context: { slot: 10 }, value: { err: null } }),
    async () => {
      throw new Error("confirmation timed out");
    },
  ]);
  await assert.rejects(startSend(registry, net, insReview(net, a.publicKey, 2), a, () => liveOf(net, a)));
  const [ready] = resumeOptions(registry, ctxOf(a)).ready;
  assert.ok(ready);
  let accountReads = 0;
  // A lagging backend: knows neither signature yet, and its bank (block 50) is
  // before both expiries. The old fabricated expiry of 0 made tx 1 look expired.
  const lagging = {
    ...net,
    connection: {
      getEpochInfo: async () => ({ absoluteSlot: 5, blockHeight: 50 }),
      getSignatureStatuses: async (sigs: string[]) => ({ value: sigs.map(() => null) }),
      getAccountInfoAndContext: async () => {
        accountReads += 1;
        return { context: { slot: 5 }, value: null };
      },
    } as unknown as Connection,
  };
  await assert.rejects(reviewInscribeResume(lagging, a.publicKey, ready.number, ready.upload.content, ready.attempts), /not resuming yet/);
  assert.equal(accountReads, 0, "the account was never read");
});

test("after a page reload, or under another RPC or network, Resume is off and says what to do", async () => {
  const store = memoryMarkerStore();
  const before = new InscriptionRegistry(store, "page-1");
  const a = createLocalTestWallet("localnet", () => "localnet");
  const net = mockNet([
    async () => ({ context: { slot: 10 }, value: { err: null } }),
    async () => {
      throw new Error("confirmation timed out");
    },
  ]);
  await assert.rejects(startSend(before, net, insReview(net, a.publicKey, 2), a, () => liveOf(net, a)));
  assert.equal(resumeOptions(before, ctxOf(a)).ready.length, 1);
  assert.equal(store.load().length, 1, "a marker survives the page");

  // Another RPC, or another network: blocked.
  assert.match(resumeOptions(before, ctxOf(a, "http://127.0.0.1:9999")).blocked[0]!.reason, /different RPC/);
  assert.match(resumeOptions(before, ctxOf(a, LOCAL, "othergenesis")).blocked[0]!.reason, /different network/);

  // The page reloads: a new registry, only the marker is left.
  const after = new InscriptionRegistry(store, "page-2");
  const options = resumeOptions(after, ctxOf(a));
  assert.equal(options.ready.length, 0);
  assert.equal(options.blocked.length, 1);
  assert.match(options.blocked[0]!.reason, /before the page was reloaded/);
  const html = renderArt(appState(net, a, after));
  assert.match(html, /Resume is off for #<!-- -->70/);
  assert.match(html, /wait until every earlier transaction of this upload has confirmed or expired/);
  assert.match(html, /prepareInscribeResume/);
  assert.match(html, /start a fresh inscription/);
  assert.doesNotMatch(html, /data-testid="inscribe-resume"/);
  // Even a new upload of the same number from this page cannot resume while the old note says history is missing.
  after.begin(uploadKey({ rpcUrl: LOCAL, genesisHash: GENESIS, payer: a.publicKey.toBase58(), number: NUMBER, content }), content, uri);
  after.submit(uploadKey({ rpcUrl: LOCAL, genesisHash: GENESIS, payer: a.publicKey.toBase58(), number: NUMBER, content }), { index: 0, label: "x", signature: "NEW", lastValidBlockHeight: 9 });
  after.settle(uploadKey({ rpcUrl: LOCAL, genesisHash: GENESIS, payer: a.publicKey.toBase58(), number: NUMBER, content }), { outcomes: [], failed: { signature: "NEW", state: "unknown" } });
  const both = resumeOptions(after, ctxOf(a));
  assert.equal(both.ready.length, 0);
  assert.match(both.blocked[0]!.reason, /earlier page load/);
  // Hiding the note removes the note, never the block: the lost history does not come back.
  after.forgetForeign(options.blocked[0]!.marker!);
  const hidden = resumeOptions(after, ctxOf(a));
  assert.equal(hidden.ready.length, 0);
  assert.equal(hidden.blocked.length, 1);
  assert.match(hidden.blocked[0]!.reason, /earlier page load/);
  assert.equal(hidden.blocked[0]!.marker, undefined);
});
