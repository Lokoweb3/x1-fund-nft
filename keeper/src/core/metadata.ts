/**
 * Fund NFT metadata (Metaplex Token Metadata), shared by the CLI and the web
 * app: client-side bounds that mirror programs/fund_nft/src/metaplex.rs, the
 * Token Metadata PDAs, the attach_metadata / update_metadata builders, and a
 * decoder for the stored name, symbol and uri.
 *
 * Display only. Nothing in the fund's accounting reads the metadata, and the
 * program never lets it touch a vault.
 *
 * Browser-safe: no node: imports.
 */
import type { Program as ProgramT } from "@anchor-lang/core";
import { Buffer } from "buffer";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, type TransactionInstruction } from "@solana/web3.js";
import { NFT_TOKEN_PROGRAM_ID, fundPda } from "./owner.js";

/** Token Metadata on X1 mainnet and testnet (metaplex.rs METAPLEX_PROGRAM_ID). */
export const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// Bounds from programs/fund_nft/src/metaplex.rs, in UTF-8 bytes.
export const MAX_NAME_LEN = 32;
export const MAX_SYMBOL_LEN = 10;
export const MAX_URI_LEN = 200;

export interface MetadataFields {
  name: string;
  symbol: string;
  uri: string;
}

export type MetadataUpdate = Partial<MetadataFields>;

const encoder = new TextEncoder();

export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

function checkField(flag: string, value: string, max: number): void {
  const len = utf8Length(value);
  if (len > max) throw new Error(`${flag} is ${len} bytes; the limit is ${max}`);
  if (value.includes("\0")) throw new Error(`${flag} cannot contain NUL characters`);
}

/** Same checks as metaplex.rs validate_name / validate_symbol / validate_uri. */
export function validateMetadataUpdate(update: MetadataUpdate): void {
  if (update.name !== undefined) checkField("--name", update.name, MAX_NAME_LEN);
  if (update.symbol !== undefined) checkField("--symbol", update.symbol, MAX_SYMBOL_LEN);
  if (update.uri !== undefined) checkField("--uri", update.uri, MAX_URI_LEN);
}

export function validateMetadataFields(fields: MetadataFields): void {
  validateMetadataUpdate(fields);
}

export function metadataPda(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), nftMint.toBuffer()],
    METAPLEX_PROGRAM_ID,
  )[0];
}

export function masterEditionPda(nftMint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), nftMint.toBuffer(), Buffer.from("edition")],
    METAPLEX_PROGRAM_ID,
  )[0];
}

export interface HolderAccounts {
  holder: PublicKey;
  nftMint: PublicKey;
  /** The holder's token account with the NFT (amount 1). */
  nftAccount: PublicKey;
}

export async function buildAttachMetadataIx(
  program: ProgramT,
  accounts: HolderAccounts,
  fields: MetadataFields,
): Promise<TransactionInstruction> {
  validateMetadataFields(fields);
  return program.methods
    .attachMetadata(fields.name, fields.symbol, fields.uri)
    .accountsStrict({
      holder: accounts.holder,
      fund: fundPda(accounts.nftMint, program.programId),
      nftMint: accounts.nftMint,
      nftAccount: accounts.nftAccount,
      metadata: metadataPda(accounts.nftMint),
      masterEdition: masterEditionPda(accounts.nftMint),
      nftTokenProgram: NFT_TOKEN_PROGRAM_ID,
      metadataProgram: METAPLEX_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}

export async function buildUpdateMetadataIx(
  program: ProgramT,
  accounts: HolderAccounts,
  update: MetadataUpdate,
): Promise<TransactionInstruction> {
  if (update.name === undefined && update.symbol === undefined && update.uri === undefined) {
    throw new Error("set-metadata needs at least one of --name, --symbol, --uri");
  }
  validateMetadataUpdate(update);
  return program.methods
    .updateMetadata(update.name ?? null, update.symbol ?? null, update.uri ?? null)
    .accountsStrict({
      holder: accounts.holder,
      fund: fundPda(accounts.nftMint, program.programId),
      nftMint: accounts.nftMint,
      nftAccount: accounts.nftAccount,
      metadata: metadataPda(accounts.nftMint),
      nftTokenProgram: NFT_TOKEN_PROGRAM_ID,
      metadataProgram: METAPLEX_PROGRAM_ID,
    })
    .instruction();
}

export interface StoredMetadata extends MetadataFields {
  updateAuthority: PublicKey;
  mint: PublicKey;
}

/**
 * Decode the head of a Token Metadata `Metadata` account: key (4 =
 * MetadataV1), update authority, mint, then borsh strings name, symbol, uri.
 * Trailing NUL padding (older Token Metadata versions) is trimmed.
 */
export function decodeMetadata(data: Uint8Array): StoredMetadata {
  if (data.length < 1 + 32 + 32 || data[0] !== 4) throw new Error("not a Token Metadata MetadataV1 account");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 1;
  const key = () => {
    const k = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return k;
  };
  const decoder = new TextDecoder();
  const str = () => {
    if (offset + 4 > data.length) throw new Error("metadata string is truncated");
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > data.length) throw new Error("metadata string is truncated");
    const s = decoder.decode(data.subarray(offset, offset + len)).replace(/\0+$/, "");
    offset += len;
    return s;
  };
  const updateAuthority = key();
  const mint = key();
  const name = str();
  const symbol = str();
  const uri = str();
  return { updateAuthority, mint, name, symbol, uri };
}
