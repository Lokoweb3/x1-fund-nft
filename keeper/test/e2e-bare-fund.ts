/**
 * e2e helper, localnet only: send create_fund WITHOUT the vault ATAs, to
 * reproduce "tx 1 confirmed, tx 2 never sent" so e2e-local.sh can check that
 * `ensure-vaults` recovers it. Refuses any RPC that is not a loopback
 * validator with a non-X1 genesis.
 *
 *   KEYPAIR=<work dir key> RPC_URL=http://127.0.0.1:<port> npx tsx test/e2e-bare-fund.ts \
 *     <quote> <cash bps> <target mint> <pool> <target bps>
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { clusterFromGenesisHash } from "../src/cluster.js";
import { createProgram } from "../src/fund.js";
import { buildCreateFundIx, fundPda, validateCreateFund, type CreateFundArgs } from "../src/owner.js";

const require = createRequire(import.meta.url);
const { AnchorProvider, Wallet } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL;
  const keyFile = process.env.KEYPAIR;
  if (!rpcUrl || !keyFile) throw new Error("RPC_URL and KEYPAIR are required");
  const connection = new Connection(rpcUrl, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (clusterFromGenesisHash(genesis, rpcUrl) !== "localnet") {
    throw new Error(`refusing: ${rpcUrl} (genesis ${genesis}) is not a loopback local validator`);
  }
  const [quote, cashBps, target, pool, targetBps] = process.argv.slice(2);
  if (!quote || !cashBps || !target || !pool || !targetBps) throw new Error("usage: <quote> <cash bps> <mint> <pool> <bps>");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyFile, "utf8")) as number[]));
  const program = createProgram(new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" }));
  const quoteKey = new PublicKey(quote);
  const args: CreateFundArgs = {
    quote: quoteKey,
    targets: [
      { mint: quoteKey, pool: PublicKey.default, bps: Number(cashBps) },
      { mint: new PublicKey(target), pool: new PublicKey(pool), bps: Number(targetBps) },
    ],
    perRun: 100_000n,
    interval: 3_600n,
    window: 3_600,
    maxDevBps: 300,
  };
  validateCreateFund(args);
  const nft = Keypair.generate();
  const ix = await buildCreateFundIx(program, { creator: payer.publicKey, nftMint: nft.publicKey, quoteMint: quoteKey }, args);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToLegacyMessage(),
  );
  tx.sign([payer, nft]);
  const signature = await connection.sendRawTransaction(tx.serialize());
  const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (result.value.err) throw new Error(`create_fund failed: ${JSON.stringify(result.value.err)}`);
  console.log(`bare create_fund confirmed: ${signature}`);
  console.log(`fund PDA: ${fundPda(nft.publicKey).toBase58()}`);
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
