/**
 * Owner CLI for fund NFTs: create-fund, deposit, withdraw, show.
 *
 * Default is simulate-only. A send needs --send, KEYPAIR, and
 * `--cluster <mainnet|testnet|localnet>` matching the RPC's genesis hash
 * (src/cluster.ts); mainnet also needs --i-understand-mainnet. The genesis
 * hash is checked before any keypair is loaded. See README.md.
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
  type TransactionInstruction,
} from "@solana/web3.js";
import { clusterFromGenesisHash, type DetectedCluster } from "./cluster.js";
import { createProgram, decodeFund, type FundAccount } from "./fund.js";
import { readPool, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./pool.js";
import {
  associatedTokenAddress,
  buildCreateFundIx,
  checkPool,
  computeBudget,
  createAtaIdempotentIx,
  formatUi,
  fundPda,
  NFT_TOKEN_PROGRAM_ID,
  parseCli,
  PROGRAM_ID,
  sendGate,
  XDEX_PROGRAM_ID,
  type ComputeBudget,
  type ParsedCli,
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

interface MintInfo {
  address: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
}

interface Ctx {
  connection: Connection;
  rpcUrl: string;
  cluster: DetectedCluster;
  genesisHash: string;
  send: boolean;
  payer: PublicKey;
  signer: Keypair | undefined;
  program: ProgramT;
  budget: ComputeBudget;
}

interface PlannedTx {
  label: string;
  instructions: TransactionInstruction[];
  extraSigners: Keypair[];
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
      throw new Error(`--payer ${parsed.options.payer.toBase58()} does not match KEYPAIR ${signer.publicKey.toBase58()}`);
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
  const ctx: Ctx = { connection, rpcUrl, cluster, genesisHash, send: gate.send, payer, signer, program, budget };

  let plan: PlannedTx[];
  switch (parsed.command) {
    case "create-fund":
      plan = await planCreateFund(ctx, parsed);
      break;
    case "deposit":
      plan = await planDeposit(ctx, parsed);
      break;
    case "withdraw":
      plan = await planWithdraw(ctx, parsed);
      break;
  }
  await run(ctx, plan);
}

async function planCreateFund(
  ctx: Ctx,
  parsed: Extract<ParsedCli, { command: "create-fund" }>,
): Promise<PlannedTx[]> {
  const args = parsed.create;
  let xdex = XDEX_PROGRAM_ID;
  if (parsed.options.xdex) {
    if (ctx.cluster !== "localnet") {
      throw new Error(`--xdex is only allowed on localnet; this RPC is ${ctx.cluster}`);
    }
    xdex = parsed.options.xdex;
  }
  const quote = await mintInfo(ctx.connection, args.quote);
  const targetInfo: Array<MintInfo | undefined> = [];
  for (const [i, target] of args.targets.entries()) {
    if (target.mint.equals(args.quote)) {
      targetInfo.push(undefined);
      continue;
    }
    const poolAccount = await ctx.connection.getAccountInfo(target.pool);
    if (!poolAccount) throw new Error(`target ${i} pool ${target.pool.toBase58()} does not exist`);
    checkPool(i, target, args.quote, poolAccount.owner, readPool(poolAccount.data), xdex);
    targetInfo.push(await mintInfo(ctx.connection, target.mint));
  }

  const nft = Keypair.generate();
  const fund = fundPda(nft.publicKey);
  const createIx = await buildCreateFundIx(
    ctx.program,
    { creator: ctx.payer, nftMint: nft.publicKey, quoteMint: args.quote },
    args,
  );
  const quoteVault = associatedTokenAddress(fund, args.quote, quote.tokenProgram);

  console.log(`NFT mint (generated in memory): ${nft.publicKey.toBase58()}`);
  console.log(`fund PDA:                       ${fund.toBase58()}`);
  console.log("\nSummary of create-fund:");
  console.log(`  creator / payer  ${ctx.payer.toBase58()}`);
  console.log(`  quote mint       ${args.quote.toBase58()} (${quote.decimals} decimals, ${programName(quote.tokenProgram)})`);
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
  console.log(`  quote vault ATA  ${quoteVault.toBase58()} (created idempotently)`);
  console.log(`  NFT goes to      ${associatedTokenAddress(ctx.payer, nft.publicKey, NFT_TOKEN_PROGRAM_ID).toBase58()}`);

  const plan: PlannedTx[] = [
    {
      label: "create_fund + quote vault",
      instructions: [
        ...ctx.budget.instructions,
        createIx,
        createAtaIdempotentIx(ctx.payer, fund, args.quote, quote.tokenProgram),
      ],
      extraSigners: [nft],
    },
  ];
  const targetVaults = targetInfo
    .filter((m): m is MintInfo => m !== undefined)
    .map((m) => createAtaIdempotentIx(ctx.payer, fund, m.address, m.tokenProgram));
  if (targetVaults.length > 0) {
    // execute_dca needs each target vault to exist. A separate transaction
    // keeps create_fund under the size limit with up to 8 targets.
    for (const m of targetInfo.filter((x): x is MintInfo => x !== undefined)) {
      console.log(`  target vault ATA ${associatedTokenAddress(fund, m.address, m.tokenProgram).toBase58()} (${m.address.toBase58()})`);
    }
    plan.push({
      label: "target vaults",
      instructions: [...ctx.budget.instructions, ...targetVaults],
      extraSigners: [],
    });
  }
  return plan;
}

async function planDeposit(ctx: Ctx, parsed: Extract<ParsedCli, { command: "deposit" }>): Promise<PlannedTx[]> {
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

  console.log("\nSummary of deposit:");
  console.log(`  fund             ${parsed.fund.toBase58()}`);
  console.log(`  depositor        ${ctx.payer.toBase58()} (from ${source.toBase58()})`);
  console.log(`  amount           ${formatUi(parsed.amount, quote.decimals)} of ${fund.quoteMint.toBase58()} (raw ${parsed.amount})`);
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
  return [{ label: "deposit", instructions, extraSigners: [] }];
}

async function planWithdraw(ctx: Ctx, parsed: Extract<ParsedCli, { command: "withdraw" }>): Promise<PlannedTx[]> {
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

  console.log("\nSummary of withdraw:");
  console.log(`  fund             ${parsed.fund.toBase58()}`);
  console.log(`  holder           ${ctx.payer.toBase58()}`);
  console.log(`  NFT account      ${nftAccount ? `${nftAccount.address.toBase58()} (owner ${nftOwner!.toBase58()})` : "not found"}`);
  console.log(`  mint             ${parsed.mint.toBase58()} (${mint.decimals} decimals)`);
  console.log(`  amount           ${formatUi(amount, mint.decimals)} (raw ${amount}) of vault ${formatUi(vaultBalance, mint.decimals)}`);
  console.log(`  from vault       ${vault.toBase58()}`);
  console.log(`  to               ${destination.toBase58()} (holder ATA, created idempotently)`);
  if (parsed.mint.equals(fund.quoteMint)) {
    console.log("  quote withdraw: target budgets shrink in proportion to their current size");
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
  return [
    {
      label: "withdraw",
      instructions: [
        ...ctx.budget.instructions,
        createAtaIdempotentIx(ctx.payer, ctx.payer, parsed.mint, mint.tokenProgram),
        ix,
      ],
      extraSigners: [],
    },
  ];
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
  console.log(`quote mint       ${fund.quoteMint.toBase58()} (${quote.decimals} decimals)`);
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

/** Simulate every planned transaction; send only through the gate, and only if its simulation passed. */
async function run(ctx: Ctx, plan: PlannedTx[]): Promise<void> {
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
  for (const [i, tx] of plan.entries()) {
    const header = `tx ${i + 1}/${plan.length} (${tx.label})`;
    const { blockhash, lastValidBlockHeight } = await ctx.connection.getLatestBlockhash("confirmed");
    const message = new TransactionMessage({
      payerKey: ctx.payer,
      recentBlockhash: blockhash,
      instructions: tx.instructions,
    }).compileToLegacyMessage();
    const vtx = new VersionedTransaction(message);
    console.log(`\n${header}: ${vtx.serialize().length} bytes, signers ${[ctx.payer, ...tx.extraSigners.map((k) => k.publicKey)].map((k) => k.toBase58()).join(", ")}`);
    const sim = await ctx.connection.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    });
    for (const line of sim.value.logs ?? []) console.log(`  | ${line}`);
    console.log(`  simulation: ${sim.value.err ? `FAILED ${JSON.stringify(sim.value.err)}` : "ok"}, ${sim.value.unitsConsumed ?? "?"} compute units`);
    if (sim.value.err) {
      throw new Error(`${header} simulation failed: ${JSON.stringify(sim.value.err)}${ctx.send ? "; nothing sent" : ""}`);
    }
    if (!ctx.send) continue;
    vtx.sign([ctx.signer!, ...tx.extraSigners]);
    const signature = await ctx.connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
    const result = await ctx.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    if (result.value.err) throw new Error(`${header} ${signature} failed: ${JSON.stringify(result.value.err)}`);
    console.log(`  sent and confirmed: ${signature}`);
  }
  if (!ctx.send) console.log("\nsimulate-only: nothing was signed or sent (add --send, KEYPAIR and --cluster to send)");
}

async function loadFund(connection: Connection, program: ProgramT, fund: PublicKey): Promise<FundAccount> {
  const info = await connection.getAccountInfo(fund);
  if (!info) throw new Error(`fund ${fund.toBase58()} does not exist`);
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error(`fund ${fund.toBase58()} is owned by ${info.owner.toBase58()}, not ${PROGRAM_ID.toBase58()}`);
  }
  return decodeFund(program, info.data);
}

async function mintInfo(connection: Connection, mint: PublicKey): Promise<MintInfo> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} does not exist`);
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}, not a token program`);
  }
  if (info.data.length < 82) throw new Error(`mint ${mint.toBase58()} is too short to be a mint`);
  return { address: mint, tokenProgram: info.owner, decimals: info.data[44]! };
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
  // Approximate preview; the program floors and assigns the remainder itself.
  for (const [i, t] of fund.targets.entries()) {
    const share = (amount * BigInt(t.bps)) / 10_000n;
    console.log(`  budget +~${formatUi(share, decimals)} to target ${i} (${t.mint.toBase58()}, ${t.bps} bps)`);
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

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
