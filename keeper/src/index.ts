/**
 * Permissionless crank for fund NFTs.
 *
 * Scans Fund accounts, keeps the targets whose interval has elapsed, and
 * builds execute_dca from the pinned pool account. Pass --dry-run to print
 * the transaction and not send it. Sending requires KEYPAIR and is refused
 * when the RPC URL looks like X1 mainnet.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { BN, Idl, Wallet } from "@anchor-lang/core";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  type AccountMeta,
} from "@solana/web3.js";

const require = createRequire(import.meta.url);
const { AnchorProvider, Program } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

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
import idlJson from "../idl/fund_nft.json" with { type: "json" };
import {
  associatedTokenAddress,
  readPool,
  readTokenAccountOwner,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./pool.js";

const IDL = idlJson as Idl;
const DEFAULT_RPC = "https://rpc.mainnet.x1.xyz";

interface TargetAccount {
  mint: PublicKey;
  pool: PublicKey;
  bps: number;
  budget: BN;
  last_run: BN;
}

interface FundAccount {
  nft_mint: PublicKey;
  quote_mint: PublicKey;
  bump: number;
  per_run_quote: BN;
  interval_secs: BN;
  twap_window_secs: number;
  max_dev_bps: number;
  targets: TargetAccount[];
}

interface DueTarget {
  fund: PublicKey;
  fundAccount: FundAccount;
  targetIndex: number;
  target: TargetAccount;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run") || !process.env.KEYPAIR;
  const rpcUrl = process.env.RPC_URL ?? DEFAULT_RPC;
  if (!dryRun && isMainnet(rpcUrl)) {
    throw new Error("refusing to send a transaction to X1 mainnet");
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const payer = loadPayer();
  const provider = new AnchorProvider(connection, new KeypairWallet(payer), {
    commitment: "confirmed",
  });
  const program = new Program(IDL, provider);
  const programId = new PublicKey(IDL.address);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
  });

  const due: DueTarget[] = [];
  for (const { pubkey, account } of accounts) {
    let decoded: FundAccount;
    try {
      decoded = program.coder.accounts.decode("Fund", account.data) as FundAccount;
    } catch {
      continue;
    }
    decoded.targets.forEach((target, targetIndex) => {
      if (target.mint.equals(decoded.quote_mint)) return;
      if (target.budget.lten(0)) return;
      const next = BigInt(target.last_run.toString()) + BigInt(decoded.interval_secs.toString());
      if (now >= next) {
        due.push({ fund: pubkey, fundAccount: decoded, targetIndex, target });
      }
    });
  }

  console.log(
    `${dryRun ? "dry-run" : "send"} ${rpcUrl}: ${accounts.length} program accounts, ${due.length} due targets`,
  );
  if (due.length === 0) return;

  for (const item of due) {
    const built = await buildExecuteAccounts(connection, payer.publicKey, item);
    const builder = program.methods
      .executeDca(item.targetIndex)
      .accounts(built.accounts);
    if (dryRun) {
      const tx = await builder.transaction();
      console.log(
        JSON.stringify(
          {
            fund: item.fund.toBase58(),
            targetIndex: item.targetIndex,
            mint: item.target.mint.toBase58(),
            pool: item.target.pool.toBase58(),
            authority: built.authority.toBase58(),
            instructionAccounts: tx.instructions[0]?.keys.map(describeMeta),
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
}

async function buildExecuteAccounts(
  connection: Connection,
  caller: PublicKey,
  item: DueTarget,
): Promise<{ accounts: Record<string, PublicKey>; authority: PublicKey }> {
  const poolInfo = await connection.getAccountInfo(item.target.pool);
  if (!poolInfo) throw new Error(`pool ${item.target.pool.toBase58()} is missing`);
  const pool = readPool(poolInfo.data);
  const quoteIsToken0 = pool.token0Mint.equals(item.fundAccount.quote_mint);
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
  const quoteProgram = await tokenProgramForMint(connection, item.fundAccount.quote_mint);
  const targetProgram = await tokenProgramForMint(connection, item.target.mint);
  return {
    authority,
    accounts: {
      caller,
      fund: item.fund,
      quoteMint: item.fundAccount.quote_mint,
      targetMint: item.target.mint,
      quoteVault: associatedTokenAddress(item.fund, item.fundAccount.quote_mint, quoteProgram),
      targetVault: associatedTokenAddress(item.fund, item.target.mint, targetProgram),
      callerQuoteAccount: associatedTokenAddress(caller, item.fundAccount.quote_mint, quoteProgram),
      quoteTokenProgram: quoteProgram,
      targetTokenProgram: targetProgram,
      poolProgram: poolInfo.owner,
      poolState: item.target.pool,
      ammConfig: pool.ammConfig,
      authority,
      poolInputVault: inputVault,
      poolOutputVault: outputVault,
      poolInputMint: item.fundAccount.quote_mint,
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
  if (!file) return Keypair.generate();
  const secret = JSON.parse(readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function isMainnet(rpcUrl: string): boolean {
  return rpcUrl.includes("rpc.mainnet.x1.xyz");
}

function describeMeta(meta: AccountMeta): { pubkey: string; signer: boolean; writable: boolean } {
  return { pubkey: meta.pubkey.toBase58(), signer: meta.isSigner, writable: meta.isWritable };
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
