/**
 * Fund account decoding and due-target selection.
 *
 * The Anchor 1.2.2 `Program` constructor camelCases the IDL, so the coder
 * knows the account as `fund` and its fields as `nftMint`, `quoteMint`,
 * `perRunQuote`, `targets[].lastRun` and so on. Everything here goes through
 * that camelCased coder so the keeper and the tests decode the same way.
 *
 * Browser-safe (no node: imports): the web app in app/ imports this file.
 */
import { Program } from "@anchor-lang/core";
import { Buffer } from "buffer";
import type { BN, Idl, Program as ProgramT, Provider } from "@anchor-lang/core";
import type { GetProgramAccountsFilter, PublicKey } from "@solana/web3.js";
import idlJson from "../../idl/fund_nft.json" with { type: "json" };

export const IDL = idlJson as Idl;
/** Coder name for the Fund account after the IDL is camelCased. */
export const FUND_ACCOUNT = "fund";

export interface TargetAccount {
  mint: PublicKey;
  pool: PublicKey;
  bps: number;
  budget: BN;
  lastRun: BN;
}

export interface FundAccount {
  nftMint: PublicKey;
  quoteMint: PublicKey;
  bump: number;
  perRunQuote: BN;
  intervalSecs: BN;
  twapWindowSecs: number;
  maxDevBps: number;
  targets: TargetAccount[];
}

export interface DueTarget {
  fund: PublicKey;
  fundAccount: FundAccount;
  targetIndex: number;
  target: TargetAccount;
}

export function createProgram(provider: Provider): ProgramT {
  return new Program(IDL, provider);
}

/** getProgramAccounts filter that returns only accounts with the Fund discriminator. */
export function fundFilters(program: ProgramT): GetProgramAccountsFilter[] {
  const discriminator = program.coder.accounts.memcmp(FUND_ACCOUNT) as {
    offset: number;
    bytes: string;
  };
  return [{ memcmp: { offset: discriminator.offset, bytes: discriminator.bytes } }];
}

/** Decode a Fund account. Throws on a wrong discriminator or a malformed body. */
export function decodeFund(program: ProgramT, data: Uint8Array): FundAccount {
  return program.coder.accounts.decode<FundAccount>(FUND_ACCOUNT, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
}

/**
 * Targets the program would accept in execute_dca right now: not the quote
 * cash slot, a non-zero budget, and `now >= lastRun + intervalSecs`.
 */
export function dueTargets(fund: PublicKey, fundAccount: FundAccount, now: bigint): DueTarget[] {
  const due: DueTarget[] = [];
  const interval = BigInt(fundAccount.intervalSecs.toString());
  fundAccount.targets.forEach((target, targetIndex) => {
    if (target.mint.equals(fundAccount.quoteMint)) return;
    if (target.budget.lten(0)) return;
    const next = BigInt(target.lastRun.toString()) + interval;
    if (now >= next) {
      due.push({ fund, fundAccount, targetIndex, target });
    }
  });
  return due;
}
