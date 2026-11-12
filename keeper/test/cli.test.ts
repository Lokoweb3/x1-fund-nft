import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { X1_MAINNET_GENESIS_HASH, X1_TESTNET_GENESIS_HASH } from "../src/cluster.js";
import { createProgram, FUND_ACCOUNT, IDL } from "../src/fund.js";
import {
  assertPlanFits,
  buildCreateFundIx,
  buildWithdrawNativeIx,
  checkPool,
  fundVaults,
  MAX_TX_BYTES,
  nativeAvailable,
  NFT_TOKEN_PROGRAM_ID,
  USAGE,
  planCreateFund,
  readTransferFeeConfig,
  transferFeeFor,
  txSize,
  type MintMeta,
  computeBudget,
  createAtaIdempotentIx,
  createFundRemainingAccounts,
  formatUi,
  fundPda,
  parseCli,
  partialFailureMessage,
  PROGRAM_ID,
  sendGate,
  validateCreateFund,
  XDEX_PROGRAM_ID,
  type CommonOptions,
  type CreateFundArgs,
} from "../src/owner.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type PoolAccounts,
} from "../src/pool.js";
import { exactLamports, prepareWithdrawNative, readNativeBalance } from "../src/core/rpc.js";

const require = createRequire(import.meta.url);
const { AnchorProvider, BN, Wallet } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

const QUOTE = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";
const TEST_MINT = "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz";
const POOL = "7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD";
const LOCAL = "http://127.0.0.1:18999";

function createArgv(overrides: Record<string, string | string[]> = {}): string[] {
  const base: Record<string, string | string[]> = {
    "--quote": QUOTE,
    "--target": [`${QUOTE}:default:2000`, `${TEST_MINT}:${POOL}:8000`],
    "--per-run": "100000",
    "--interval": "3600",
    "--window": "3600",
    "--max-dev-bps": "300",
    ...overrides,
  };
  const argv = ["create-fund"];
  for (const [flag, value] of Object.entries(base)) {
    for (const v of Array.isArray(value) ? value : [value]) argv.push(flag, v);
  }
  return argv;
}

function createArgs(argv: string[]): CreateFundArgs {
  const parsed = parseCli(argv);
  assert.equal(parsed.command, "create-fund");
  return (parsed as Extract<typeof parsed, { command: "create-fund" }>).create;
}

test("create-fund parses targets, the cash slice, and raw integers", () => {
  const parsed = parseCli([...createArgv(), "--payer", QUOTE, "--send", "--cluster", "localnet"]);
  assert.equal(parsed.command, "create-fund");
  if (parsed.command !== "create-fund") return;
  assert.ok(parsed.create.quote.equals(new PublicKey(QUOTE)));
  assert.equal(parsed.create.targets.length, 2);
  assert.ok(parsed.create.targets[0]!.pool.equals(PublicKey.default));
  assert.equal(parsed.create.targets[0]!.bps, 2000);
  assert.ok(parsed.create.targets[1]!.pool.equals(new PublicKey(POOL)));
  assert.equal(parsed.create.perRun, 100000n);
  assert.equal(parsed.create.interval, 3600n);
  assert.equal(parsed.create.window, 3600);
  assert.equal(parsed.create.maxDevBps, 300);
  assert.equal(parsed.options.send, true);
  assert.equal(parsed.options.cluster, "localnet");
  assert.equal(parsed.options.iUnderstandMainnet, false);
  // --flag=value form works too.
  const eq = parseCli(["show", `--fund=${QUOTE}`]);
  assert.equal(eq.command, "show");
});

test("argument errors are rejected", () => {
  assert.throws(() => parseCli([]), /usage/);
  assert.throws(() => parseCli(["drain"]), /unknown command/);
  assert.throws(() => parseCli(["show"]), /requires --fund/);
  assert.throws(() => parseCli(["show", "--fund", "nope"]), /not a base58 public key/);
  assert.throws(() => parseCli(["show", "--fund", QUOTE, "--amount", "1"]), /unknown or misplaced/);
  assert.throws(() => parseCli(["deposit", "--fund", QUOTE, "--amount", "1.5"]), /non-negative integer/);
  assert.throws(() => parseCli(["deposit", "--fund", QUOTE, "--amount", "-1"]), /non-negative integer/);
  assert.throws(() => parseCli(["deposit", "--fund", QUOTE, "--amount", "0"]), /greater than zero/);
  assert.throws(() => parseCli(["deposit", "--fund", QUOTE, "--amount", "18446744073709551616"]), /exceeds/);
  assert.throws(() => parseCli(["deposit", "--fund", QUOTE, "--amount", "1", "--cluster", "devnet"]), /--cluster must be/);
  assert.throws(() => parseCli(["deposit", "--fund", QUOTE, "--fund", QUOTE, "--amount", "1"]), /more than once/);
  assert.throws(() => parseCli(createArgv({ "--target": `${TEST_MINT}:${POOL}` })), /<mint>:<pool>:<bps>/);
  const all = parseCli(["withdraw", "--fund", QUOTE, "--mint", QUOTE, "--amount", "all"]);
  assert.equal(all.command === "withdraw" && all.amount, "all");
});

test("bounds match state.rs", () => {
  // Accepted edges.
  createArgs(createArgv({ "--max-dev-bps": "500", "--window": "900", "--interval": "60" }));
  createArgs(createArgv({ "--max-dev-bps": "0", "--window": "86400" }));
  // Rejected edges.
  assert.throws(() => createArgs(createArgv({ "--max-dev-bps": "501" })), /cannot exceed 500/);
  assert.throws(() => createArgs(createArgv({ "--window": "899" })), /between 900 and 86400/);
  assert.throws(() => createArgs(createArgv({ "--window": "86401" })), /between 900 and 86400/);
  assert.throws(() => createArgs(createArgv({ "--interval": "59" })), /at least 60/);
  assert.throws(() => createArgs(createArgv({ "--per-run": "0" })), /greater than zero/);
  assert.throws(
    () => createArgs(createArgv({ "--target": [`${QUOTE}:default:2000`, `${TEST_MINT}:${POOL}:7999`] })),
    /sum to 9999/,
  );
  assert.throws(() => createArgs(createArgv({ "--target": [] })), /requires|at least one/);
  assert.throws(
    () => createArgs(createArgv({ "--target": [`${QUOTE}:default:0`, `${TEST_MINT}:${POOL}:10000`] })),
    /greater than zero/,
  );
  // Cash slice must use the default pool; non-cash must pin one.
  assert.throws(() => createArgs(createArgv({ "--target": [`${QUOTE}:${POOL}:10000`] })), /cash slice/);
  assert.throws(() => createArgs(createArgv({ "--target": [`${TEST_MINT}:default:10000`] })), /must pin a pool/);
  // Duplicates.
  assert.throws(
    () => createArgs(createArgv({ "--target": [`${TEST_MINT}:${POOL}:5000`, `${TEST_MINT}:${QUOTE}:5000`] })),
    /duplicate mint/,
  );
  const other = Keypair.generate().publicKey.toBase58();
  assert.throws(
    () => createArgs(createArgv({ "--target": [`${TEST_MINT}:${POOL}:5000`, `${other}:${POOL}:5000`] })),
    /duplicate pool/,
  );
  // At most 8 targets: 8 is fine, 9 is not.
  const mints = Array.from({ length: 9 }, () => Keypair.generate().publicKey.toBase58());
  const pools = Array.from({ length: 9 }, () => Keypair.generate().publicKey.toBase58());
  const eight = mints.slice(0, 8).map((m, i) => `${m}:${pools[i]}:1250`);
  createArgs(createArgv({ "--target": eight }));
  const nine = mints.map((m, i) => `${m}:${pools[i]}:${i === 0 ? 2000 : 1000}`);
  assert.throws(() => createArgs(createArgv({ "--target": nine })), /at most 8/);
  // validateCreateFund is the same function parseCli runs.
  assert.throws(
    () =>
      validateCreateFund({
        quote: new PublicKey(QUOTE),
        targets: [{ mint: new PublicKey(QUOTE), pool: PublicKey.default, bps: 10_000 }],
        perRun: 1n,
        interval: 60n,
        window: 900,
        maxDevBps: 501,
      }),
    /cannot exceed 500/,
  );
});

test("fund PDA is [\"fund\", nft_mint] under the program id", () => {
  assert.equal(PROGRAM_ID.toBase58(), "6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM");
  const nft = new PublicKey(TEST_MINT);
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from("fund"), nft.toBuffer()], PROGRAM_ID);
  assert.ok(fundPda(nft).equals(expected));
  assert.ok(!fundPda(nft).equals(fundPda(new PublicKey(QUOTE))));
  assert.ok(!PublicKey.isOnCurve(fundPda(nft).toBytes()));
});

test("create_fund remaining accounts are the non-cash target mints in order", async () => {
  const quote = new PublicKey(QUOTE);
  const a = Keypair.generate().publicKey;
  const b = Keypair.generate().publicKey;
  const targets = [
    { mint: a, pool: Keypair.generate().publicKey, bps: 3000 },
    { mint: quote, pool: PublicKey.default, bps: 2000 },
    { mint: b, pool: Keypair.generate().publicKey, bps: 5000 },
  ];
  const metas = createFundRemainingAccounts(quote, targets);
  assert.deepEqual(
    metas.map((m) => m.pubkey.toBase58()),
    [a.toBase58(), b.toBase58()],
  );
  assert.ok(metas.every((m) => !m.isSigner && !m.isWritable));

  const program = createProgram(
    new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
  );
  const creator = Keypair.generate().publicKey;
  const nft = Keypair.generate().publicKey;
  const ix = await buildCreateFundIx(
    program,
    { creator, nftMint: nft, quoteMint: quote },
    { quote, targets, perRun: 1000n, interval: 60n, window: 900, maxDevBps: 100 },
  );
  assert.ok(ix.programId.equals(PROGRAM_ID));
  const keys = ix.keys.map((k) => k.pubkey.toBase58());
  // 8 named accounts in IDL order, then the remaining accounts.
  assert.equal(keys.length, 10);
  assert.equal(keys[0], creator.toBase58());
  assert.equal(keys[1], fundPda(nft).toBase58());
  assert.equal(keys[2], nft.toBase58());
  assert.ok(ix.keys[2]!.isSigner, "nft mint signs");
  assert.equal(keys[4], quote.toBase58());
  assert.equal(keys[5], TOKEN_PROGRAM_ID.toBase58());
  assert.equal(keys[6], ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
  assert.equal(keys[7], SystemProgram.programId.toBase58());
  assert.deepEqual(keys.slice(8), [a.toBase58(), b.toBase58()]);
  // The args round-trip through the IDL coder.
  // The runtime coder is BorshInstructionCoder, which has decode.
  const coder = program.coder.instruction as unknown as { decode(data: Buffer): unknown };
  const decoded = coder.decode(ix.data) as {
    name: string;
    data: { params: { targets: Array<{ mint: PublicKey; pool: PublicKey; bps: number }>; maxDevBps: number } };
  };
  assert.equal(decoded.name, "createFund");
  assert.equal(decoded.data.params.maxDevBps, 100);
  assert.deepEqual(
    decoded.data.params.targets.map((t) => [t.mint.toBase58(), t.pool.toBase58(), t.bps]),
    targets.map((t) => [t.mint.toBase58(), t.pool.toBase58(), t.bps]),
  );
});

test("pool check requires XDEX ownership and the quote/target mints", () => {
  const quote = new PublicKey(QUOTE);
  const target = { mint: new PublicKey(TEST_MINT), pool: new PublicKey(POOL), bps: 10_000 };
  const k = () => Keypair.generate().publicKey;
  const pool = (m0: PublicKey, m1: PublicKey): PoolAccounts => ({
    ammConfig: k(),
    token0Vault: k(),
    token1Vault: k(),
    token0Mint: m0,
    token1Mint: m1,
    token0Program: k(),
    token1Program: k(),
    observation: k(),
  });
  checkPool(0, target, quote, XDEX_PROGRAM_ID, pool(quote, target.mint), XDEX_PROGRAM_ID);
  checkPool(0, target, quote, XDEX_PROGRAM_ID, pool(target.mint, quote), XDEX_PROGRAM_ID);
  assert.throws(() => checkPool(0, target, quote, k(), pool(quote, target.mint), XDEX_PROGRAM_ID), /not XDEX/);
  assert.throws(() => checkPool(0, target, quote, XDEX_PROGRAM_ID, pool(quote, k()), XDEX_PROGRAM_ID), /not quote/);
});

test("send gate refuses without every flag", () => {
  const opts = (o: Partial<CommonOptions>): CommonOptions => ({
    send: false,
    cluster: undefined,
    iUnderstandMainnet: false,
    payer: undefined,
    rpcUrl: undefined,
    xdex: undefined,
    ...o,
  });
  const localGenesis = "11111111111111111111111111111111";
  // No --send: simulate, whatever else is set.
  assert.deepEqual(
    sendGate({ options: opts({ cluster: "localnet" }), genesisHash: localGenesis, rpcUrl: LOCAL, keypairEnv: "/k.json" }),
    { send: false },
  );
  // --send without KEYPAIR.
  assert.throws(
    () => sendGate({ options: opts({ send: true, cluster: "localnet" }), genesisHash: localGenesis, rpcUrl: LOCAL, keypairEnv: undefined }),
    /needs KEYPAIR/,
  );
  // --send without --cluster.
  assert.throws(
    () => sendGate({ options: opts({ send: true }), genesisHash: localGenesis, rpcUrl: LOCAL, keypairEnv: "/k.json" }),
    /requires --cluster/,
  );
  // --cluster that does not match the genesis hash.
  assert.throws(
    () =>
      sendGate({
        options: opts({ send: true, cluster: "localnet" }),
        genesisHash: X1_TESTNET_GENESIS_HASH,
        rpcUrl: "https://rpc.testnet.x1.xyz",
        keypairEnv: "/k.json",
      }),
    /is testnet/,
  );
  // Unknown non-loopback chain.
  assert.throws(
    () =>
      sendGate({
        options: opts({ send: true, cluster: "localnet" }),
        genesisHash: localGenesis,
        rpcUrl: "https://rpc.example.com",
        keypairEnv: "/k.json",
      }),
    /not X1 mainnet or testnet/,
  );
  // Mainnet without --i-understand-mainnet.
  const mainnet = { genesisHash: X1_MAINNET_GENESIS_HASH, rpcUrl: "https://rpc.mainnet.x1.xyz", keypairEnv: "/k.json" };
  assert.throws(() => sendGate({ options: opts({ send: true, cluster: "mainnet" }), ...mainnet }), /--i-understand-mainnet/);
  // All flags present.
  assert.deepEqual(
    sendGate({ options: opts({ send: true, cluster: "mainnet", iUnderstandMainnet: true }), ...mainnet }),
    { send: true, cluster: "mainnet" },
  );
  assert.deepEqual(
    sendGate({ options: opts({ send: true, cluster: "localnet" }), genesisHash: localGenesis, rpcUrl: LOCAL, keypairEnv: "/k.json" }),
    { send: true, cluster: "localnet" },
  );
});

test("helpers: UI units, compute budget, ATA idempotent instruction", () => {
  assert.equal(formatUi(1_000_000n, 6), "1");
  assert.equal(formatUi(1_500n, 6), "0.0015");
  assert.equal(formatUi(42n, 0), "42");
  const budget = computeBudget({ COMPUTE_UNIT_LIMIT: "200000", PRIORITY_FEE_MICROLAMPORTS: "5" });
  assert.equal(budget.unitLimit, 200000);
  assert.equal(budget.microLamports, 5);
  assert.equal(budget.instructions.length, 2);
  assert.equal(computeBudget({}).unitLimit, 400000);
  assert.throws(() => computeBudget({ COMPUTE_UNIT_LIMIT: "1400001" }), /between/);
  const payer = Keypair.generate().publicKey;
  const owner = Keypair.generate().publicKey;
  const ix = createAtaIdempotentIx(payer, owner, new PublicKey(QUOTE), TOKEN_PROGRAM_ID);
  assert.ok(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
  assert.deepEqual([...ix.data], [1]);
  assert.ok(ix.keys[0]!.isSigner && ix.keys[0]!.pubkey.equals(payer));
  assert.ok(ix.keys[2]!.pubkey.equals(owner));
});

// ---- create-fund transaction sizes ----

const sizeProgram = createProgram(
  new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
);

function mintMeta(tokenProgram: PublicKey): MintMeta {
  return { address: Keypair.generate().publicKey, tokenProgram, decimals: 6, transferFee: undefined };
}

/** Plan for `nonCash` distinct Token-2022 targets, optionally plus a cash slice. */
async function sizedPlan(quoteProgram: PublicKey, nonCash: number, cash: boolean) {
  const payer = Keypair.generate().publicKey;
  const quote = mintMeta(quoteProgram);
  const mints = Array.from({ length: nonCash }, () => mintMeta(TOKEN_2022_PROGRAM_ID));
  const targets = mints.map((m) => ({ mint: m.address, pool: Keypair.generate().publicKey, bps: 1 }));
  if (cash) targets.unshift({ mint: quote.address, pool: PublicKey.default, bps: 1 });
  const args = { quote: quote.address, targets, perRun: 1n, interval: 60n, window: 900, maxDevBps: 0 };
  const plan = await planCreateFund(sizeProgram, payer, Keypair.generate(), args, quote, mints, computeBudget({}).instructions);
  return { payer, plan, sizes: plan.map((tx) => txSize(payer, tx.instructions)) };
}

test("create-fund transaction sizes: what fits and what is refused", async () => {
  // Expected tx 1 size by non-cash target count, Token-2022 quote, with the
  // compute-budget instructions. Measured offline; each target adds 99 bytes
  // (66 bytes of params + a 32-byte remaining account + 1).
  const t22 = [724, 824, 923, 1022, 1121, 1220, 1319, 1418];
  for (let n = 1; n <= 8; n++) {
    const { payer, plan, sizes } = await sizedPlan(TOKEN_2022_PROGRAM_ID, n, false);
    assert.equal(sizes[0], t22[n - 1], `t22 quote, ${n} targets`);
    // tx 2 (target vaults) always fits, even with 8 targets.
    assert.ok(sizes[1]! <= MAX_TX_BYTES, `tx 2 with ${n} targets is ${sizes[1]}`);
    if (n <= 6) {
      assert.doesNotThrow(() => assertPlanFits(payer, plan));
    } else {
      assert.throws(
        () => assertPlanFits(payer, plan),
        new RegExp(`tx 1/2 \\(create_fund \\+ quote vault\\) is ${t22[n - 1]} bytes; the limit is 1232\\. Nothing was simulated or sent`),
      );
    }
  }
  // With a cash slice the cash target costs 66 bytes but no remaining account.
  // Token-2022 quote: cash + 5 = 1187 fits, cash + 6 = 1286 does not.
  // Classic quote: cash + 5 = 1155 fits, cash + 6 = 1254 does not.
  for (const qp of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
    let maxFit = -1;
    for (let n = 0; n <= 7; n++) {
      const { payer, plan } = await sizedPlan(qp, n, true);
      try {
        assertPlanFits(payer, plan);
        maxFit = n;
      } catch (err) {
        assert.match(String(err), /the limit is 1232/);
      }
    }
    assert.equal(maxFit, 5, `${qp.toBase58()} quote with a cash slice fits cash + 5 targets`);
  }
  // Classic quote, no cash slice: 6 fit (1188), 7 do not (1287).
  const classic6 = await sizedPlan(TOKEN_PROGRAM_ID, 6, false);
  const classic7 = await sizedPlan(TOKEN_PROGRAM_ID, 7, false);
  assert.deepEqual([classic6.sizes[0], classic7.sizes[0]], [1188, 1287]);
  assert.doesNotThrow(() => assertPlanFits(classic6.payer, classic6.plan));
  assert.throws(() => assertPlanFits(classic7.payer, classic7.plan), /1287 bytes/);
});

test("create-fund plan: tx 1 has create_fund and the quote vault, tx 2 the target vaults", async () => {
  const { plan } = await sizedPlan(TOKEN_2022_PROGRAM_ID, 2, true);
  assert.equal(plan.length, 2);
  assert.equal(plan[0]!.extraSigners.length, 1, "the NFT mint signs tx 1");
  // compute limit, compute price, create_fund, quote ATA
  assert.deepEqual(
    plan[0]!.instructions.map((ix) => ix.programId.toBase58()),
    [
      "ComputeBudget111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111",
      PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    ],
  );
  assert.equal(plan[1]!.instructions.filter((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).length, 2);
  // A cash-only fund has no tx 2.
  const cashOnly = await sizedPlan(TOKEN_2022_PROGRAM_ID, 0, true);
  assert.equal(cashOnly.plan.length, 1);
  // fundVaults lists the quote vault first, then targets, as ATAs of the fund.
  const fund = Keypair.generate().publicKey;
  const q = mintMeta(TOKEN_2022_PROGRAM_ID);
  const t = mintMeta(TOKEN_PROGRAM_ID);
  const vaults = fundVaults(fund, q, [t]);
  assert.equal(vaults.length, 2);
  const [expectedQuote] = PublicKey.findProgramAddressSync(
    [fund.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), q.address.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  assert.ok(vaults[0]!.vault.equals(expectedQuote));
});

test("partial failure message is honest about what was sent", async () => {
  const { plan: txs } = await sizedPlan(TOKEN_2022_PROGRAM_ID, 1, true);
  const fund = Keypair.generate().publicKey;
  const plan = { txs, fund, recovery: `npx tsx src/cli.ts ensure-vaults --fund ${fund.toBase58()}` };
  const done = [{ label: txs[0]!.label, signature: "SIG1" }];

  // tx 1 confirmed, tx 2 rejected before landing.
  const notSent = partialFailureMessage(plan, done, 1, "was rejected before landing: boom", "not sent");
  assert.match(notSent, /confirmed before the failure:\n {2}tx 1\/2 \(create_fund \+ quote vault\): SIG1/);
  assert.match(notSent, /not sent: tx 2\/2 \(target vaults\)/);
  assert.match(notSent, new RegExp(`fund PDA: ${fund.toBase58()}`));
  assert.match(notSent, /recovery: npx tsx src\/cli\.ts ensure-vaults/);
  assert.doesNotMatch(notSent, /nothing (was )?sent|no transaction was sent/i);

  // tx 2 sent but unconfirmed: not listed as "not sent".
  const unknown = partialFailureMessage(plan, done, 1, "SIG2 was sent but its status is unknown", "unknown");
  assert.match(unknown, /may or may not have landed/);
  assert.match(unknown, /every transaction was submitted/);
  assert.match(unknown, /recovery:/);

  // tx 1 rejected: nothing confirmed, both listed as not sent, no recovery needed.
  const first = partialFailureMessage(plan, [], 0, "was rejected before landing: boom", "not sent");
  assert.match(first, /no earlier transaction confirmed/);
  assert.match(first, /not sent: tx 1\/2 \(create_fund \+ quote vault\), tx 2\/2 \(target vaults\)/);
  assert.doesNotMatch(first, /recovery:/);
});

test("ensure-vaults parses", () => {
  const parsed = parseCli(["ensure-vaults", "--fund", QUOTE, "--payer", QUOTE]);
  assert.equal(parsed.command, "ensure-vaults");
  assert.throws(() => parseCli(["ensure-vaults"]), /requires --fund/);
  assert.throws(() => parseCli(["ensure-vaults", "--fund", QUOTE, "--amount", "1"]), /unknown or misplaced/);
});

test("transfer fee: TLV parse and fee math", () => {
  // Mint base (82) + padding to 165 + account type + one TLV entry of type 1.
  const data = Buffer.alloc(166 + 4 + 108);
  data[165] = 1;
  data.writeUInt16LE(1, 166);
  data.writeUInt16LE(108, 168);
  const value = 170;
  // older: epoch 0, max 1000, 100 bps; newer: epoch 10, max u64::MAX, 500 bps
  data.writeBigUInt64LE(0n, value + 72);
  data.writeBigUInt64LE(1000n, value + 80);
  data.writeUInt16LE(100, value + 88);
  data.writeBigUInt64LE(10n, value + 90);
  data.writeBigUInt64LE((1n << 64n) - 1n, value + 98);
  data.writeUInt16LE(500, value + 106);
  const cfg = readTransferFeeConfig(data)!;
  assert.equal(cfg.older.basisPoints, 100);
  assert.equal(cfg.newer.basisPoints, 500);
  // Before epoch 10 the older fee applies, capped at 1000.
  assert.equal(transferFeeFor(cfg, 1_000n, 5n), 10n);
  assert.equal(transferFeeFor(cfg, 1_000_000n, 5n), 1000n);
  // From epoch 10 the newer fee applies; ceil(1001 * 500 / 10000) = 51.
  assert.equal(transferFeeFor(cfg, 1_001n, 10n), 51n);
  assert.equal(transferFeeFor(undefined, 1_000n, 10n), 0n);
  // No extension: classic-length mint, or Token-2022 mint without type 1.
  assert.equal(readTransferFeeConfig(Buffer.alloc(82)), undefined);
  const noFee = Buffer.alloc(170);
  noFee[165] = 1;
  assert.equal(readTransferFeeConfig(noFee), undefined);
});

test("withdraw-native parses raw lamports and all, and nothing else", () => {
  const raw = parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "1500000", "--payer", QUOTE]);
  assert.equal(raw.command, "withdraw-native");
  if (raw.command !== "withdraw-native") return;
  assert.ok(raw.fund.equals(new PublicKey(QUOTE)));
  assert.equal(raw.amount, 1_500_000n);
  assert.ok(raw.options.payer!.equals(new PublicKey(QUOTE)));
  assert.equal(raw.options.send, false);
  const all = parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "all"]);
  assert.equal(all.command === "withdraw-native" && all.amount, "all");
  const max = parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "18446744073709551615"]);
  assert.equal(max.command === "withdraw-native" && max.amount, (1n << 64n) - 1n);

  assert.throws(() => parseCli(["withdraw-native", "--fund", QUOTE]), /requires --amount/);
  assert.throws(() => parseCli(["withdraw-native", "--amount", "1"]), /requires --fund/);
  assert.throws(() => parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "0"]), /greater than zero/);
  assert.throws(() => parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "1.5"]), /non-negative integer/);
  assert.throws(() => parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "-1"]), /non-negative integer/);
  assert.throws(() => parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "ALL"]), /non-negative integer/);
  assert.throws(
    () => parseCli(["withdraw-native", "--fund", QUOTE, "--amount", "18446744073709551616"]),
    /exceeds/,
  );
  // No token mint: --mint belongs to withdraw.
  assert.throws(
    () => parseCli(["withdraw-native", "--fund", QUOTE, "--mint", QUOTE, "--amount", "1"]),
    /unknown or misplaced/,
  );
  assert.throws(() => parseCli(["withdraw-native", "--fund", QUOTE, "--fund", QUOTE, "--amount", "1"]), /more than once/);
  assert.match(USAGE, /withdraw-native --fund <pda> --amount <lamports\|all>/);
});

test("withdraw-native carries the same send flags as withdraw through the same gate", () => {
  const argv = ["withdraw-native", "--fund", QUOTE, "--amount", "all"];
  const mainnet = { genesisHash: X1_MAINNET_GENESIS_HASH, rpcUrl: "https://rpc.mainnet.x1.xyz", keypairEnv: "/k.json" };
  // Simulate-only without --send, even with KEYPAIR set.
  assert.deepEqual(sendGate({ options: parseCli(argv).options, ...mainnet }), { send: false });
  // --send alone, then without --i-understand-mainnet, are refused.
  assert.throws(() => sendGate({ options: parseCli([...argv, "--send"]).options, ...mainnet }), /requires --cluster/);
  assert.throws(
    () => sendGate({ options: parseCli([...argv, "--send", "--cluster", "mainnet"]).options, ...mainnet }),
    /--i-understand-mainnet/,
  );
  assert.throws(
    () => sendGate({ options: parseCli([...argv, "--send", "--cluster", "testnet"]).options, ...mainnet }),
    /is mainnet/,
  );
  assert.throws(
    () =>
      sendGate({
        options: parseCli([...argv, "--send", "--cluster", "mainnet", "--i-understand-mainnet"]).options,
        ...mainnet,
        keypairEnv: undefined,
      }),
    /needs KEYPAIR/,
  );
  assert.deepEqual(
    sendGate({ options: parseCli([...argv, "--send", "--cluster", "mainnet", "--i-understand-mainnet"]).options, ...mainnet }),
    { send: true, cluster: "mainnet" },
  );
});

test("native available is lamports above the rent-exempt minimum", () => {
  const rent = 3_000_000n;
  assert.equal(nativeAvailable(rent, rent), 0n);
  assert.equal(nativeAvailable(rent - 1n, rent), 0n);
  assert.equal(nativeAvailable(0n, rent), 0n);
  assert.equal(nativeAvailable(rent + 1n, rent), 1n);
  assert.equal(nativeAvailable(rent + 123_456n, rent), 123_456n);
});

test("withdraw_native builder names the program's accounts in IDL order", async () => {
  const program = createProgram(
    new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
  );
  const holder = Keypair.generate().publicKey;
  const nftMint = Keypair.generate().publicKey;
  const nftAccount = Keypair.generate().publicKey;
  const ix = await buildWithdrawNativeIx(program, { holder, nftMint, nftAccount }, 4_200n);
  assert.ok(ix.programId.equals(PROGRAM_ID));
  assert.deepEqual(
    ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [holder.toBase58(), true, true],
      [fundPda(nftMint).toBase58(), false, true],
      [nftMint.toBase58(), false, false],
      [nftAccount.toBase58(), false, false],
      [NFT_TOKEN_PROGRAM_ID.toBase58(), false, false],
    ],
  );
  // Discriminator sha256("global:withdraw_native")[..8], then amount u64 LE.
  const disc = createHash("sha256").update("global:withdraw_native").digest().subarray(0, 8);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...disc]);
  assert.equal(ix.data.length, 16);
  assert.equal(ix.data.readBigUInt64LE(8), 4_200n);
  await assert.rejects(buildWithdrawNativeIx(program, { holder, nftMint, nftAccount }, 0n), /greater than zero/);
  await assert.rejects(buildWithdrawNativeIx(program, { holder, nftMint, nftAccount }, 1n << 64n), /exceeds u64/);

  // The IDL appends the instruction and the error; earlier ones keep their codes.
  const names = IDL.instructions.map((i) => i.name);
  assert.equal(names[names.length - 1], "withdraw_native");
  const errors = IDL.errors ?? [];
  const native = errors.find((e) => e.name === "NativeAboveAvailable");
  assert.equal(native?.code, 6054);
  assert.equal(errors.find((e) => e.name === "PayerChanged")?.code, 6053);
  assert.equal(Math.max(...errors.map((e) => e.code)), 6054);
});

test("readNativeBalance marks lamport counts a JS number cannot hold exactly as inexact", async () => {
  const fund = Keypair.generate().publicKey;
  const fake = (lamports: number, rent: number) =>
    ({
      getAccountInfo: async () => ({ lamports, data: Buffer.alloc(755), owner: PROGRAM_ID, executable: false }),
      getMinimumBalanceForRentExemption: async () => rent,
    }) as unknown as Connection;
  const max = Number.MAX_SAFE_INTEGER; // 2^53 - 1
  const ok = await readNativeBalance(fake(max, 6_145_680), fund);
  assert.ok(ok.exact);
  if (!ok.exact) return;
  assert.equal(ok.lamports, 9_007_199_254_740_991n);
  assert.equal(ok.rentMinimum, 6_145_680n);
  assert.equal(ok.available, 9_007_199_254_740_991n - 6_145_680n);
  assert.equal(ok.dataLength, 755);
  // 2^53 + 1 is not representable; the parsed number is already rounded.
  for (const [lamports, rent] of [[2 ** 53 + 1, 6_145_680], [2 ** 53, 6_145_680], [10_000_000, 2 ** 53 + 1]] as const) {
    const b = await readNativeBalance(fake(lamports, rent), fund);
    assert.equal(b.exact, false, `${lamports}/${rent}`);
    assert.equal(b.dataLength, 755);
  }
  assert.equal(exactLamports(0, "x"), 0n);
  assert.throws(() => exactLamports(2 ** 53 + 1, "x"), /too large to read exactly; use --amount <lamports>/);
  assert.throws(() => exactLamports(-1, "x"), /too large to read exactly/);
});

test("prepareWithdrawNative: exact balances are checked; an inexact one allows only an explicit amount", async () => {
  const provider = new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {});
  const program = createProgram(provider);
  const holder = Keypair.generate().publicKey;
  const nftMint = Keypair.generate().publicKey;
  const nftAccount = Keypair.generate().publicKey;
  const fund = fundPda(nftMint);
  const fundData = await program.coder.accounts.encode(FUND_ACCOUNT, {
    nftMint,
    quoteMint: new PublicKey(QUOTE),
    bump: 254,
    perRunQuote: new BN(100_000),
    intervalSecs: new BN(3_600),
    twapWindowSecs: 3_600,
    maxDevBps: 300,
    targets: [{ mint: new PublicKey(QUOTE), pool: PublicKey.default, bps: 10_000, budget: new BN(0), lastRun: new BN(0) }],
  });
  const nftData = Buffer.alloc(165);
  nftMint.toBuffer().copy(nftData, 0);
  holder.toBuffer().copy(nftData, 32);
  const RENT = 6_145_680;
  const connectionWith = (lamports: number) =>
    ({
      getAccountInfo: async (key: PublicKey) => {
        if (key.equals(fund)) return { lamports, data: fundData, owner: PROGRAM_ID, executable: false };
        if (key.equals(nftAccount)) return { lamports: 2_039_280, data: nftData, owner: TOKEN_PROGRAM_ID, executable: false };
        return null;
      },
      getMinimumBalanceForRentExemption: async () => RENT,
      getTokenLargestAccounts: async () => ({ value: [{ address: nftAccount, amount: "1" }] }),
    }) as unknown as Connection;
  const ctx = (lamports: number) => ({ connection: connectionWith(lamports), program, payer: holder, budget: [] });
  const amountOf = (ix: { data: Buffer }) => ix.data.readBigUInt64LE(8);

  // Exact: all = lamports - rent; above available and nothing available are refused.
  const exact = await prepareWithdrawNative(ctx(RENT + 500_000_000), fund, "all");
  assert.equal(exact.summary.amount, 500_000_000n);
  assert.ok(exact.summary.balance.exact);
  assert.ok(exact.summary.payerHoldsNft);
  assert.equal(amountOf(exact.plan.txs[0]!.instructions.at(-1)! as { data: Buffer }), 500_000_000n);
  await assert.rejects(prepareWithdrawNative(ctx(RENT + 500_000_000), fund, 500_000_001n), /exceeds the 0.5 XNT available/);
  await assert.rejects(prepareWithdrawNative(ctx(RENT), fund, "all"), /no native XNT above its rent-exempt minimum/);

  // Inexact (2^53 + 1 lamports): `all` is refused, an explicit amount is built
  // unchecked and left to the program's rent floor.
  const big = 2 ** 53 + 1;
  await assert.rejects(prepareWithdrawNative(ctx(big), fund, "all"), /too large to read exactly; use --amount <lamports>/);
  const explicit = await prepareWithdrawNative(ctx(big), fund, 9_007_199_254_740_993n);
  assert.equal(explicit.summary.balance.exact, false);
  assert.equal(explicit.summary.amount, 9_007_199_254_740_993n);
  assert.equal(amountOf(explicit.plan.txs[0]!.instructions.at(-1)! as { data: Buffer }), 9_007_199_254_740_993n);
  await assert.rejects(prepareWithdrawNative(ctx(big), fund, 0n), /greater than zero/);
});
