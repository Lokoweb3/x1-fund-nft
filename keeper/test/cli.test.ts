import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { X1_MAINNET_GENESIS_HASH, X1_TESTNET_GENESIS_HASH } from "../src/cluster.js";
import { createProgram } from "../src/fund.js";
import {
  buildCreateFundIx,
  checkPool,
  computeBudget,
  createAtaIdempotentIx,
  createFundRemainingAccounts,
  formatUi,
  fundPda,
  parseCli,
  PROGRAM_ID,
  sendGate,
  validateCreateFund,
  XDEX_PROGRAM_ID,
  type CommonOptions,
  type CreateFundArgs,
} from "../src/owner.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, type PoolAccounts } from "../src/pool.js";

const require = createRequire(import.meta.url);
const { AnchorProvider, Wallet } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

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
