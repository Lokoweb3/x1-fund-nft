/**
 * core/mint_policy.ts mirrors programs/fund_nft/src/mint_policy.rs. These are
 * the Rust unit tests, case for case, plus checks against live mint shapes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import {
  ALLOWED_EXTENSIONS,
  BASE_MINT_LEN,
  checkMintBytes,
  describeMintPolicyError,
  EXT_GROUP_MEMBER_POINTER,
  EXT_GROUP_POINTER,
  EXT_INTEREST_BEARING_CONFIG,
  EXT_METADATA_POINTER,
  EXT_MINT_CLOSE_AUTHORITY,
  EXT_SCALED_UI_AMOUNT,
  EXT_TOKEN_GROUP,
  EXT_TOKEN_GROUP_MEMBER,
  EXT_TOKEN_METADATA,
  EXT_TRANSFER_FEE_CONFIG,
  EXTENSION_NAMES,
  mintExtensionTypes,
} from "../src/core/mint_policy.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src/core/pool.js";

const IS_INITIALIZED_OFFSET = 45;
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = 166;

function baseMint(): Uint8Array {
  const data = new Uint8Array(BASE_MINT_LEN);
  data[IS_INITIALIZED_OFFSET] = 1;
  return data;
}

function mint2022(entries: Array<[number, number]>): Uint8Array {
  const out: number[] = [...baseMint()];
  while (out.length < TLV_START) out.push(0);
  out[ACCOUNT_TYPE_OFFSET] = 1;
  for (const [typ, len] of entries) {
    out.push(typ & 0xff, typ >> 8, len & 0xff, len >> 8);
    for (let i = 0; i < len; i++) out.push(7);
  }
  return Uint8Array.from(out);
}

const extend = (data: Uint8Array, tail: number[]) => Uint8Array.from([...data, ...tail]);

test("mint_policy: constants match the spl-token-2022-interface 2.1.0 ExtensionType names", () => {
  const pairs: Array<[number, string]> = [
    [EXT_TRANSFER_FEE_CONFIG, "TransferFeeConfig"],
    [EXT_MINT_CLOSE_AUTHORITY, "MintCloseAuthority"],
    [EXT_INTEREST_BEARING_CONFIG, "InterestBearingConfig"],
    [EXT_METADATA_POINTER, "MetadataPointer"],
    [EXT_TOKEN_METADATA, "TokenMetadata"],
    [EXT_GROUP_POINTER, "GroupPointer"],
    [EXT_TOKEN_GROUP, "TokenGroup"],
    [EXT_GROUP_MEMBER_POINTER, "GroupMemberPointer"],
    [EXT_TOKEN_GROUP_MEMBER, "TokenGroupMember"],
    [EXT_SCALED_UI_AMOUNT, "ScaledUiAmount"],
  ];
  for (const [value, name] of pairs) assert.equal(EXTENSION_NAMES[value], name);
  assert.deepEqual([...ALLOWED_EXTENSIONS], pairs.map(([v]) => v));
  assert.equal(EXTENSION_NAMES[0], "Uninitialized");
  // The enum is contiguous 0..27 in 2.1.0.
  assert.deepEqual(Object.keys(EXTENSION_NAMES).map(Number), Array.from({ length: 28 }, (_, i) => i));
});

test("mint_policy: rejects every other known extension, and an unknown future type", () => {
  const others = Object.keys(EXTENSION_NAMES)
    .map(Number)
    .filter((t) => t !== 0 && !ALLOWED_EXTENSIONS.includes(t));
  assert.deepEqual(others, [2, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 24, 26, 27]);
  for (const typ of others) {
    const data = mint2022([
      [EXT_METADATA_POINTER, 64],
      [typ, 8],
    ]);
    assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, data), { ok: false, kind: "Disallowed", type: typ }, EXTENSION_NAMES[typ]);
  }
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, mint2022([[999, 0]])), { ok: false, kind: "Disallowed", type: 999 });
  assert.match(describeMintPolicyError({ kind: "Disallowed", type: 12 }), /PermanentDelegate \(type 12\)/);
});

test("mint_policy: classic and allowlisted Token-2022 mints pass", () => {
  assert.deepEqual(checkMintBytes(TOKEN_PROGRAM_ID, baseMint()), { ok: true });
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, baseMint()), { ok: true });
  const all = mint2022(ALLOWED_EXTENSIONS.map((t) => [t, 12] as [number, number]));
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, all), { ok: true });
  // TEST-shaped mint: metadata pointer, transfer fee, then trailing zeros.
  const testLike = extend(
    mint2022([
      [EXT_METADATA_POINTER, 64],
      [EXT_TRANSFER_FEE_CONFIG, 108],
    ]),
    [0, 0, 0, 0, 0, 0],
  );
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, testLike), { ok: true });
  assert.deepEqual(mintExtensionTypes(testLike), [EXT_METADATA_POINTER, EXT_TRANSFER_FEE_CONFIG]);
});

test("mint_policy: malformed or foreign accounts are rejected", () => {
  const other = new PublicKey(new Uint8Array(32).fill(5));
  assert.deepEqual(checkMintBytes(other, baseMint()), { ok: false, kind: "NotATokenProgram" });
  const uninit = baseMint();
  uninit[IS_INITIALIZED_OFFSET] = 0;
  assert.deepEqual(checkMintBytes(TOKEN_PROGRAM_ID, uninit), { ok: false, kind: "Malformed" });
  // A classic mint never has extension bytes.
  assert.deepEqual(checkMintBytes(TOKEN_PROGRAM_ID, mint2022([])), { ok: false, kind: "Malformed" });
  // A token account (type 2) is not a mint.
  const account = mint2022([]);
  account[ACCOUNT_TYPE_OFFSET] = 2;
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, account), { ok: false, kind: "Malformed" });
  // A non-zero type header with no length after it: two or three trailing bytes naming PermanentDelegate.
  for (const tail of [
    [12, 0],
    [12, 0, 0],
  ]) {
    const data = extend(mint2022([[EXT_METADATA_POINTER, 64]]), tail);
    assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, data), { ok: false, kind: "Malformed" }, String(tail));
  }
  // One trailing byte is realloc padding, and a zero type ends the entries.
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, extend(mint2022([[EXT_METADATA_POINTER, 64]]), [0])), { ok: true });
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, extend(mint2022([[EXT_METADATA_POINTER, 64]]), [0, 0, 0])), { ok: true });
  // A TLV length that runs off the end.
  const truncated = mint2022([[EXT_METADATA_POINTER, 64]]);
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, truncated.subarray(0, truncated.length - 1)), { ok: false, kind: "Malformed" });
  // Short of the base length, for either program.
  assert.deepEqual(checkMintBytes(TOKEN_2022_PROGRAM_ID, baseMint().subarray(0, 81)), { ok: false, kind: "Malformed" });
});
