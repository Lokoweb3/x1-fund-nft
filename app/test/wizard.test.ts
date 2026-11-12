/**
 * The wizard's plain-language arithmetic: percentages to exact bps (always
 * 10000 with the cash slice), schedules, projections, labels, friendly
 * errors, and the review sentences.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { validateCreateFund, type MintMeta } from "@core/owner.js";
import { TOKEN_2022_PROGRAM_ID } from "@core/pool.js";
import { bpsToPercent, countdown, FREQUENCIES, humanDuration, humanInterval, percentToBps, project, splitToTargets } from "../src/lib/wizard.js";
import { CURATED_TOKENS, labelFor } from "../src/lib/tokens.js";
import { friendlyError } from "../src/lib/errors.js";
import { createFundSentences, inscribeSentences } from "../src/lib/actions.js";

const quote = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const TEST = new PublicKey("C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz");
const k = () => Keypair.generate().publicKey;

test("percentages convert to basis points exactly", () => {
  assert.equal(percentToBps("80"), 8000);
  assert.equal(percentToBps("80.5"), 8050);
  assert.equal(percentToBps("33.33"), 3333);
  assert.equal(percentToBps("0.01"), 1);
  assert.equal(percentToBps("100"), 10_000);
  assert.equal(percentToBps(" 12.3 % "), 1230);
  assert.equal(percentToBps("7."), 700);
  for (const bad of ["", "abc", "-1", "1.234", "100.01", "1e2", "0x10"]) assert.throws(() => percentToBps(bad), undefined, bad);
  assert.equal(bpsToPercent(3333), "33.33");
  assert.equal(bpsToPercent(8050), "80.5");
  assert.equal(bpsToPercent(2000), "20");
});

test("shares plus keep-as-cash always sum to exactly 10000 bps, and pass the program's bounds", () => {
  const cases: string[][] = [["80"], ["33.33", "33.33", "33.33"], ["100"], ["12.5", "12.5", "50"], ["0.01"], ["99.99"]];
  for (const shares of cases) {
    const rows = shares.map((percent) => ({ mint: k(), pool: k(), percent }));
    const split = splitToTargets(quote, rows);
    const sum = split.targets.reduce((a, t) => a + t.bps, 0);
    assert.equal(sum, 10_000, shares.join("+"));
    const expectedCash = 10_000 - shares.reduce((a, p) => a + percentToBps(p), 0);
    assert.equal(split.cashBps, expectedCash);
    // The cash slice is the quote mint with the default pool, first.
    if (expectedCash > 0) {
      assert.ok(split.targets[0]!.mint.equals(quote) && split.targets[0]!.pool.equals(PublicKey.default));
      assert.equal(split.targets.length, shares.length + 1);
    } else assert.equal(split.targets.length, shares.length);
    validateCreateFund({ quote, targets: split.targets, perRun: 1n, interval: 60n, window: 3600, maxDevBps: 300 });
  }
  assert.throws(() => splitToTargets(quote, [{ mint: k(), pool: k(), percent: "60" }, { mint: k(), pool: k(), percent: "50" }]), /110%, more than 100%/);
  assert.throws(() => splitToTargets(quote, [{ mint: k(), pool: k(), percent: "0" }]), /more than 0%/);
});

test("schedules and durations in words", () => {
  assert.deepEqual(FREQUENCIES.map((f) => f.secs), [300, 900, 3600, 14_400, 86_400, 604_800]);
  assert.equal(humanInterval(3600), "1 hour");
  assert.equal(humanInterval(14_400n), "4 hours");
  assert.equal(humanInterval(300), "5 minutes");
  assert.equal(humanInterval(604_800), "1 week");
  assert.equal(humanInterval(90), "90 seconds");
  assert.equal(humanDuration(99 * 3600), "about 4 days");
  assert.equal(humanDuration(10 * 3600), "about 10 hours");
  assert.equal(countdown(23 * 60), "23 min");
  assert.equal(countdown(0n), "now");
  assert.equal(countdown(2 * 3600 + 5 * 60), "2 h 5 min");
});

test("projection: a deposit lasts deposit / per-buy rounds, by the program's slice arithmetic", () => {
  // 10 USDC.X at 0.1 per round, 80% TEST + 20% cash, hourly: TEST budget 8, slice 0.08 -> 100 buys.
  const p = project(10_000_000n, 100_000n, 3600n, [
    { bps: 2000, cash: true },
    { bps: 8000, cash: false },
  ])!;
  assert.equal(p.buys, 100);
  assert.equal(p.seconds, 99 * 3600);
  assert.equal(p.spentPerRound, 80_000n);
  assert.equal(humanDuration(p.seconds), "about 4 days");
  // A partial last buy counts.
  assert.equal(project(1_050_000n, 100_000n, 60n, [{ bps: 10_000, cash: false }])!.buys, 11);
  assert.equal(project(0n, 1n, 60n, [{ bps: 10_000, cash: false }]), undefined);
  assert.equal(project(1n, 1n, 60n, [{ bps: 10_000, cash: true }]), undefined);
});

test("labels: on-chain metadata first, then the curated list, then the short address", () => {
  assert.deepEqual(labelFor(TEST, { symbol: "Test", name: "Test", nameSource: "token-2022" }), { symbol: "Test", name: "Test", source: "token-2022" });
  assert.equal(labelFor(TEST).symbol, "TEST");
  assert.equal(labelFor(TEST).source, "curated");
  assert.equal(labelFor("So11111111111111111111111111111111111111112").symbol, "WXNT");
  const other = k().toBase58();
  assert.deepEqual(labelFor(other), { symbol: `${other.slice(0, 4)}…${other.slice(-4)}`, name: other, source: "address" });
  // Control characters in a mint's own symbol never reach the screen.
  assert.equal(labelFor(TEST, { symbol: "\u0000\u0007", nameSource: "token-2022" }).source, "curated");
  assert.deepEqual(
    CURATED_TOKENS.map((t) => [t.symbol, t.mint]),
    [
      ["USDC.X", "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq"],
      ["TEST", "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz"],
      ["JACK", "54uAdhRHZmbGnD1tATH7F7Qp5us7xsXJQTf6MpMEdFbg"],
      ["GOOGL.X", "E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5"],
      ["PEPE", "81LkybSBLvXYMTF6azXohUWyBvDGUXznm4yiXPkYkDTJ"],
      ["WXNT", "So11111111111111111111111111111111111111112"],
    ],
  );
  assert.ok(CURATED_TOKENS.every((t) => t.network === "mainnet"));
});

test("friendly errors map to actions", () => {
  const notDeployed = friendlyError(
    new Error("program 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM is not deployed on this RPC (https://rpc.mainnet.x1.xyz, mainnet): getAccountInfo returned no account. Nothing was simulated or sent."),
    { cluster: "mainnet" },
  );
  assert.equal(notDeployed.action?.kind, "switch-local");
  assert.equal(notDeployed.action?.label, "Switch to Local validator to try it");
  assert.match(notDeployed.raw, /is not deployed on this RPC/);
  assert.equal(friendlyError(new Error("depositor balance 1 is below the deposit 2")).action?.kind, "add-funds");
  assert.equal(friendlyError(new Error("tx 1/2 (create_fund + quote vault) is 1300 bytes; the limit is 1232.")).action?.kind, "fewer-tokens");
  assert.equal(friendlyError(new Error("target 1 pool X does not exist")).action?.kind, "change-token");
  assert.equal(friendlyError(new Error("Connect a wallet to sign")).action?.kind, "connect-wallet");
  assert.match(friendlyError(new Error("custom program error: AttachCostTooHigh")).title, /0.03 XNT/);
  assert.match(friendlyError(new Error('failed: {"InstructionError":[1,{"Custom":6052}]}')).title, /^Pay for the image from an ordinary wallet/);
  assert.match(friendlyError(new Error("custom program error: 0x17a5")).title, /^Token Metadata changed your wallet account, transaction refused/);
  assert.match(friendlyError(new Error("Error Code: PayerNotWallet")).title, /ordinary wallet/);
  assert.match(friendlyError(new Error("not resuming yet: an earlier transaction may still land")).title, /about a minute/);
  assert.equal(
    friendlyError(new Error("the RPC answered from slot 100, older than the settlement evidence at slot 120; nothing was simulated or sent")).title,
    "The network node is behind, try resuming again in a few seconds.",
  );
  assert.equal(friendlyError(new Error("something odd")).title, "something odd");
});

const usdcMeta: MintMeta = { address: quote, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6, transferFee: undefined };

test("review sentences: 'Every 1 hour this fund spends 0.08 USDC.X on TEST'", () => {
  const args = {
    quote,
    targets: [
      { mint: quote, pool: PublicKey.default, bps: 2000 },
      { mint: TEST, pool: k(), bps: 8000 },
    ],
    perRun: 100_000n,
    interval: 3600n,
    window: 3600,
    maxDevBps: 300,
  };
  const s = createFundSentences(args, usdcMeta, undefined);
  assert.equal(s[0], "Every 1 hour this fund spends 0.08 USDC.X on TEST.");
  assert.match(s[1]!, /keeps 20% of every deposit as cash in USDC\.X/);
  assert.match(s[2]!, /more than 3% below the 1 hour average price/);
  assert.match(s[2]!, /0\.1% of each buy is a tip for the keeper/);
});

test("inscribe review sentences name the number, transactions, fee, uri and the trust note", () => {
  const plan = { number: 67n, fee: 500_000_000n, uri: "https://67.x1ins.xyz/content/67", txs: [{}] } as unknown as Parameters<typeof inscribeSentences>[0];
  const s = inscribeSentences(plan, 540, 15_000_000n);
  assert.match(s[0]!, /540-byte metadata JSON on X1 as inscription #67 \(predicted/);
  assert.match(s[1]!, /1 transaction\. The X1 Inscriptions fee is 0\.5000 XNT, plus about 0\.0150 XNT rent/);
  assert.equal(s[2], "Your fund NFT's metadata link will be https://67.x1ins.xyz/content/67.");
  assert.match(s[3]!, /third-party, upgradeable program/);
});
