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
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Program as ProgramT, Wallet } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { clusterFromGenesisHash, type DetectedCluster } from "./cluster.js";
import { createProgram, decodeFund, type FundAccount } from "./fund.js";
import { readPool, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./pool.js";
import {
  assertPlanFits,
  associatedTokenAddress,
  ensureVaultsCommandLine,
  sendPlan,
  checkPool,
  computeBudget,
  createAtaIdempotentIx,
  formatUi,
  fundPda,
  fundVaults,
  NFT_TOKEN_PROGRAM_ID,
  parseCli,
  partialFailureMessage,
  planCreateFund,
  PROGRAM_ID,
  readTransferFeeConfig,
  sendGate,
  transferFeeFor,
  txSize,
  XDEX_PROGRAM_ID,
  type CommonOptions,
  type ComputeBudget,
  type FailedTxState,
  type MintMeta,
  type ParsedCli,
  type Plan,
  type PlannedTx,
  type TxOutcome,
} from "./owner.js";

const require = createRequire(import.meta.url);
const { AnchorProvider, BN: BNCtor } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

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
  const quote = await mintInfo(ctx.connection, args.quote);
  const targetMints: MintMeta[] = [];
  for (const [i, target] of args.targets.entries()) {
    if (target.mint.equals(args.quote)) continue;
    const poolAccount = await ctx.connection.getAccountInfo(target.pool);
    if (!poolAccount) throw new Error(`target ${i} pool ${target.pool.toBase58()} does not exist`);
    checkPool(i, target, args.quote, poolAccount.owner, readPool(poolAccount.data), xdex);
    targetMints.push(await mintInfo(ctx.connection, target.mint));
  }

  const nft = Keypair.generate();
  const fund = fundPda(nft.publicKey);
  const txs = await planCreateFund(ctx.program, ctx.payer, nft, args, quote, targetMints, ctx.budget.instructions);
  // Refuse an oversized plan before printing anything that looks final.
  assertPlanFits(
    ctx.payer,
    txs,
    "create_fund carries every target's params plus each non-cash mint as an account; use fewer targets " +
      "(with a Token-2022 quote: at most 6 non-cash targets, or a cash slice plus 5).",
  );

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
  console.log(`  NFT goes to      ${associatedTokenAddress(ctx.payer, nft.publicKey, NFT_TOKEN_PROGRAM_ID).toBase58()}`);
  for (const { mint, vault } of fundVaults(fund, quote, targetMints)) {
    const which = mint.address.equals(args.quote) ? "quote vault ATA " : "target vault ATA";
    console.log(`  ${which} ${vault.toBase58()} (${mint.address.toBase58()}, created idempotently)`);
  }
  if (txs.length > 1) {
    console.log("  note: these are separate transactions, not one atomic step; ensure-vaults recovers missing vaults");
  }
  return { txs, fund, recovery: ensureVaultsCommand(ctx, fund) };
}

async function planDeposit(ctx: Ctx, parsed: Extract<ParsedCli, { command: "deposit" }>): Promise<Plan> {
  const fund = await loadFund(ctx.connection, ctx.program, parsed.fund);
  const quote = await mintInfo(ctx.connection, fund.quoteMint);
  const source = associatedTokenAddress(ctx.payer, fund.quoteMint, quote.tokenProgram);
  const vault = associatedTokenAddress(parsed.fund, fund.quoteMint, quote.tokenProgram);
  const sourceInfo = await ctx.connection.getAccountInfo(source);
  if (!sourceInfo) throw new Error(`depositor quote account ${source.toBase58()} does not exist`);
  const balance = tokenAmount(sourceInfo.data);
  if (balance < parsed.amount) {
    throw new Error(
      `depositor balance ${formatUi(balance, quote.decimals)} is below the deposit ${formatUi(parsed.amount, quote.decimals)}`,
    );
  }
  const vaultExists = (await ctx.connection.getAccountInfo(vault)) !== null;
  const fee = await feeFor(ctx.connection, quote, parsed.amount);

  console.log("\nSummary of deposit:");
  console.log(`  fund             ${parsed.fund.toBase58()}`);
  console.log(`  depositor        ${ctx.payer.toBase58()} (from ${source.toBase58()})`);
  console.log(`  amount           ${formatUi(parsed.amount, quote.decimals)} of ${fund.quoteMint.toBase58()} (raw ${parsed.amount})`);
  if (quote.transferFee) {
    console.log(`  gross debit      ${formatUi(parsed.amount, quote.decimals)} from the depositor`);
    console.log(`  transfer fee     ${formatUi(fee, quote.decimals)} (estimated at the current epoch)`);
    console.log(`  net to vault     ${formatUi(parsed.amount - fee, quote.decimals)}; budgets are credited from the vault's actual increase`);
  }
  console.log(`  quote vault      ${vault.toBase58()}${vaultExists ? "" : " (missing; created idempotently)"}`);
  printSplit(fund, parsed.amount, quote.decimals);

  const ix = await ctx.program.methods
    .deposit(new BNCtor(parsed.amount.toString()))
    .accountsStrict({
      depositor: ctx.payer,
      fund: parsed.fund,
      quoteMint: fund.quoteMint,
      depositorQuote: source,
      quoteVault: vault,
      tokenProgram: quote.tokenProgram,
    })
    .instruction();
  const instructions = [...ctx.budget.instructions];
  if (!vaultExists) instructions.push(createAtaIdempotentIx(ctx.payer, parsed.fund, fund.quoteMint, quote.tokenProgram));
  instructions.push(ix);
  return { txs: [{ label: "deposit", instructions, extraSigners: [] }], fund: parsed.fund };
}

async function planWithdraw(ctx: Ctx, parsed: Extract<ParsedCli, { command: "withdraw" }>): Promise<Plan> {
  const fund = await loadFund(ctx.connection, ctx.program, parsed.fund);
  const mint = await mintInfo(ctx.connection, parsed.mint);
  const vault = associatedTokenAddress(parsed.fund, parsed.mint, mint.tokenProgram);
  const vaultInfo = await ctx.connection.getAccountInfo(vault);
  if (!vaultInfo) throw new Error(`fund vault ${vault.toBase58()} for ${parsed.mint.toBase58()} does not exist`);
  const vaultBalance = tokenAmount(vaultInfo.data);
  const amount = parsed.amount === "all" ? vaultBalance : parsed.amount;
  if (amount === 0n) throw new Error(`fund vault ${vault.toBase58()} is empty`);
  if (amount > vaultBalance) {
    throw new Error(`withdraw ${formatUi(amount, mint.decimals)} exceeds the vault balance ${formatUi(vaultBalance, mint.decimals)}`);
  }
  const nftAccount = await findNftAccount(ctx.connection, fund.nftMint);
  const nftOwner = nftAccount ? nftAccount.owner : undefined;
  const destination = associatedTokenAddress(ctx.payer, parsed.mint, mint.tokenProgram);
  const fee = await feeFor(ctx.connection, mint, amount);

  console.log("\nSummary of withdraw:");
  console.log(`  fund             ${parsed.fund.toBase58()}`);
  console.log(`  holder           ${ctx.payer.toBase58()}`);
  console.log(`  NFT account      ${nftAccount ? `${nftAccount.address.toBase58()} (owner ${nftOwner!.toBase58()})` : "not found"}`);
  console.log(`  mint             ${parsed.mint.toBase58()} (${mint.decimals} decimals${feeNote(mint)})`);
  console.log(`  amount           ${formatUi(amount, mint.decimals)} (raw ${amount}) of vault ${formatUi(vaultBalance, mint.decimals)}`);
  if (mint.transferFee) {
    console.log(`  gross debit      ${formatUi(amount, mint.decimals)} from the vault`);
    console.log(`  transfer fee     ${formatUi(fee, mint.decimals)} (estimated at the current epoch)`);
    console.log(`  net to holder    ${formatUi(amount - fee, mint.decimals)}`);
  }
  console.log(`  from vault       ${vault.toBase58()}`);
  console.log(`  to               ${destination.toBase58()} (holder ATA, created idempotently)`);
  if (parsed.mint.equals(fund.quoteMint)) {
    console.log(
      `  quote withdraw: target budgets shrink by the gross ${formatUi(amount, mint.decimals)}, in proportion to their current size`,
    );
  }
  if (!nftOwner || !nftOwner.equals(ctx.payer)) {
    console.log(`  WARNING: ${ctx.payer.toBase58()} does not hold the fund NFT; the program will reject this`);
  }

  const ix = await ctx.program.methods
    .withdraw(new BNCtor(amount.toString()))
    .accountsStrict({
      holder: ctx.payer,
      fund: parsed.fund,
      nftMint: fund.nftMint,
      nftAccount: nftAccount ? nftAccount.address : associatedTokenAddress(ctx.payer, fund.nftMint, NFT_TOKEN_PROGRAM_ID),
      nftTokenProgram: NFT_TOKEN_PROGRAM_ID,
      mint: parsed.mint,
      vault,
      destination,
      tokenProgram: mint.tokenProgram,
    })
    .instruction();
  return {
    txs: [
      {
        label: "withdraw",
        instructions: [
          ...ctx.budget.instructions,
          createAtaIdempotentIx(ctx.payer, ctx.payer, parsed.mint, mint.tokenProgram),
          ix,
        ],
        extraSigners: [],
      },
    ],
    fund: parsed.fund,
  };
}

/** Create any missing quote/target vault ATAs. With none missing it sends nothing. */
async function planEnsureVaults(ctx: Ctx, fundKey: PublicKey): Promise<Plan> {
  const fund = await loadFund(ctx.connection, ctx.program, fundKey);
  const quote = await mintInfo(ctx.connection, fund.quoteMint);
  const targetMints: MintMeta[] = [];
  for (const t of fund.targets) {
    if (!t.mint.equals(fund.quoteMint)) targetMints.push(await mintInfo(ctx.connection, t.mint));
  }
  const vaults = fundVaults(fundKey, quote, targetMints);
  const infos = await ctx.connection.getMultipleAccountsInfo(vaults.map((v) => v.vault), "confirmed");
  console.log(`\nVaults of fund ${fundKey.toBase58()}:`);
  const missing = vaults.filter((v, i) => {
    console.log(`  ${v.mint.address.toBase58()} ${v.vault.toBase58()} ${infos[i] ? "exists" : "MISSING"}`);
    return !infos[i];
  });
  if (missing.length === 0) {
    console.log(`all ${vaults.length} vaults exist; nothing to do`);
    return { txs: [], fund: fundKey };
  }
  console.log(`creating ${missing.length} missing vault(s), payer ${ctx.payer.toBase58()}`);
  return {
    txs: [
      {
        label: "ensure vaults",
        instructions: [
          ...ctx.budget.instructions,
          ...missing.map((v) => createAtaIdempotentIx(ctx.payer, fundKey, v.mint.address, v.mint.tokenProgram)),
        ],
        extraSigners: [],
      },
    ],
    fund: fundKey,
    recovery: ensureVaultsCommand(ctx, fundKey),
  };
}

async function show(connection: Connection, program: ProgramT, fundKey: PublicKey): Promise<void> {
  const fund = await loadFund(connection, program, fundKey);
  const quote = await mintInfo(connection, fund.quoteMint);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const interval = BigInt(fund.intervalSecs.toString());
  const nftAccount = await findNftAccount(connection, fund.nftMint);
  console.log(`fund             ${fundKey.toBase58()}`);
  console.log(`NFT mint         ${fund.nftMint.toBase58()}`);
  console.log(`NFT holder       ${nftAccount ? nftAccount.owner.toBase58() : "unknown"}`);
  console.log(`quote mint       ${fund.quoteMint.toBase58()} (${quote.decimals} decimals${feeNote(quote)})`);
  console.log(`per run          ${formatUi(BigInt(fund.perRunQuote.toString()), quote.decimals)} (raw ${fund.perRunQuote.toString()})`);
  console.log(`interval         ${interval} s`);
  console.log(`TWAP window      ${fund.twapWindowSecs} s`);
  console.log(`max deviation    ${fund.maxDevBps} bps`);
  let budgetTotal = 0n;
  console.log("targets:");
  for (const [i, t] of fund.targets.entries()) {
    const cash = t.mint.equals(fund.quoteMint);
    const budget = BigInt(t.budget.toString());
    budgetTotal += budget;
    const lastRun = BigInt(t.lastRun.toString());
    const next = lastRun + interval;
    let due: string;
    if (cash) due = "never (cash slice)";
    else if (budget === 0n) due = "no budget";
    else if (now >= next) due = "due now";
    else due = `${isoTime(next)} (in ${next - now} s)`;
    console.log(`  [${i}] ${t.mint.toBase58()} ${(t.bps / 100).toFixed(2)}%${cash ? " cash" : ` pool ${t.pool.toBase58()}`}`);
    console.log(`      budget ${formatUi(budget, quote.decimals)} quote (raw ${budget})`);
    console.log(`      last_run ${lastRun === 0n ? "never" : `${isoTime(lastRun)} (${lastRun})`}; next due ${due}`);
  }
  console.log(`budget total     ${formatUi(budgetTotal, quote.decimals)} quote (raw ${budgetTotal})`);
  console.log("vaults:");
  const mints = [fund.quoteMint, ...fund.targets.map((t) => t.mint).filter((m) => !m.equals(fund.quoteMint))];
  for (const m of mints) {
    const info = await mintInfo(connection, m);
    const vault = associatedTokenAddress(fundKey, m, info.tokenProgram);
    const account = await connection.getAccountInfo(vault);
    const bal = account ? `${formatUi(tokenAmount(account.data), info.decimals)} (raw ${tokenAmount(account.data)})` : "missing";
    console.log(`  ${m.toBase58()} ${vault.toBase58()} ${bal}`);
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
  const program = await ctx.connection.getAccountInfo(PROGRAM_ID);
  if (!program || !program.executable) {
    throw new Error(
      `program ${PROGRAM_ID.toBase58()} is not deployed on this RPC (${ctx.rpcUrl}, ${ctx.cluster}): ` +
        `${program ? "the account is not executable" : "getAccountInfo returned no account"}. Nothing was simulated or sent.`,
    );
  }
  console.log(
    `\ncompute budget: limit ${ctx.budget.unitLimit} units, price ${ctx.budget.microLamports} micro-lamports/unit`,
  );
  const header = (i: number) => `tx ${i + 1}/${txs.length} (${txs[i]!.label})`;
  for (const [i, tx] of txs.entries()) {
    const signers = [ctx.payer, ...tx.extraSigners.map((k) => k.publicKey)].map((k) => k.toBase58());
    console.log(`\n${header(i)}: ${txSize(ctx.payer, tx.instructions)} bytes, signers ${signers.join(", ")}`);
    const sim = await ctx.connection.simulateTransaction(compile(ctx.payer, tx, PublicKey.default.toBase58()), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    for (const line of sim.value.logs ?? []) console.log(`  | ${line}`);
    console.log(`  simulation: ${sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "ok"}, ${sim.value.unitsConsumed ?? "?"} compute units`);
    if (sim.value.err) {
      // Every simulation runs before the first send, so this is true for all of them.
      throw new Error(`${header(i)} simulation failed: ${JSON.stringify(sim.value.err)}; no transaction was sent`);
    }
  }
  if (!ctx.send) {
    console.log("\nsimulate-only: nothing was signed or sent (add --send, KEYPAIR and --cluster to send)");
    return;
  }

  await sendPlan({ connection: ctx.connection, plan, payer: ctx.payer, signers: [ctx.signer!], rpcUrl: ctx.rpcUrl });
}

function partialFailure(
  plan: Plan,
  done: TxOutcome[],
  failed: number,
  what: string,
  state: FailedTxState,
): Error {
  return new Error(partialFailureMessage(plan, done, failed, what, state));
}

function compile(payer: PublicKey, tx: PlannedTx, blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: tx.instructions,
  }).compileToLegacyMessage();
  return new VersionedTransaction(message);
}

async function loadFund(connection: Connection, program: ProgramT, fund: PublicKey): Promise<FundAccount> {
  const info = await connection.getAccountInfo(fund);
  if (!info) throw new Error(`fund ${fund.toBase58()} does not exist`);
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error(`fund ${fund.toBase58()} is owned by ${info.owner.toBase58()}, not ${PROGRAM_ID.toBase58()}`);
  }
  return decodeFund(program, info.data);
}

async function mintInfo(connection: Connection, mint: PublicKey): Promise<MintMeta> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} does not exist`);
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}, not a token program`);
  }
  if (info.data.length < 82) throw new Error(`mint ${mint.toBase58()} is too short to be a mint`);
  return {
    address: mint,
    tokenProgram: info.owner,
    decimals: info.data[44]!,
    transferFee: info.owner.equals(TOKEN_2022_PROGRAM_ID) ? readTransferFeeConfig(info.data) : undefined,
  };
}

async function feeFor(connection: Connection, mint: MintMeta, amount: bigint): Promise<bigint> {
  if (!mint.transferFee) return 0n;
  const { epoch } = await connection.getEpochInfo("confirmed");
  return transferFeeFor(mint.transferFee, amount, BigInt(epoch));
}

function feeNote(mint: MintMeta): string {
  if (!mint.transferFee) return "";
  const f = mint.transferFee.newer;
  return `, transfer fee ${f.basisPoints} bps from epoch ${f.epoch}`;
}

/** The token account holding the single NFT, if any. */
async function findNftAccount(
  connection: Connection,
  nftMint: PublicKey,
): Promise<{ address: PublicKey; owner: PublicKey } | undefined> {
  const largest = await connection.getTokenLargestAccounts(nftMint, "confirmed");
  const holder = largest.value.find((a) => a.amount === "1");
  if (!holder) return undefined;
  const info = await connection.getAccountInfo(holder.address);
  if (!info) return undefined;
  return { address: holder.address, owner: new PublicKey(info.data.subarray(32, 64)) };
}

function printSplit(fund: FundAccount, amount: bigint, decimals: number): void {
  // Preview only: computed on the gross amount, before any transfer fee. The
  // program credits budgets from the vault's actual increase and assigns the
  // rounding remainder itself.
  console.log("  budget preview (pre transfer-fee, approximate):");
  for (const [i, t] of fund.targets.entries()) {
    const share = (amount * BigInt(t.bps)) / 10_000n;
    console.log(`    +~${formatUi(share, decimals)} to target ${i} (${t.mint.toBase58()}, ${t.bps} bps)`);
  }
}

function tokenAmount(data: Buffer): bigint {
  if (data.length < 72) throw new Error("token account is too short");
  return data.readBigUInt64LE(64);
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
