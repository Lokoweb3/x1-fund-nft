import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Keypair, PublicKey, SendTransactionError, SystemProgram } from "@solana/web3.js";
import {
  base58,
  classifySendError,
  ensureVaultsCommandLine,
  PlanSendError,
  sendPlan,
  shellQuote,
  type Plan,
  type SendConnection,
} from "../src/owner.js";

const payer = Keypair.generate();
const fund = Keypair.generate().publicKey;
const rpcUrl = "https://rpc.example/?a=1&b=2";

function plan(): Plan {
  const ix = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: fund, lamports: 1 });
  return {
    txs: [
      { label: "create_fund", instructions: [ix], extraSigners: [] },
      { label: "target vaults", instructions: [ix], extraSigners: [] },
    ],
    fund,
    recovery: ensureVaultsCommandLine({
      fund,
      payer: payer.publicKey,
      rpcUrl,
      send: true,
      cluster: "mainnet",
      iUnderstandMainnet: true,
    }),
  };
}

/** Mock RPC: each hook may throw; records how many submissions it accepted. */
function mock(hooks: { blockhash?: (n: number) => void; send?: (n: number) => void }): SendConnection & { sent: number } {
  let bh = 0;
  const conn = {
    sent: 0,
    async getLatestBlockhash() {
      hooks.blockhash?.(bh++);
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 };
    },
    async sendRawTransaction() {
      hooks.send?.(conn.sent);
      conn.sent += 1;
      return "ignored";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  };
  return conn;
}

const quiet = () => {};

test("base58 matches PublicKey encoding", () => {
  for (let i = 0; i < 20; i++) {
    const k = Keypair.generate().publicKey;
    assert.equal(base58(k.toBytes()), k.toBase58());
  }
  assert.equal(base58(new Uint8Array(32)), PublicKey.default.toBase58());
});

test("only a JSON-RPC SendTransactionError counts as not sent", () => {
  const refused = new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "preflight", logs: [] });
  assert.equal(classifySendError(refused), "not sent");
  assert.equal(classifySendError(new Error("socket hang up")), "unknown");
  assert.equal(classifySendError("weird"), "unknown");
});

test("A: transport failure after submission is reported unknown with its signature (codex r2)", async () => {
  const conn = mock({
    send: (n) => {
      if (n === 1) throw new Error("transport response lost after submission");
    },
  });
  await assert.rejects(
    sendPlan({ connection: conn, plan: plan(), payer: payer.publicKey, signers: [payer], rpcUrl, log: quiet }),
    (err: Error) => {
      assert.match(err.message, /tx 2\/2 \(target vaults\) \w+ may have been submitted; its status is unknown/);
      assert.match(err.message, /solana confirm -v \w+ --url 'https:\/\/rpc\.example\/\?a=1&b=2'/);
      assert.match(err.message, /confirmed before the failure:\n  tx 1\/2 \(create_fund\): \w+/);
      assert.doesNotMatch(err.message, /not sent: .*tx 2\/2/);
      assert.match(err.message, new RegExp(`fund PDA: ${fund.toBase58()}`));
      assert.match(err.message, /recovery: KEYPAIR='REPLACE_WITH_THE_SAME_KEYPAIR_PATH' npx tsx src\/cli.ts ensure-vaults/);
      return true;
    },
  );
});

test("A': an RPC refusal is reported as not sent", async () => {
  const conn = mock({
    send: (n) => {
      if (n === 0) throw new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "x", logs: [] });
    },
  });
  await assert.rejects(
    sendPlan({ connection: conn, plan: plan(), payer: payer.publicKey, signers: [payer], rpcUrl, log: quiet }),
    /tx 1\/2 \(create_fund\) \w+ was refused by the RPC before landing[\s\S]*not sent: tx 1\/2 \(create_fund\), tx 2\/2 \(target vaults\)/,
  );
});

test("B: blockhash failure after tx1 confirmed still gives the partial report (codex r2)", async () => {
  const conn = mock({
    blockhash: (n) => {
      if (n === 1) throw new Error("blockhash RPC unavailable");
    },
  });
  await assert.rejects(
    sendPlan({ connection: conn, plan: plan(), payer: payer.publicKey, signers: [payer], rpcUrl, log: quiet }),
    (err: Error) => {
      assert.match(err.message, /tx 2\/2 \(target vaults\) could not be prepared .*blockhash RPC unavailable/);
      assert.match(err.message, /confirmed before the failure:\n  tx 1\/2 \(create_fund\): \w+/);
      assert.match(err.message, /not sent: tx 2\/2 \(target vaults\)/);
      assert.match(err.message, /fund PDA: /);
      assert.match(err.message, /recovery: /);
      return true;
    },
  );
  assert.equal(conn.sent, 1);
});

test("the recovery command is valid shell and quotes a URL with &", () => {
  const line = plan().recovery!;
  assert.doesNotMatch(line, /</);
  execFileSync("bash", ["-n", "-c", line]);
  assert.equal(shellQuote("https://x/?a=1&b=2"), "'https://x/?a=1&b=2'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("onSubmit: called right before each broadcast, never for a transaction that was not broadcast", async () => {
  const events: string[] = [];
  let bh = 0;
  const conn: SendConnection = {
    async getLatestBlockhash() {
      bh += 1;
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 + bh };
    },
    async sendRawTransaction() {
      events.push("send");
      return "ignored";
    },
    async confirmTransaction() {
      events.push("confirm");
      return { context: { slot: 4242 }, value: { err: null } };
    },
  };
  let submits: { index: number; label: string; signature: string; lastValidBlockHeight: number }[] = [];
  // The guard refuses tx 2 at the broadcast stage: tx 2 is signed but never broadcast.
  await assert.rejects(
    sendPlan({
      connection: conn,
      plan: plan(),
      payer: payer.publicKey,
      signers: [payer],
      rpcUrl,
      log: quiet,
      guard: ({ index, stage }) => {
        events.push(`guard ${index} ${stage}`);
        if (index === 1 && stage === "broadcast") throw new Error("session changed");
      },
      onSubmit: (tx) => {
        events.push(`submit ${tx.index}`);
        submits.push(tx);
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "not sent");
      assert.equal(err.lastValidBlockHeight, undefined);
      assert.equal(err.done.length, 1);
      assert.equal(err.done[0]!.lastValidBlockHeight, 101);
      assert.equal(err.done[0]!.confirmedSlot, 4242);
      return true;
    },
  );
  assert.deepEqual(events, ["guard 0 sign", "guard 0 broadcast", "submit 0", "send", "confirm", "guard 1 sign", "guard 1 broadcast"]);
  assert.equal(submits.length, 1);
  assert.equal(submits[0]!.index, 0);
  assert.equal(submits[0]!.label, "create_fund");
  assert.equal(submits[0]!.lastValidBlockHeight, 101);

  // A signing failure, or an onSubmit that throws, means nothing was broadcast.
  submits = [];
  const sends = mock({});
  await assert.rejects(
    sendPlan({
      connection: sends,
      plan: plan(),
      payer: payer.publicKey,
      sign: async () => {
        throw new Error("User rejected the request");
      },
      rpcUrl,
      log: quiet,
      onSubmit: (tx) => submits.push(tx),
    }),
    /could not be prepared/,
  );
  assert.equal(submits.length, 0);
  assert.equal(sends.sent, 0);
  await assert.rejects(
    sendPlan({
      connection: sends,
      plan: plan(),
      payer: payer.publicKey,
      signers: [payer],
      rpcUrl,
      log: quiet,
      onSubmit: () => {
        throw new Error("registry unavailable");
      },
    }),
    /signed but not broadcast: registry unavailable[\s\S]*not sent: tx 1\/2/,
  );
  assert.equal(sends.sent, 0);
});

test("onSubmit: an unknown or failed transaction keeps its expiry on PlanSendError", async () => {
  const seen: number[] = [];
  const conn = mock({
    send: (n) => {
      if (n === 1) throw new Error("socket hang up");
    },
  });
  await assert.rejects(
    sendPlan({ connection: conn, plan: plan(), payer: payer.publicKey, signers: [payer], rpcUrl, log: quiet, onSubmit: (tx) => seen.push(tx.index) }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "unknown");
      assert.equal(err.lastValidBlockHeight, 100);
      assert.equal(err.done[0]!.lastValidBlockHeight, 100);
      return true;
    },
  );
  // The transport failed after onSubmit: tx 2 was recorded before it could leave.
  assert.deepEqual(seen, [0, 1]);
  const failing: SendConnection = {
    ...mock({}),
    async confirmTransaction() {
      return { value: { err: { InstructionError: [0, "x"] } } };
    },
  };
  await assert.rejects(
    sendPlan({ connection: failing, plan: plan(), payer: payer.publicKey, signers: [payer], rpcUrl, log: quiet }),
    (err: unknown) => err instanceof PlanSendError && err.state === "failed" && err.lastValidBlockHeight === 100,
  );
});
