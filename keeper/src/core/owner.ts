/**
 * Owner building blocks shared by the CLI (src/cli.ts) and the web app
 * (app/): client-side bounds that mirror programs/fund_nft/src/state.rs,
 * instruction builders, plan size checks, transfer-fee math, and the send
 * phase with its honest partial-failure reporting. Everything here is offline
 * so the unit tests can cover it; core/rpc.ts adds the RPC reads.
 *
 * Browser-safe: no node: imports and no process.env. BN comes from bn.js
 * directly (the package Anchor re-exports), because Anchor's CommonJS build
 * does not expose BN as a named ESM export under Node.
 */
import BN from "bn.js";
import { Buffer } from "buffer";
import type { Program as ProgramT } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type AccountMeta,
} from "@solana/web3.js";
import type { Cluster } from "./cluster.js";
import { IDL } from "./fund.js";
import { buildAttachMetadataIx, type MetadataFields } from "./metadata.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, type PoolAccounts } from "./pool.js";

export const PROGRAM_ID = new PublicKey(IDL.address);
/** Mainnet XDEX cp-swap program, the only pool program the default build accepts. */
export const XDEX_PROGRAM_ID = new PublicKey("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");
/** The fund NFT is always a classic SPL mint (create_fund.rs NFT_TOKEN_PROGRAM_ID). */
export const NFT_TOKEN_PROGRAM_ID = TOKEN_PROGRAM_ID;
export const FUND_SEED = Buffer.from("fund");

// Bounds from programs/fund_nft/src/state.rs.
export const MAX_TARGETS = 8;
export const BPS_SUM = 10_000;
export const MAX_DEV_BPS = 500;
export const MIN_TWAP_WINDOW_SECS = 900;
export const MAX_TWAP_WINDOW_SECS = 86_400;
export const MIN_INTERVAL_SECS = 60n;
export const U64_MAX = (1n << 64n) - 1n;
export const I64_MAX = (1n << 63n) - 1n;

export const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

export interface TargetSpec {
  mint: PublicKey;
  /** PublicKey.default for the cash slice. */
  pool: PublicKey;
  bps: number;
}

export interface CreateFundArgs {
  quote: PublicKey;
  targets: TargetSpec[];
  perRun: bigint;
  interval: bigint;
  window: number;
  maxDevBps: number;
}

export function parsePubkey(value: string, what: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${what}: ${JSON.stringify(value)} is not a base58 public key`);
  }
}

/** Parse a non-negative decimal integer string. Rejects signs, decimals and exponents. */
export function parseUint(value: string, what: string, max: bigint): bigint {
  if (!/^\d+$/.test(value)) throw new Error(`${what} must be a non-negative integer (raw units), got ${JSON.stringify(value)}`);
  const n = BigInt(value);
  if (n > max) throw new Error(`${what} ${value} exceeds ${max}`);
  return n;
}

/**
 * Parse a UI-unit decimal string ("1.25") into raw units for a mint with
 * `decimals` places. Rejects signs, exponents, and more fractional digits than
 * the mint has, so the raw amount is exact.
 */
export function parseUi(value: string, decimals: number, what: string, max: bigint = U64_MAX): bigint {
  const v = value.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(v);
  if (!m || v === "" || v === ".") throw new Error(`${what} must be a non-negative decimal number, got ${JSON.stringify(value)}`);
  const whole = m[1] ?? "";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`${what} has more than ${decimals} decimal places`);
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (raw > max) throw new Error(`${what} ${value} exceeds the maximum`);
  return raw;
}

/** Same checks, in the same spirit, as state.rs validate_create. Throws on the first failure. */
export function validateCreateFund(args: CreateFundArgs): void {
  if (args.perRun <= 0n) throw new Error("--per-run must be greater than zero");
  if (args.interval < MIN_INTERVAL_SECS) throw new Error(`--interval must be at least ${MIN_INTERVAL_SECS} seconds`);
  if (args.window < MIN_TWAP_WINDOW_SECS || args.window > MAX_TWAP_WINDOW_SECS) {
    throw new Error(`--window must be between ${MIN_TWAP_WINDOW_SECS} and ${MAX_TWAP_WINDOW_SECS} seconds`);
  }
  if (args.maxDevBps > MAX_DEV_BPS) throw new Error(`--max-dev-bps cannot exceed ${MAX_DEV_BPS}`);
  const n = args.targets.length;
  if (n === 0) throw new Error("at least one --target is required");
  if (n > MAX_TARGETS) throw new Error(`at most ${MAX_TARGETS} targets, got ${n}`);
  let sum = 0;
  args.targets.forEach((target, i) => {
    if (target.bps <= 0) throw new Error(`target ${i}: bps must be greater than zero`);
    sum += target.bps;
    const cash = target.mint.equals(args.quote);
    if (cash && !target.pool.equals(PublicKey.default)) {
      throw new Error(`target ${i}: the cash slice (quote mint) must use pool "default"`);
    }
    if (!cash && target.pool.equals(PublicKey.default)) {
      throw new Error(`target ${i}: a non-cash target must pin a pool`);
    }
    for (const previous of args.targets.slice(0, i)) {
      if (previous.mint.equals(target.mint)) throw new Error(`target ${i}: duplicate mint ${target.mint.toBase58()}`);
      if (!target.pool.equals(PublicKey.default) && previous.pool.equals(target.pool)) {
        throw new Error(`target ${i}: duplicate pool ${target.pool.toBase58()}`);
      }
    }
  });
  if (sum !== BPS_SUM) throw new Error(`target weights sum to ${sum}, must be ${BPS_SUM}`);
}

export function fundPda(nftMint: PublicKey, programId: PublicKey = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([FUND_SEED, nftMint.toBuffer()], programId)[0];
}

/** create_fund remaining accounts: one read-only mint per non-cash target, in target order. */
export function createFundRemainingAccounts(quote: PublicKey, targets: TargetSpec[]): AccountMeta[] {
  return targets
    .filter((target) => !target.mint.equals(quote))
    .map((target) => ({ pubkey: target.mint, isSigner: false, isWritable: false }));
}

/** Check a pool account against its target: owned by XDEX, mints are {quote, target}. */
export function checkPool(
  index: number,
  target: TargetSpec,
  quote: PublicKey,
  poolOwner: PublicKey,
  pool: PoolAccounts,
  xdex: PublicKey,
): void {
  const where = `target ${index} pool ${target.pool.toBase58()}`;
  if (!poolOwner.equals(xdex)) {
    throw new Error(`${where} is owned by ${poolOwner.toBase58()}, not XDEX ${xdex.toBase58()}`);
  }
  const forward = pool.token0Mint.equals(quote) && pool.token1Mint.equals(target.mint);
  const reverse = pool.token1Mint.equals(quote) && pool.token0Mint.equals(target.mint);
  if (!forward && !reverse) {
    throw new Error(
      `${where} trades ${pool.token0Mint.toBase58()}/${pool.token1Mint.toBase58()}, not quote ${quote.toBase58()} / target ${target.mint.toBase58()}`,
    );
  }
}

export interface CreateFundAccounts {
  creator: PublicKey;
  nftMint: PublicKey;
  quoteMint: PublicKey;
}

export async function buildCreateFundIx(
  program: ProgramT,
  accounts: CreateFundAccounts,
  args: CreateFundArgs,
): Promise<TransactionInstruction> {
  const fund = fundPda(accounts.nftMint, program.programId);
  return program.methods
    .createFund({
      perRunQuote: new BN(args.perRun.toString()),
      intervalSecs: new BN(args.interval.toString()),
      twapWindowSecs: args.window,
      maxDevBps: args.maxDevBps,
      targets: args.targets.map((t) => ({ mint: t.mint, pool: t.pool, bps: t.bps })),
    })
    .accountsStrict({
      creator: accounts.creator,
      fund,
      nftMint: accounts.nftMint,
      creatorNftAccount: associatedTokenAddress(accounts.creator, accounts.nftMint, NFT_TOKEN_PROGRAM_ID),
      quoteMint: accounts.quoteMint,
      tokenProgram: NFT_TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts(createFundRemainingAccounts(args.quote, args.targets))
    .instruction();
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/** Associated Token Account program `CreateIdempotent` (instruction 1). */
export function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

export interface ComputeBudget {
  instructions: TransactionInstruction[];
  unitLimit: number;
  microLamports: number;
}

/** Plain string map: process.env in the CLI, {} or app settings in the browser. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

function envInt(env: EnvLike, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

/** Same env vars and bounds as the keeper (src/index.ts). */
export function computeBudgetFromEnv(env: EnvLike): ComputeBudget {
  const unitLimit = envInt(env, "COMPUTE_UNIT_LIMIT", DEFAULT_COMPUTE_UNIT_LIMIT, 1, MAX_COMPUTE_UNIT_LIMIT);
  const microLamports = envInt(env, "PRIORITY_FEE_MICROLAMPORTS", 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    unitLimit,
    microLamports,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ],
  };
}

/** Raw integer amount to a decimal string with `decimals` places, trailing zeros trimmed. */
export function formatUi(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  if (decimals === 0) return `${negative ? "-" : ""}${abs}`;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Largest serialized transaction the cluster accepts (PACKET_DATA_SIZE). */
export const MAX_TX_BYTES = 1232;

export interface MintMeta {
  address: PublicKey;
  tokenProgram: PublicKey;
  decimals: number;
  transferFee: TransferFeeConfig | undefined;
}

export interface PlannedTx {
  label: string;
  instructions: TransactionInstruction[];
  extraSigners: Keypair[];
  /**
   * Needs an account an earlier transaction of the same plan creates (for
   * example attach_metadata needs the fund create_fund makes), so it cannot
   * be simulated before that one confirms. Callers size-check it up front
   * and rely on the RPC's preflight simulation when it is sent.
   */
  dependsOnPrevious?: boolean;
}

export interface Plan {
  txs: PlannedTx[];
  /** The fund this plan creates or touches, printed again on a partial failure. */
  fund?: PublicKey;
  /** Command to run if only some transactions confirmed. */
  recovery?: string;
}

export interface TxOutcome {
  label: string;
  signature: string;
  /** Last block height at which this transaction could land (from the blockhash it was signed with). */
  lastValidBlockHeight: number;
  /**
   * The slot of the RPC response that confirmed it, when the RPC gave one. The
   * transaction executed at or before this slot, so any account state read to
   * plan a follow-up must come from a bank at least this new.
   */
  confirmedSlot?: number;
}

/**
 * Called by sendPlan for a transaction it is about to broadcast: after every
 * guard passed, synchronously, immediately before sendRawTransaction. A
 * transaction that never reaches this point was never broadcast. A caller
 * that must track every transaction that may land (an inscription upload)
 * records it here, so the record does not depend on the send's result.
 */
export type SubmitHook = (tx: { index: number; label: string; signature: string; lastValidBlockHeight: number }) => void;

export type FailedTxState = "not sent" | "unknown" | "failed";

/**
 * Error text when transaction `failed` of a multi-transaction plan did not
 * confirm. It lists what did confirm, says which transactions were not sent
 * (the failing one only when it truly was not), and gives the recovery
 * command when anything may have landed.
 */
export function partialFailureMessage(
  plan: Plan,
  done: ReadonlyArray<Pick<TxOutcome, "label" | "signature">>,
  failed: number,
  what: string,
  state: FailedTxState,
): string {
  const total = plan.txs.length;
  const name = (i: number) => `tx ${i + 1}/${total} (${plan.txs[i]!.label})`;
  const lines = [`${name(failed)} ${what}`];
  if (done.length === 0) {
    lines.push("no earlier transaction confirmed");
  } else {
    lines.push("confirmed before the failure:");
    done.forEach((d, i) => lines.push(`  ${name(i)}: ${d.signature}`));
  }
  const after = plan.txs.slice(failed + 1).map((_, k) => name(failed + 1 + k));
  const notSent = state === "not sent" ? [name(failed), ...after] : after;
  if (state === "unknown") lines.push(`${name(failed)} may or may not have landed; check the signature`);
  if (state === "failed") lines.push(`${name(failed)} landed and failed; it changed nothing but fees`);
  lines.push(notSent.length ? `not sent: ${notSent.join(", ")}` : "every transaction was submitted");
  if (plan.fund) lines.push(`fund PDA: ${plan.fund.toBase58()}`);
  if (plan.recovery && (done.length > 0 || state === "unknown")) lines.push(`recovery: ${plan.recovery}`);
  return lines.join("\n");
}

/** Serialized size of the legacy transaction, signature slots included. */
export function txSize(payer: PublicKey, instructions: TransactionInstruction[]): number {
  const message = new TransactionMessage({
    payerKey: payer,
    // Any 32-byte value; the size does not depend on it.
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToLegacyMessage();
  return new VersionedTransaction(message).serialize().length;
}

/** Throws a clear error, before any RPC send, if a planned transaction is too large. */
export function assertPlanFits(payer: PublicKey, plan: PlannedTx[], hint = ""): void {
  plan.forEach((tx, i) => {
    const size = txSize(payer, tx.instructions);
    if (size > MAX_TX_BYTES) {
      throw new Error(
        `tx ${i + 1}/${plan.length} (${tx.label}) is ${size} bytes; the limit is ${MAX_TX_BYTES}. ` +
          `Nothing was simulated or sent.${hint ? ` ${hint}` : ""}`,
      );
    }
  });
}

/**
 * create-fund plan. tx 1: compute budget + create_fund + quote vault ATA, so
 * deposits work as soon as it confirms. Then, when `metadata` is given,
 * attach_metadata (Metaplex metadata + master edition), kept out of tx 1 so
 * create_fund's size limit does not change; it depends on tx 1. Last (when
 * there are non-cash targets): the target vault ATAs execute_dca needs.
 * They are separate transactions, not one atomic step: tx 1 can confirm
 * while the rest are never sent. `set-metadata` and `ensure-vaults` recover
 * that.
 */
export async function planCreateFund(
  program: ProgramT,
  payer: PublicKey,
  nft: Keypair,
  args: CreateFundArgs,
  quote: MintMeta,
  targetMints: MintMeta[],
  budget: TransactionInstruction[],
  metadata?: MetadataFields,
): Promise<PlannedTx[]> {
  const fund = fundPda(nft.publicKey, program.programId);
  const createIx = await buildCreateFundIx(
    program,
    { creator: payer, nftMint: nft.publicKey, quoteMint: args.quote },
    args,
  );
  const plan: PlannedTx[] = [
    {
      label: "create_fund + quote vault",
      instructions: [...budget, createIx, createAtaIdempotentIx(payer, fund, quote.address, quote.tokenProgram)],
      extraSigners: [nft],
    },
  ];
  if (metadata) {
    const attachIx = await buildAttachMetadataIx(
      program,
      {
        holder: payer,
        nftMint: nft.publicKey,
        nftAccount: associatedTokenAddress(payer, nft.publicKey, NFT_TOKEN_PROGRAM_ID),
      },
      metadata,
    );
    plan.push({ label: "attach_metadata", instructions: [...budget, attachIx], extraSigners: [], dependsOnPrevious: true });
  }
  if (targetMints.length > 0) {
    plan.push({
      label: "target vaults",
      instructions: [
        ...budget,
        ...targetMints.map((m) => createAtaIdempotentIx(payer, fund, m.address, m.tokenProgram)),
      ],
      extraSigners: [],
    });
  }
  return plan;
}

/** Vault ATAs a fund needs: the quote vault, then each non-cash target vault. */
export function fundVaults(
  fund: PublicKey,
  quote: MintMeta,
  targetMints: MintMeta[],
): Array<{ mint: MintMeta; vault: PublicKey }> {
  return [quote, ...targetMints].map((mint) => ({
    mint,
    vault: associatedTokenAddress(fund, mint.address, mint.tokenProgram),
  }));
}

// Token-2022 transfer fee, same layout as programs/fund_nft/src/token_fee.rs.
export interface ScheduledFee {
  epoch: bigint;
  maximumFee: bigint;
  basisPoints: number;
}
export interface TransferFeeConfig {
  older: ScheduledFee;
  newer: ScheduledFee;
}

/** The TransferFeeConfig (TLV type 1) in mint data, or undefined if absent. */
export function readTransferFeeConfig(bytes: Uint8Array): TransferFeeConfig | undefined {
  if (bytes.length < 166 || bytes[165] !== 1) return undefined;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 166;
  while (offset + 4 <= bytes.length) {
    const type = data.getUint16(offset, true);
    const len = data.getUint16(offset + 2, true);
    const value = offset + 4;
    if (value + len > bytes.length) throw new Error("mint TLV data is truncated");
    if (type === 0 && len === 0) break;
    if (type === 1) {
      if (len < 108) throw new Error(`transfer-fee extension has length ${len}, expected 108`);
      const fee = (at: number): ScheduledFee => ({
        epoch: data.getBigUint64(at, true),
        maximumFee: data.getBigUint64(at + 8, true),
        basisPoints: data.getUint16(at + 16, true),
      });
      return { older: fee(value + 72), newer: fee(value + 90) };
    }
    offset = value + len;
  }
  return undefined;
}

/** Fee on a transfer of `amount` at `epoch`: ceil(amount * bps / 10000), capped at the maximum. */
export function transferFeeFor(config: TransferFeeConfig | undefined, amount: bigint, epoch: bigint): bigint {
  if (!config) return 0n;
  const fee = epoch >= config.newer.epoch ? config.newer : config.older;
  if (fee.basisPoints === 0 || amount === 0n) return 0n;
  const raw = (amount * BigInt(fee.basisPoints) + 9_999n) / 10_000n;
  return raw < fee.maximumFee ? raw : fee.maximumFee;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 encoding, used to name a transaction signature before it is submitted. */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** The fee-payer signature of a signed transaction, which is its transaction id. */
export function signatureOf(tx: VersionedTransaction): string {
  return base58(tx.signatures[0]);
}

/**
 * Classify a `sendRawTransaction` exception. Only a JSON-RPC error response
 * (web3.js `SendTransactionError`, e.g. a failed preflight) proves the node
 * refused the transaction. Any other exception (network failure, timeout,
 * lost response) may have happened after the node accepted and forwarded it,
 * so its status is unknown and the owner must check the signature before
 * retrying.
 */
export function classifySendError(err: unknown): Exclude<FailedTxState, "failed"> {
  return err instanceof SendTransactionError ? "not sent" : "unknown";
}

/** Single-quote a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Copyable ensure-vaults command. The keypair path is a quoted placeholder;
 * the CLI never prints key material or the KEYPAIR path it was given.
 */
export function ensureVaultsCommandLine(input: {
  fund: PublicKey;
  payer: PublicKey;
  rpcUrl: string;
  send: boolean;
  cluster: Cluster | undefined;
  iUnderstandMainnet: boolean;
}): string {
  const parts = [
    "npx tsx src/cli.ts ensure-vaults",
    `--fund ${input.fund.toBase58()}`,
    `--payer ${input.payer.toBase58()}`,
    `--rpc ${shellQuote(input.rpcUrl)}`,
  ];
  if (input.send) {
    parts.push("--send");
    if (input.cluster) parts.push(`--cluster ${input.cluster}`);
    if (input.iUnderstandMainnet) parts.push("--i-understand-mainnet");
  }
  const prefix = input.send ? "KEYPAIR='REPLACE_WITH_THE_SAME_KEYPAIR_PATH' " : "";
  return prefix + parts.join(" ");
}

/**
 * Copyable set-metadata command with the given fields (shell-quoted). Same
 * placeholder rule as ensureVaultsCommandLine for the keypair.
 */
export function setMetadataCommandLine(input: {
  fund: PublicKey;
  payer: PublicKey;
  rpcUrl: string;
  send: boolean;
  cluster: Cluster | undefined;
  iUnderstandMainnet: boolean;
  fields: Partial<MetadataFields>;
}): string {
  const parts = [
    "npx tsx src/cli.ts set-metadata",
    `--fund ${input.fund.toBase58()}`,
    `--payer ${input.payer.toBase58()}`,
    `--rpc ${shellQuote(input.rpcUrl)}`,
  ];
  if (input.fields.name !== undefined) parts.push(`--name=${shellQuote(input.fields.name)}`);
  if (input.fields.symbol !== undefined) parts.push(`--symbol=${shellQuote(input.fields.symbol)}`);
  if (input.fields.uri !== undefined) parts.push(`--uri=${shellQuote(input.fields.uri)}`);
  if (input.send) {
    parts.push("--send");
    if (input.cluster) parts.push(`--cluster ${input.cluster}`);
    if (input.iUnderstandMainnet) parts.push("--i-understand-mainnet");
  }
  const prefix = input.send ? "KEYPAIR='REPLACE_WITH_THE_SAME_KEYPAIR_PATH' " : "";
  return prefix + parts.join(" ");
}

/** The RPC calls the send phase needs; `Connection` satisfies it. */
export interface SendConnection {
  getLatestBlockhash(commitment: "confirmed"): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  sendRawTransaction(raw: Buffer | Uint8Array, opts: { skipPreflight: boolean }): Promise<string>;
  confirmTransaction(
    strategy: { signature: string; blockhash: string; lastValidBlockHeight: number },
    commitment: "confirmed",
  ): Promise<{ context?: { slot: number }; value: { err: unknown } }>;
}

export function compileTx(payer: PublicKey, tx: PlannedTx, blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: tx.instructions,
  }).compileToLegacyMessage();
  return new VersionedTransaction(message);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Signs a compiled transaction for the fee payer and returns the signed
 * transaction. The CLI signs with its Keypair (`keypairSigner`); the web app
 * passes the wallet's `signTransaction`. It runs in stage 1, before anything
 * is submitted, so a rejection or error here is always "not sent".
 */
export type TxSigner = (tx: VersionedTransaction) => Promise<VersionedTransaction>;

export function keypairSigner(signers: Keypair[]): TxSigner {
  return async (tx) => {
    tx.sign(signers);
    return tx;
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Error thrown by `sendPlan`. Its message is exactly `partialFailureMessage`;
 * the fields let a UI link the confirmed signatures and the failed one.
 */
export class PlanSendError extends Error {
  constructor(
    message: string,
    readonly done: TxOutcome[],
    readonly failedIndex: number,
    readonly state: FailedTxState,
    /** Signature of the failed transaction, when it was signed. */
    readonly signature: string | undefined,
    /**
     * Last block height at which the failed transaction can still land, set
     * whenever it was submitted ("unknown" or "failed"; undefined only for
     * "not sent"). A transaction whose status is unknown must not be retried
     * or worked around until it is confirmed or this height has passed. Every
     * confirmed transaction in `done` carries its own.
     */
    readonly lastValidBlockHeight?: number,
  ) {
    super(message);
    this.name = "PlanSendError";
  }
}

/**
 * Send an already-simulated plan in order. Every exit path after the first
 * confirmed transaction goes through `partialFailureMessage`, so the owner
 * always gets the confirmed signatures, the fund PDA, and the recovery step.
 *
 * Stage 1 (blockhash, compile, sign) happens before anything leaves this
 * process, so a failure there is "not sent". The payer signs first (`sign`,
 * or `signers` as Keypairs), then the plan's extra signers (the NFT mint).
 * The signer must return the exact message it was given, so what is sent is
 * what was simulated. Stage 2 (submission) is "not sent" only for a JSON-RPC
 * error response; any other exception is "unknown", with the signature to
 * check before retrying.
 *
 * `guard`, when given, runs before EACH signature and again before EACH
 * broadcast. If it throws, that transaction and every later one are reported
 * "not sent" (nothing of it left this process); transactions already
 * submitted keep their honest status. The web app uses it to stop when the
 * network, signer or mainnet acknowledgement changed mid-send.
 *
 * `onSubmit`, when given, runs after the broadcast guard and immediately
 * before each sendRawTransaction (see SubmitHook). If it throws, that
 * transaction is "not sent".
 */
export type SendGuard = (step: { index: number; stage: "sign" | "broadcast" }) => void;

export async function sendPlan(input: {
  connection: SendConnection;
  plan: Plan;
  payer: PublicKey;
  /** Keypair signers for the fee payer (CLI). Ignored when `sign` is given. */
  signers?: Keypair[];
  /** Injected fee-payer signer (the web app's wallet). */
  sign?: TxSigner;
  rpcUrl: string;
  log?: (line: string) => void;
  guard?: SendGuard;
  onSubmit?: SubmitHook;
}): Promise<TxOutcome[]> {
  const { connection, plan, payer, rpcUrl } = input;
  const sign = input.sign ?? keypairSigner(input.signers ?? []);
  const log = input.log ?? ((line: string) => console.log(line));
  const total = plan.txs.length;
  const done: TxOutcome[] = [];
  const fail = (i: number, what: string, state: FailedTxState, signature?: string, lastValid?: number) =>
    new PlanSendError(partialFailureMessage(plan, done, i, what, state), [...done], i, state, signature, lastValid);
  for (const [i, tx] of plan.txs.entries()) {
    let blockhash: string;
    let lastValidBlockHeight: number;
    let vtx: VersionedTransaction;
    let signature: string;
    try {
      ({ blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed"));
      const unsigned = compileTx(payer, tx, blockhash);
      const message = unsigned.message.serialize();
      input.guard?.({ index: i, stage: "sign" });
      vtx = await sign(unsigned);
      if (!bytesEqual(vtx.message.serialize(), message)) {
        throw new Error("the signer changed the transaction message; refusing to send what was not simulated");
      }
      if (tx.extraSigners.length > 0) vtx.sign(tx.extraSigners);
      if (vtx.signatures.some((s) => s.every((b) => b === 0))) {
        throw new Error("a required signature is missing");
      }
      signature = signatureOf(vtx);
    } catch (err) {
      throw fail(i, `could not be prepared (blockhash/compile/sign): ${errText(err)}`, "not sent");
    }
    try {
      // The wallet may have taken a while; re-check before anything leaves.
      input.guard?.({ index: i, stage: "broadcast" });
      // Synchronously, so nothing can run between the record and the send.
      input.onSubmit?.({ index: i, label: tx.label, signature, lastValidBlockHeight });
    } catch (err) {
      throw fail(i, `${signature} was signed but not broadcast: ${errText(err)}`, "not sent", signature);
    }
    try {
      await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: false });
    } catch (err) {
      const state = classifySendError(err);
      const what =
        state === "not sent"
          ? `${signature} was refused by the RPC before landing: ${errText(err)}`
          : `${signature} may have been submitted; its status is unknown: ${errText(err)}. ` +
            `Check it with: solana confirm -v ${signature} --url ${shellQuote(rpcUrl)} before retrying.`;
      throw fail(i, what, state, signature, state === "unknown" ? lastValidBlockHeight : undefined);
    }
    let result: { context?: { slot: number }; value: { err: unknown } };
    try {
      result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
    } catch (err) {
      throw fail(
        i,
        `${signature} was sent but its status is unknown: ${errText(err)}. ` +
          `Check it with: solana confirm -v ${signature} --url ${shellQuote(rpcUrl)} before retrying.`,
        "unknown",
        signature,
        lastValidBlockHeight,
      );
    }
    if (result.value.err) {
      throw fail(i, `${signature} landed and failed: ${JSON.stringify(result.value.err)}`, "failed", signature, lastValidBlockHeight);
    }
    const slot = result.context?.slot;
    done.push({ label: tx.label, signature, lastValidBlockHeight, ...(typeof slot === "number" ? { confirmedSlot: slot } : {}) });
    log(`  tx ${i + 1}/${total} (${tx.label}) sent and confirmed: ${signature}`);
  }
  return done;
}

