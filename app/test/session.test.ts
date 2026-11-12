/**
 * A send must stop when the session it was authorized under is gone, and an
 * old reply must never overwrite newer data. Mock RPCs only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { X1_MAINNET_GENESIS_HASH } from "@core/cluster.js";
import { PlanSendError, type Plan } from "@core/owner.js";
import { signAndSend, type Review } from "../src/lib/actions.js";
import type { NetworkInfo } from "../src/lib/network.js";
import { sessionMismatch, signerId, type SessionKey } from "../src/lib/session.js";
import { createLocalTestWallet, walletSigner, type AppSigner } from "../src/lib/signer.js";

const LOCAL = "http://127.0.0.1:8899";
const MAINNET = "https://rpc.mainnet.x1.xyz";

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

/** Mock RPC that records broadcasts. Hooks let a test change the session mid-call. */
function mockNet(opts: {
  cluster: "localnet" | "mainnet";
  genesis?: () => Promise<string>;
  onConfirm?: (n: number) => void;
}): NetworkInfo & { sent: number } {
  let confirms = 0;
  const net = {
    generation: 1,
    rpcUrl: opts.cluster === "mainnet" ? MAINNET : LOCAL,
    genesisHash: opts.cluster === "mainnet" ? X1_MAINNET_GENESIS_HASH : "localgenesis",
    cluster: opts.cluster,
    loopback: opts.cluster === "localnet",
    sent: 0,
    connection: {
      getGenesisHash: opts.genesis ?? (async () => (opts.cluster === "mainnet" ? X1_MAINNET_GENESIS_HASH : "localgenesis")),
      getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
      sendRawTransaction: async () => {
        net.sent += 1;
        return "sig";
      },
      confirmTransaction: async () => {
        opts.onConfirm?.(confirms++);
        return { value: { err: null } };
      },
    } as unknown as Connection,
  };
  return net;
}

function twoTxPlan(payer: PublicKey): Plan {
  const ix = () => SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  return {
    txs: [
      { label: "first", instructions: [ix()], extraSigners: [] },
      { label: "second", instructions: [ix()], extraSigners: [] },
    ],
  };
}

function reviewFor(net: NetworkInfo, payer: PublicKey): Review {
  const plan = twoTxPlan(payer);
  return {
    id: 1,
    title: "test",
    generation: net.generation,
    rpcUrl: net.rpcUrl,
    cluster: net.cluster,
    payer,
    plan,
    sentences: [],
    rows: [],
    warnings: [],
    sims: [],
    accounts: [],
    simOk: true,
    nothingToDo: false,
    signerEpoch: 7,
  };
}

function liveOf(net: NetworkInfo, signer: AppSigner, mainnetAck = false): SessionKey {
  return {
    generation: net.generation,
    rpcUrl: net.rpcUrl,
    cluster: net.cluster,
    signerId: signerId(signer),
    signer,
    signerEpoch: 7,
    mainnetAck,
  };
}

test("delayed genesis, then a network change: nothing is signed or sent", async () => {
  const gate = deferred<string>();
  const net = mockNet({ cluster: "localnet", genesis: () => gate.promise });
  const signer = createLocalTestWallet("localnet", () => "localnet");
  let live = liveOf(net, signer);
  const sending = signAndSend({ net, review: reviewFor(net, signer.publicKey), signer, mainnetAck: false, getLive: () => live });
  await tick();
  live = { ...live, generation: 2, rpcUrl: MAINNET, cluster: "mainnet" }; // the user switched network
  gate.resolve("localgenesis");
  await assert.rejects(sending, /session changed: the network changed/);
  assert.equal(net.sent, 0);
});

test("delayed wallet return, then a context change: that tx and the rest are 'not sent'", async () => {
  const net = mockNet({ cluster: "localnet" });
  const inner = createLocalTestWallet("localnet", () => "localnet");
  let live: SessionKey;
  const slow: AppSigner = {
    ...inner,
    sign: async (tx) => {
      await tick();
      live = { ...live, signerId: null }; // wallet disconnected while its prompt was open
      return inner.sign(tx);
    },
  };
  live = liveOf(net, slow);
  await assert.rejects(
    signAndSend({ net, review: reviewFor(net, slow.publicKey), signer: slow, mainnetAck: false, getLive: () => live }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "not sent");
      assert.equal(err.failedIndex, 0);
      // Caught immediately after the wallet promise resolved, before the NFT key or any broadcast.
      assert.match(err.message, /could not be prepared .*session changed: the signer changed/);
      assert.match(err.message, /not sent: tx 1\/2 \(first\), tx 2\/2 \(second\)/);
      return true;
    },
  );
  assert.equal(net.sent, 0);
});

test("a two-transaction plan interrupted between transactions keeps tx 1 confirmed and stops tx 2", async () => {
  const signer = createLocalTestWallet("localnet", () => "localnet");
  let live: SessionKey;
  const net = mockNet({
    cluster: "localnet",
    onConfirm: (n) => {
      if (n === 0) live = { ...live, generation: live.generation + 1 }; // reconnect after tx 1
    },
  });
  live = liveOf(net, signer);
  await assert.rejects(
    signAndSend({ net, review: reviewFor(net, signer.publicKey), signer, mainnetAck: false, getLive: () => live }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.done.length, 1, "tx 1 is reported confirmed, never cancelled");
      assert.equal(err.failedIndex, 1);
      assert.equal(err.state, "not sent");
      assert.match(err.message, /confirmed before the failure:\n {2}tx 1\/2 \(first\)/);
      assert.match(err.message, /not sent: tx 2\/2 \(second\)/);
      return true;
    },
  );
  assert.equal(net.sent, 1);
});

test("mainnet: clearing the acknowledgement while the wallet is open stops the send", async () => {
  const net = mockNet({ cluster: "mainnet" });
  const kp = Keypair.generate();
  let live: SessionKey;
  const wallet = walletSigner("mock", kp.publicKey, async (tx) => {
    live = { ...live, mainnetAck: false };
    tx.sign([kp]);
    return tx;
  });
  live = liveOf(net, wallet, true);
  await assert.rejects(
    signAndSend({ net, review: reviewFor(net, kp.publicKey), signer: wallet, mainnetAck: true, getLive: () => live }),
    /mainnet acknowledgement was cleared/,
  );
  assert.equal(net.sent, 0);
});

test("a review built under an older network generation is refused before any call", async () => {
  const net = mockNet({ cluster: "localnet" });
  const signer = createLocalTestWallet("localnet", () => "localnet");
  const review = { ...reviewFor(net, signer.publicKey), generation: 0 };
  await assert.rejects(
    signAndSend({ net, review, signer, mainnetAck: false, getLive: () => liveOf(net, signer) }),
    /network changed since this review was built/,
  );
  assert.equal(net.sent, 0);
});

test("sessionMismatch names what changed", () => {
  const objA = createLocalTestWallet("localnet", () => "localnet");
  const base: SessionKey = { generation: 3, rpcUrl: LOCAL, cluster: "localnet", signerId: "wallet:A", signer: objA, signerEpoch: 1, mainnetAck: false };
  assert.equal(sessionMismatch(base, base), undefined);
  assert.match(sessionMismatch(base, { ...base, generation: 4 })!, /network changed/);
  assert.match(sessionMismatch(base, { ...base, rpcUrl: MAINNET })!, /network changed/);
  assert.match(sessionMismatch(base, { ...base, signerId: "wallet:B" })!, /signer changed/);
  // Same key, but the connection moved (disconnect + reconnect) or another signer object is active.
  assert.match(sessionMismatch(base, { ...base, signerEpoch: 2 })!, /wallet connection changed.*even if the same key is back/);
  const objB = { ...objA }; // same kind and public key, different object
  assert.match(sessionMismatch(base, { ...base, signer: objB })!, /different signer object/);
  const main = { ...base, cluster: "mainnet" as const, rpcUrl: MAINNET, mainnetAck: true };
  assert.match(sessionMismatch(main, { ...main, mainnetAck: false })!, /acknowledgement/);
});

test("same-key signer swap during the genesis await: neither A nor B signs, nothing is sent", async () => {
  const gate = deferred<string>();
  const net = mockNet({ cluster: "localnet", genesis: () => gate.promise });
  const kp = Keypair.generate();
  let signs = 0;
  const signWith = async (tx: import("@solana/web3.js").VersionedTransaction) => {
    signs += 1;
    tx.sign([kp]);
    return tx;
  };
  const a = walletSigner("A", kp.publicKey, signWith);
  const b = walletSigner("B", kp.publicKey, signWith); // same key, another adapter
  let live = liveOf(net, a);
  const sending = signAndSend({ net, review: reviewFor(net, kp.publicKey), signer: a, mainnetAck: false, getLive: () => live });
  await tick();
  live = { ...live, signer: b, signerEpoch: live.signerEpoch + 1 };
  gate.resolve("localgenesis");
  await assert.rejects(sending, /session changed: the wallet connection changed/);
  assert.equal(signs, 0);
  assert.equal(net.sent, 0);
});

test("an adapter event just before the wallet promise resolves: 0 broadcasts, all 'not sent'", async () => {
  const net = mockNet({ cluster: "localnet" });
  const kp = Keypair.generate();
  let live: SessionKey;
  let signs = 0;
  const wallet = walletSigner("A", kp.publicKey, async (tx) => {
    signs += 1;
    tx.sign([kp]);
    // disconnect + reconnect of the same account, fired as the prompt resolves
    live = { ...live, signerEpoch: live.signerEpoch + 2 };
    return tx;
  });
  live = liveOf(net, wallet);
  await assert.rejects(
    signAndSend({ net, review: reviewFor(net, kp.publicKey), signer: wallet, mainnetAck: false, getLive: () => live }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "not sent");
      assert.equal(err.failedIndex, 0);
      assert.match(err.message, /not sent: tx 1\/2 \(first\), tx 2\/2 \(second\)/);
      return true;
    },
  );
  assert.equal(signs, 1, "no further signature was requested");
  assert.equal(net.sent, 0);
});
