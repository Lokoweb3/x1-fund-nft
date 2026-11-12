import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  assertSendAllowed,
  clusterFromGenesisHash,
  X1_MAINNET_GENESIS_HASH,
  X1_TESTNET_GENESIS_HASH,
} from "../src/cluster.js";
import { createProgram, decodeFund, dueTargets, FUND_ACCOUNT, fundFilters, IDL } from "../src/fund.js";

const require = createRequire(import.meta.url);
const { AnchorProvider, BN, utils, Wallet } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

// Offline: the connection is never used.
const provider = new AnchorProvider(
  new Connection("http://127.0.0.1:1"),
  new Wallet(Keypair.generate()),
  {},
);
const program = createProgram(provider);

const NOW = 1_800_000_000n;
const INTERVAL = 3_600;
const quoteMint = Keypair.generate().publicKey;
const targetMint = Keypair.generate().publicKey;
const otherMint = Keypair.generate().publicKey;
const pool = Keypair.generate().publicKey;

async function encodeFund(targets: Array<{ mint: PublicKey; budget: number; lastRun: number }>) {
  return program.coder.accounts.encode(FUND_ACCOUNT, {
    nftMint: Keypair.generate().publicKey,
    quoteMint,
    bump: 254,
    perRunQuote: new BN(1_000_000),
    intervalSecs: new BN(INTERVAL),
    twapWindowSecs: 600,
    maxDevBps: 300,
    targets: targets.map((t) => ({
      mint: t.mint,
      pool,
      bps: 5_000,
      budget: new BN(t.budget),
      lastRun: new BN(t.lastRun),
    })),
  });
}

test("encoded Fund decodes and its due target is selected", async () => {
  const data = await encodeFund([
    // Quote cash target: never cranked even with a budget and an old lastRun.
    { mint: quoteMint, budget: 500_000, lastRun: 0 },
    // Due: lastRun + interval == now.
    { mint: targetMint, budget: 500_000, lastRun: Number(NOW) - INTERVAL },
  ]);
  const filter = fundFilters(program)[0] as { memcmp: { offset: number; bytes: string } };
  assert.equal(filter.memcmp.offset, 0);
  const idlDiscriminator = IDL.accounts!.find((a) => a.name === "Fund")!.discriminator;
  assert.equal(filter.memcmp.bytes, utils.bytes.bs58.encode(Buffer.from(idlDiscriminator)));
  assert.deepEqual([...data.subarray(0, 8)], idlDiscriminator);

  const fundKey = Keypair.generate().publicKey;
  const decoded = decodeFund(program, data);
  assert.ok(decoded.quoteMint.equals(quoteMint));
  assert.equal(decoded.intervalSecs.toNumber(), INTERVAL);
  assert.equal(decoded.targets[1]!.lastRun.toNumber(), Number(NOW) - INTERVAL);

  const due = dueTargets(fundKey, decoded, NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0]!.targetIndex, 1);
  assert.ok(due[0]!.target.mint.equals(targetMint));
  assert.ok(due[0]!.fund.equals(fundKey));
});

test("non-due and empty-budget targets are skipped", async () => {
  const data = await encodeFund([
    { mint: targetMint, budget: 500_000, lastRun: Number(NOW) - INTERVAL + 1 },
    { mint: otherMint, budget: 0, lastRun: 0 },
  ]);
  const due = dueTargets(Keypair.generate().publicKey, decodeFund(program, data), NOW);
  assert.deepEqual(due, []);
});

test("decode rejects a non-Fund discriminator instead of returning garbage", async () => {
  const data = await encodeFund([{ mint: targetMint, budget: 1, lastRun: 0 }]);
  data[0] ^= 0xff;
  assert.throws(() => decodeFund(program, data));
});

test("cluster guard", () => {
  const base = { iUnderstandMainnet: false, rpcUrl: "http://127.0.0.1:8899" };
  assert.equal(clusterFromGenesisHash(X1_MAINNET_GENESIS_HASH), "mainnet");
  assert.equal(clusterFromGenesisHash(X1_TESTNET_GENESIS_HASH), "testnet");
  assert.equal(clusterFromGenesisHash("11111111111111111111111111111111"), "localnet");

  // Mismatched genesis hash is rejected.
  assert.throws(
    () => assertSendAllowed({ ...base, clusterFlag: "testnet", genesisHash: X1_MAINNET_GENESIS_HASH }),
    /--cluster testnet but .* is mainnet/,
  );
  assert.throws(
    () => assertSendAllowed({ ...base, clusterFlag: "localnet", genesisHash: X1_TESTNET_GENESIS_HASH }),
    /is testnet/,
  );
  // --cluster is required to send.
  assert.throws(
    () => assertSendAllowed({ ...base, clusterFlag: undefined, genesisHash: X1_TESTNET_GENESIS_HASH }),
    /requires --cluster/,
  );
  // Mainnet needs --i-understand-mainnet.
  assert.throws(
    () => assertSendAllowed({ ...base, clusterFlag: "mainnet", genesisHash: X1_MAINNET_GENESIS_HASH }),
    /--i-understand-mainnet/,
  );
  // URL fallback guard: mainnet-looking URL refused without the mainnet flags.
  assert.throws(
    () =>
      assertSendAllowed({
        clusterFlag: "localnet",
        genesisHash: "11111111111111111111111111111111",
        iUnderstandMainnet: false,
        rpcUrl: "https://rpc.mainnet.x1.xyz",
      }),
    /looks like X1 mainnet/,
  );
  // Allowed cases.
  assert.equal(
    assertSendAllowed({ ...base, clusterFlag: "testnet", genesisHash: X1_TESTNET_GENESIS_HASH }),
    "testnet",
  );
  assert.equal(
    assertSendAllowed({
      clusterFlag: "mainnet",
      genesisHash: X1_MAINNET_GENESIS_HASH,
      iUnderstandMainnet: true,
      rpcUrl: "https://rpc.mainnet.x1.xyz",
    }),
    "mainnet",
  );
});
