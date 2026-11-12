/**
 * What a pasted token mint is: decimals, token program, transfer fee, the
 * program's extension policy (mint_policy.ts), and a display name from the
 * Token-2022 TokenMetadata extension or, failing that, the Metaplex Token
 * Metadata account. Read-only; one getMultipleAccountsInfo per batch.
 *
 * Names and symbols come from whoever controls the mint's metadata, so they
 * are labels, never identity. The app always shows the address too.
 *
 * Browser-safe: no node: imports.
 */
import { PublicKey } from "@solana/web3.js";
import { decodeMetadata, metadataPda, METAPLEX_PROGRAM_ID } from "./metadata.js";
import { checkMintBytes, mintExtensionTypes, type MintPolicyResult } from "./mint_policy.js";
import { readTransferFeeConfig, type MintMeta } from "./owner.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./pool.js";

export const EXT_TOKEN_METADATA = 19;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export interface Token2022Metadata {
  updateAuthority: PublicKey | null;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}

/**
 * The TokenMetadata (type 19) TLV entry of a Token-2022 mint, if present:
 * update_authority (OptionalNonZeroPubkey), mint, then borsh strings name,
 * symbol, uri. Additional metadata is not read. Returns undefined when the
 * entry is absent or does not parse.
 */
export function readToken2022Metadata(data: Uint8Array): Token2022Metadata | undefined {
  if (data.length <= 166 || data[165] !== 1) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 166;
  while (offset + 4 <= data.length) {
    const type = view.getUint16(offset, true);
    const len = view.getUint16(offset + 2, true);
    const start = offset + 4;
    const end = start + len;
    if (type === 0 || end > data.length) return undefined;
    if (type === EXT_TOKEN_METADATA) {
      try {
        if (len < 64 + 12) return undefined;
        const body = data.subarray(start, end);
        const bv = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const authority = body.subarray(0, 32);
        let p = 64;
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const str = () => {
          if (p + 4 > body.length) throw new Error("truncated");
          const n = bv.getUint32(p, true);
          if (p + 4 + n > body.length) throw new Error("truncated");
          const s = decoder.decode(body.subarray(p + 4, p + 4 + n));
          p += 4 + n;
          return s;
        };
        const name = str();
        const symbol = str();
        const uri = str();
        return {
          updateAuthority: authority.every((b) => b === 0) ? null : new PublicKey(authority),
          mint: new PublicKey(body.subarray(32, 64)),
          name,
          symbol,
          uri,
        };
      } catch {
        return undefined;
      }
    }
    offset = end;
  }
  return undefined;
}

export type NameSource = "token-2022" | "metaplex";

export interface TokenInfo extends MintMeta {
  /** Display name and symbol read from chain, when the mint has metadata. */
  name?: string;
  symbol?: string;
  nameSource?: NameSource;
  /** Token-2022 TLV extension types present (empty for classic mints). */
  extensions: number[];
  /** The fund program's mint extension allowlist, applied to these bytes. */
  policy: MintPolicyResult;
}

/** Why an address is not a usable mint. */
export type NotAMint =
  | { kind: "missing" }
  | { kind: "wallet" }
  | { kind: "token-account" }
  | { kind: "other-program"; owner: PublicKey }
  | { kind: "malformed" };

export type TokenLookup = { ok: true; info: TokenInfo } | { ok: false; address: PublicKey; why: NotAMint };

export function describeNotAMint(why: NotAMint): string {
  switch (why.kind) {
    case "missing":
      return "no account exists at this address on this network";
    case "wallet":
      return "this is a wallet address, not a token mint";
    case "token-account":
      return "this is a token account (a balance someone holds), not the token's mint";
    case "other-program":
      return `this account belongs to program ${why.owner.toBase58()}, not a token program, so it is not a token mint`;
    case "malformed":
      return "this account is not an initialized token mint";
  }
}

/** The account reads used here; `Connection` satisfies it. */
export interface MultiAccountReader {
  getMultipleAccountsInfo(
    keys: PublicKey[],
    commitment?: "confirmed",
  ): Promise<Array<{ owner: PublicKey; data: Uint8Array; executable?: boolean } | null>>;
}

function classify(
  address: PublicKey,
  info: { owner: PublicKey; data: Uint8Array } | null,
  metaplex: { owner: PublicKey; data: Uint8Array } | null,
): TokenLookup {
  if (!info) return { ok: false, address, why: { kind: "missing" } };
  if (info.owner.toBase58() === SYSTEM_PROGRAM) return { ok: false, address, why: { kind: "wallet" } };
  const isToken = info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID);
  if (!isToken) return { ok: false, address, why: { kind: "other-program", owner: info.owner } };
  const data = info.data;
  // Classic token accounts are 165 bytes; Token-2022 accounts carry account type 2 at byte 165.
  if ((info.owner.equals(TOKEN_PROGRAM_ID) && data.length === 165) || (data.length > 165 && data[165] === 2)) {
    return { ok: false, address, why: { kind: "token-account" } };
  }
  if (data.length < 82 || data[45] !== 1) return { ok: false, address, why: { kind: "malformed" } };
  const is2022 = info.owner.equals(TOKEN_2022_PROGRAM_ID);
  const token: TokenInfo = {
    address,
    tokenProgram: info.owner,
    decimals: data[44]!,
    transferFee: is2022 ? safe(() => readTransferFeeConfig(data)) : undefined,
    extensions: is2022 ? mintExtensionTypes(data) : [],
    policy: checkMintBytes(info.owner, data),
  };
  const ext = is2022 ? readToken2022Metadata(data) : undefined;
  if (ext && ext.mint.equals(address) && (ext.name || ext.symbol)) {
    token.name = ext.name.trim();
    token.symbol = ext.symbol.trim();
    token.nameSource = "token-2022";
  } else if (metaplex && metaplex.owner.equals(METAPLEX_PROGRAM_ID)) {
    const md = safe(() => decodeMetadata(metaplex.data));
    if (md && md.mint.equals(address) && (md.name || md.symbol)) {
      token.name = md.name.trim();
      token.symbol = md.symbol.trim();
      token.nameSource = "metaplex";
    }
  }
  return { ok: true, info: token };
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/**
 * Look up several mints at once: each mint and its Metaplex metadata PDA in
 * getMultipleAccountsInfo batches of 100 accounts.
 */
export async function readTokenInfos(connection: MultiAccountReader, mints: PublicKey[]): Promise<TokenLookup[]> {
  const keys = mints.flatMap((m) => [m, metadataPda(m)]);
  const infos: Array<{ owner: PublicKey; data: Uint8Array } | null> = [];
  for (let i = 0; i < keys.length; i += 100) {
    infos.push(...(await connection.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  }
  return mints.map((m, i) => classify(m, infos[2 * i] ?? null, infos[2 * i + 1] ?? null));
}

export async function readTokenInfo(connection: MultiAccountReader, mint: PublicKey): Promise<TokenLookup> {
  return (await readTokenInfos(connection, [mint]))[0]!;
}

/** The RPC call walletTokenBalance needs; `Connection` satisfies it. */
export interface TokenBalanceReader {
  getTokenAccountsByOwner(
    owner: PublicKey,
    filter: { mint: PublicKey },
    commitment?: "confirmed",
  ): Promise<{ value: Array<{ pubkey: PublicKey; account: { data: Uint8Array } }> }>;
}

/** Sum of every token account `owner` holds for `mint` (raw units). */
export async function walletTokenBalance(connection: TokenBalanceReader, owner: PublicKey, mint: PublicKey): Promise<bigint> {
  const res = await connection.getTokenAccountsByOwner(owner, { mint }, "confirmed");
  let total = 0n;
  for (const { account } of res.value) {
    const d = account.data;
    if (d.length >= 72) total += new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true);
  }
  return total;
}
