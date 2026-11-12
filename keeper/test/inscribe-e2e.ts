/**
 * e2e driver, localnet only: inscribe JSON through the X1 Inscriptions
 * program cloned from mainnet, then read the bytes back from chain.
 * test/inscribe-e2e.sh starts the validator and runs this. It refuses any
 * RPC that is not a loopback validator with a non-X1 genesis.
 *
 *   RPC_URL=http://127.0.0.1:<port> PAYER_KEY=<work dir key> RIVAL_KEY=<work dir key> npx tsx test/inscribe-e2e.ts
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { clusterFromGenesisHash } from "../src/core/cluster.js";
import { compileTx, PlanSendError, sendPlan, signatureOf, type Plan, type TxOutcome } from "../src/core/owner.js";
import {
  decodeInscription,
  fetchInscription,
  fetchInscriptionConfig,
  inscribeIx,
  inscriptionAssetPda,
  prepareInscribe,
  prepareInscribeResume,
  type InscribePlan,
} from "../src/core/inscribe.js";

let passed = 0;
let failed = 0;
const pass = (what: string) => {
  passed++;
  console.log(`PASS: ${what}`);
};
const fail = (what: string) => {
  failed++;
  console.log(`FAIL: ${what}`);
};
const check = (ok: boolean, what: string) => (ok ? pass(what) : fail(what));

const rpcUrl = process.env.RPC_URL ?? "";
const connection = new Connection(rpcUrl, "confirmed");
const genesis = await connection.getGenesisHash();
if (clusterFromGenesisHash(genesis, rpcUrl) !== "localnet") {
  throw new Error(`refusing: ${rpcUrl} (genesis ${genesis}) is not a loopback local validator`);
}
const key = (name: string) => {
  const file = process.env[name];
  if (!file) throw new Error(`${name} is required`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));
};
const payer = key("PAYER_KEY");
const rival = key("RIVAL_KEY");
const quiet = () => {};

function json(size: number, tag: string): Uint8Array {
  const base = { name: `Fund ${tag}`, symbol: "XFUND", description: "", image: "https://example.invalid/f.png", attributes: [{ trait_type: "tag", value: tag }] };
  const empty = new TextEncoder().encode(JSON.stringify(base)).length;
  base.description = "d".repeat(size - empty);
  const out = new TextEncoder().encode(JSON.stringify(base));
  if (out.length !== size) throw new Error("sample size");
  return out;
}

const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

async function units(done: TxOutcome[]): Promise<string> {
  const out: string[] = [];
  for (const d of done) {
    const tx = await connection.getTransaction(d.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    out.push(`${d.label}: ${tx?.meta?.computeUnitsConsumed} CU, fee ${tx?.meta?.fee}`);
  }
  return out.join("; ");
}

async function send(plan: Plan, signer: Keypair): Promise<TxOutcome[]> {
  return sendPlan({ connection, plan, payer: signer.publicKey, signers: [signer], rpcUrl, log: quiet });
}

/** Read the inscription back and compare every byte and header field. */
async function verify(plan: InscribePlan, content: Uint8Array, owner: PublicKey, label: string): Promise<void> {
  const ins = await fetchInscription(connection, plan.number);
  if (!ins) return fail(`${label}: inscription #${plan.number} missing`);
  check(equal(ins.content, content), `${label}: #${plan.number} bytes read back from chain equal the ${content.length}-byte JSON`);
  check(ins.sealed && ins.written === content.length && ins.totalSize === content.length, `${label}: sealed, written ${ins.written}/${ins.totalSize}`);
  check(ins.contentType === "application/json" && ins.encoding === 0, `${label}: content type ${ins.contentType}, encoding ${ins.encoding}`);
  check(ins.creator.equals(owner) && ins.owner.equals(owner) && ins.writer.equals(owner), `${label}: creator, owner and writer are the payer`);
  const info = await connection.getAccountInfo(plan.inscription, "confirmed");
  console.log(`    inscription account ${plan.inscription.toBase58()}: ${info?.data.length} bytes, ${info?.lamports} lamports`);
  const asset = await connection.getAccountInfo(inscriptionAssetPda(plan.number), "confirmed");
  if (!asset) return fail(`${label}: Core asset missing`);
  const assetOwner = new PublicKey(asset.data.subarray(1, 33));
  check(asset.owner.toBase58() === "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d" && asset.data[0] === 1, `${label}: asset is a Core AssetV1`);
  check(assetOwner.equals(owner), `${label}: the payer owns the Core asset ${plan.asset.toBase58()}`);
  // AssetV1: key, owner, update authority (u8 + 32), name, uri.
  const dv = new DataView(asset.data.buffer, asset.data.byteOffset);
  let o = 1 + 32 + 1 + 32;
  const nameLen = dv.getUint32(o, true);
  const name = new TextDecoder().decode(asset.data.subarray(o + 4, o + 4 + nameLen));
  o += 4 + nameLen;
  const uriLen = dv.getUint32(o, true);
  const uri = new TextDecoder().decode(asset.data.subarray(o + 4, o + 4 + uriLen));
  console.log(`    Core asset: ${asset.data.length} bytes, ${asset.lamports} lamports, name ${JSON.stringify(name)}, uri ${uri}`);
  const frozen = isFrozen(asset.data);
  check(!frozen, `${label}: the Core asset is not frozen`);
}

/**
 * Core plugin data: after the base asset comes a PluginHeaderV1 (key 3, u64
 * registry offset), and the registry (key 4) lists plugin records. A
 * FreezeDelegate record has PluginType 1 (Royalties 0, FreezeDelegate 1, ...). Its data is the Plugin enum tag, then one bool (frozen).
 */
function isFrozen(data: Uint8Array): boolean {
  const dv = new DataView(data.buffer, data.byteOffset);
  let o = 1 + 32 + 1 + 32;
  o += 4 + dv.getUint32(o, true);
  o += 4 + dv.getUint32(o, true);
  if (data[o] === 1) o += 9; else o += 1; // seq: Option<u64>
  if (o >= data.length) return false; // no plugins
  if (data[o] !== 3) throw new Error(`no plugin header at ${o}`);
  const registry = Number(dv.getBigUint64(o + 1, true));
  if (data[registry] !== 4) throw new Error(`no plugin registry at ${registry}`);
  const count = dv.getUint32(registry + 1, true);
  let r = registry + 5;
  for (let i = 0; i < count; i++) {
    const pluginType = data[r]!;
    // authority: u8 tag, plus 32 bytes for Address
    const authTag = data[r + 1]!;
    const after = r + 2 + (authTag === 3 ? 32 : 0);
    const offset = Number(dv.getBigUint64(after, true));
    if (pluginType === 1) return data[offset + 1] === 1; // plugin enum tag, then frozen
    r = after + 8;
  }
  return false;
}

const config0 = await fetchInscriptionConfig(connection);
console.log(`config: next ${config0.nextInscription}, fee ${config0.fees.inscribe}, paused ${config0.paused}, treasury ${config0.treasury.toBase58()}`);
check(!config0.paused, "cloned config is not paused");

// 1. The on-chain max_fee guard: a max_fee one lamport below the fee is refused.
{
  const n = config0.nextInscription;
  const ix = inscribeIx({
    creator: payer.publicKey,
    number: n,
    treasury: config0.treasury,
    contentType: "application/json",
    totalSize: 2,
    chunk: new TextEncoder().encode("{}"),
    encoding: 0,
    writer: null,
    maxFee: config0.fees.inscribe - 1n,
  });
  try {
    await send({ txs: [{ label: "inscribe with max_fee = fee - 1", instructions: [ix], extraSigners: [] }] }, payer);
    fail("max_fee below the fee was accepted");
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    check(/0x17b5|FeeChanged/.test(text), "program refuses max_fee = fee - 1 with FeeChanged (6069)");
    check(!(await connection.getAccountInfo(inscriptionAssetPda(n))), "nothing was created");
  }
}

// 2. The main run: a 1536-byte JSON, planned for the payer and for a rival from the same config read.
const content = json(1536, "main");
const rivalContent = json(1536, "rival");
const plan = await prepareInscribe(connection, { payer: payer.publicKey, content, contentType: "application/json", maxFee: config0.fees.inscribe });
const rivalPlan = await prepareInscribe(connection, { payer: rival.publicKey, content: rivalContent, contentType: "application/json", maxFee: config0.fees.inscribe });
check(plan.number === rivalPlan.number, `both plans predict #${plan.number}`);
check(plan.txs.length === 3,`1536 bytes plan as ${plan.txs.length} transactions (${plan.chunks.join(" + ")}), sizes ${plan.sizes.join(", ")}`);
const payerBefore = BigInt(await connection.getBalance(payer.publicKey, "confirmed"));
const done = await send(plan, payer);
check(done.length === plan.txs.length, `all ${done.length} transactions confirmed`);
console.log(`    ${await units(done)}`);
const payerAfter = BigInt(await connection.getBalance(payer.publicKey, "confirmed"));
console.log(`    payer spent ${payerBefore - payerAfter} lamports in total`);
await verify(plan, content, payer.publicKey, "main");
const config1 = await fetchInscriptionConfig(connection);
check(config1.nextInscription === plan.number + 1n, `config.next_inscription advanced to ${config1.nextInscription}`);

// 3. Race: the rival's plan still names #n, which is now taken.
{
  const rivalBefore = await connection.getBalance(rival.publicKey, "confirmed");
  try {
    await send(rivalPlan, rival);
    fail("a plan for a taken number was accepted");
  } catch (err) {
    const e = err as PlanSendError;
    const text = e instanceof Error ? e.message : String(e);
    check(/ConstraintSeeds|0x7d6/.test(text), "rival's tx 1 fails with ConstraintSeeds (2006): the number is taken");
    check(e instanceof PlanSendError && e.failedIndex === 0 && e.done.length === 0, "sendPlan stopped at tx 1; no append was sent");
  }
  const after = await fetchInscription(connection, plan.number);
  check(!!after && equal(after.content, content), `#${plan.number} still holds the payer's bytes`);
  check(!(await connection.getAccountInfo(inscriptionAssetPda(plan.number + 1n))), `nothing was written to #${plan.number + 1n}`);
  const rivalAfter = await connection.getBalance(rival.publicKey, "confirmed");
  check(rivalAfter === rivalBefore, `rival paid nothing (preflight refused it): ${rivalBefore} -> ${rivalAfter}`);
  // The append from the rival's plan, sent on its own, is refused: the rival is not #n's writer.
  try {
    await send({ txs: [rivalPlan.txs[1]!] }, rival);
    fail("rival's append to #n was accepted");
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    check(/Error Code|custom program error/.test(text), `rival's stray append to #${plan.number} is refused by the program`);
    console.log(`    ${(/Error Code: \w+|custom program error: 0x[0-9a-f]+/.exec(text) ?? [""])[0]}`);
  }
  const still = await fetchInscription(connection, plan.number);
  check(!!still && equal(still.content, content), `#${plan.number} bytes unchanged after the stray append`);
}

// 4. Resume: only tx 1 lands, then the rest is planned from chain state.
{
  const c2 = json(2000, "resume");
  const p2 = await prepareInscribe(connection, { payer: payer.publicKey, content: c2, contentType: "application/json", maxFee: config0.fees.inscribe });
  await send({ txs: [p2.txs[0]!] }, payer);
  const partial = await fetchInscription(connection, p2.number);
  check(!!partial && !partial.sealed && partial.written === 600, `resume: #${p2.number} has 600 of 2000 bytes after tx 1`);
  const partialAsset = await connection.getAccountInfo(p2.asset, "confirmed");
  check(!!partialAsset && isFrozen(partialAsset.data), `resume: #${p2.number}'s NFT is frozen while the upload is unfinished`);
  // Codex r: an append signed earlier and still in flight must block resume.
  // Hold tx 2 (the first append) signed but unsent, as a lost-response send would leave it.
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const held = compileTx(payer.publicKey, p2.txs[1]!, blockhash);
  held.sign([payer]);
  const heldSig = signatureOf(held);
  let blocked = false;
  try {
    await prepareInscribeResume(connection, {
      payer: payer.publicKey, number: p2.number, content: c2, contentType: "application/json",
      priorAttempts: [{ signature: heldSig, lastValidBlockHeight }],
    });
  } catch (err) {
    blocked = /not resuming yet/.test(String(err));
  }
  check(blocked, "resume refuses while an earlier append can still land");
  // The old append now lands late, exactly the race the guard exists for.
  const lateSig = await connection.sendRawTransaction(held.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: lateSig, blockhash, lastValidBlockHeight }, "confirmed");
  const afterLate = await fetchInscription(connection, p2.number);
  check(!!afterLate && afterLate.written === 1500, `the late append landed: #${p2.number} has ${afterLate?.written} bytes`);
  // Now settled (confirmed): resume reads fresh state and plans only what is really missing.
  const rest = await prepareInscribeResume(connection, {
    payer: payer.publicKey, number: p2.number, content: c2, contentType: "application/json",
    priorAttempts: [{ signature: heldSig, lastValidBlockHeight }],
  });
  check(rest.txs.length === p2.txs.length - 2, `resume after the late append plans the ${rest.txs.length} remaining transaction(s), not a duplicate`);
  await send(rest, payer);
  await verify(p2, c2, payer.publicKey, "resume");
  const again = await prepareInscribeResume(connection, { payer: payer.publicKey, number: p2.number, content: c2, contentType: "application/json", priorAttempts: [] });
  check(again.txs.length === 1 && again.txs[0]!.label.startsWith("thaw NFT"), "resume of a sealed inscription plans only the (no-op) thaw");
  await send(again, payer);
  await verify(p2, c2, payer.publicKey, "resume, thaw again");
}

// 5. A small JSON fits one transaction and is sealed at once.
{
  const c3 = json(600, "small");
  const p3 = await prepareInscribe(connection, { payer: payer.publicKey, content: c3, contentType: "application/json", maxFee: config0.fees.inscribe });
  check(p3.txs.length === 1, `600 bytes is one transaction (${p3.sizes[0]} bytes)`);
  const d3 = await send(p3, payer);
  console.log(`    ${await units(d3)}`);
  await verify(p3, c3, payer.publicKey, "small");
}

// 6. Decoding a raw account read matches fetchInscription.
{
  const info = await connection.getAccountInfo(plan.inscription, "confirmed");
  check(!!info && decodeInscription(info.data).number === plan.number, "decodeInscription reads the number back");
}

console.log(`\ninscribe-e2e driver: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
