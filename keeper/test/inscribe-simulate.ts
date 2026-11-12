/**
 * Mainnet SIMULATE-ONLY run of planInscribe for a ~1.5 KB Metaplex JSON.
 *
 *   cd keeper && npx tsx test/inscribe-simulate.ts [PAYER_PUBKEY]
 *
 * It reads the live config, plans, and simulates each transaction with
 * sigVerify false and replaceRecentBlockhash. Nothing is signed or sent: no
 * keypair is loaded, and the only methods called are getAccountInfo,
 * getMultipleAccountsInfo and simulateTransaction.
 *
 * Each transaction is simulated against the current chain state on its own.
 * Only tx 1 (inscribe) can succeed this way. Each append needs the inscription
 * tx 1 would create, which does not exist on mainnet, so those simulations
 * fail with AccountNotInitialized. The local e2e (test/inscribe-e2e.sh) runs
 * the whole plan.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { compileTx, txSize } from "../src/core/owner.js";
import { fetchInscriptionConfig, inscriptionCollectionPda, inscriptionUri, MAINNET_GENESIS_POOL, prepareInscribe } from "../src/core/inscribe.js";

const RPC = "https://rpc.mainnet.x1.xyz";
const payer = new PublicKey(process.argv[2] ?? "99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM");
const MAX_FEE = 500_000_000n; // 0.5 XNT: the fee read on 2026-11-12. A higher live fee is refused.

/** A Metaplex-style fund NFT JSON padded to exactly `size` bytes. */
export function sampleMetadata(size: number): Uint8Array {
  const base = {
    name: "X1 Fund #1",
    symbol: "XFUND",
    description: "",
    image: "https://example.invalid/fund.png",
    external_url: "https://example.invalid/fund",
    attributes: [
      { trait_type: "quote", value: "USDC.X" },
      { trait_type: "targets", value: 3 },
      { trait_type: "interval_secs", value: 3600 },
    ],
    properties: { category: "image", files: [{ uri: "https://example.invalid/fund.png", type: "image/png" }] },
  };
  const empty = new TextEncoder().encode(JSON.stringify(base)).length;
  if (empty > size) throw new Error(`base JSON is already ${empty} bytes`);
  base.description = "x".repeat(size - empty);
  const out = new TextEncoder().encode(JSON.stringify(base));
  if (out.length !== size) throw new Error(`sample is ${out.length} bytes, wanted ${size}`);
  return out;
}

const connection = new Connection(RPC, "confirmed");
const content = sampleMetadata(1536);
const { treasury, paused, nextInscription } = await fetchInscriptionConfig(connection);
console.log(`config: next_inscription ${nextInscription}, paused ${paused}, treasury ${treasury.toBase58()}`);
const plan = await prepareInscribe(connection, { payer, content, contentType: "application/json", maxFee: MAX_FEE });
console.log(`payer ${payer.toBase58()}`);
console.log(`content ${content.length} bytes application/json`);
console.log(`predicted inscription #${plan.number}: ${plan.inscription.toBase58()}`);
console.log(`predicted Core asset: ${plan.asset.toBase58()}`);
console.log(`uri: ${plan.uri} (inscriptionUri check: ${plan.uri === inscriptionUri(plan.number)})`);
console.log(`inscribe fee (max_fee passed): ${plan.fee} lamports`);
console.log(`transactions: ${plan.txs.length}; chunks ${plan.chunks.join(" + ")}; sizes ${plan.sizes.join(", ")} bytes`);

for (const [i, tx] of plan.txs.entries()) {
  const ix = tx.instructions[tx.instructions.length - 1]!;
  const accounts = i === 0 ? [payer, treasury, MAINNET_GENESIS_POOL, plan.inscription, plan.asset, inscriptionCollectionPda()] : [];
  const pre = accounts.length ? await connection.getMultipleAccountsInfo(accounts, "confirmed") : [];
  const sim = await connection.simulateTransaction(compileTx(payer, tx, PublicKey.default.toBase58()), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
    ...(accounts.length ? { accounts: { encoding: "base64", addresses: accounts.map((a) => a.toBase58()) } } : {}),
  });
  console.log(`\n== tx ${i + 1}/${plan.txs.length}: ${tx.label} (${txSize(payer, tx.instructions)} bytes, ${ix.keys.length} accounts)`);
  const networkFee = await connection.getFeeForMessage(compileTx(payer, tx, (await connection.getLatestBlockhash("confirmed")).blockhash).message, "confirmed");
  console.log(`slot ${sim.context.slot}; err ${JSON.stringify(sim.value.err)}; units consumed ${sim.value.unitsConsumed}; network fee ${networkFee.value} lamports`);
  for (const line of sim.value.logs ?? []) console.log(`  ${line}`);
  if (accounts.length && sim.value.accounts) {
    const names = ["payer", "treasury", "genesis pool", "inscription", "asset", "collection"];
    sim.value.accounts.forEach((post, k) => {
      const before = BigInt(pre[k]?.lamports ?? 0);
      const after = BigInt(post?.lamports ?? 0);
      const len = post ? Buffer.from(post.data[0], "base64").length : 0;
      console.log(`  ${names[k]!.padEnd(12)} ${accounts[k]!.toBase58()} lamports ${before} -> ${after} (${after - before >= 0n ? "+" : ""}${after - before}), data ${len} bytes`);
    });
  }
}
console.log("\nnothing was signed or sent");
