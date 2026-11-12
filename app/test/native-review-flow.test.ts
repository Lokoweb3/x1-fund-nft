/**
 * Regression: the typed amount reaches the instruction exactly. Runs
 * parseNativeAmount -> reviewWithdrawNative -> prepareWithdrawNative ->
 * withdraw_native instruction -> simulation against a fully mocked RPC that
 * has no sign or send methods (any other call throws).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import BN from "bn.js";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { FUND_ACCOUNT } from "@core/fund.js";
import { fundPda, PROGRAM_ID } from "@core/owner.js";
import { TOKEN_PROGRAM_ID } from "@core/pool.js";
import { readNativeBalance } from "@core/rpc.js";
import { makeProgram, reviewWithdrawNative } from "../src/lib/actions.js";
import { parseNativeAmount } from "../src/lib/native.js";
import type { NetworkInfo } from "../src/lib/network.js";

const RENT = 6_145_680;
const holder = Keypair.generate().publicKey;
const nftMint = Keypair.generate().publicKey;
const nftAccount = Keypair.generate().publicKey;
const fund = fundPda(nftMint);
const QUOTE = new PublicKey("So11111111111111111111111111111111111111112");

/** A read-only fake RPC. `state.lamports` is the fund's balance; `calls` records every method used. */
async function fakeNet() {
  const state = { lamports: RENT + 500_000_000 };
  const calls: string[] = [];
  const nftData = Buffer.alloc(165);
  nftMint.toBuffer().copy(nftData, 0);
  holder.toBuffer().copy(nftData, 32);
  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    getAccountInfo: async (key) => {
      const k = key as PublicKey;
      if (k.equals(fund)) return { lamports: state.lamports, data: fundData, owner: PROGRAM_ID, executable: false };
      if (k.equals(nftAccount)) return { lamports: 2_039_280, data: nftData, owner: TOKEN_PROGRAM_ID, executable: false };
      if (k.equals(PROGRAM_ID)) return { lamports: 1, data: Buffer.alloc(36), owner: new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), executable: true };
      return null;
    },
    getMinimumBalanceForRentExemption: async () => RENT,
    getTokenLargestAccounts: async () => ({ value: [{ address: nftAccount, amount: "1" }] }),
    simulateTransaction: async () => ({ value: { err: null, logs: ["Program log: Instruction: WithdrawNative"], unitsConsumed: 6028 } }),
    getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 100 }),
    getFeeForMessage: async () => ({ value: 5000 }),
  };
  const connection = new Proxy({} as Connection, {
    get(_t, name) {
      if (typeof name !== "string" || name === "then") return undefined;
      const h = handlers[name];
      return (...args: unknown[]) => {
        calls.push(name);
        if (!h) throw new Error(`unexpected RPC call ${name}`);
        return h(...args);
      };
    },
  });
  const net = { generation: 1, rpcUrl: "http://127.0.0.1:1", cluster: "localnet", genesisHash: "g", loopback: true, connection } as unknown as NetworkInfo;
  const fundData = await makeProgram(net).coder.accounts.encode(FUND_ACCOUNT, {
    nftMint,
    quoteMint: QUOTE,
    bump: 254,
    perRunQuote: new BN(100_000),
    intervalSecs: new BN(3_600),
    twapWindowSecs: 3_600,
    maxDevBps: 300,
    targets: [{ mint: QUOTE, pool: PublicKey.default, bps: 10_000, budget: new BN(0), lastRun: new BN(0) }],
  });
  return { net, state, calls };
}

/** u64 amount of the withdraw_native instruction (after the 8-byte discriminator). */
function encodedAmount(review: Awaited<ReturnType<typeof reviewWithdrawNative>>): bigint {
  const ix = review.plan.txs[0]!.instructions.at(-1)!;
  assert.ok(ix.programId.equals(PROGRAM_ID));
  return Buffer.from(ix.data).readBigUInt64LE(8);
}

test("' 0.200000001 ' becomes 200000001 lamports in the review text and in the instruction", async () => {
  const { net, calls } = await fakeNet();
  const balance = await readNativeBalance(net.connection, fund);
  const amount = parseNativeAmount(" 0.200000001 ", false, balance);
  assert.equal(amount, 200_000_001n);
  const review = await reviewWithdrawNative(net, holder, fund, amount);
  assert.equal(review.simOk, true);
  assert.equal(review.action, "withdraw-native");
  assert.match(review.sentences[0]!, /^You move 0\.200000001 XNT \(native\) from the fund account to your wallet /);
  assert.ok(review.rows.some(([k, v]) => k === "Amount" && v === "0.200000001 XNT (raw 200000001 lamports)"));
  assert.equal(encodedAmount(review), 200_000_001n);
  assert.match(review.sentences.at(-1)!, /Network fees for this transaction: about 0\.000005 XNT, as quoted by the RPC\./);
  assert.ok(!calls.some((c) => /send|sign|request/i.test(c)), calls.join(","));
});

test("'all' encodes the available amount read when the review is built, not when the page loaded", async () => {
  const { net, state } = await fakeNet();
  const onPage = await readNativeBalance(net.connection, fund);
  assert.ok(onPage.exact && onPage.available === 500_000_000n);
  const amount = parseNativeAmount("", true, onPage);
  // More XNT arrives (a reflection) between the page load and the review.
  state.lamports = RENT + 700_000_123;
  const review = await reviewWithdrawNative(net, holder, fund, amount);
  assert.equal(encodedAmount(review), 700_000_123n);
  assert.match(review.sentences[0]!, /^You move 0\.700000123 XNT \(native\)/);
  assert.match(review.sentences[1]!, /after this, 0 XNT is left to withdraw\./);
});

test("'all' with a stale 0.3 XNT on screen encodes the fresh 500000000 and the review says 0.5", async () => {
  const { net, state } = await fakeNet();
  state.lamports = RENT + 300_000_000;
  const stale = await readNativeBalance(net.connection, fund);
  assert.ok(stale.exact && stale.available === 300_000_000n);
  const amount = parseNativeAmount("", true, stale);
  state.lamports = RENT + 500_000_000;
  const review = await reviewWithdrawNative(net, holder, fund, amount);
  assert.equal(encodedAmount(review), 500_000_000n);
  assert.match(review.sentences[0]!, /^You move 0\.5 XNT \(native\)/);
  assert.ok(review.rows.some(([k, v]) => k === "Amount" && v === "0.5 XNT (raw 500000000 lamports)"));
});
