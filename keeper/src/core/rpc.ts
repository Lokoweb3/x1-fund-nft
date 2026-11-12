/**
 * RPC-reading planners shared by the CLI (src/cli.ts) and the web app (app/).
 *
 * Each `prepare*` function reads what it needs, applies the same checks the
 * CLI has always applied (same error text), and returns the Plan plus a
 * structured summary. Printing is left to the caller: the CLI prints the
 * summary lines, the app renders a review screen. Nothing here signs or
 * sends; see sendPlan in core/owner.ts.
 *
 * Browser-safe: no node: imports.
 */
import type { Program as ProgramT } from "@anchor-lang/core";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type Connection,
  type SimulatedTransactionResponse,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { DetectedCluster } from "./cluster.js";
import { decodeFund, dueTargets, type FundAccount } from "./fund.js";
import {
  assertPlanFits,
  associatedTokenAddress,
  buildWithdrawNativeIx,
  checkPool,
  compileTx,
  createAtaIdempotentIx,
  formatUi,
  fundPda,
  fundVaults,
  MAX_TARGETS,
  nativeAvailable,
  NFT_TOKEN_PROGRAM_ID,
  planCreateFund,
  PROGRAM_ID,
  readTransferFeeConfig,
  transferFeeFor,
  txSize,
  MAX_TX_BYTES,
  type CreateFundArgs,
  type MintMeta,
  type Plan,
  type PlannedTx,
} from "./owner.js";
import { readPool, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./pool.js";
import {
  buildAttachMetadataIx,
  buildUpdateMetadataIx,
  decodeMetadata,
  masterEditionPda,
  metadataPda,
  METAPLEX_PROGRAM_ID,
  validateMetadataFields,
  validateMetadataUpdate,
  type MetadataFields,
  type MetadataUpdate,
  type StoredMetadata,
} from "./metadata.js";

/** What a planner needs: the RPC, an Anchor Program for the coder, the fee payer, and the compute-budget instructions. */
export interface PlanContext {
  connection: Connection;
  program: ProgramT;
  payer: PublicKey;
  budget: TransactionInstruction[];
}

/** Hint attached to an oversized create-fund plan. */
export const CREATE_FUND_SIZE_HINT =
  "create_fund carries every target's params plus each non-cash mint as an account; use fewer targets " +
  "(with a Token-2022 quote: at most 6 non-cash targets, or a cash slice plus 5).";

/** Token amount (u64 at offset 64) of an SPL token account. */
export function tokenAmount(data: Uint8Array): bigint {
  if (data.length < 72) throw new Error("token account is too short");
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

export async function mintInfo(connection: Connection, mint: PublicKey): Promise<MintMeta> {
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

export async function loadFund(connection: Connection, program: ProgramT, fund: PublicKey): Promise<FundAccount> {
  const info = await connection.getAccountInfo(fund);
  if (!info) throw new Error(`fund ${fund.toBase58()} does not exist`);
  if (!info.owner.equals(PROGRAM_ID)) {
    throw new Error(`fund ${fund.toBase58()} is owned by ${info.owner.toBase58()}, not ${PROGRAM_ID.toBase58()}`);
  }
  return decodeFund(program, info.data);
}

/** Estimated transfer fee for `amount` at the current epoch (0 without a fee extension). */
export async function feeFor(connection: Connection, mint: MintMeta, amount: bigint): Promise<bigint> {
  if (!mint.transferFee) return 0n;
  const { epoch } = await connection.getEpochInfo("confirmed");
  return transferFeeFor(mint.transferFee, amount, BigInt(epoch));
}

export interface NftAccount {
  address: PublicKey;
  owner: PublicKey;
}

/** The token account holding the single NFT, if any. */
export async function findNftAccount(connection: Connection, nftMint: PublicKey): Promise<NftAccount | undefined> {
  const largest = await connection.getTokenLargestAccounts(nftMint, "confirmed");
  const holder = largest.value.find((a) => a.amount === "1");
  if (!holder) return undefined;
  const info = await connection.getAccountInfo(holder.address);
  if (!info) return undefined;
  return { address: holder.address, owner: new PublicKey(info.data.subarray(32, 64)) };
}

/**
 * Throws unless the fund program exists and is executable on this RPC. Same
 * text as the CLI, which the docs quote.
 */
export async function assertProgramDeployed(
  connection: Connection,
  rpcUrl: string,
  cluster: DetectedCluster,
): Promise<void> {
  const program = await connection.getAccountInfo(PROGRAM_ID);
  if (!program || !program.executable) {
    throw new Error(
      `program ${PROGRAM_ID.toBase58()} is not deployed on this RPC (${rpcUrl}, ${cluster}): ` +
        `${program ? "the account is not executable" : "getAccountInfo returned no account"}. Nothing was simulated or sent.`,
    );
  }
}

export interface SimResult {
  label: string;
  /** Serialized size in bytes. */
  size: number;
  /** Fee payer first, then the plan's extra signers. */
  signers: PublicKey[];
  logs: string[];
  err: SimulatedTransactionResponse["err"];
  unitsConsumed: number | undefined;
}

/** Simulate one planned transaction (no signature check, fresh blockhash). */
export async function simulateTx(connection: Connection, payer: PublicKey, tx: PlannedTx): Promise<SimResult> {
  const sim = await connection.simulateTransaction(compileTx(payer, tx, PublicKey.default.toBase58()), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  return {
    label: tx.label,
    size: txSize(payer, tx.instructions),
    signers: [payer, ...tx.extraSigners.map((k) => k.publicKey)],
    logs: sim.value.logs ?? [],
    err: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed,
  };
}

/** Accounts the plan's instructions reference, deduplicated, with their strongest role. */
export function planAccounts(plan: Plan): Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> {
  const seen = new Map<string, { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>();
  for (const tx of plan.txs) {
    for (const ix of tx.instructions) {
      for (const k of [...ix.keys, { pubkey: ix.programId, isSigner: false, isWritable: false }]) {
        const key = k.pubkey.toBase58();
        const prev = seen.get(key);
        seen.set(key, {
          pubkey: k.pubkey,
          isSigner: (prev?.isSigner ?? false) || k.isSigner,
          isWritable: (prev?.isWritable ?? false) || k.isWritable,
        });
      }
    }
  }
  return [...seen.values()];
}

// ---- create-fund ----

/**
 * Read the quote and target mints and check each target pool (owned by
 * `xdex`, trading quote/target). Throws on the first problem.
 */
export async function readCreateFundMints(
  connection: Connection,
  args: CreateFundArgs,
  xdex: PublicKey,
): Promise<{ quote: MintMeta; targetMints: MintMeta[] }> {
  const quote = await mintInfo(connection, args.quote);
  const targetMints: MintMeta[] = [];
  for (const [i, target] of args.targets.entries()) {
    if (target.mint.equals(args.quote)) continue;
    const poolAccount = await connection.getAccountInfo(target.pool);
    if (!poolAccount) throw new Error(`target ${i} pool ${target.pool.toBase58()} does not exist`);
    checkPool(i, target, args.quote, poolAccount.owner, readPool(poolAccount.data), xdex);
    targetMints.push(await mintInfo(connection, target.mint));
  }
  return { quote, targetMints };
}

export interface CreateFundPrepared {
  plan: Plan;
  nft: Keypair;
  fund: PublicKey;
  quote: MintMeta;
  targetMints: MintMeta[];
  nftAccount: PublicKey;
  vaults: Array<{ mint: MintMeta; vault: PublicKey }>;
}

/**
 * Pool checks, then the create-fund plan (create_fund + quote vault, then
 * attach_metadata when `metadata` is given, then the target vaults) with a
 * fresh NFT mint keypair (held in memory only), size-checked.
 * `plan.recovery` is left for the caller to set.
 */
export async function prepareCreateFund(
  ctx: PlanContext,
  args: CreateFundArgs,
  xdex: PublicKey,
  metadata?: MetadataFields,
  /**
   * The NFT mint keypair to use, when the caller had to know the fund PDA
   * before planning (the web app writes it into the NFT's metadata JSON).
   * Default: a fresh keypair. Held in memory only.
   */
  nftMint?: Keypair,
): Promise<CreateFundPrepared> {
  if (metadata) {
    validateMetadataFields(metadata);
    await assertMetadataProgramDeployed(ctx.connection);
  }
  const { quote, targetMints } = await readCreateFundMints(ctx.connection, args, xdex);
  const nft = nftMint ?? Keypair.generate();
  const fund = fundPda(nft.publicKey, ctx.program.programId);
  const txs = await planCreateFund(ctx.program, ctx.payer, nft, args, quote, targetMints, ctx.budget, metadata);
  // Refuse an oversized plan before anything looks final.
  assertPlanFits(ctx.payer, txs, CREATE_FUND_SIZE_HINT);
  return {
    plan: { txs, fund },
    nft,
    fund,
    quote,
    targetMints,
    nftAccount: associatedTokenAddress(ctx.payer, nft.publicKey, NFT_TOKEN_PROGRAM_ID),
    vaults: fundVaults(fund, quote, targetMints),
  };
}

/**
 * The most non-cash targets whose create-fund plan fits in one transaction,
 * for this quote mint and with or without a cash slice. Built offline from
 * the real builders with throwaway keys, so it is the same limit
 * assertPlanFits enforces.
 */
export async function maxTargetsThatFit(
  program: ProgramT,
  payer: PublicKey,
  quote: MintMeta,
  cash: boolean,
  budget: TransactionInstruction[],
): Promise<{ maxNonCash: number; sizes: number[] }> {
  const sizes: number[] = [];
  let maxNonCash = 0;
  for (let n = 0; n <= MAX_TARGETS - (cash ? 1 : 0); n++) {
    if (n === 0 && !cash) {
      sizes.push(0);
      continue;
    }
    const mints: MintMeta[] = Array.from({ length: n }, () => ({
      address: Keypair.generate().publicKey,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      decimals: 0,
      transferFee: undefined,
    }));
    const targets = mints.map((m) => ({ mint: m.address, pool: Keypair.generate().publicKey, bps: 1 }));
    if (cash) targets.unshift({ mint: quote.address, pool: PublicKey.default, bps: 1 });
    const args: CreateFundArgs = { quote: quote.address, targets, perRun: 1n, interval: 60n, window: 900, maxDevBps: 0 };
    const plan = await planCreateFund(program, payer, Keypair.generate(), args, quote, mints, budget);
    const size = Math.max(...plan.map((tx) => txSize(payer, tx.instructions)));
    sizes.push(size);
    if (size <= MAX_TX_BYTES) maxNonCash = n;
  }
  return { maxNonCash, sizes };
}

// ---- deposit ----

export interface DepositSummary {
  fund: PublicKey;
  fundAccount: FundAccount;
  quote: MintMeta;
  depositor: PublicKey;
  source: PublicKey;
  balance: bigint;
  vault: PublicKey;
  vaultExists: boolean;
  amount: bigint;
  /** Estimated transfer fee at the current epoch; 0 without a fee extension. */
  fee: bigint;
  /** Pre-fee, approximate budget split; the program credits the vault's actual increase. */
  split: Array<{ index: number; mint: PublicKey; bps: number; share: bigint }>;
}

export async function prepareDeposit(
  ctx: PlanContext,
  fundKey: PublicKey,
  amount: bigint,
): Promise<{ plan: Plan; summary: DepositSummary }> {
  if (amount <= 0n) throw new Error("--amount must be greater than zero");
  const fund = await loadFund(ctx.connection, ctx.program, fundKey);
  const quote = await mintInfo(ctx.connection, fund.quoteMint);
  const source = associatedTokenAddress(ctx.payer, fund.quoteMint, quote.tokenProgram);
  const vault = associatedTokenAddress(fundKey, fund.quoteMint, quote.tokenProgram);
  const sourceInfo = await ctx.connection.getAccountInfo(source);
  if (!sourceInfo) throw new Error(`depositor quote account ${source.toBase58()} does not exist`);
  const balance = tokenAmount(sourceInfo.data);
  if (balance < amount) {
    throw new Error(
      `depositor balance ${formatUi(balance, quote.decimals)} is below the deposit ${formatUi(amount, quote.decimals)}`,
    );
  }
  const vaultExists = (await ctx.connection.getAccountInfo(vault)) !== null;
  const fee = await feeFor(ctx.connection, quote, amount);

  const ix = await ctx.program.methods
    .deposit(new BN(amount.toString()))
    .accountsStrict({
      depositor: ctx.payer,
      fund: fundKey,
      quoteMint: fund.quoteMint,
      depositorQuote: source,
      quoteVault: vault,
      tokenProgram: quote.tokenProgram,
    })
    .instruction();
  const instructions = [...ctx.budget];
  if (!vaultExists) instructions.push(createAtaIdempotentIx(ctx.payer, fundKey, fund.quoteMint, quote.tokenProgram));
  instructions.push(ix);
  return {
    plan: { txs: [{ label: "deposit", instructions, extraSigners: [] }], fund: fundKey },
    summary: {
      fund: fundKey,
      fundAccount: fund,
      quote,
      depositor: ctx.payer,
      source,
      balance,
      vault,
      vaultExists,
      amount,
      fee,
      split: fund.targets.map((t, index) => ({
        index,
        mint: t.mint,
        bps: t.bps,
        share: (amount * BigInt(t.bps)) / 10_000n,
      })),
    },
  };
}

// ---- withdraw ----

export interface WithdrawSummary {
  fund: PublicKey;
  fundAccount: FundAccount;
  holder: PublicKey;
  nftAccount: NftAccount | undefined;
  mint: MintMeta;
  vault: PublicKey;
  vaultBalance: bigint;
  amount: bigint;
  fee: bigint;
  destination: PublicKey;
  isQuote: boolean;
  /** False when the payer does not hold the NFT; the program will reject it. */
  payerHoldsNft: boolean;
}

export async function prepareWithdraw(
  ctx: PlanContext,
  fundKey: PublicKey,
  mintKey: PublicKey,
  requested: bigint | "all",
): Promise<{ plan: Plan; summary: WithdrawSummary }> {
  if (requested === 0n) throw new Error("--amount must be greater than zero");
  const fund = await loadFund(ctx.connection, ctx.program, fundKey);
  const mint = await mintInfo(ctx.connection, mintKey);
  const vault = associatedTokenAddress(fundKey, mintKey, mint.tokenProgram);
  const vaultInfo = await ctx.connection.getAccountInfo(vault);
  if (!vaultInfo) throw new Error(`fund vault ${vault.toBase58()} for ${mintKey.toBase58()} does not exist`);
  const vaultBalance = tokenAmount(vaultInfo.data);
  const amount = requested === "all" ? vaultBalance : requested;
  if (amount === 0n) throw new Error(`fund vault ${vault.toBase58()} is empty`);
  if (amount > vaultBalance) {
    throw new Error(
      `withdraw ${formatUi(amount, mint.decimals)} exceeds the vault balance ${formatUi(vaultBalance, mint.decimals)}`,
    );
  }
  const nftAccount = await findNftAccount(ctx.connection, fund.nftMint);
  const destination = associatedTokenAddress(ctx.payer, mintKey, mint.tokenProgram);
  const fee = await feeFor(ctx.connection, mint, amount);

  const ix = await ctx.program.methods
    .withdraw(new BN(amount.toString()))
    .accountsStrict({
      holder: ctx.payer,
      fund: fundKey,
      nftMint: fund.nftMint,
      nftAccount: nftAccount ? nftAccount.address : associatedTokenAddress(ctx.payer, fund.nftMint, NFT_TOKEN_PROGRAM_ID),
      nftTokenProgram: NFT_TOKEN_PROGRAM_ID,
      mint: mintKey,
      vault,
      destination,
      tokenProgram: mint.tokenProgram,
    })
    .instruction();
  return {
    plan: {
      txs: [
        {
          label: "withdraw",
          instructions: [...ctx.budget, createAtaIdempotentIx(ctx.payer, ctx.payer, mintKey, mint.tokenProgram), ix],
          extraSigners: [],
        },
      ],
      fund: fundKey,
    },
    summary: {
      fund: fundKey,
      fundAccount: fund,
      holder: ctx.payer,
      nftAccount,
      mint,
      vault,
      vaultBalance,
      amount,
      fee,
      destination,
      isQuote: mintKey.equals(fund.quoteMint),
      payerHoldsNft: nftAccount !== undefined && nftAccount.owner.equals(ctx.payer),
    },
  };
}

// ---- withdraw-native ----

export interface NativeBalance {
  lamports: bigint;
  dataLength: number;
  /** Rent-exempt minimum for the Fund account's current data length. */
  rentMinimum: bigint;
  /** lamports - rentMinimum, floored at 0: what withdraw_native may move. */
  available: bigint;
}

/** Native XNT on the Fund account and how much of it the holder can withdraw. */
export async function readNativeBalance(connection: Connection, fundKey: PublicKey): Promise<NativeBalance> {
  const info = await connection.getAccountInfo(fundKey, "confirmed");
  if (!info) throw new Error(`fund ${fundKey.toBase58()} does not exist`);
  const lamports = BigInt(info.lamports);
  const rentMinimum = BigInt(await connection.getMinimumBalanceForRentExemption(info.data.length, "confirmed"));
  return { lamports, dataLength: info.data.length, rentMinimum, available: nativeAvailable(lamports, rentMinimum) };
}

export interface WithdrawNativeSummary {
  fund: PublicKey;
  fundAccount: FundAccount;
  holder: PublicKey;
  nftAccount: NftAccount | undefined;
  balance: NativeBalance;
  amount: bigint;
  /** False when the payer does not hold the NFT; the program will reject it. */
  payerHoldsNft: boolean;
}

export async function prepareWithdrawNative(
  ctx: PlanContext,
  fundKey: PublicKey,
  requested: bigint | "all",
): Promise<{ plan: Plan; summary: WithdrawNativeSummary }> {
  if (requested === 0n) throw new Error("--amount must be greater than zero");
  const fund = await loadFund(ctx.connection, ctx.program, fundKey);
  const balance = await readNativeBalance(ctx.connection, fundKey);
  const amount = requested === "all" ? balance.available : requested;
  if (amount === 0n) {
    throw new Error(
      `fund ${fundKey.toBase58()} has no native XNT above its rent-exempt minimum ` +
        `(${formatUi(balance.lamports, 9)} held, ${formatUi(balance.rentMinimum, 9)} reserved for rent)`,
    );
  }
  if (amount > balance.available) {
    throw new Error(
      `withdraw-native ${formatUi(amount, 9)} exceeds the ${formatUi(balance.available, 9)} XNT available ` +
        `(fund holds ${formatUi(balance.lamports, 9)}, ${formatUi(balance.rentMinimum, 9)} stays for rent)`,
    );
  }
  const nftAccount = await findNftAccount(ctx.connection, fund.nftMint);
  const ix = await buildWithdrawNativeIx(
    ctx.program,
    {
      holder: ctx.payer,
      nftMint: fund.nftMint,
      nftAccount: nftAccount ? nftAccount.address : associatedTokenAddress(ctx.payer, fund.nftMint, NFT_TOKEN_PROGRAM_ID),
    },
    amount,
  );
  return {
    plan: { txs: [{ label: "withdraw_native", instructions: [...ctx.budget, ix], extraSigners: [] }], fund: fundKey },
    summary: {
      fund: fundKey,
      fundAccount: fund,
      holder: ctx.payer,
      nftAccount,
      balance,
      amount,
      payerHoldsNft: nftAccount !== undefined && nftAccount.owner.equals(ctx.payer),
    },
  };
}

// ---- ensure-vaults ----

export interface VaultState {
  mint: MintMeta;
  vault: PublicKey;
  exists: boolean;
}

/** Plan creating any missing quote/target vault ATAs. With none missing, `plan.txs` is empty. */
export async function prepareEnsureVaults(
  ctx: PlanContext,
  fundKey: PublicKey,
): Promise<{ plan: Plan; vaults: VaultState[]; missing: VaultState[] }> {
  const fund = await loadFund(ctx.connection, ctx.program, fundKey);
  const quote = await mintInfo(ctx.connection, fund.quoteMint);
  const targetMints: MintMeta[] = [];
  for (const t of fund.targets) {
    if (!t.mint.equals(fund.quoteMint)) targetMints.push(await mintInfo(ctx.connection, t.mint));
  }
  const planned = fundVaults(fundKey, quote, targetMints);
  const infos = await ctx.connection.getMultipleAccountsInfo(planned.map((v) => v.vault), "confirmed");
  const vaults = planned.map((v, i) => ({ ...v, exists: infos[i] !== null && infos[i] !== undefined }));
  const missing = vaults.filter((v) => !v.exists);
  if (missing.length === 0) return { plan: { txs: [], fund: fundKey }, vaults, missing };
  return {
    plan: {
      txs: [
        {
          label: "ensure vaults",
          instructions: [
            ...ctx.budget,
            ...missing.map((v) => createAtaIdempotentIx(ctx.payer, fundKey, v.mint.address, v.mint.tokenProgram)),
          ],
          extraSigners: [],
        },
      ],
      fund: fundKey,
    },
    vaults,
    missing,
  };
}

// ---- metadata ----

/** Throws unless Token Metadata is deployed (executable) on this RPC. */
export async function assertMetadataProgramDeployed(connection: Connection): Promise<void> {
  const info = await connection.getAccountInfo(METAPLEX_PROGRAM_ID);
  if (!info || !info.executable) {
    throw new Error(
      `Token Metadata ${METAPLEX_PROGRAM_ID.toBase58()} is not deployed on this RPC; ` +
        "metadata cannot be attached. Nothing was simulated or sent.",
    );
  }
}

/** The fund NFT's stored metadata, or undefined when none is attached. */
export async function readFundMetadata(
  connection: Connection,
  nftMint: PublicKey,
): Promise<{ address: PublicKey; edition: PublicKey; editionExists: boolean; stored: StoredMetadata | undefined }> {
  const address = metadataPda(nftMint);
  const edition = masterEditionPda(nftMint);
  const [md, ed] = await connection.getMultipleAccountsInfo([address, edition], "confirmed");
  let stored: StoredMetadata | undefined;
  if (isInitializedPda(md, address, "metadata")) {
    stored = decodeMetadata(md!.data);
  }
  return { address, edition, editionExists: isInitializedPda(ed, edition, "master edition"), stored };
}

/**
 * Whether a Token Metadata PDA holds an initialized account. Anyone can send
 * lamports to these public addresses, which leaves a System-owned account
 * with no data; that is still uninitialized (the program checks
 * `data_is_empty`, and Token Metadata allocates over it). Anything else that
 * is not owned by Token Metadata is rejected as unexpected.
 */
export function isInitializedPda(
  info: { owner: PublicKey; data: Uint8Array } | null | undefined,
  address: PublicKey,
  what: string,
): boolean {
  if (!info) return false;
  if (info.data.length === 0 && info.owner.equals(SystemProgram.programId)) return false;
  if (!info.owner.equals(METAPLEX_PROGRAM_ID)) {
    throw new Error(`${what} account ${address.toBase58()} is owned by ${info.owner.toBase58()}, not Token Metadata`);
  }
  if (info.data.length === 0) return false;
  return true;
}

export interface SetMetadataSummary {
  fund: PublicKey;
  nftMint: PublicKey;
  holder: PublicKey;
  nftAccount: NftAccount | undefined;
  /** attach when no metadata exists yet (needs all three fields), else update. */
  mode: "attach" | "update";
  current: StoredMetadata | undefined;
  /** Fields after the change. */
  next: MetadataFields;
  metadata: PublicKey;
  /** False when the payer does not hold the fund NFT; the program will reject this. */
  payerHoldsNft: boolean;
}

/**
 * set-metadata: attach_metadata when the fund NFT has no metadata (all of
 * name, symbol and uri required), otherwise update_metadata with only the
 * given fields. The payer must hold the NFT; the program checks it.
 */
export async function prepareSetMetadata(
  ctx: PlanContext,
  fundKey: PublicKey,
  update: MetadataUpdate,
): Promise<{ plan: Plan; summary: SetMetadataSummary }> {
  if (update.name === undefined && update.symbol === undefined && update.uri === undefined) {
    throw new Error("set-metadata needs at least one of --name, --symbol, --uri");
  }
  validateMetadataUpdate(update);
  await assertMetadataProgramDeployed(ctx.connection);
  const fund = await loadFund(ctx.connection, ctx.program, fundKey);
  const nftAccount = await findNftAccount(ctx.connection, fund.nftMint);
  const md = await readFundMetadata(ctx.connection, fund.nftMint);
  const accounts = {
    holder: ctx.payer,
    nftMint: fund.nftMint,
    nftAccount: nftAccount ? nftAccount.address : associatedTokenAddress(ctx.payer, fund.nftMint, NFT_TOKEN_PROGRAM_ID),
  };
  let ix: TransactionInstruction;
  let mode: SetMetadataSummary["mode"];
  let next: MetadataFields;
  if (!md.stored) {
    if (md.editionExists) throw new Error(`master edition ${md.edition.toBase58()} exists without metadata`);
    if (update.name === undefined || update.symbol === undefined || update.uri === undefined) {
      throw new Error("this fund NFT has no metadata yet; attaching it needs all of --name, --symbol and --uri");
    }
    next = { name: update.name, symbol: update.symbol, uri: update.uri };
    ix = await buildAttachMetadataIx(ctx.program, accounts, next);
    mode = "attach";
  } else {
    if (!md.stored.updateAuthority.equals(fundKey)) {
      throw new Error(
        `metadata ${md.address.toBase58()} has update authority ${md.stored.updateAuthority.toBase58()}, not the fund`,
      );
    }
    next = {
      name: update.name ?? md.stored.name,
      symbol: update.symbol ?? md.stored.symbol,
      uri: update.uri ?? md.stored.uri,
    };
    ix = await buildUpdateMetadataIx(ctx.program, accounts, update);
    mode = "update";
  }
  return {
    plan: {
      txs: [{ label: mode === "attach" ? "attach_metadata" : "update_metadata", instructions: [...ctx.budget, ix], extraSigners: [] }],
      fund: fundKey,
    },
    summary: {
      fund: fundKey,
      nftMint: fund.nftMint,
      holder: ctx.payer,
      nftAccount,
      mode,
      current: md.stored,
      next,
      metadata: md.address,
      payerHoldsNft: nftAccount !== undefined && nftAccount.owner.equals(ctx.payer),
    },
  };
}

// ---- read-only fund view ----

export type DueState = "cash" | "no budget" | "due" | "later";

export interface TargetView {
  index: number;
  mint: PublicKey;
  pool: PublicKey;
  bps: number;
  cash: boolean;
  budget: bigint;
  lastRun: bigint;
  nextDue: bigint;
  due: DueState;
}

export interface FundView {
  fund: PublicKey;
  account: FundAccount;
  quote: MintMeta;
  nftAccount: NftAccount | undefined;
  perRun: bigint;
  interval: bigint;
  targets: TargetView[];
  budgetTotal: bigint;
  /** Quote vault first, then each non-cash target vault; balance undefined when the vault is missing. */
  vaults: Array<{ mint: MintMeta; vault: PublicKey; balance: bigint | undefined }>;
  /** Indices of the targets the keeper would crank now (same rule as the keeper's dueTargets). */
  keeperDue: number[];
  now: bigint;
}

export async function loadFundView(
  connection: Connection,
  program: ProgramT,
  fundKey: PublicKey,
  now: bigint,
): Promise<FundView> {
  const account = await loadFund(connection, program, fundKey);
  const quote = await mintInfo(connection, account.quoteMint);
  const interval = BigInt(account.intervalSecs.toString());
  const nftAccount = await findNftAccount(connection, account.nftMint);
  let budgetTotal = 0n;
  const targets: TargetView[] = account.targets.map((t, index) => {
    const cash = t.mint.equals(account.quoteMint);
    const budget = BigInt(t.budget.toString());
    budgetTotal += budget;
    const lastRun = BigInt(t.lastRun.toString());
    const nextDue = lastRun + interval;
    let due: DueState;
    if (cash) due = "cash";
    else if (budget === 0n) due = "no budget";
    else if (now >= nextDue) due = "due";
    else due = "later";
    return { index, mint: t.mint, pool: t.pool, bps: t.bps, cash, budget, lastRun, nextDue, due };
  });
  const mints = [account.quoteMint, ...account.targets.map((t) => t.mint).filter((m) => !m.equals(account.quoteMint))];
  const vaults: FundView["vaults"] = [];
  for (const m of mints) {
    const info = m.equals(account.quoteMint) ? quote : await mintInfo(connection, m);
    const vault = associatedTokenAddress(fundKey, m, info.tokenProgram);
    const acct = await connection.getAccountInfo(vault);
    vaults.push({ mint: info, vault, balance: acct ? tokenAmount(acct.data) : undefined });
  }
  return {
    fund: fundKey,
    account,
    quote,
    nftAccount,
    perRun: BigInt(account.perRunQuote.toString()),
    interval,
    targets,
    budgetTotal,
    vaults,
    keeperDue: dueTargets(fundKey, account, now).map((d) => d.targetIndex),
    now,
  };
}

// ---- funds held by a wallet ----

export interface HeldFund {
  fund: PublicKey;
  nftMint: PublicKey;
  nftAccount: PublicKey;
  account: FundAccount;
}

/**
 * Funds whose NFT `owner` holds: classic SPL token accounts with amount 1 and
 * 0 decimals, mapped to fundPda(mint), kept when that account exists, is
 * owned by the program, and decodes as a Fund.
 */
export async function findFundsHeldBy(connection: Connection, program: ProgramT, owner: PublicKey): Promise<HeldFund[]> {
  const res = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed");
  const candidates: Array<{ nftMint: PublicKey; nftAccount: PublicKey; fund: PublicKey }> = [];
  for (const { pubkey, account } of res.value) {
    const data = account.data as { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } };
    const info = data.parsed?.info;
    if (!info?.mint || info.tokenAmount?.amount !== "1" || info.tokenAmount.decimals !== 0) continue;
    const nftMint = new PublicKey(info.mint);
    candidates.push({ nftMint, nftAccount: pubkey, fund: fundPda(nftMint, program.programId) });
  }
  const out: HeldFund[] = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const chunk = candidates.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(chunk.map((c) => c.fund), "confirmed");
    chunk.forEach((c, k) => {
      const info = infos[k];
      if (!info || !info.owner.equals(program.programId)) return;
      try {
        const account = decodeFund(program, info.data);
        if (account.nftMint.equals(c.nftMint)) out.push({ ...c, account });
      } catch {
        // Not a Fund account.
      }
    });
  }
  return out;
}
