/**
 * Owner CLI building blocks: argument parsing, client-side bounds that mirror
 * programs/fund_nft/src/state.rs, instruction builders, and the send gate.
 * Everything here is offline so the unit tests can cover it; src/cli.ts adds
 * the RPC reads, simulation, and sending.
 */
import { createRequire } from "node:module";
import type { Program as ProgramT } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { assertSendAllowed, CLUSTERS, isCluster, type Cluster } from "./cluster.js";
import { IDL } from "./fund.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, type PoolAccounts } from "./pool.js";

const require = createRequire(import.meta.url);
const { BN } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

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
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

export const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;
export const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

export type Command = "create-fund" | "deposit" | "withdraw" | "show";
export const COMMANDS: readonly Command[] = ["create-fund", "deposit", "withdraw", "show"];

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

export interface CommonOptions {
  send: boolean;
  cluster: Cluster | undefined;
  iUnderstandMainnet: boolean;
  payer: PublicKey | undefined;
  rpcUrl: string | undefined;
  xdex: PublicKey | undefined;
}

export type ParsedCli =
  | { command: "create-fund"; options: CommonOptions; create: CreateFundArgs }
  | { command: "deposit"; options: CommonOptions; fund: PublicKey; amount: bigint }
  | { command: "withdraw"; options: CommonOptions; fund: PublicKey; mint: PublicKey; amount: bigint | "all" }
  | { command: "show"; options: CommonOptions; fund: PublicKey };

const VALUE_FLAGS = new Set([
  "--quote",
  "--target",
  "--per-run",
  "--interval",
  "--window",
  "--max-dev-bps",
  "--fund",
  "--amount",
  "--mint",
  "--payer",
  "--cluster",
  "--rpc",
  "--xdex",
]);
const BOOL_FLAGS = new Set(["--send", "--i-understand-mainnet"]);

const ALLOWED: Record<Command, string[]> = {
  "create-fund": ["--quote", "--target", "--per-run", "--interval", "--window", "--max-dev-bps", "--xdex"],
  deposit: ["--fund", "--amount"],
  withdraw: ["--fund", "--mint", "--amount"],
  show: ["--fund"],
};
const COMMON = ["--payer", "--cluster", "--rpc", "--send", "--i-understand-mainnet"];

export const USAGE = `usage: npx tsx src/cli.ts <command> [flags]

commands:
  create-fund --quote <mint> --target <mint>:<pool>:<bps> [--target ...]
              --per-run <raw> --interval <secs> --window <secs> --max-dev-bps <n>
              (the cash slice is --target <quoteMint>:default:<bps>; localnet only: --xdex <id>)
  deposit     --fund <pda> --amount <raw>
  withdraw    --fund <pda> --mint <mint> --amount <raw|all>
  show        --fund <pda>

common flags:
  --payer <pubkey>          fee payer / signer for simulation when KEYPAIR is unset
  --rpc <url>               RPC endpoint (default: $RPC_URL, else https://rpc.mainnet.x1.xyz)
  --send                    send instead of simulate; also needs KEYPAIR and --cluster
  --cluster <${CLUSTERS.join("|")}>   must match the RPC's genesis hash
  --i-understand-mainnet    required, with --cluster mainnet, to send to X1 mainnet

Default is simulate-only. env: KEYPAIR, RPC_URL, COMPUTE_UNIT_LIMIT, PRIORITY_FEE_MICROLAMPORTS`;

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

/** `<mint>:<pool>:<bps>`; pool `default` (or the all-zero key) marks the cash slice. */
export function parseTarget(spec: string): TargetSpec {
  const parts = spec.split(":");
  if (parts.length !== 3) throw new Error(`--target ${JSON.stringify(spec)} must be <mint>:<pool>:<bps>`);
  const [mint, pool, bps] = parts as [string, string, string];
  return {
    mint: parsePubkey(mint, "--target mint"),
    pool: pool === "default" ? PublicKey.default : parsePubkey(pool, "--target pool"),
    bps: Number(parseUint(bps, "--target bps", 65_535n)),
  };
}

export function parseCli(argv: string[]): ParsedCli {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") throw new Error(USAGE);
  if (!(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(`unknown command ${JSON.stringify(command)}\n${USAGE}`);
  }
  const cmd = command as Command;
  const allowed = new Set([...ALLOWED[cmd], ...COMMON]);
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    let arg = rest[i]!;
    let inline: string | undefined;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (!allowed.has(arg)) throw new Error(`${cmd}: unknown or misplaced argument ${arg}\n${USAGE}`);
    if (BOOL_FLAGS.has(arg)) {
      if (inline !== undefined) throw new Error(`${arg} takes no value`);
      bools.add(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = inline ?? rest[++i];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        throw new Error(`${arg} needs a value`);
      }
      const list = values.get(arg) ?? [];
      list.push(value);
      values.set(arg, list);
    }
  }
  const one = (flag: string): string | undefined => {
    const list = values.get(flag);
    if (!list) return undefined;
    if (list.length > 1) throw new Error(`${flag} given more than once`);
    return list[0];
  };
  const need = (flag: string): string => {
    const value = one(flag);
    if (value === undefined) throw new Error(`${cmd} requires ${flag}`);
    return value;
  };

  const clusterValue = one("--cluster");
  if (clusterValue !== undefined && !isCluster(clusterValue)) {
    throw new Error(`--cluster must be one of ${CLUSTERS.join(", ")}`);
  }
  const payerValue = one("--payer");
  const xdexValue = one("--xdex");
  const options: CommonOptions = {
    send: bools.has("--send"),
    cluster: clusterValue as Cluster | undefined,
    iUnderstandMainnet: bools.has("--i-understand-mainnet"),
    payer: payerValue === undefined ? undefined : parsePubkey(payerValue, "--payer"),
    rpcUrl: one("--rpc"),
    xdex: xdexValue === undefined ? undefined : parsePubkey(xdexValue, "--xdex"),
  };

  switch (cmd) {
    case "create-fund": {
      const create: CreateFundArgs = {
        quote: parsePubkey(need("--quote"), "--quote"),
        targets: (values.get("--target") ?? []).map(parseTarget),
        perRun: parseUint(need("--per-run"), "--per-run", U64_MAX),
        interval: parseUint(need("--interval"), "--interval", I64_MAX),
        window: Number(parseUint(need("--window"), "--window", 0xffff_ffffn)),
        maxDevBps: Number(parseUint(need("--max-dev-bps"), "--max-dev-bps", 0xffffn)),
      };
      validateCreateFund(create);
      return { command: cmd, options, create };
    }
    case "deposit": {
      const amount = parseUint(need("--amount"), "--amount", U64_MAX);
      if (amount === 0n) throw new Error("--amount must be greater than zero");
      return { command: cmd, options, fund: parsePubkey(need("--fund"), "--fund"), amount };
    }
    case "withdraw": {
      const raw = need("--amount");
      const amount = raw === "all" ? "all" : parseUint(raw, "--amount", U64_MAX);
      if (amount === 0n) throw new Error("--amount must be greater than zero");
      return {
        command: cmd,
        options,
        fund: parsePubkey(need("--fund"), "--fund"),
        mint: parsePubkey(need("--mint"), "--mint"),
        amount,
      };
    }
    case "show":
      return { command: cmd, options, fund: parsePubkey(need("--fund"), "--fund") };
  }
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

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
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
export function computeBudget(env: NodeJS.ProcessEnv = process.env): ComputeBudget {
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

export interface SendGateInput {
  options: CommonOptions;
  genesisHash: string;
  rpcUrl: string;
  keypairEnv: string | undefined;
}

/**
 * Decide simulate vs send. Called after getGenesisHash and before any keypair
 * is loaded. Without --send it always simulates. With --send it requires
 * KEYPAIR and the keeper's cluster guard (--cluster matching genesis, and
 * --i-understand-mainnet for mainnet); any failure throws.
 */
export function sendGate(input: SendGateInput): { send: boolean; cluster?: Cluster } {
  if (!input.options.send) return { send: false };
  if (!input.keypairEnv) throw new Error("refusing to send: --send needs KEYPAIR set to a JSON keypair file");
  const cluster = assertSendAllowed({
    clusterFlag: input.options.cluster,
    genesisHash: input.genesisHash,
    iUnderstandMainnet: input.options.iUnderstandMainnet,
    rpcUrl: input.rpcUrl,
  });
  return { send: true, cluster };
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
