import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

// Browser-safe (no node: imports): the web app in app/ imports this file.

/**
 * Offsets checked against the live USDC.X/TEST pool, its amm config, and its
 * observation account. See programs/fund_nft/src/xdex.rs.
 */
export const POOL_LEN = 637;
export const POOL_DISCRIMINATOR = Buffer.from("f7ede3f5d7c3de46", "hex");
const OFF_AMM_CONFIG = 8;
const OFF_TOKEN_0_VAULT = 72;
const OFF_TOKEN_1_VAULT = 104;
const OFF_TOKEN_0_MINT = 168;
const OFF_TOKEN_1_MINT = 200;
const OFF_TOKEN_0_PROGRAM = 232;
const OFF_TOKEN_1_PROGRAM = 264;
const OFF_OBSERVATION = 296;

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

export interface PoolAccounts {
  ammConfig: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  token0Program: PublicKey;
  token1Program: PublicKey;
  observation: PublicKey;
}

export function readPool(data: Uint8Array): PoolAccounts {
  if (data.length !== POOL_LEN || !POOL_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw new Error(`pool account is not a 637-byte PoolState (len ${data.length})`);
  }
  return {
    ammConfig: keyAt(data, OFF_AMM_CONFIG),
    token0Vault: keyAt(data, OFF_TOKEN_0_VAULT),
    token1Vault: keyAt(data, OFF_TOKEN_1_VAULT),
    token0Mint: keyAt(data, OFF_TOKEN_0_MINT),
    token1Mint: keyAt(data, OFF_TOKEN_1_MINT),
    token0Program: keyAt(data, OFF_TOKEN_0_PROGRAM),
    token1Program: keyAt(data, OFF_TOKEN_1_PROGRAM),
    observation: keyAt(data, OFF_OBSERVATION),
  };
}

/** SPL token account owner, the wallet or PDA that must sign. Offset 32. */
export function readTokenAccountOwner(data: Uint8Array): PublicKey {
  if (data.length < 64) {
    throw new Error("token account is too short to contain an owner");
  }
  return new PublicKey(data.subarray(32, 64));
}

export function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

function keyAt(data: Uint8Array, offset: number): PublicKey {
  return new PublicKey(data.subarray(offset, offset + 32));
}
