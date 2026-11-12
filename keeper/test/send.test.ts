import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { Keypair, PublicKey, SendTransactionError, SystemProgram } from "@solana/web3.js";
import {
  base58,
  classifySendError,
  ensureVaultsCommandLine,
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
