/**
 * Permissionless crank for fund NFTs.
 *
 * Scans Fund accounts, keeps the targets whose interval has elapsed, and
 * builds execute_dca from the pinned pool account. Pass --dry-run (or leave
 * KEYPAIR unset) to print the transactions and not send them. A send needs
 * KEYPAIR and `--cluster <mainnet|testnet|localnet>` matching the RPC's
 * genesis hash; mainnet additionally needs --i-understand-mainnet.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Program as ProgramT, Wallet } from "@anchor-lang/core";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type AccountMeta,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  assertSendAllowed,
  clusterFromGenesisHash,
  CLUSTERS,
  isCluster,
  type Cluster,
} from "./cluster.js";
import { createProgram, decodeFund, dueTargets, fundFilters, IDL, type DueTarget } from "./fund.js";
import {
  associatedTokenAddress,
  readPool,
  readTokenAccountOwner,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./pool.js";

const require = createRequire(import.meta.url);
const { AnchorProvider } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

const DEFAULT_RPC = "https://rpc.mainnet.x1.xyz";
const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

class KeypairWallet implements Wallet {
  constructor(readonly payer: Keypair) {}

  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      tx.sign([this.payer]);
    } else {
      tx.partialSign(this.payer);
    }
    return tx;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }
}

interface Options {
  dryRun: boolean;
  cluster: Cluster | undefined;
  iUnderstandMainnet: boolean;
}

interface ComputeBudget {
  instructions: TransactionInstruction[];
  unitLimit: number;
  microLamports: number;
}

function parseArgs(argv: string[]): Options {
  let dryRun = false;
  let cluster: Cluster | undefined;
  let iUnderstandMainnet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--i-understand-mainnet") {
      iUnderstandMainnet = true;
    } else if (arg === "--cluster" || arg.startsWith("--cluster=")) {
      const value = arg === "--cluster" ? argv[++i] : arg.slice("--cluster=".length);
      if (!value || !isCluster(value)) {
        throw new Error(`--cluster must be one of ${CLUSTERS.join(", ")}`);
      }
      cluster = value;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { dryRun: dryRun || !process.env.KEYPAIR, cluster, iUnderstandMainnet };
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function computeBudget(): ComputeBudget {
  const unitLimit = envInt("COMPUTE_UNIT_LIMIT", DEFAULT_COMPUTE_UNIT_LIMIT, 1, MAX_COMPUTE_UNIT_LIMIT);
  const microLamports = envInt("PRIORITY_FEE_MICROLAMPORTS", 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    unitLimit,
    microLamports,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ],
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC;
  const connection = new Connection(rpcUrl, "confirmed");

  // Identify the chain from its genesis hash before any keypair is loaded.
  const genesisHash = await connection.getGenesisHash();
  const cluster = clusterFromGenesisHash(genesisHash);
  if (!options.dryRun) {
    assertSendAllowed({
      clusterFlag: options.cluster,
      genesisHash,
      iUnderstandMainnet: options.iUnderstandMainnet,
      rpcUrl,
    });
  }
  const budget = computeBudget();

  const payer = options.dryRun ? Keypair.generate() : loadPayer();
  const provider = new AnchorProvider(connection, new KeypairWallet(payer), {
    commitment: "confirmed",
  });
  const program = createProgram(provider);
  const programId = new PublicKey(IDL.address);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: fundFilters(program),
  });

  let failures = 0;
  const due: DueTarget[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      due.push(...dueTargets(pubkey, decodeFund(program, account.data), now));
    } catch (err) {
      failures++;
      console.error(`fund ${pubkey.toBase58()}: decode failed: ${errorMessage(err)}`);
    }
  }

  console.log(
    `${options.dryRun ? "dry-run" : "send"} ${rpcUrl} (${cluster}, genesis ${genesisHash}): ` +
      `${accounts.length} fund accounts, ${due.length} due targets`,
  );

  for (const item of due) {
    try {
      await processTarget(program, connection, payer.publicKey, item, options.dryRun, budget);
    } catch (err) {
      failures++;
      console.error(`fund ${item.fund.toBase58()} target ${item.targetIndex}: ${errorMessage(err)}`);
    }
  }

  if (failures > 0) {
    console.error(`${failures} item(s) failed`);
    process.exitCode = 1;
  }
}

async function processTarget(
  program: ProgramT,
  connection: Connection,
  caller: PublicKey,
  item: DueTarget,
  dryRun: boolean,
  budget: ComputeBudget,
): Promise<void> {
  const built = await buildExecuteAccounts(connection, caller, item);
  const builder = program.methods
    .executeDca(item.targetIndex)
    .accounts(built.accounts)
    .preInstructions(budget.instructions);
  if (dryRun) {
    const tx = await builder.transaction();
    const execute = tx.instructions.find((ix) => ix.programId.equals(program.programId));
    console.log(
      JSON.stringify(
        {
          fund: item.fund.toBase58(),
          targetIndex: item.targetIndex,
          mint: item.target.mint.toBase58(),
          pool: item.target.pool.toBase58(),
          authority: built.authority.toBase58(),
          computeUnitLimit: budget.unitLimit,
          priorityFeeMicroLamports: budget.microLamports,
          instructionAccounts: execute?.keys.map(describeMeta),
        },
        null,
        2,
      ),
    );
  } else {
    const signature = await builder.rpc();
    console.log(`executed ${item.fund.toBase58()} target ${item.targetIndex}: ${signature}`);
  }
}

async function buildExecuteAccounts(
  connection: Connection,
  caller: PublicKey,
  item: DueTarget,
): Promise<{ accounts: Record<string, PublicKey>; authority: PublicKey }> {
  const quoteMint = item.fundAccount.quoteMint;
  const poolInfo = await connection.getAccountInfo(item.target.pool);
  if (!poolInfo) throw new Error(`pool ${item.target.pool.toBase58()} is missing`);
  const pool = readPool(poolInfo.data);
  const quoteIsToken0 = pool.token0Mint.equals(quoteMint);
  const targetIsOther = quoteIsToken0
    ? pool.token1Mint.equals(item.target.mint)
    : pool.token0Mint.equals(item.target.mint);
  if (!targetIsOther) {
    throw new Error(`pool ${item.target.pool.toBase58()} mints do not match the fund target`);
  }
  const inputVault = quoteIsToken0 ? pool.token0Vault : pool.token1Vault;
  const outputVault = quoteIsToken0 ? pool.token1Vault : pool.token0Vault;
  const inputProgram = quoteIsToken0 ? pool.token0Program : pool.token1Program;
  const outputProgram = quoteIsToken0 ? pool.token1Program : pool.token0Program;
  const vaultInfo = await connection.getAccountInfo(inputVault);
  if (!vaultInfo) throw new Error(`pool vault ${inputVault.toBase58()} is missing`);
  const authority = readTokenAccountOwner(vaultInfo.data);
  const quoteProgram = await tokenProgramForMint(connection, quoteMint);
  const targetProgram = await tokenProgramForMint(connection, item.target.mint);
  return {
    authority,
    accounts: {
      caller,
      fund: item.fund,
      quoteMint,
      targetMint: item.target.mint,
      quoteVault: associatedTokenAddress(item.fund, quoteMint, quoteProgram),
      targetVault: associatedTokenAddress(item.fund, item.target.mint, targetProgram),
      callerQuoteAccount: associatedTokenAddress(caller, quoteMint, quoteProgram),
      quoteTokenProgram: quoteProgram,
      targetTokenProgram: targetProgram,
      poolProgram: poolInfo.owner,
      poolState: item.target.pool,
      ammConfig: pool.ammConfig,
      authority,
      poolInputVault: inputVault,
      poolOutputVault: outputVault,
      poolInputMint: quoteMint,
      poolOutputMint: item.target.mint,
      poolInputTokenProgram: inputProgram,
      poolOutputTokenProgram: outputProgram,
      observationState: pool.observation,
    },
  };
}

async function tokenProgramForMint(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} is missing`);
  if (info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return info.owner;
  }
  throw new Error(`mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}`);
}

function loadPayer(): Keypair {
  const file = process.env.KEYPAIR;
  if (!file) throw new Error("KEYPAIR is required to send");
  const secret = JSON.parse(readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function describeMeta(meta: AccountMeta): { pubkey: string; signer: boolean; writable: boolean } {
  return { pubkey: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});
