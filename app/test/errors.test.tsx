/**
 * "Nothing was sent" / "Nothing was changed" only when that is true: after
 * transaction 1 confirmed, a wallet rejection of transaction 2 must say so.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Keypair, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import { PlanSendError, sendPlan, type Plan, type SendConnection } from "@core/owner.js";
import { SendLog, type SendRecord } from "../src/components/SendLog.js";
import { friendlyError } from "../src/lib/errors.js";

const payer = Keypair.generate();

function threeTx(): Plan {
  const ix = () => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  return {
    txs: [
      { label: "create_fund + quote vault", instructions: [ix()], extraSigners: [] },
      { label: "attach_metadata", instructions: [ix()], extraSigners: [] },
      { label: "target vaults", instructions: [ix()], extraSigners: [] },
    ],
  };
}

const conn: SendConnection = {
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 50 }),
  sendRawTransaction: async () => "x",
  confirmTransaction: async () => ({ context: { slot: 9 }, value: { err: null } }),
};

/** A wallet that signs transaction 1, then the owner rejects transaction 2. */
async function rejectSecond(): Promise<PlanSendError> {
  let n = 0;
  const sign = async (tx: VersionedTransaction) => {
    if (n++ === 1) throw new Error("WalletSignTransactionError: User rejected the request.");
    tx.sign([payer]);
    return tx;
  };
  try {
    await sendPlan({ connection: conn, plan: threeTx(), payer: payer.publicKey, sign, rpcUrl: "http://127.0.0.1:8899", log: () => {} });
  } catch (err) {
    assert.ok(err instanceof PlanSendError);
    return err;
  }
  throw new Error("expected a PlanSendError");
}

test("tx 1 confirmed, tx 2 rejected: the message names what confirmed and what was not sent", async () => {
  const err = await rejectSecond();
  assert.equal(err.failedIndex, 1);
  assert.equal(err.total, 3);
  const sig = err.done[0]!.signature;
  const title = friendlyError(err).title;
  assert.equal(title, `You declined transaction 2 of 3 in the wallet. Transaction 1 had already confirmed (signature ${sig}); transactions 2–3 were not sent.`);
  assert.doesNotMatch(title, /Nothing was sent/);
  // Only the message string: still does not claim nothing was sent.
  assert.doesNotMatch(friendlyError(err.message).title, /Nothing was sent/);
  assert.match(friendlyError(err.message).title, /had already confirmed/);
});

test("the send log shows the scoped text", async () => {
  const err = await rejectSecond();
  const record: SendRecord = {
    id: 1,
    reviewId: 1,
    title: "Create fund",
    cluster: "localnet",
    rpcUrl: "http://127.0.0.1:8899",
    status: "failed",
    total: 3,
    lines: [],
    outcomes: err.done,
    error: err.message,
    failedSig: err.signature,
    failState: err.state,
    failedIndex: err.failedIndex,
  };
  const html = renderToString(<SendLog sends={[record]} explorer={{ mainnet: "", testnet: "", localnet: "" }} onDismiss={() => {}} onOpenFund={() => {}} locked={false} />);
  assert.match(html, /data-testid="send-failed-friendly"/);
  assert.match(html, /You declined transaction 2 of 3 in the wallet\. Transaction 1 had already confirmed/);
  assert.doesNotMatch(html, /Nothing was sent/);
});

test("a rejection of the first transaction, or a single one, still says nothing was sent", () => {
  assert.equal(friendlyError(new Error("User rejected the request")).title, "You declined in the wallet. Nothing was sent.");
  assert.equal(
    friendlyError(new Error("User rejected the request"), { send: { done: [], failedIndex: 0, total: 3 } }).title,
    "You declined transaction 1 of 3 in the wallet. Nothing was sent.",
  );
  assert.equal(
    friendlyError(new Error("User rejected the request"), { send: { done: [{ signature: "A" }, { signature: "B" }], failedIndex: 2, total: 3 } }).title,
    "You declined transaction 3 of 3 in the wallet. Transactions 1–2 had already confirmed (signatures A, B); transaction 3 was not sent.",
  );
});

test("an on-chain refusal after tx 1 confirmed does not say nothing was changed", () => {
  const e = new Error("tx 2/3 (attach_metadata) X landed and failed: custom program error: 0x17a5\nconfirmed before the failure:\n  tx 1/3: SIG1");
  const t = friendlyError(e, { send: { done: [{ signature: "SIG1" }], failedIndex: 1, total: 3 } }).title;
  assert.equal(
    t,
    "Token Metadata changed your wallet account, transaction refused. Transaction 2 of 3 changed nothing. Transaction 1 had already confirmed (signature SIG1). Transaction 3 was not sent.",
  );
  assert.doesNotMatch(friendlyError(e).title, /Nothing was changed/);
  assert.match(friendlyError(new Error("custom program error: 0x17a5")).title, /Nothing was changed\.$/);
});
