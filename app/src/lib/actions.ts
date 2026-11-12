/**
 * The app's action pipeline, mirroring src/cli.ts:
 *
 *   build the plan (shared planners) -> assertPlanFits -> program deployed?
 *   -> simulate EVERY transaction that can be simulated -> human review
 *   -> Sign & send (sendPlan)
 *
 * A transaction marked dependsOnPrevious (attach_metadata after create_fund,
 * an inscription's appends) needs an account an earlier transaction of the
 * same plan creates. Like the CLI, it is size-checked here and simulated by
 * the RPC's preflight when it is sent; the review says so.
 *
 * Every builder, check and the send phase come from keeper/src/core; this
 * file only turns their structured summaries into review sentences and rows.
 */
import { AnchorProvider, type Program as ProgramT, type Wallet } from "@anchor-lang/core";
import { Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { assertSendAllowed } from "@core/cluster.js";
import { createProgram } from "@core/fund.js";
import {
  assertPlanFits,
  compileTx,
  computeBudgetFromEnv,
  ensureVaultsCommandLine,
  formatUi,
  sendPlan,
  setMetadataCommandLine,
  txSize,
  XDEX_PROGRAM_ID,
  type CreateFundArgs,
  type MintMeta,
  type Plan,
  type TxOutcome,
} from "@core/owner.js";
import {
  assertProgramDeployed,
  planAccounts,
  prepareCreateFund,
  prepareDeposit,
  prepareEnsureVaults,
  prepareSetMetadata,
  prepareWithdraw,
  prepareWithdrawNative,
  simulateTx,
  type PlanContext,
  type SimResult,
  type WithdrawNativeSummary,
} from "@core/rpc.js";
import { TOKEN_2022_PROGRAM_ID } from "@core/pool.js";
import { FIRST_CHUNK_MAX, INSCRIPTION_PROGRAM_ID, prepareInscribe, type InscribePlan } from "@core/inscribe.js";
import type { MetadataFields, MetadataUpdate } from "@core/metadata.js";
import type { NetworkInfo } from "./network";
import { assertSession, sessionGuard, signerId, type SessionKey } from "./session";
import type { AppSigner } from "./signer";
import { labelFor, type TokenLabel } from "./tokens";
import { bpsToPercent, humanInterval } from "./wizard";

/** Compute budget for app sends: the keeper/CLI defaults (400k units, price 0). */
export const BUDGET = computeBudgetFromEnv({});

/** Anchor needs a Wallet for its provider; the coder never signs with it. */
function readOnlyWallet(publicKey: PublicKey): Wallet {
  const refuse = async () => {
    throw new Error("read-only provider");
  };
  return {
    publicKey,
    signTransaction: refuse as <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>,
    signAllTransactions: refuse as <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>,
    get payer(): never {
      throw new Error("read-only provider");
    },
  } as unknown as Wallet;
}

export function makeProgram(net: NetworkInfo, payer: PublicKey = PublicKey.default): ProgramT {
  return createProgram(new AnchorProvider(net.connection, readOnlyWallet(payer), { commitment: "confirmed" }));
}

export function planContext(net: NetworkInfo, payer: PublicKey): PlanContext {
  return { connection: net.connection, program: makeProgram(net, payer), payer, budget: BUDGET.instructions };
}

export type Row = [label: string, value: string];

/** A simulated transaction, or one that cannot be simulated before the previous one lands. */
export interface ReviewSim extends SimResult {
  /** True for a transaction that depends on an earlier one of the same plan (preflight-simulated at send). */
  skipped?: boolean;
}

export interface Review {
  /** Unique per built review. */
  id: number;
  title: string;
  /** Network generation the review was built and simulated under. */
  generation: number;
  /**
   * Signer epoch when the review build started (set by the page that built
   * it). A send requires the live epoch to be unchanged: any wallet connect,
   * disconnect, account or adapter change since then needs a fresh review.
   */
  signerEpoch?: number;
  rpcUrl: string;
  cluster: NetworkInfo["cluster"];
  payer: PublicKey;
  plan: Plan;
  /** The review in plain sentences. `rows` are the technical details. */
  sentences: string[];
  rows: Row[];
  warnings: string[];
  sims: ReviewSim[];
  accounts: ReturnType<typeof planAccounts>;
  simOk: boolean;
  nothingToDo: boolean;
  /** Shown after a successful send (e.g. the new fund PDA and NFT mint). */
  created?: { fund: PublicKey; nftMint: PublicKey };
  /** For an inscription review: what it writes, so the page can read it back after the send. */
  inscribe?: {
    number: bigint;
    uri: string;
    content: Uint8Array;
    contentType: string;
  };
}

interface Prepared {
  plan: Plan;
  rows: Row[];
  sentences?: string[];
  warnings?: string[];
  created?: Review["created"];
  inscribe?: Review["inscribe"];
}

export interface FinishOptions {
  /** Which program must be deployed for this plan. Default: the fund program. */
  program?: "fund" | "inscriptions";
}

let reviewCounter = 0;

/** Size check, program check, and simulation of every transaction that can be simulated now. */
export async function finishReview(net: NetworkInfo, payer: PublicKey, title: string, p: Prepared, opts: FinishOptions = {}): Promise<Review> {
  const base = {
    id: ++reviewCounter,
    title,
    generation: net.generation,
    rpcUrl: net.rpcUrl,
    cluster: net.cluster,
    payer,
    plan: p.plan,
    rows: p.rows,
    sentences: p.sentences ?? [],
    warnings: p.warnings ?? [],
    accounts: planAccounts(p.plan),
    created: p.created,
    inscribe: p.inscribe,
  };
  if (p.plan.txs.length === 0) return { ...base, sims: [], simOk: false, nothingToDo: true };
  assertPlanFits(payer, p.plan.txs);
  if (opts.program === "inscriptions") await assertInscriptionsDeployed(net);
  else await assertProgramDeployed(net.connection, net.rpcUrl, net.cluster);
  const sims: ReviewSim[] = [];
  for (const tx of p.plan.txs) {
    if (tx.dependsOnPrevious) {
      // Same rule as the CLI: size-checked above, simulated by the RPC's preflight when it is sent.
      sims.push({
        label: tx.label,
        size: txSize(payer, tx.instructions),
        signers: [payer, ...tx.extraSigners.map((k) => k.publicKey)],
        logs: [],
        err: null,
        unitsConsumed: undefined,
        skipped: true,
      });
      continue;
    }
    sims.push(await simulateTx(net.connection, payer, tx));
  }
  const fees = await networkFees(net, payer, p.plan);
  const n = p.plan.txs.length;
  const sentences =
    fees === undefined
      ? base.sentences
      : [...base.sentences, `Network fees for ${n === 1 ? "this transaction" : `these ${n} transactions`}: about ${xnt(fees)} XNT, as quoted by the RPC.`];
  return { ...base, sentences, sims, simOk: sims.every((s) => s.err === null), nothingToDo: false };
}

async function assertInscriptionsDeployed(net: NetworkInfo): Promise<void> {
  const info = await net.connection.getAccountInfo(INSCRIPTION_PROGRAM_ID);
  if (!info || !info.executable) {
    throw new Error(`X1 Inscriptions is not deployed on this RPC (${net.rpcUrl}, ${net.cluster}). Nothing was simulated or sent.`);
  }
}

/** Lamports as XNT for display. */
export function xnt(lamports: bigint | number): string {
  const v = Number(lamports) / 1e9;
  if (v > 0 && v < 0.0001) return v.toFixed(6);
  return v >= 1 ? v.toFixed(3) : v.toFixed(4);
}

/** Sum of getFeeForMessage over the plan, or undefined if the RPC cannot quote it. */
async function networkFees(net: NetworkInfo, payer: PublicKey, plan: Plan): Promise<bigint | undefined> {
  try {
    const { blockhash } = await net.connection.getLatestBlockhash("confirmed");
    let total = 0n;
    for (const tx of plan.txs) {
      const fee = await net.connection.getFeeForMessage(compileTx(payer, tx, blockhash).message, "confirmed");
      if (fee.value === null) return undefined;
      total += BigInt(fee.value);
    }
    return total;
  } catch {
    return undefined;
  }
}

export async function rent(net: NetworkInfo, bytes: number): Promise<bigint> {
  return BigInt(await net.connection.getMinimumBalanceForRentExemption(bytes, "confirmed"));
}

/** Token account size for a vault of this mint: 165, or Token-2022's 165 + type byte + ImmutableOwner (+ TransferFeeAmount). */
function vaultSize(m: MintMeta): number {
  if (!m.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return 165;
  return 165 + 1 + 4 + (m.transferFee ? 4 + 8 : 0);
}

/** Fund account size: 8-byte discriminator + Fund::INIT_SPACE (state.rs, up to 8 targets of 82 bytes). */
export const FUND_ACCOUNT_LEN = 8 + 32 + 32 + 1 + 8 + 8 + 4 + 2 + 4 + 8 * (32 + 32 + 2 + 8 + 8);
/**
 * attach_metadata, measured on the cloned Token Metadata (docs/ASSUMPTIONS.md):
 * a 607-byte metadata account (rent plus Token Metadata's 0.01 XNT fee) and a
 * 20-byte master edition, about 0.0161 XNT. The program refuses to let
 * attach_metadata debit the holder more than 0.03 XNT (AttachCostTooHigh).
 */
export const METADATA_CREATE_FEE = 10_000_000n;
export const ATTACH_DEBIT_CAP_LAMPORTS = 30_000_000n;
export const ATTACH_NOTE = "Attaching the NFT metadata costs about 0.016 XNT; the program refuses more than 0.03 XNT.";

export async function attachCost(net: NetworkInfo): Promise<bigint> {
  return (await rent(net, 607)) + METADATA_CREATE_FEE + (await rent(net, 20));
}

function ui(raw: bigint, mint: MintMeta): string {
  return `${formatUi(raw, mint.decimals)} (raw ${raw})`;
}

function feeRows(mint: MintMeta, amount: bigint, fee: bigint, from: string, netTo: string): Row[] {
  if (!mint.transferFee) return [];
  return [
    ["Gross debit", `${formatUi(amount, mint.decimals)} from ${from}`],
    ["Transfer fee (est.)", `${formatUi(fee, mint.decimals)} at the current epoch`],
    [`Net to ${netTo}`, formatUi(amount - fee, mint.decimals)],
  ];
}

function mintNote(m: MintMeta): string {
  const prog = m.tokenProgram.equals(TOKEN_2022_PROGRAM_ID) ? "Token-2022" : "SPL Token";
  const fee = m.transferFee ? `, transfer fee ${m.transferFee.newer.basisPoints} bps from epoch ${m.transferFee.newer.epoch}` : "";
  return `${m.decimals} decimals, ${prog}${fee}`;
}

/** Labels for mints, by base58; falls back to the curated list and the short address. */
export type Labels = Record<string, TokenLabel | undefined>;
const sym = (labels: Labels | undefined, mint: PublicKey) => (labels?.[mint.toBase58()] ?? labelFor(mint)).symbol;

/** "and" list: "A", "A and B", "A, B and C". */
function andList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface CreateFundOptions {
  /** Attach Metaplex metadata as transaction 2. */
  metadata?: MetadataFields;
  /** The NFT mint keypair (the wizard picks it first so the fund PDA can go into the metadata JSON). */
  nft?: Keypair;
  labels?: Labels;
}

/** Plain sentences describing a create-fund plan (exported for tests). */
export function createFundSentences(args: CreateFundArgs, quote: MintMeta, labels: Labels | undefined): string[] {
  const q = sym(labels, args.quote);
  const every = humanInterval(args.interval);
  const buys = args.targets.filter((t) => !t.mint.equals(args.quote));
  const cash = args.targets.find((t) => t.mint.equals(args.quote));
  const spend = buys.map((t) => `${formatUi((args.perRun * BigInt(t.bps)) / 10_000n, quote.decimals)} ${q} on ${sym(labels, t.mint)}`);
  const out = [`Every ${every} this fund spends ${andList(spend)}.`];
  if (cash) out.push(`It keeps ${bpsToPercent(cash.bps)}% of every deposit as cash in ${q}; that share is never spent.`);
  out.push(
    `Each buy goes through its pinned XDEX pool and is refused if it gets more than ${bpsToPercent(args.maxDevBps)}% below the ${humanInterval(args.window)} average price. ` +
      "0.1% of each buy is a tip for the keeper who runs it.",
  );
  return out;
}

export async function reviewCreateFund(net: NetworkInfo, payer: PublicKey, args: CreateFundArgs, opts: CreateFundOptions = {}): Promise<Review> {
  const ctx = planContext(net, payer);
  const p = await prepareCreateFund(ctx, args, XDEX_PROGRAM_ID, opts.metadata, opts.nft);
  const rows: Row[] = [
    ["NFT mint (new, in memory)", p.nft.publicKey.toBase58()],
    ["Fund PDA", p.fund.toBase58()],
    ["Creator / payer", payer.toBase58()],
    ["Quote mint", `${args.quote.toBase58()} (${mintNote(p.quote)})`],
    ["Per run", `${ui(args.perRun, p.quote)} quote`],
    ["Interval", `${args.interval} s`],
    ["TWAP window", `${args.window} s`],
    ["Max deviation", `${args.maxDevBps} bps`],
    ...args.targets.map((t, i): Row => [
      `Target ${i}`,
      `${t.mint.toBase58()} ${(t.bps / 100).toFixed(2)}% ` +
        (t.mint.equals(args.quote) ? "(cash slice, not swapped)" : `via pool ${t.pool.toBase58()}`),
    ]),
    ["NFT goes to", p.nftAccount.toBase58()],
    ...p.vaults.map((v): Row => [
      v.mint.address.equals(args.quote) ? "Quote vault ATA" : "Target vault ATA",
      `${v.vault.toBase58()} (${v.mint.address.toBase58()}, created idempotently)`,
    ]),
  ];
  if (opts.metadata) {
    rows.push(["NFT name", opts.metadata.name], ["NFT symbol", opts.metadata.symbol], ["NFT metadata uri", opts.metadata.uri]);
  }
  const sentences = createFundSentences(args, p.quote, opts.labels);
  sentences.push("You receive an NFT that owns this fund. Whoever holds it can withdraw the fund's tokens; send or sell the NFT and you hand the fund over.");
  const rentLamports =
    (await rent(net, FUND_ACCOUNT_LEN)) + (await rent(net, 82)) + (await rent(net, 165)) + (await Promise.all(p.vaults.map((v) => rent(net, vaultSize(v.mint))))).reduce((a, b) => a + b, 0n);
  sentences.push(
    `Rent: about ${xnt(rentLamports)} XNT is set aside in the fund account, the NFT and its account, and ${p.vaults.length} vault${p.vaults.length === 1 ? "" : "s"}. It stays in those accounts.`,
  );
  if (opts.metadata) sentences.push(`${ATTACH_NOTE} The NFT shows "${opts.metadata.name}" with the metadata at ${opts.metadata.uri}.`);
  else sentences.push("The NFT gets no name or picture now. Add them later with \"Set image / edit metadata\" on the fund page.");
  const warnings: string[] = [];
  if (p.plan.txs.length > 1) {
    warnings.push(
      `These are ${p.plan.txs.length} separate transactions, not one atomic step. If a later one does not land, the fund page can finish the job ` +
        `(${opts.metadata ? '"Set image / edit metadata" and ' : ""}"Ensure vaults").`,
    );
  }
  if (opts.metadata) {
    warnings.push(
      "attach_metadata (tx 2) cannot be simulated in advance: it needs the fund that tx 1 creates. It is size-checked now, and the RPC simulates it (preflight) when it is sent, after tx 1 confirms.",
    );
  }
  const ensure = ensureVaultsCommandLine({ fund: p.fund, payer, rpcUrl: net.rpcUrl, send: false, cluster: undefined, iUnderstandMainnet: false });
  const setMd = opts.metadata
    ? `; for the metadata press "Set image / edit metadata" (CLI: ${setMetadataCommandLine({ fund: p.fund, payer, rpcUrl: net.rpcUrl, send: false, cluster: undefined, iUnderstandMainnet: false, fields: opts.metadata })})`
    : "";
  const plan: Plan = {
    ...p.plan,
    recovery: `open fund ${p.fund.toBase58()} in this app and press "Ensure vaults" (CLI: ${ensure})${setMd}`,
  };
  return finishReview(net, payer, "Create fund", { plan, rows, sentences, warnings, created: { fund: p.fund, nftMint: p.nft.publicKey } });
}

export async function reviewDeposit(net: NetworkInfo, payer: PublicKey, fund: PublicKey, amount: bigint, labels?: Labels): Promise<Review> {
  const { plan, summary: s } = await prepareDeposit(planContext(net, payer), fund, amount);
  const q = sym(labels, s.quote.address);
  const rows: Row[] = [
    ["Fund", s.fund.toBase58()],
    ["Depositor", `${s.depositor.toBase58()} (from ${s.source.toBase58()})`],
    ["Amount", `${ui(s.amount, s.quote)} of ${s.quote.address.toBase58()}`],
    ["Depositor balance", ui(s.balance, s.quote)],
    ...feeRows(s.quote, s.amount, s.fee, "the depositor", "vault (budgets use the vault's actual increase)"),
    ["Quote vault", `${s.vault.toBase58()}${s.vaultExists ? "" : " (missing; created idempotently)"}`],
    ...s.split.map((x): Row => [
      `Budget +~ target ${x.index}`,
      `${formatUi(x.share, s.quote.decimals)} (${x.mint.toBase58()}, ${x.bps} bps; pre transfer-fee, approximate)`,
    ]),
  ];
  const sentences = [
    `You deposit ${formatUi(s.amount, s.quote.decimals)} ${q} into this fund (your balance is ${formatUi(s.balance, s.quote.decimals)} ${q}).`,
    `It is split: ${andList(s.split.map((x) => `${formatUi(x.share, s.quote.decimals)} ${x.mint.equals(s.quote.address) ? "kept as cash" : `for ${sym(labels, x.mint)}`}`))}.`,
  ];
  if (s.fee > 0n) sentences.push(`The token's transfer fee takes about ${formatUi(s.fee, s.quote.decimals)} ${q} of it on the way in.`);
  return finishReview(net, payer, "Deposit", { plan, rows, sentences });
}

export async function reviewWithdraw(
  net: NetworkInfo,
  payer: PublicKey,
  fund: PublicKey,
  mint: PublicKey,
  amount: bigint | "all",
  labels?: Labels,
): Promise<Review> {
  const { plan, summary: s } = await prepareWithdraw(planContext(net, payer), fund, mint, amount);
  const m = sym(labels, s.mint.address);
  const rows: Row[] = [
    ["Fund", s.fund.toBase58()],
    ["Holder", s.holder.toBase58()],
    ["NFT account", s.nftAccount ? `${s.nftAccount.address.toBase58()} (owner ${s.nftAccount.owner.toBase58()})` : "not found"],
    ["Mint", `${s.mint.address.toBase58()} (${mintNote(s.mint)})`],
    ["Amount", `${ui(s.amount, s.mint)} of vault ${formatUi(s.vaultBalance, s.mint.decimals)}`],
    ...feeRows(s.mint, s.amount, s.fee, "the vault", "holder"),
    ["From vault", s.vault.toBase58()],
    ["To", `${s.destination.toBase58()} (holder ATA, created idempotently)`],
  ];
  const sentences = [`You take ${formatUi(s.amount, s.mint.decimals)} ${m} out of the fund (it holds ${formatUi(s.vaultBalance, s.mint.decimals)} ${m}) into your wallet.`];
  if (s.fee > 0n) sentences.push(`The token's transfer fee takes about ${formatUi(s.fee, s.mint.decimals)} ${m} on the way out.`);
  const warnings: string[] = [];
  if (s.isQuote) {
    warnings.push(
      `Taking out the pay-with token shrinks the planned buys: the budgets go down by ${formatUi(s.amount, s.mint.decimals)} in total, in proportion to their size.`,
    );
  }
  if (!s.payerHoldsNft) warnings.push(`${payer.toBase58()} does not hold the fund NFT; the program will reject this.`);
  return finishReview(net, payer, "Withdraw", { plan, rows, sentences, warnings });
}

/** Plain sentences for a native XNT withdraw (exported for tests). Network fees are appended by finishReview. */
export function withdrawNativeSentences(s: WithdrawNativeSummary): string[] {
  const b = s.balance;
  const left = b.available - s.amount;
  return [
    `You move ${formatUi(s.amount, 9)} XNT (native) from the fund account to your wallet ${s.holder.toBase58()}.`,
    `The fund account holds ${formatUi(b.lamports, 9)} XNT. ${formatUi(b.rentMinimum, 9)} XNT stays there for rent and can never be withdrawn; ` +
      `after this, ${formatUi(left, 9)} XNT is left to withdraw.`,
    "The fund's token vaults, budgets and targets are not touched.",
  ];
}

export async function reviewWithdrawNative(net: NetworkInfo, payer: PublicKey, fund: PublicKey, amount: bigint | "all"): Promise<Review> {
  const { plan, summary: s } = await prepareWithdrawNative(planContext(net, payer), fund, amount);
  const b = s.balance;
  const rows: Row[] = [
    ["Fund", s.fund.toBase58()],
    ["Holder (receives the XNT)", s.holder.toBase58()],
    ["NFT account", s.nftAccount ? `${s.nftAccount.address.toBase58()} (owner ${s.nftAccount.owner.toBase58()})` : "not found"],
    ["Fund XNT", `${formatUi(b.lamports, 9)} (raw ${b.lamports})`],
    ["Rent reserve", `${formatUi(b.rentMinimum, 9)} (rent-exempt minimum for ${b.dataLength} bytes; stays)`],
    ["Available", `${formatUi(b.available, 9)} (raw ${b.available})`],
    ["Amount", `${formatUi(s.amount, 9)} XNT (raw ${s.amount} lamports)`],
  ];
  const warnings: string[] = [];
  if (!s.payerHoldsNft) warnings.push(`${payer.toBase58()} does not hold the fund NFT; the program will reject this.`);
  return finishReview(net, payer, "Withdraw native XNT", { plan, rows, sentences: withdrawNativeSentences(s), warnings });
}

export async function reviewEnsureVaults(net: NetworkInfo, payer: PublicKey, fund: PublicKey): Promise<Review> {
  const { plan, vaults, missing } = await prepareEnsureVaults(planContext(net, payer), fund);
  const rows: Row[] = vaults.map((v): Row => [
    `Vault ${v.mint.address.toBase58()}`,
    `${v.vault.toBase58()} ${v.exists ? "exists" : "MISSING"}`,
  ]);
  rows.push(["Result", missing.length === 0 ? `all ${vaults.length} vaults exist; nothing to do` : `creating ${missing.length} missing vault(s)`]);
  const sentences = [missing.length === 0 ? `All ${vaults.length} vaults exist.` : `This creates ${missing.length} missing vault(s) so the fund can hold every token.`];
  return finishReview(net, payer, "Ensure vaults", {
    plan: { ...plan, recovery: plan.txs.length ? `press "Ensure vaults" again for fund ${fund.toBase58()}` : undefined },
    rows,
    sentences,
  });
}

export async function reviewSetMetadata(net: NetworkInfo, payer: PublicKey, fund: PublicKey, update: MetadataUpdate): Promise<Review> {
  const { plan, summary: s } = await prepareSetMetadata(planContext(net, payer), fund, update);
  const rows: Row[] = [
    ["Fund", s.fund.toBase58()],
    ["NFT mint", s.nftMint.toBase58()],
    ["Metadata account", s.metadata.toBase58()],
    ["Mode", s.mode],
    ["Name", `${s.current?.name ?? "(none)"} -> ${s.next.name}`],
    ["Symbol", `${s.current?.symbol ?? "(none)"} -> ${s.next.symbol}`],
    ["Uri", `${s.current?.uri ?? "(none)"} -> ${s.next.uri}`],
  ];
  const sentences = [
    s.mode === "attach"
      ? `This gives the fund NFT its name "${s.next.name}", symbol ${s.next.symbol} and metadata link ${s.next.uri}.`
      : `This changes the fund NFT's ${andList(
          (["name", "symbol", "uri"] as const).filter((k) => update[k] !== undefined && update[k] !== s.current?.[k]).map((k) => (k === "uri" ? "metadata link" : k)),
        ) || "metadata (no field differs)"}. Only the holder of the NFT can do this.`,
  ];
  if (s.mode === "attach") sentences.push(ATTACH_NOTE);
  const warnings: string[] = [];
  if (!s.payerHoldsNft) warnings.push(`${payer.toBase58()} does not hold the fund NFT; the program will reject this.`);
  return finishReview(net, payer, "Set metadata", { plan: { ...plan, recovery: `press "Set image / edit metadata" again for fund ${fund.toBase58()}` }, rows, sentences, warnings });
}

/** Plain sentences for an inscription plan (exported for tests). */
export function inscribeSentences(p: InscribePlan, bytes: number, rentLamports: bigint, fees?: bigint): string[] {
  return [
    `This stores your ${bytes}-byte metadata JSON on X1 as inscription #${p.number} (predicted; the program picks the number when transaction 1 lands).`,
    `It takes ${p.txs.length} transaction${p.txs.length === 1 ? "" : "s"}. The X1 Inscriptions fee is ${xnt(p.fee)} XNT, plus about ${xnt(rentLamports)} XNT rent kept in the inscription and its NFT${
      fees === undefined ? "" : `, about ${xnt(p.fee + rentLamports + fees)} XNT in total with network fees`
    }.`,
    `Your fund NFT's metadata link will be ${p.uri}.`,
    "X1 Inscriptions is a third-party, upgradeable program, and its gateway is an off-chain website. The bytes stay on chain, but wallets follow the link, so the picture is only as available as that site.",
  ];
}

/** Rent the payer leaves in a new inscription: the account (212-byte header + content) and its Core asset (588 bytes, plus Core's 0.0015 XNT fee). */
export async function inscriptionRent(net: NetworkInfo, bytes: number): Promise<bigint> {
  return (await rent(net, 212 + bytes)) + (await rent(net, 588)) + 1_500_000n;
}

/**
 * The canary app inscribes only what fits ONE transaction: content of at most
 * FIRST_CHUNK_MAX (600) bytes, which planInscribe sends as a single inscribe
 * that seals at once (no append, no thaw). One transaction is atomic, so a
 * failure never leaves a partial upload, and the app never needs to resume.
 * Multi-transaction inscriptions and resume stay at the core/CLI level
 * (keeper/src/core/inscribe.ts), out of canary scope.
 */
export const INSCRIBE_MAX_BYTES = FIRST_CHUNK_MAX;

export function inscribeTooLarge(bytes: number): string | undefined {
  if (bytes <= INSCRIBE_MAX_BYTES) return undefined;
  return `Too large to inscribe in one transaction (${bytes} bytes, max ${INSCRIBE_MAX_BYTES}). Turn on Compact, shorten the description, or use Upload/Paste link.`;
}

/** Throws unless the inscription plan is exactly one transaction carrying all of `content`. Checked at planning and again before sending. */
export function assertSingleTxInscription(plan: Plan, content: Uint8Array): void {
  const tooLarge = inscribeTooLarge(content.length);
  if (tooLarge) throw new Error(`${tooLarge} Nothing was simulated or sent.`);
  if (plan.txs.length !== 1) {
    throw new Error(`the inscription plan has ${plan.txs.length} transactions; the app only sends single-transaction inscriptions. Nothing was simulated or sent.`);
  }
}

export async function reviewInscribe(net: NetworkInfo, payer: PublicKey, content: Uint8Array, maxFee: bigint): Promise<Review> {
  // Refuse before any RPC read.
  const tooLarge = inscribeTooLarge(content.length);
  if (tooLarge) throw new Error(`${tooLarge} Nothing was simulated or sent.`);
  const p = await prepareInscribe(net.connection, { payer, content, contentType: "application/json", maxFee });
  assertSingleTxInscription(p, content);
  const rentLamports = await inscriptionRent(net, content.length);
  const rows: Row[] = [
    ["Program", INSCRIPTION_PROGRAM_ID.toBase58()],
    ["Predicted number", `#${p.number}`],
    ["Inscription account", p.inscription.toBase58()],
    ["Inscription NFT (Core asset)", p.asset.toBase58()],
    ["Fee (max_fee sent)", `${p.fee} lamports`],
    ["Your max fee", `${maxFee} lamports`],
    ["Chunks", p.chunks.join(" + ")],
    ["Transaction sizes", p.sizes.join(", ")],
    ["Uri", p.uri],
  ];
  const warnings = [
    "If someone else inscribes first, the transaction fails (the predicted number is taken). No inscription fee or rent is committed on that failure, but the network fee can still be charged if the transaction lands and fails. Build the review again.",
  ];
  // One atomic transaction: there is nothing to resume.
  const plan: Plan = { ...p, recovery: undefined };
  const r = await finishReview(
    net,
    payer,
    "Inscribe metadata",
    { plan, rows, sentences: inscribeSentences(p, content.length, rentLamports), warnings, inscribe: { number: p.number, uri: p.uri, content, contentType: "application/json" } },
    { program: "inscriptions" },
  );
  return r;
}

/**
 * Re-check the chain, then hand the reviewed plan to the shared sendPlan with
 * the signer's TxSigner. Throws (and sends nothing) unless every gate passes.
 *
 * `getLive` returns the app's live session. It must still match the session
 * the review was built under (network generation, RPC, cluster, signer, and
 * on mainnet the acknowledgement) after the genesis re-check, before EACH
 * signature and before EACH broadcast; otherwise the remaining transactions
 * are reported "not sent". Already-submitted transactions keep their status.
 */
export async function signAndSend(input: {
  net: NetworkInfo;
  review: Review;
  signer: AppSigner;
  mainnetAck: boolean;
  getLive: () => SessionKey;
  log?: (line: string) => void;
}): Promise<TxOutcome[]> {
  const { net, review, signer } = input;
  if (!review.simOk) throw new Error("every simulation must pass before sending");
  if (review.inscribe) assertSingleTxInscription(review.plan, review.inscribe.content);
  if (review.rpcUrl !== net.rpcUrl || review.generation !== net.generation) {
    throw new Error("the network changed since this review was built; build it again");
  }
  if (!signer.publicKey.equals(review.payer)) {
    throw new Error(`the active signer ${signer.publicKey.toBase58()} is not the payer this review was built for; build it again`);
  }
  if (net.cluster === "unknown") throw new Error("refusing to send: this RPC is not X1 mainnet, X1 testnet, or a loopback localnet");
  if (signer.kind === "local-test" && net.cluster !== "localnet") throw new Error("the local test wallet signs only on localnet");
  if (net.cluster === "mainnet" && !input.mainnetAck) {
    throw new Error('refusing to send to X1 mainnet: tick "I understand this is X1 mainnet and uses real funds" first');
  }
  if (review.signerEpoch === undefined) throw new Error("this review has no signer epoch; build it again");
  const expected: SessionKey = {
    generation: review.generation,
    rpcUrl: review.rpcUrl,
    cluster: review.cluster,
    signerId: signerId(signer),
    // Captured now and compared with === : the very object that signs.
    signer,
    signerEpoch: review.signerEpoch,
    mainnetAck: input.mainnetAck,
  };
  assertSession(expected, input.getLive());
  // Same guard as the CLI: the genesis hash, fetched again now, must still be
  // the cluster this session detected.
  const genesisHash = await net.connection.getGenesisHash();
  assertSendAllowed({ clusterFlag: net.cluster, genesisHash, iUnderstandMainnet: input.mainnetAck, rpcUrl: net.rpcUrl });
  // The genesis call may have been slow; the session must still be the same.
  assertSession(expected, input.getLive());
  return sendPlan({
    connection: net.connection,
    plan: review.plan,
    payer: review.payer,
    // Re-check immediately after the wallet promise resolves, before the
    // NFT key adds its signature: an event during the prompt invalidates it.
    sign: async (tx) => {
      const signed = await signer.sign(tx);
      assertSession(expected, input.getLive());
      return signed;
    },
    rpcUrl: net.rpcUrl,
    log: input.log ?? (() => {}),
    guard: sessionGuard(expected, input.getLive),
  });
}
