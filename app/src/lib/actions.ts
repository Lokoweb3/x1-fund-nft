/**
 * The app's action pipeline, mirroring src/cli.ts:
 *
 *   build the plan (shared planners) -> assertPlanFits -> program deployed?
 *   -> simulate EVERY transaction -> human review -> Sign & send (sendPlan)
 *
 * Every builder, check and the send phase come from keeper/src/core; this
 * file only turns their structured summaries into review rows.
 */
import { AnchorProvider, type Program as ProgramT, type Wallet } from "@anchor-lang/core";
import { PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import { assertSendAllowed } from "@core/cluster.js";
import { createProgram } from "@core/fund.js";
import {
  assertPlanFits,
  computeBudgetFromEnv,
  ensureVaultsCommandLine,
  formatUi,
  sendPlan,
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
  prepareWithdraw,
  simulateTx,
  type PlanContext,
  type SimResult,
} from "@core/rpc.js";
import { TOKEN_2022_PROGRAM_ID } from "@core/pool.js";
import type { NetworkInfo } from "./network";
import { assertSession, sessionGuard, signerId, type SessionKey } from "./session";
import type { AppSigner } from "./signer";

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
  rows: Row[];
  warnings: string[];
  sims: SimResult[];
  accounts: ReturnType<typeof planAccounts>;
  simOk: boolean;
  nothingToDo: boolean;
  /** Shown after a successful send (e.g. the new fund PDA and NFT mint). */
  created?: { fund: PublicKey; nftMint: PublicKey };
}

interface Prepared {
  plan: Plan;
  rows: Row[];
  warnings?: string[];
  created?: Review["created"];
}

let reviewCounter = 0;

/** Size check, program check, and simulation of every transaction in the plan. */
export async function finishReview(net: NetworkInfo, payer: PublicKey, title: string, p: Prepared): Promise<Review> {
  const base = {
    id: ++reviewCounter,
    title,
    generation: net.generation,
    rpcUrl: net.rpcUrl,
    cluster: net.cluster,
    payer,
    plan: p.plan,
    rows: p.rows,
    warnings: p.warnings ?? [],
    accounts: planAccounts(p.plan),
    created: p.created,
  };
  if (p.plan.txs.length === 0) return { ...base, sims: [], simOk: false, nothingToDo: true };
  assertPlanFits(payer, p.plan.txs);
  await assertProgramDeployed(net.connection, net.rpcUrl, net.cluster);
  const sims: SimResult[] = [];
  for (const tx of p.plan.txs) sims.push(await simulateTx(net.connection, payer, tx));
  return { ...base, sims, simOk: sims.every((s) => s.err === null), nothingToDo: false };
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

export async function reviewCreateFund(net: NetworkInfo, payer: PublicKey, args: CreateFundArgs): Promise<Review> {
  const ctx = planContext(net, payer);
  const p = await prepareCreateFund(ctx, args, XDEX_PROGRAM_ID);
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
  const warnings =
    p.plan.txs.length > 1
      ? ["These are separate transactions, not one atomic step. If the second does not land, use Ensure vaults on the fund page."]
      : [];
  const plan: Plan = {
    ...p.plan,
    recovery:
      `open fund ${p.fund.toBase58()} in this app and press "Ensure vaults"; CLI alternative: ` +
      ensureVaultsCommandLine({ fund: p.fund, payer, rpcUrl: net.rpcUrl, send: false, cluster: undefined, iUnderstandMainnet: false }),
  };
  return finishReview(net, payer, "Create fund", { plan, rows, warnings, created: { fund: p.fund, nftMint: p.nft.publicKey } });
}

export async function reviewDeposit(net: NetworkInfo, payer: PublicKey, fund: PublicKey, amount: bigint): Promise<Review> {
  const { plan, summary: s } = await prepareDeposit(planContext(net, payer), fund, amount);
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
  return finishReview(net, payer, "Deposit", { plan, rows });
}

export async function reviewWithdraw(
  net: NetworkInfo,
  payer: PublicKey,
  fund: PublicKey,
  mint: PublicKey,
  amount: bigint | "all",
): Promise<Review> {
  const { plan, summary: s } = await prepareWithdraw(planContext(net, payer), fund, mint, amount);
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
  const warnings: string[] = [];
  if (s.isQuote) {
    warnings.push(
      `Quote withdraw: target budgets shrink by the gross ${formatUi(s.amount, s.mint.decimals)}, in proportion to their current size.`,
    );
  }
  if (!s.payerHoldsNft) warnings.push(`${payer.toBase58()} does not hold the fund NFT; the program will reject this.`);
  return finishReview(net, payer, "Withdraw", { plan, rows, warnings });
}

export async function reviewEnsureVaults(net: NetworkInfo, payer: PublicKey, fund: PublicKey): Promise<Review> {
  const { plan, vaults, missing } = await prepareEnsureVaults(planContext(net, payer), fund);
  const rows: Row[] = vaults.map((v): Row => [
    `Vault ${v.mint.address.toBase58()}`,
    `${v.vault.toBase58()} ${v.exists ? "exists" : "MISSING"}`,
  ]);
  rows.push(["Result", missing.length === 0 ? `all ${vaults.length} vaults exist; nothing to do` : `creating ${missing.length} missing vault(s)`]);
  return finishReview(net, payer, "Ensure vaults", {
    plan: { ...plan, recovery: plan.txs.length ? `press "Ensure vaults" again for fund ${fund.toBase58()}` : undefined },
    rows,
  });
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
