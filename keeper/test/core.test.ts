/**
 * Shared core (src/core/*) as the web app uses it: an injected signer for
 * sendPlan, UI-unit parsing, the honest size limit, and browser safety.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { AnchorProvider, type Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { createProgram } from "../src/core/fund.js";
import {
  computeBudgetFromEnv,
  keypairSigner,
  parseUi,
  PlanSendError,
  sendPlan,
  type Plan,
  type SendConnection,
  type TxSigner,
} from "../src/core/owner.js";
import { maxTargetsThatFit, planAccounts, tokenAmount } from "../src/core/rpc.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src/core/pool.js";

const payer = Keypair.generate();
const extra = Keypair.generate();
const quiet = () => {};
/** Offline: never signs. Wallet is not a named ESM export of Anchor's CommonJS build. */
const readOnlyWallet = {
  publicKey: payer.publicKey,
  signTransaction: async () => {
    throw new Error("read-only");
  },
  signAllTransactions: async () => {
    throw new Error("read-only");
  },
} as unknown as Wallet;

function plan(withExtra: boolean): Plan {
  const transfer = () =>
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const first = transfer();
  // The extra signer (like the NFT mint in create_fund) signs only tx 1.
  if (withExtra) first.keys.push({ pubkey: extra.publicKey, isSigner: true, isWritable: false });
  return {
    txs: [
      { label: "first", instructions: [first], extraSigners: withExtra ? [extra] : [] },
      { label: "second", instructions: [transfer()], extraSigners: [] },
    ],
    fund: Keypair.generate().publicKey,
    recovery: "use Ensure vaults",
  };
}

function conn(): SendConnection & { raw: Uint8Array[] } {
  const c = {
    raw: [] as Uint8Array[],
    async getLatestBlockhash() {
      return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 };
    },
    async sendRawTransaction(raw: Uint8Array) {
      c.raw.push(raw);
      return "x";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  };
  return c;
}

test("sendPlan with an injected (wallet-style) signer: payer signs first, then the NFT key", async () => {
  const c = conn();
  const seen: number[] = [];
  const walletSign: TxSigner = async (tx) => {
    // A wallet receives the transaction before the extra signer has signed.
    seen.push(tx.signatures.filter((s) => s.some((b) => b !== 0)).length);
    // Round-trip through bytes, as a wallet adapter does.
    const copy = VersionedTransaction.deserialize(tx.serialize());
    copy.sign([payer]);
    return copy;
  };
  const done = await sendPlan({ connection: c, plan: plan(true), payer: payer.publicKey, sign: walletSign, rpcUrl: "x", log: quiet });
  assert.equal(done.length, 2);
  assert.deepEqual(seen, [0, 0]);
  const first = VersionedTransaction.deserialize(c.raw[0]!);
  assert.equal(first.signatures.length, 2);
  assert.ok(first.signatures.every((s) => s.some((b) => b !== 0)), "payer and NFT signatures present");
});

test("sendPlan: a rejected wallet signature is 'not sent' and nothing is submitted", async () => {
  const c = conn();
  const reject: TxSigner = async () => {
    throw new Error("User rejected the request.");
  };
  await assert.rejects(
    sendPlan({ connection: c, plan: plan(true), payer: payer.publicKey, sign: reject, rpcUrl: "x", log: quiet }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "not sent");
      assert.equal(err.failedIndex, 0);
      assert.equal(err.signature, undefined);
      assert.match(err.message, /could not be prepared .*User rejected/);
      assert.match(err.message, /not sent: tx 1\/2 \(first\), tx 2\/2 \(second\)/);
      return true;
    },
  );
  assert.equal(c.raw.length, 0);
});

test("sendPlan refuses a signer that changes the message (what is sent must be what was simulated)", async () => {
  const c = conn();
  const tamper: TxSigner = async (tx) => {
    const other = Keypair.generate();
    const changed = new VersionedTransaction(tx.message);
    changed.message.recentBlockhash = other.publicKey.toBase58();
    changed.sign([payer]);
    return changed;
  };
  await assert.rejects(
    sendPlan({ connection: c, plan: plan(false), payer: payer.publicKey, sign: tamper, rpcUrl: "x", log: quiet }),
    /changed the transaction message; refusing to send what was not simulated/,
  );
  assert.equal(c.raw.length, 0);
});

test("sendPlan: a signer that does not sign is refused before submission", async () => {
  const c = conn();
  await assert.rejects(
    sendPlan({ connection: c, plan: plan(false), payer: payer.publicKey, sign: async (tx) => tx, rpcUrl: "x", log: quiet }),
    /a required signature is missing/,
  );
  assert.equal(c.raw.length, 0);
});

test("PlanSendError carries the confirmed signatures for a partial failure", async () => {
  const c = conn();
  let n = 0;
  c.confirmTransaction = async () => (n++ === 0 ? { value: { err: null } } : { value: { err: { InstructionError: [0, "Custom"] } } });
  await assert.rejects(
    sendPlan({ connection: c, plan: plan(false), payer: payer.publicKey, sign: keypairSigner([payer]), rpcUrl: "x", log: quiet }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "failed");
      assert.equal(err.done.length, 1);
      assert.equal(err.done[0]!.label, "first");
      assert.ok(err.signature && err.signature.length > 60);
      assert.match(err.message, /landed and failed/);
      assert.match(err.message, /recovery: use Ensure vaults/);
      return true;
    },
  );
});

test("parseUi converts UI units exactly and rejects bad input", () => {
  assert.equal(parseUi("1", 6, "amount"), 1_000_000n);
  assert.equal(parseUi("0.1", 6, "amount"), 100_000n);
  assert.equal(parseUi("1000.000001", 6, "amount"), 1_000_000_001n);
  assert.equal(parseUi(".5", 2, "amount"), 50n);
  assert.equal(parseUi("7", 0, "amount"), 7n);
  assert.throws(() => parseUi("0.0000001", 6, "amount"), /more than 6 decimal places/);
  assert.throws(() => parseUi("-1", 6, "amount"), /non-negative decimal/);
  assert.throws(() => parseUi("1e3", 6, "amount"), /non-negative decimal/);
  assert.throws(() => parseUi("", 6, "amount"), /non-negative decimal/);
  assert.throws(() => parseUi("18446744073709.551616", 6, "amount"), /exceeds/);
});

test("maxTargetsThatFit gives the same limit assertPlanFits enforces", async () => {
  const program = createProgram(new AnchorProvider(new Connection("http://127.0.0.1:1"), readOnlyWallet, {}));
  const budget = computeBudgetFromEnv({}).instructions;
  const meta = (tokenProgram: PublicKey) => ({ address: Keypair.generate().publicKey, tokenProgram, decimals: 6, transferFee: undefined });
  const p = payer.publicKey;
  assert.equal((await maxTargetsThatFit(program, p, meta(TOKEN_2022_PROGRAM_ID), false, budget)).maxNonCash, 6);
  assert.equal((await maxTargetsThatFit(program, p, meta(TOKEN_2022_PROGRAM_ID), true, budget)).maxNonCash, 5);
  assert.equal((await maxTargetsThatFit(program, p, meta(TOKEN_PROGRAM_ID), true, budget)).maxNonCash, 5);
  assert.equal((await maxTargetsThatFit(program, p, meta(TOKEN_PROGRAM_ID), false, budget)).maxNonCash, 6);
});

test("planAccounts dedupes keys and keeps the strongest role; tokenAmount reads offset 64", () => {
  const accounts = planAccounts(plan(true));
  const payerRow = accounts.find((a) => a.pubkey.equals(payer.publicKey))!;
  assert.ok(payerRow.isSigner && payerRow.isWritable);
  assert.equal(accounts.filter((a) => a.pubkey.equals(SystemProgram.programId)).length, 1);
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, 123_456_789n, true);
  assert.equal(tokenAmount(data), 123_456_789n);
});

test("src/core is browser-safe: no node: imports, no process, no createRequire", () => {
  const dir = new URL("../src/core/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 5);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    assert.doesNotMatch(src, /from "node:|require\(|createRequire|process\./, f);
  }
});

test("sendPlan guard: a context change between transactions stops the rest as 'not sent'", async () => {
  const c = conn();
  let live = true;
  await assert.rejects(
    sendPlan({
      connection: c,
      plan: plan(false),
      payer: payer.publicKey,
      sign: keypairSigner([payer]),
      rpcUrl: "x",
      log: () => {
        live = false; // the network changes right after tx 1 confirmed
      },
      guard: () => {
        if (!live) throw new Error("session changed");
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "not sent");
      assert.equal(err.failedIndex, 1);
      assert.equal(err.done.length, 1, "tx 1 stays reported as confirmed");
      assert.match(err.message, /session changed/);
      assert.match(err.message, /not sent: tx 2\/2 \(second\)/);
      return true;
    },
  );
  assert.equal(c.raw.length, 1, "only tx 1 was submitted");
});

test("sendPlan guard: a change while the wallet is open stops before broadcast", async () => {
  const c = conn();
  let live = true;
  const slowWallet: TxSigner = async (tx) => {
    await new Promise((r) => setTimeout(r, 20));
    live = false; // e.g. the user switched account while the prompt was open
    tx.sign([payer]);
    return tx;
  };
  const stages: string[] = [];
  await assert.rejects(
    sendPlan({
      connection: c,
      plan: plan(false),
      payer: payer.publicKey,
      sign: slowWallet,
      rpcUrl: "x",
      log: quiet,
      guard: ({ stage }) => {
        stages.push(stage);
        if (!live) throw new Error("session changed");
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof PlanSendError);
      assert.equal(err.state, "not sent");
      assert.equal(err.failedIndex, 0);
      assert.ok(err.signature, "the signed-but-unsent signature is named");
      assert.match(err.message, /was signed but not broadcast: session changed/);
      assert.match(err.message, /not sent: tx 1\/2 \(first\), tx 2\/2 \(second\)/);
      return true;
    },
  );
  assert.deepEqual(stages, ["sign", "broadcast"]);
  assert.equal(c.raw.length, 0, "nothing was submitted");
});
