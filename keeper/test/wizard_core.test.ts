/**
 * Core changes the web app's wizard relies on: prepareCreateFund accepts a
 * caller-chosen NFT mint keypair (so the fund PDA can be written into the
 * metadata JSON first), and inscription plans mark every transaction after
 * the first as depending on the previous one (it cannot be pre-simulated).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AnchorProvider, type Wallet } from "@anchor-lang/core";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { createProgram } from "../src/core/fund.js";
import { decodeInscriptionConfig, planInscribe } from "../src/core/inscribe.js";
import { fundPda, XDEX_PROGRAM_ID } from "../src/core/owner.js";
import { POOL_DISCRIMINATOR, POOL_LEN, TOKEN_2022_PROGRAM_ID } from "../src/core/pool.js";
import { prepareCreateFund } from "../src/core/rpc.js";

function mint(decimals: number): Uint8Array {
  const d = new Uint8Array(82);
  d[44] = decimals;
  d[45] = 1;
  return d;
}

test("prepareCreateFund uses the NFT mint keypair it is given", async () => {
  const quote = Keypair.generate().publicKey;
  const target = Keypair.generate().publicKey;
  const pool = Keypair.generate().publicKey;
  const poolData = new Uint8Array(POOL_LEN);
  poolData.set(POOL_DISCRIMINATOR, 0);
  poolData.set(quote.toBytes(), 168);
  poolData.set(target.toBytes(), 200);
  const accounts = new Map<string, { owner: PublicKey; data: Uint8Array; executable: boolean; lamports: number }>([
    [quote.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: mint(6), executable: false, lamports: 1 }],
    [target.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: mint(9), executable: false, lamports: 1 }],
    [pool.toBase58(), { owner: XDEX_PROGRAM_ID, data: poolData, executable: false, lamports: 1 }],
  ]);
  const connection = { getAccountInfo: async (k: PublicKey) => accounts.get(k.toBase58()) ?? null } as unknown as Connection;
  const payer = Keypair.generate().publicKey;
  const program = createProgram(new AnchorProvider(connection, { publicKey: payer } as unknown as Wallet, {}));
  const nft = Keypair.generate();
  const args = {
    quote,
    targets: [
      { mint: quote, pool: PublicKey.default, bps: 2000 },
      { mint: target, pool, bps: 8000 },
    ],
    perRun: 100_000n,
    interval: 3600n,
    window: 3600,
    maxDevBps: 300,
  };
  const p = await prepareCreateFund({ connection, program, payer, budget: [] }, args, XDEX_PROGRAM_ID, undefined, nft);
  assert.equal(p.nft, nft);
  assert.ok(p.fund.equals(fundPda(nft.publicKey)));
  assert.deepEqual(p.plan.txs[0]!.extraSigners, [nft]);
  // Without one, a fresh key every time.
  const q = await prepareCreateFund({ connection, program, payer, budget: [] }, args, XDEX_PROGRAM_ID);
  assert.ok(!q.nft.publicKey.equals(nft.publicKey));
});

test("inscription plans: only the first transaction can be pre-simulated", () => {
  const f = JSON.parse(readFileSync(new URL("fixtures/x1-inscriptions-config.json", import.meta.url), "utf8")) as { dataBase64: string };
  const config = decodeInscriptionConfig(Uint8Array.from(Buffer.from(f.dataBase64, "base64")));
  const payer = Keypair.generate().publicKey;
  const content = new TextEncoder().encode(JSON.stringify({ name: "x", pad: "y".repeat(1500) }));
  const plan = planInscribe({ payer, content, contentType: "application/json", maxFee: config.fees.inscribe, config });
  assert.equal(plan.txs.length, 3);
  assert.deepEqual(plan.txs.map((t) => t.dependsOnPrevious === true), [false, true, true]);
  const one = planInscribe({ payer, content: new TextEncoder().encode("{}"), contentType: "application/json", maxFee: config.fees.inscribe, config });
  assert.equal(one.txs[0]!.dependsOnPrevious, undefined);
});
