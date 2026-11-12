/**
 * A review is single-use: after its send, dismissing the receipt must not
 * bring Sign & send back. Server-rendered ReviewPanel, no browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { AppState, Unresolved } from "../src/App.js";
import { ReviewPanel } from "../src/components/ReviewPanel.js";
import type { Review } from "../src/lib/actions.js";
import type { SendRecord } from "../src/components/SendLog.js";
import { createLocalTestWallet } from "../src/lib/signer.js";
import { signerId } from "../src/lib/session.js";

const LOCAL = "http://127.0.0.1:8899";
const signer = createLocalTestWallet("localnet", () => "localnet");
const fund = Keypair.generate().publicKey;

const review: Review = {
  id: 42,
  title: "Deposit",
  generation: 1,
  signerEpoch: 3,
  rpcUrl: LOCAL,
  cluster: "localnet",
  payer: signer.publicKey,
  plan: { txs: [], fund },
  rows: [],
  sentences: [],
  warnings: [],
  sims: [{ label: "deposit", size: 300, signers: [signer.publicKey], logs: [], err: null, unitsConsumed: 1 }],
  accounts: [],
  simOk: true,
  nothingToDo: false,
};

function state(opts: { attempted?: number[]; sends?: SendRecord[]; unresolved?: Unresolved[] }): AppState {
  const live = {
    generation: 1,
    rpcUrl: LOCAL,
    cluster: "localnet" as const,
    signerId: signerId(signer),
    signer,
    signerEpoch: 3,
    mainnetAck: false,
  };
  return {
    net: { generation: 1, rpcUrl: LOCAL, cluster: "localnet", genesisHash: "g", loopback: true, connection: {} as never },
    signer,
    mainnetAck: false,
    explorer: { mainnet: "", testnet: "", localnet: "" },
    go: () => {},
    sendPending: false,
    startSend: () => {},
    sends: opts.sends ?? [],
    sendTick: 0,
    live: () => live,
    attempted: new Set(opts.attempted ?? []),
    unresolved: opts.unresolved ?? [],
    switchNetwork: () => {},
  };
}

const render = (s: AppState) => renderToString(<ReviewPanel s={s} review={review} onClose={() => {}} />);

test("a fresh review offers an enabled Sign & send", () => {
  const html = render(state({}));
  assert.match(html, /data-testid="sign-and-send"/);
  assert.doesNotMatch(html, /data-testid="sign-and-send"[^>]*disabled/);
});

test("after its send, with the receipt dismissed, the review has NO send button", () => {
  // The receipt (send record) is gone, but the review id stays attempted.
  const html = render(state({ attempted: [42], sends: [] }));
  assert.doesNotMatch(html, /sign-and-send/);
  assert.match(html, /data-testid="review-used"/);
  assert.match(html, /already used for a send/);
});

test("a create with metadata reads as sentences and says tx 2 is not pre-simulated", () => {
  const sim = review.sims[0]!;
  const three: Review = {
    ...review,
    id: 43,
    title: "Create fund",
    sentences: ["Every 1 hour this fund spends 0.08 USDC.X on TEST."],
    rows: [["Fund PDA", fund.toBase58()]],
    sims: [sim, { ...sim, label: "attach_metadata", skipped: true }, { ...sim, label: "target vaults" }],
  };
  const html = renderToString(<ReviewPanel s={state({})} review={three} onClose={() => {}} />);
  assert.match(html, /data-testid="review-sentences"/);
  assert.match(html, /Every 1 hour this fund spends 0.08 USDC.X on TEST./);
  assert.match(html, /Technical details \(<!-- -->1<!-- -->\)/);
  assert.match(html, /not simulated yet/);
  assert.match(html, /data-testid="sim-skipped"/);
  assert.match(html, /cannot be simulated in advance/);
  assert.match(html, /Sign &amp; send<!-- --> \(3 transactions, in order\)/);
});

test("the NFT image step renders its options without contacting any host", async () => {
  const { ArtStep } = await import("../src/components/ArtStep.js");
  const html = renderToString(
    <ArtStep s={state({})} ctx={{ fund, quote: null, targets: [] }} allowNone onChange={() => {}} />,
  );
  for (const text of ["Inscribe on X1", "Host it myself", "Paste a metadata link", "No metadata now", "Compact (fits one inscription transaction)", "An X1"]) {
    assert.ok(html.includes(text), text);
  }
  // No img/video element (and so no request) before an explicit Check.
  assert.doesNotMatch(html, /<img|<video/);
});

test("an unknown-status attempt of the same action and fund is shown on a new review", () => {
  const unresolved: Unresolved[] = [{ rpcUrl: LOCAL, title: "Deposit", fund: fund.toBase58(), signature: "SIGUNKNOWN" }];
  const html = render(state({ unresolved }));
  assert.match(html, /data-testid="unresolved-note"/);
  assert.match(html, /SIGUNKNOWN/);
  // Another fund: not shown.
  const other = [{ ...unresolved[0]!, fund: new PublicKey(Keypair.generate().publicKey).toBase58() }];
  assert.doesNotMatch(render(state({ unresolved: other })), /unresolved-note/);
});
