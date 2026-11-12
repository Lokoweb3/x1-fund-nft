/**
 * Owner CLI for fund NFTs: create-fund, deposit, withdraw, show, ensure-vaults.
 *
 * Default is simulate-only. A send needs --send, KEYPAIR, and
 * `--cluster <mainnet|testnet|localnet>` matching the RPC's genesis hash
 * (src/cluster.ts); mainnet also needs --i-understand-mainnet. The genesis
 * hash is checked before any keypair is loaded. See README.md.
 *
 * A command may need more than one transaction (create-fund: create_fund +
 * quote vault, then the target vaults). They are not atomic. Every planned
 * transaction is size-checked and simulated before the first one is sent; if
 * a later one then fails to send or confirm, the CLI prints what did confirm,
 * what was not sent, and the recovery command.
 *
 * The planners (core/rpc.ts) and builders (core/owner.ts) are shared with the
 * web app in app/; this file only prints and signs with a Keypair.
 */
import { readFileSync } from "node:fs";
import { AnchorProvider, type Program as ProgramT, type Wallet } from "@anchor-lang/core";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { clusterFromGenesisHash, type DetectedCluster } from "./cluster.js";
import { createProgram } from "./fund.js";
import { TOKEN_2022_PROGRAM_ID } from "./pool.js";
import {
  assertPlanFits,
  computeBudget,
  ensureVaultsCommandLine,
  formatUi,
  keypairSigner,
  parseCli,
  sendGate,
  sendPlan,
  XDEX_PROGRAM_ID,
  type CommonOptions,
  type ComputeBudget,
  type MintMeta,
  type ParsedCli,
  type Plan,
} from "./owner.js";
import {
  assertProgramDeployed,
  loadFundView,
  prepareCreateFund,
  prepareDeposit,
  prepareEnsureVaults,
  prepareWithdraw,
  simulateTx,
  type PlanContext,
} from "./core/rpc.js";

const DEFAULT_RPC = "https://rpc.mainnet.x1.xyz";

/** Wallet that only knows a public key. The CLI signs transactions itself. */
class PubkeyWallet implements Wallet {
  constructor(readonly publicKey: PublicKey) {}
  get payer(): Keypair {
    throw new Error("no keypair loaded");
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(): Promise<T> {
    throw new Error("PubkeyWallet cannot sign");
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(): Promise<T[]> {
    throw new Error("PubkeyWallet cannot sign");
  }
}

interface Ctx {
  connection: Connection;
  rpcUrl: string;
  cluster: DetectedCluster;
  options: CommonOptions;
  send: boolean;
  payer: PublicKey;
  signer: Keypair | undefined;
  program: ProgramT;
  budget: ComputeBudget;
}

function planContext(ctx: Ctx): PlanContext {
  return { connection: ctx.connection, program: ctx.program, payer: ctx.payer, budget: ctx.budget.instructions };
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  const rpcUrl = parsed.options.rpcUrl ?? process.env.RPC_URL ?? DEFAULT_RPC;
  const connection = new Connection(rpcUrl, "confirmed");

  // Identify the chain from its genesis hash before any keypair is loaded.
  const genesisHash = await connection.getGenesisHash();
  const cluster = clusterFromGenesisHash(genesisHash, rpcUrl);
  const gate = sendGate({ options: parsed.options, genesisHash, rpcUrl, keypairEnv: process.env.KEYPAIR });
  const budget = computeBudget();
  console.log(`${gate.send ? "SEND" : "simulate-only"}: ${rpcUrl} (${cluster}, genesis ${genesisHash})`);

  if (parsed.command === "show") {
    const program = createProgram(
      new AnchorProvider(connection, new PubkeyWallet(PublicKey.default), { commitment: "confirmed" }),
    );
    await show(connection, program, parsed.fund);
    return;
  }

  let signer: Keypair | undefined;
  let payer: PublicKey;
  if (gate.send) {
    signer = loadKeypair(process.env.KEYPAIR!);
    if (parsed.options.payer && !parsed.options.payer.equals(signer.publicKey)) {
      throw new Error(
        `--payer ${parsed.options.payer.toBase58()} does not match KEYPAIR ${signer.publicKey.toBase58()}; nothing was sent`,
      );
    }
    payer = signer.publicKey;
  } else if (parsed.options.payer) {
    payer = parsed.options.payer;
  } else if (process.env.KEYPAIR) {
    // Simulation only needs the public key; the genesis check already ran.
    payer = loadKeypair(process.env.KEYPAIR).publicKey;
  } else {
    throw new Error("simulation needs a fee payer: pass --payer <pubkey> or set KEYPAIR");
  }
  const program = createProgram(
    new AnchorProvider(connection, new PubkeyWallet(payer), { commitment: "confirmed" }),
  );
  const ctx: Ctx = { connection, rpcUrl, cluster, options: parsed.options, send: gate.send, payer, signer, program, budget };

  let plan: Plan;
  switch (parsed.command) {
    case "create-fund":
      plan = await planCreate(ctx, parsed);
      break;
    case "deposit":
      plan = await planDeposit(ctx, parsed);
      break;
    case "withdraw":
      plan = await planWithdraw(ctx, parsed);
      break;
    case "ensure-vaults":
      plan = await planEnsureVaults(ctx, parsed.fund);
      break;
  }
  await run(ctx, plan);
}

/** Shell command line for ensure-vaults with the same RPC and send flags. */
function ensureVaultsCommand(ctx: Ctx, fund: PublicKey): string {
  return ensureVaultsCommandLine({
    fund,
    payer: ctx.payer,
    rpcUrl: ctx.rpcUrl,
    send: ctx.send,
    cluster: ctx.options.cluster,
    iUnderstandMainnet: ctx.options.iUnderstandMainnet,
  });
}

async function planCreate(ctx: Ctx, parsed: Extract<ParsedCli, { command: "create-fund" }>): Promise<Plan> {
  const args = parsed.create;
  let xdex = XDEX_PROGRAM_ID;
  if (parsed.options.xdex) {
    if (ctx.cluster !== "localnet") {
      throw new Error(`--xdex is only allowed on localnet; this RPC is ${ctx.cluster}`);
    }
    xdex = parsed.options.xdex;
  }
  const prepared = await prepareCreateFund(planContext(ctx), args, xdex);
  const { nft, fund, quote, plan } = prepared;

  console.log(`NFT mint (generated in memory): ${nft.publicKey.toBase58()}`);
  console.log(`fund PDA:                       ${fund.toBase58()}`);
  console.log("\nSummary of create-fund:");
  console.log(`  creator / payer  ${ctx.payer.toBase58()}`);
  console.log(`  quote mint       ${args.quote.toBase58()} (${quote.decimals} decimals, ${programName(quote.tokenProgram)}${feeNote(quote)})`);
  console.log(`  per run          ${formatUi(args.perRun, quote.decimals)} quote (raw ${args.perRun})`);
  console.log(`  interval         ${args.interval} s`);
  console.log(`  TWAP window      ${args.window} s`);
  console.log(`  max deviation    ${args.maxDevBps} bps`);
  args.targets.forEach((t, i) => {
    const cash = t.mint.equals(args.quote);
    console.log(
      `  target ${i}         ${t.mint.toBase58()} ${(t.bps / 100).toFixed(2)}% ` +
        (cash ? "(cash slice, not swapped)" : `via pool ${t.pool.toBase58()}`),
    );
  });
  console.log(`  NFT goes to      ${prepared.nftAccount.toBase58()}`);
  for (const { mint, vault } of prepared.vaults) {
    const which = mint.address.equals(args.quote) ? "quote vault ATA " : "target vault ATA";
    console.log(`  ${which} ${vault.toBase58()} (${mint.address.toBase58()}, created idempotently)`);
  }
  if (plan.txs.length > 1) {
    console.log("  note: these are separate transactions, not one atomic step; ensure-vaults recovers missing vaults");
  }
  return { ...plan, recovery: ensureVaultsCommand(ctx, fund) };
}

async function planDeposit(ctx: Ctx, parsed: Extract<ParsedCli, { command: "deposit" }>): Promise<Plan> {
  const { plan, summary: s } = await prepareDeposit(planContext(ctx), parsed.fund, parsed.amount);
  const d = s.quote.decimals;
  console.log("\nSummary of deposit:");
  console.log(`  fund             ${s.fund.toBase58()}`);
  console.log(`  depositor        ${s.depositor.toBase58()} (from ${s.source.toBase58()})`);
  console.log(`  amount           ${formatUi(s.amount, d)} of ${s.quote.address.toBase58()} (raw ${s.amount})`);
  if (s.quote.transferFee) {
    console.log(`  gross debit      ${formatUi(s.amount, d)} from the depositor`);
    console.log(`  transfer fee     ${formatUi(s.fee, d)} (estimated at the current epoch)`);
    console.log(`  net to vault     ${formatUi(s.amount - s.fee, d)}; budgets are credited from the vault's actual increase`);
  }
  console.log(`  quote vault      ${s.vault.toBase58()}${s.vaultExists ? "" : " (missing; created idempotently)"}`);
  // Preview only: computed on the gross amount, before any transfer fee. The
  // program credits budgets from the vault's actual increase and assigns the
  // rounding remainder itself.
  console.log("  budget preview (pre transfer-fee, approximate):");
  for (const p of s.split) {
    console.log(`    +~${formatUi(p.share, d)} to target ${p.index} (${p.mint.toBase58()}, ${p.bps} bps)`);
  }
  return plan;
}

async function planWithdraw(ctx: Ctx, parsed: Extract<ParsedCli, { command: "withdraw" }>): Promise<Plan> {
  const { plan, summary: s } = await prepareWithdraw(planContext(ctx), parsed.fund, parsed.mint, parsed.amount);
  const d = s.mint.decimals;
  console.log("\nSummary of withdraw:");
  console.log(`  fund             ${s.fund.toBase58()}`);
  console.log(`  holder           ${s.holder.toBase58()}`);
  console.log(`  NFT account      ${s.nftAccount ? `${s.nftAccount.address.toBase58()} (owner ${s.nftAccount.owner.toBase58()})` : "not found"}`);
  console.log(`  mint             ${s.mint.address.toBase58()} (${d} decimals${feeNote(s.mint)})`);
  console.log(`  amount           ${formatUi(s.amount, d)} (raw ${s.amount}) of vault ${formatUi(s.vaultBalance, d)}`);
  if (s.mint.transferFee) {
    console.log(`  gross debit      ${formatUi(s.amount, d)} from the vault`);
    console.log(`  transfer fee     ${formatUi(s.fee, d)} (estimated at the current epoch)`);
    console.log(`  net to holder    ${formatUi(s.amount - s.fee, d)}`);
  }
  console.log(`  from vault       ${s.vault.toBase58()}`);
  console.log(`  to               ${s.destination.toBase58()} (holder ATA, created idempotently)`);
  if (s.isQuote) {
    console.log(
      `  quote withdraw: target budgets shrink by the gross ${formatUi(s.amount, d)}, in proportion to their current size`,
    );
  }
  if (!s.payerHoldsNft) {
    console.log(`  WARNING: ${ctx.payer.toBase58()} does not hold the fund NFT; the program will reject this`);
  }
  return plan;
}

/** Create any missing quote/target vault ATAs. With none missing it sends nothing. */
async function planEnsureVaults(ctx: Ctx, fundKey: PublicKey): Promise<Plan> {
  const { plan, vaults, missing } = await prepareEnsureVaults(planContext(ctx), fundKey);
  console.log(`\nVaults of fund ${fundKey.toBase58()}:`);
  for (const v of vaults) {
    console.log(`  ${v.mint.address.toBase58()} ${v.vault.toBase58()} ${v.exists ? "exists" : "MISSING"}`);
  }
  if (missing.length === 0) {
    console.log(`all ${vaults.length} vaults exist; nothing to do`);
    return plan;
  }
  console.log(`creating ${missing.length} missing vault(s), payer ${ctx.payer.toBase58()}`);
  return { ...plan, recovery: ensureVaultsCommand(ctx, fundKey) };
}

async function show(connection: Connection, program: ProgramT, fundKey: PublicKey): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const v = await loadFundView(connection, program, fundKey, now);
  const d = v.quote.decimals;
  console.log(`fund             ${fundKey.toBase58()}`);
  console.log(`NFT mint         ${v.account.nftMint.toBase58()}`);
  console.log(`NFT holder       ${v.nftAccount ? v.nftAccount.owner.toBase58() : "unknown"}`);
  console.log(`quote mint       ${v.account.quoteMint.toBase58()} (${d} decimals${feeNote(v.quote)})`);
  console.log(`per run          ${formatUi(v.perRun, d)} (raw ${v.perRun})`);
  console.log(`interval         ${v.interval} s`);
  console.log(`TWAP window      ${v.account.twapWindowSecs} s`);
  console.log(`max deviation    ${v.account.maxDevBps} bps`);
  console.log("targets:");
  for (const t of v.targets) {
    let due: string;
    if (t.due === "cash") due = "never (cash slice)";
    else if (t.due === "no budget") due = "no budget";
    else if (t.due === "due") due = "due now";
    else due = `${isoTime(t.nextDue)} (in ${t.nextDue - now} s)`;
    console.log(`  [${t.index}] ${t.mint.toBase58()} ${(t.bps / 100).toFixed(2)}%${t.cash ? " cash" : ` pool ${t.pool.toBase58()}`}`);
    console.log(`      budget ${formatUi(t.budget, d)} quote (raw ${t.budget})`);
    console.log(`      last_run ${t.lastRun === 0n ? "never" : `${isoTime(t.lastRun)} (${t.lastRun})`}; next due ${due}`);
  }
  console.log(`budget total     ${formatUi(v.budgetTotal, d)} quote (raw ${v.budgetTotal})`);
  console.log("vaults:");
  for (const vault of v.vaults) {
    const bal =
      vault.balance === undefined ? "missing" : `${formatUi(vault.balance, vault.mint.decimals)} (raw ${vault.balance})`;
    console.log(`  ${vault.mint.address.toBase58()} ${vault.vault.toBase58()} ${bal}`);
  }
}

/**
 * Size-check and simulate every planned transaction, then (only with the send
 * gate open) send them in order. Nothing is sent unless every simulation
 * passed. A failure after the first send reports exactly what confirmed.
 */
async function run(ctx: Ctx, plan: Plan): Promise<void> {
  const { txs } = plan;
  if (txs.length === 0) return;
  assertPlanFits(ctx.payer, txs);
  await assertProgramDeployed(ctx.connection, ctx.rpcUrl, ctx.cluster);
  console.log(
    `\ncompute budget: limit ${ctx.budget.unitLimit} units, price ${ctx.budget.microLamports} micro-lamports/unit`,
  );
  const header = (i: number) => `tx ${i + 1}/${txs.length} (${txs[i]!.label})`;
  for (const [i, tx] of txs.entries()) {
    const signers = [ctx.payer, ...tx.extraSigners.map((k) => k.publicKey)].map((k) => k.toBase58());
    const sim = await simulateTx(ctx.connection, ctx.payer, tx);
    console.log(`\n${header(i)}: ${sim.size} bytes, signers ${signers.join(", ")}`);
    for (const line of sim.logs) console.log(`  | ${line}`);
    console.log(`  simulation: ${sim.err ? `FAILED ${JSON.stringify(sim.err)}` : "ok"}, ${sim.unitsConsumed ?? "?"} compute units`);
    if (sim.err) {
      // Every simulation runs before the first send, so this is true for all of them.
      throw new Error(`${header(i)} simulation failed: ${JSON.stringify(sim.err)}; no transaction was sent`);
    }
  }
  if (!ctx.send) {
    console.log("\nsimulate-only: nothing was signed or sent (add --send, KEYPAIR and --cluster to send)");
    return;
  }

  await sendPlan({
    connection: ctx.connection,
    plan,
    payer: ctx.payer,
    sign: keypairSigner([ctx.signer!]),
    rpcUrl: ctx.rpcUrl,
  });
}

function feeNote(mint: MintMeta): string {
  if (!mint.transferFee) return "";
  const f = mint.transferFee.newer;
  return `, transfer fee ${f.basisPoints} bps from epoch ${f.epoch}`;
}

function programName(id: PublicKey): string {
  return id.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL Token";
}

function isoTime(unix: bigint): string {
  return new Date(Number(unix) * 1000).toISOString();
}

function loadKeypair(file: string): Keypair {
  const secret = JSON.parse(readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err: unknown) => {
  console.error(`error: ${message(err)}`);
  process.exitCode = 1;
});
