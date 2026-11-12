/**
 * TypeScript port of programs/fund_nft/src/mint_policy.rs: the mint
 * extension allowlist that create_fund (quote and every non-cash target),
 * deposit (quote) and execute_dca (both mints) enforce on chain.
 *
 * Classic SPL Token mints pass. A Token-2022 mint passes only if every TLV
 * entry after the account-type byte is on ALLOWED_EXTENSIONS. The parsing
 * rules follow the Rust code line by line (one trailing byte is realloc
 * padding, a zero type ends the entries, a non-zero type without its two-byte
 * length is malformed). keeper/test/mint_policy.test.ts mirrors the Rust
 * unit tests.
 *
 * This is a client-side preview so the app can explain a refusal before
 * anything is simulated. The program's own check is the one that counts.
 *
 * Browser-safe: no node: imports.
 */
import type { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./pool.js";

/**
 * Every `ExtensionType` discriminant in spl-token-2022-interface 2.1.0
 * (`src/extension/mod.rs`, `#[repr(u16)]`, implicit from 0), the version
 * Cargo.lock resolves. Names are used in messages only.
 */
export const EXTENSION_NAMES: Readonly<Record<number, string>> = {
  0: "Uninitialized",
  1: "TransferFeeConfig",
  2: "TransferFeeAmount",
  3: "MintCloseAuthority",
  4: "ConfidentialTransferMint",
  5: "ConfidentialTransferAccount",
  6: "DefaultAccountState",
  7: "ImmutableOwner",
  8: "MemoTransfer",
  9: "NonTransferable",
  10: "InterestBearingConfig",
  11: "CpiGuard",
  12: "PermanentDelegate",
  13: "NonTransferableAccount",
  14: "TransferHook",
  15: "TransferHookAccount",
  16: "ConfidentialTransferFeeConfig",
  17: "ConfidentialTransferFeeAmount",
  18: "MetadataPointer",
  19: "TokenMetadata",
  20: "GroupPointer",
  21: "TokenGroup",
  22: "GroupMemberPointer",
  23: "TokenGroupMember",
  24: "ConfidentialMintBurn",
  25: "ScaledUiAmount",
  26: "Pausable",
  27: "PausableAccount",
};

export const EXT_TRANSFER_FEE_CONFIG = 1;
export const EXT_MINT_CLOSE_AUTHORITY = 3;
export const EXT_INTEREST_BEARING_CONFIG = 10;
export const EXT_METADATA_POINTER = 18;
export const EXT_TOKEN_METADATA = 19;
export const EXT_GROUP_POINTER = 20;
export const EXT_TOKEN_GROUP = 21;
export const EXT_GROUP_MEMBER_POINTER = 22;
export const EXT_TOKEN_GROUP_MEMBER = 23;
export const EXT_SCALED_UI_AMOUNT = 25;

/** Same list and order as mint_policy.rs ALLOWED_EXTENSIONS. */
export const ALLOWED_EXTENSIONS: readonly number[] = [
  EXT_TRANSFER_FEE_CONFIG,
  EXT_MINT_CLOSE_AUTHORITY,
  EXT_INTEREST_BEARING_CONFIG,
  EXT_METADATA_POINTER,
  EXT_TOKEN_METADATA,
  EXT_GROUP_POINTER,
  EXT_TOKEN_GROUP,
  EXT_GROUP_MEMBER_POINTER,
  EXT_TOKEN_GROUP_MEMBER,
  EXT_SCALED_UI_AMOUNT,
];

/** Base mint length shared by both token programs. */
export const BASE_MINT_LEN = 82;
const IS_INITIALIZED_OFFSET = 45;
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;
const ACCOUNT_TYPE_MINT = 1;
/** ExtensionType::Uninitialized. Token-2022 stops reading TLV entries here. */
const EXT_UNINITIALIZED = 0;

export type MintPolicyError =
  /** The account is not owned by either token program. */
  | { kind: "NotATokenProgram" }
  /** The bytes are not an initialized mint of the owner's layout. */
  | { kind: "Malformed" }
  /** A Token-2022 extension type that is not on the allowlist. */
  | { kind: "Disallowed"; type: number };

export type MintPolicyResult = { ok: true } | ({ ok: false } & MintPolicyError);

/** check_mint_bytes from mint_policy.rs. */
export function checkMintBytes(owner: PublicKey, data: Uint8Array): MintPolicyResult {
  if (owner.equals(TOKEN_PROGRAM_ID)) {
    if (data.length !== BASE_MINT_LEN || data[IS_INITIALIZED_OFFSET] !== 1) return { ok: false, kind: "Malformed" };
    return { ok: true };
  }
  if (!owner.equals(TOKEN_2022_PROGRAM_ID)) return { ok: false, kind: "NotATokenProgram" };
  if (data.length < BASE_MINT_LEN || data[IS_INITIALIZED_OFFSET] !== 1) return { ok: false, kind: "Malformed" };
  if (data.length === BASE_MINT_LEN) return { ok: true };
  if (data.length < TLV_START || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return { ok: false, kind: "Malformed" };
  let offset = TLV_START;
  while (offset < data.length) {
    if (data.length - offset < 2) break;
    const typ = data[offset]! | (data[offset + 1]! << 8);
    if (typ === EXT_UNINITIALIZED) break;
    if (data.length - offset < 4) return { ok: false, kind: "Malformed" };
    const len = data[offset + 2]! | (data[offset + 3]! << 8);
    const next = offset + 4 + len;
    if (next > data.length) return { ok: false, kind: "Malformed" };
    if (!ALLOWED_EXTENSIONS.includes(typ)) return { ok: false, kind: "Disallowed", type: typ };
    offset = next;
  }
  return { ok: true };
}

/** The TLV extension types present in a Token-2022 mint, in order (empty for classic or base-length mints). */
export function mintExtensionTypes(data: Uint8Array): number[] {
  const types: number[] = [];
  if (data.length <= TLV_START || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return types;
  let offset = TLV_START;
  while (data.length - offset >= 4) {
    const typ = data[offset]! | (data[offset + 1]! << 8);
    if (typ === EXT_UNINITIALIZED) break;
    const len = data[offset + 2]! | (data[offset + 3]! << 8);
    if (offset + 4 + len > data.length) break;
    types.push(typ);
    offset += 4 + len;
  }
  return types;
}

export function extensionName(type: number): string {
  return EXTENSION_NAMES[type] ?? `unknown extension ${type}`;
}

/** Plain-language reason for a refusal, for the app. */
export function describeMintPolicyError(err: MintPolicyError): string {
  switch (err.kind) {
    case "NotATokenProgram":
      return "this account is not owned by the SPL Token or Token-2022 program, so it is not a token mint";
    case "Malformed":
      return "this account is not an initialized token mint";
    case "Disallowed":
      return (
        `this token uses the Token-2022 extension ${extensionName(err.type)} (type ${err.type}), which the fund program refuses ` +
        "because it can block, freeze or take back the fund's tokens"
      );
  }
}
