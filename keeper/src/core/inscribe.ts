/**
 * Inscribe a fund NFT's Metaplex metadata JSON on X1 through the third-party
 * X1 Inscriptions program, so the JSON lives on chain and the NFT's metadata
 * uri can point at its gateway. docs/X1_INSCRIPTIONS.md covers the program,
 * the accounts, the fee model and every trust assumption. This file follows
 * the IDL saved in docs/x1-inscriptions/idl.json.
 *
 * The offline pieces (PDAs, config and inscription decoding, instruction
 * encoding, planning) are pure, so the unit tests cover them.
 * `fetchInscriptionConfig`, `prepareInscribe` and `prepareInscribeResume` add
 * the RPC reads. Nothing here signs or sends: the Plan goes through sendPlan
 * in core/owner.ts like every other plan.
 *
 * Browser-safe: no node: imports and no process.env.
 */
import { Buffer } from "buffer";
import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { assertPlanFits, MAX_TX_BYTES, txSize, type Plan, type PlannedTx } from "./owner.js";

/** The live X1 mainnet inscription program. It is upgradeable; the doc names its authority. */
export const INSCRIPTION_PROGRAM_ID = new PublicKey("X1insUpfkQqtsuUJvwA8A3kbnixk3qtuexex1NDJWvN");
/** Metaplex Core. The program CPIs into it to mint each inscription's NFT. */
export const CORE_PROGRAM_ID = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
/**
 * The genesis pool that the mainnet IDL pins by `address` on inscribe's
 * genesis_pool. It is the program-owned PDA ["genesis_pool"].
 */
export const MAINNET_GENESIS_POOL = new PublicKey("6z9rZwLdrvkpj1zmgXvgi3znvu1b8rZqH4vmXY6z3TUe");
/** The mainnet config PDA ["config"]. append and thaw_inscription pin it by address. */
export const MAINNET_CONFIG = new PublicKey("E33orhudcHnVwA46WejnDMXZ3HCdGQaf572r2oKcy3HP");

// Discriminators copied from the IDL.
export const DISCRIMINATORS = {
  inscribe: Uint8Array.from([150, 44, 41, 0, 67, 14, 73, 12]),
  append: Uint8Array.from([149, 120, 18, 222, 236, 225, 88, 203]),
  thawInscription: Uint8Array.from([43, 243, 150, 162, 49, 136, 189, 159]),
  configAccount: Uint8Array.from([155, 12, 170, 224, 30, 250, 204, 130]),
  inscriptionAccount: Uint8Array.from([100, 11, 151, 42, 228, 38, 69, 187]),
} as const;

/**
 * Largest first chunk (carried by `inscribe`) and later chunks (`append`).
 * These are the sizes the x1inscriptions.io site uses (600, then 900 per
 * append). The e2e test runs them against the real program on a local
 * validator. planInscribe still checks every transaction against the
 * 1232-byte limit.
 */
export const FIRST_CHUNK_MAX = 600;
export const APPEND_CHUNK_MAX = 900;
/**
 * The program allows up to 400 KB per small inscription. This planner caps
 * content at 16 KiB (at most 19 transactions). Metadata JSON is 1-2 KB.
 */
export const MAX_CONTENT_BYTES = 16 * 1024;
/** Header bytes before the content in an Inscription account (8-byte discriminator included). */
export const INSCRIPTION_HEADER_LEN = 212;
/** Config struct bytes, discriminator included. Admin extensions may follow (see decodeInscriptionConfig). */
export const CONFIG_STRUCT_LEN = 140;

export const ENCODING_RAW = 0;
export const ENCODING_GZIP = 1;
/** Bit 7 of the stored encoding marks an inscribe_big inscription (128 = raw, 129 = gzip). */
export const ENCODING_BIG_FLAG = 0x80;

const SEED_CONFIG = new TextEncoder().encode("config");
const SEED_INS = new TextEncoder().encode("ins");
const SEED_NFT_I = new TextEncoder().encode("nft_i");
const SEED_COLL_I = new TextEncoder().encode("coll_i");
const SEED_NFTAUTH = new TextEncoder().encode("nftauth");

export function u64le(n: bigint): Uint8Array {
  if (n < 0n || n >= 1n << 64n) throw new Error(`u64 out of range: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

const pda = (programId: PublicKey, ...seeds: Uint8Array[]) => PublicKey.findProgramAddressSync(seeds, programId)[0];

export function inscriptionConfigPda(programId: PublicKey = INSCRIPTION_PROGRAM_ID): PublicKey {
  return pda(programId, SEED_CONFIG);
}
export function inscriptionPda(n: bigint, programId: PublicKey = INSCRIPTION_PROGRAM_ID): PublicKey {
  return pda(programId, SEED_INS, u64le(n));
}
/** The inscription's Metaplex Core asset (its NFT). */
export function inscriptionAssetPda(n: bigint, programId: PublicKey = INSCRIPTION_PROGRAM_ID): PublicKey {
  return pda(programId, SEED_NFT_I, u64le(n));
}
/** The Core collection every inscription NFT joins. */
export function inscriptionCollectionPda(programId: PublicKey = INSCRIPTION_PROGRAM_ID): PublicKey {
  return pda(programId, SEED_COLL_I);
}
/** The program's signing PDA: update authority of the collection and freeze delegate of unfinished uploads. */
export function nftAuthPda(programId: PublicKey = INSCRIPTION_PROGRAM_ID): PublicKey {
  return pda(programId, SEED_NFTAUTH);
}

// ---------------------------------------------------------------------------
// Account decoding

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}
function key(bytes: Uint8Array, offset: number): PublicKey {
  return new PublicKey(bytes.subarray(offset, offset + 32));
}

export interface InscriptionFees {
  /** Lamports charged per inscription. inscribe refuses (FeeChanged) if it is above max_fee. */
  inscribe: bigint;
  claim: bigint;
  deploy: bigint;
  premium: [bigint, bigint, bigint];
  mint: bigint;
  marketBps: number;
}

export interface InscriptionConfig {
  admin: PublicKey;
  /** Receives the inscribe fee, minus the genesis pool's share. Passed as inscribe's `treasury`. */
  treasury: PublicKey;
  fees: InscriptionFees;
  /** The number the next inscribe will create. The program takes it from here, never from the caller. */
  nextInscription: bigint;
  /** While true, the program refuses every user action (error 6000 Paused). */
  paused: boolean;
  bump: number;
  /** set_extra_fees: 3 x u64 right after the struct, when present. */
  extraFees?: { parcel: bigint; release: bigint; bridge: bigint };
  /** set_genesis_settings: 16 bytes after the extra fees, when present. */
  genesis?: { mintBps: number; launchBps: number; marketBps: number; price: bigint; inscribeBps: number };
  /** Bytes after every extension this file knows. The IDL does not describe them. */
  unknownTail: Uint8Array;
}

/**
 * Decode the program's Config account. The Anchor struct is 140 bytes.
 * set_extra_fees appends 24 bytes. set_genesis_settings appends its five
 * arguments (3 x u16, u64, u16 = 16 bytes; its doc comment still says 14,
 * from before inscribe_bps was added). The live mainnet account (184 bytes on
 * 2026-11-12) carries 4 more bytes that the IDL does not describe. They come
 * back in `unknownTail`.
 */
export function decodeInscriptionConfig(bytes: Uint8Array): InscriptionConfig {
  if (!startsWith(bytes, DISCRIMINATORS.configAccount)) throw new Error("not an X1 Inscriptions Config account (discriminator)");
  if (bytes.length < CONFIG_STRUCT_LEN) throw new Error(`Config account is ${bytes.length} bytes, expected at least ${CONFIG_STRUCT_LEN}`);
  const v = view(bytes);
  const u64 = (o: number) => v.getBigUint64(o, true);
  const paused = bytes[138]!;
  if (paused > 1) throw new Error(`Config.paused is ${paused}, not a bool`);
  const config: InscriptionConfig = {
    admin: key(bytes, 8),
    treasury: key(bytes, 40),
    fees: {
      inscribe: u64(72),
      claim: u64(80),
      deploy: u64(88),
      premium: [u64(96), u64(104), u64(112)],
      mint: u64(120),
      marketBps: v.getUint16(128, true),
    },
    nextInscription: u64(130),
    paused: paused === 1,
    bump: bytes[139]!,
    unknownTail: new Uint8Array(),
  };
  let o = CONFIG_STRUCT_LEN;
  if (bytes.length >= o + 24) {
    config.extraFees = { parcel: u64(o), release: u64(o + 8), bridge: u64(o + 16) };
    o += 24;
  }
  if (config.extraFees && bytes.length >= o + 16) {
    config.genesis = {
      mintBps: v.getUint16(o, true),
      launchBps: v.getUint16(o + 2, true),
      marketBps: v.getUint16(o + 4, true),
      price: u64(o + 6),
      inscribeBps: v.getUint16(o + 14, true),
    };
    o += 16;
  }
  config.unknownTail = bytes.slice(o);
  return config;
}

export interface InscriptionAccount {
  number: bigint;
  owner: PublicKey;
  creator: PublicKey;
  slot: bigint;
  district: bigint;
  contentType: string;
  totalSize: number;
  written: number;
  sealed: boolean;
  price: bigint;
  encoding: number;
  writer: PublicKey;
  bump: number;
  /**
   * The bytes written so far. The account grows as appends land (it is not
   * allocated at full size up front). Empty for inscribe_big inscriptions,
   * whose content is in Part accounts.
   */
  content: Uint8Array;
}

/** Decode an Inscription account: the 212-byte header, then the bytes written so far. */
export function decodeInscription(bytes: Uint8Array): InscriptionAccount {
  if (!startsWith(bytes, DISCRIMINATORS.inscriptionAccount)) throw new Error("not an X1 Inscriptions Inscription account (discriminator)");
  if (bytes.length < INSCRIPTION_HEADER_LEN) throw new Error(`Inscription account is ${bytes.length} bytes, expected at least ${INSCRIPTION_HEADER_LEN}`);
  const v = view(bytes);
  const typeLen = bytes[160]!;
  if (typeLen > 64) throw new Error(`content_type_len ${typeLen} > 64`);
  const totalSize = v.getUint32(161, true);
  const written = v.getUint32(165, true);
  const encoding = bytes[178]!;
  // inscribe_big sets bit 7 of the stored encoding; its content is in Part accounts.
  const big = (encoding & ENCODING_BIG_FLAG) !== 0;
  if (!big && bytes.length < INSCRIPTION_HEADER_LEN + written) {
    throw new Error(`Inscription account is ${bytes.length} bytes but says ${written} bytes are written`);
  }
  return {
    number: v.getBigUint64(8, true),
    owner: key(bytes, 16),
    creator: key(bytes, 48),
    slot: v.getBigUint64(80, true),
    district: v.getBigUint64(88, true),
    contentType: new TextDecoder().decode(bytes.subarray(96, 96 + typeLen)),
    totalSize,
    written,
    sealed: bytes[169] === 1,
    price: v.getBigUint64(170, true),
    encoding,
    writer: key(bytes, 179),
    bump: bytes[211]!,
    content: big ? new Uint8Array() : bytes.slice(INSCRIPTION_HEADER_LEN, INSCRIPTION_HEADER_LEN + written),
  };
}

// ---------------------------------------------------------------------------
// Instructions (Borsh, encoded by hand to keep this file free of Anchor)

function concat(parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}
function u32le(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error(`u32 out of range: ${n}`);
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}
const borshBytes = (b: Uint8Array) => concat([u32le(b.length), b]);

export interface InscribeIxInput {
  creator: PublicKey;
  /** The number the transaction claims. It must equal config.next_inscription when the transaction runs. */
  number: bigint;
  treasury: PublicKey;
  contentType: string;
  totalSize: number;
  chunk: Uint8Array;
  encoding: number;
  /** Only this key may append. null = the creator. */
  writer: PublicKey | null;
  maxFee: bigint;
  programId?: PublicKey;
  genesisPool?: PublicKey;
}

/** inscribe. The account order follows the IDL. */
export function inscribeIx(input: InscribeIxInput): TransactionInstruction {
  const programId = input.programId ?? INSCRIPTION_PROGRAM_ID;
  const data = concat([
    DISCRIMINATORS.inscribe,
    borshBytes(new TextEncoder().encode(input.contentType)),
    u32le(input.totalSize),
    borshBytes(input.chunk),
    Uint8Array.of(input.encoding),
    input.writer ? concat([Uint8Array.of(1), input.writer.toBytes()]) : Uint8Array.of(0),
    u64le(input.maxFee),
  ]);
  const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  return new TransactionInstruction({
    programId,
    data,
    keys: [
      w(inscriptionConfigPda(programId)),
      w(inscriptionPda(input.number, programId)),
      w(input.creator, true),
      w(input.treasury),
      w(inscriptionAssetPda(input.number, programId)),
      w(inscriptionCollectionPda(programId)),
      r(nftAuthPda(programId)),
      r(CORE_PROGRAM_ID),
      r(SystemProgram.programId),
      w(input.genesisPool ?? MAINNET_GENESIS_POOL),
    ],
  });
}

/** append: the next chunk, in order. Writer only. Seals when written == total_size. */
export function appendIx(input: { writer: PublicKey; number: bigint; chunk: Uint8Array; programId?: PublicKey }): TransactionInstruction {
  const programId = input.programId ?? INSCRIPTION_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    data: concat([DISCRIMINATORS.append, borshBytes(input.chunk)]),
    keys: [
      { pubkey: inscriptionPda(input.number, programId), isSigner: false, isWritable: true },
      { pubkey: input.writer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: inscriptionConfigPda(programId), isSigner: false, isWritable: false },
    ],
  });
}

/**
 * thaw_inscription: once the inscription is sealed, unfreeze its NFT and
 * revoke the program's freeze-delegate authority. Anyone may call it. It is a
 * no-op when there is nothing to thaw.
 */
export function thawInscriptionIx(input: { payer: PublicKey; number: bigint; programId?: PublicKey }): TransactionInstruction {
  const programId = input.programId ?? INSCRIPTION_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    data: concat([DISCRIMINATORS.thawInscription, u64le(input.number)]),
    keys: [
      { pubkey: inscriptionPda(input.number, programId), isSigner: false, isWritable: false },
      { pubkey: inscriptionAssetPda(input.number, programId), isSigner: false, isWritable: true },
      { pubkey: inscriptionCollectionPda(programId), isSigner: false, isWritable: true },
      { pubkey: nftAuthPda(programId), isSigner: false, isWritable: false },
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: inscriptionConfigPda(programId), isSigner: false, isWritable: false },
    ],
  });
}

// ---------------------------------------------------------------------------
// Gateway

/**
 * The gateway URL to use as the fund NFT's Metaplex `uri`:
 * https://<n>.x1ins.xyz/content/<n>, not https://www.x1inscriptions.io/api/ins/<n>.
 * docs/X1_INSCRIPTIONS.md ("Gateway") has the evidence, checked 2026-11-12.
 * Both URLs serve the same bytes with CORS `*`. The site's own Core NFT
 * metadata uses the subdomain form (animation_url of #63). /api/ins/<n>
 * answers a browser navigation with a 307 to the subdomain anyway, so the
 * subdomain is the form that never redirects.
 */
export function inscriptionUri(n: bigint): string {
  if (n < 0n) throw new Error(`inscription number ${n} is negative`);
  return `https://${n}.x1ins.xyz/content/${n}`;
}

// ---------------------------------------------------------------------------
// Planning

/**
 * Compute-unit limits planInscribe sets when the caller passes no `budget`.
 * Measured on a local validator running the cloned mainnet program
 * (2026-11-12): inscribe 79,284 CU, a 900-byte append 7,726, and the final
 * 36-byte append + thaw_inscription 59,661. X1 mainnet sets the network fee
 * by the requested limit: about 10 lamports per CU, and 200,000 CU per
 * instruction when no limit is set. Tight limits cut the 1.5 KB plan's
 * network fee from 0.008 XNT to about 0.0024 XNT.
 */
export const COMPUTE_UNITS = { inscribe: 120_000, append: 20_000, thaw: 80_000 } as const;

export interface InscribeInput {
  payer: PublicKey;
  content: Uint8Array;
  contentType: string;
  /** The most, in lamports, the payer accepts as the program's inscribe fee. Rent and network fees are separate. */
  maxFee: bigint;
  /** The decoded live Config. Read it just before planning (prepareInscribe does). */
  config: InscriptionConfig;
  encoding?: number;
  /**
   * Instructions to put first in every transaction. Omit it to get one
   * setComputeUnitLimit per transaction from COMPUTE_UNITS. Pass [] for none.
   */
  budget?: TransactionInstruction[];
  programId?: PublicKey;
  genesisPool?: PublicKey;
}

export interface InscribePlan extends Plan {
  /** The number this plan claims: config.next_inscription when it was read. */
  number: bigint;
  inscription: PublicKey;
  /** The Core asset (NFT) the creator receives. */
  asset: PublicKey;
  /** inscriptionUri(number). */
  uri: string;
  /** The fee passed as max_fee: the fee read from config. It is at most the caller's maxFee. */
  fee: bigint;
  /** Chunk lengths, in transaction order. */
  chunks: number[];
  /** Serialized size of each transaction. */
  sizes: number[];
}

/** Checks shared by planInscribe and planInscribeResume. */
function checkContent(content: Uint8Array, contentType: string, encoding: number): void {
  if (content.length === 0) throw new Error("content is empty");
  if (content.length > MAX_CONTENT_BYTES) throw new Error(`content is ${content.length} bytes; this planner allows at most ${MAX_CONTENT_BYTES}`);
  const typeBytes = new TextEncoder().encode(contentType);
  if (typeBytes.length < 1 || typeBytes.length > 64) throw new Error("content type must be 1-64 bytes");
  if (!/^[\x21-\x7e]+$/.test(contentType)) throw new Error(`content type ${JSON.stringify(contentType)} must be printable ASCII without spaces`);
  if (encoding !== ENCODING_RAW && encoding !== ENCODING_GZIP) throw new Error("encoding must be 0 (raw) or 1 (gzip)");
  if (contentType === "application/json" && encoding === ENCODING_RAW) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error("application/json content is not valid UTF-8");
    }
    try {
      JSON.parse(text);
    } catch (err) {
      throw new Error(`application/json content does not parse: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type Part = keyof typeof COMPUTE_UNITS;
interface Draft {
  label: string;
  ixs: TransactionInstruction[];
  parts: Part[];
}

function prefixFor(draft: Draft, budget: TransactionInstruction[] | undefined): TransactionInstruction[] {
  if (budget) return budget;
  const units = draft.parts.reduce((sum, part) => sum + COMPUTE_UNITS[part], 0);
  return [ComputeBudgetProgram.setComputeUnitLimit({ units })];
}

function appendDrafts(payer: PublicKey, number: bigint, rest: Uint8Array, programId: PublicKey, firstIndex: number): Draft[] {
  const drafts: Draft[] = [];
  for (let off = 0; off < rest.length; off += APPEND_CHUNK_MAX) {
    const chunk = rest.subarray(off, Math.min(rest.length, off + APPEND_CHUNK_MAX));
    drafts.push({
      label: `append chunk ${firstIndex + drafts.length} (${chunk.length} bytes) to #${number}`,
      ixs: [appendIx({ writer: payer, number, chunk, programId })],
      parts: ["append"],
    });
  }
  return drafts;
}

/**
 * Add thaw_inscription to the last transaction if it still fits there with
 * its budget prefix. Otherwise it goes in a transaction of its own.
 */
function addThaw(payer: PublicKey, number: bigint, drafts: Draft[], budget: TransactionInstruction[] | undefined, programId: PublicKey): void {
  const thaw = thawInscriptionIx({ payer, number, programId });
  const last = drafts[drafts.length - 1];
  if (last) {
    const merged: Draft = { label: `${last.label} + thaw NFT`, ixs: [...last.ixs, thaw], parts: [...last.parts, "thaw"] };
    if (txSize(payer, [...prefixFor(merged, budget), ...merged.ixs]) <= MAX_TX_BYTES) {
      drafts[drafts.length - 1] = merged;
      return;
    }
  }
  drafts.push({ label: `thaw NFT #${number}`, ixs: [thaw], parts: ["thaw"] });
}

/**
 * Every transaction after the first needs the bytes the previous one wrote
 * (an append writes at `written`, and the first append needs the account
 * inscribe creates), so only the first can be simulated before sending.
 */
function finish(payer: PublicKey, drafts: Draft[], budget: TransactionInstruction[] | undefined): PlannedTx[] {
  const txs: PlannedTx[] = drafts.map((d, i) => ({
    label: d.label,
    instructions: [...prefixFor(d, budget), ...d.ixs],
    extraSigners: [],
    ...(i > 0 ? { dependsOnPrevious: true } : {}),
  }));
  assertPlanFits(payer, txs, "Use a smaller budget prefix.");
  return txs;
}

/**
 * Plan an inscription. Transaction 1 is `inscribe` with the first <= 600
 * bytes. Each later transaction is one `append` of <= 900 bytes. The last
 * one also calls thaw_inscription, because an NFT minted before its
 * inscription is sealed stays frozen until someone thaws it. A payload of
 * <= 600 bytes is a single transaction and is sealed at once, so its NFT
 * is never frozen.
 *
 * The creator is the writer (writer = None). Every transaction is signed by
 * the payer alone, and no throwaway upload key is created or funded.
 *
 * Refusals, before anything is simulated or sent: the program is paused; the
 * config fee is above `maxFee`; the content is empty, too big, or (for
 * application/json) not valid JSON; any transaction is over 1232 bytes.
 *
 * Race safety: transaction 1 names inscription and asset PDAs for
 * n = config.nextInscription as read. The program derives both PDAs from
 * config.next_inscription when it runs. If anyone else inscribed first, the
 * seeds no longer match and the transaction fails (Anchor ConstraintSeeds,
 * 2006). It writes nothing and charges no fee or rent; only the network fee
 * is spent. sendPlan stops at the first failure, so no append is sent.
 * Even if one were, `append` to #n checks n's writer (ConstraintHasOne,
 * 2001), and that writer is not this payer. The plan can never write to a
 * different number than the one it predicts.
 */
export function planInscribe(input: InscribeInput): InscribePlan {
  const { payer, content, contentType, config, budget } = input;
  const encoding = input.encoding ?? ENCODING_RAW;
  const programId = input.programId ?? INSCRIPTION_PROGRAM_ID;
  if (config.paused) throw new Error("the X1 Inscriptions program is paused (config.paused); it refuses every inscribe. Nothing was simulated or sent.");
  if (input.maxFee < 0n) throw new Error("maxFee must be non-negative");
  if (config.fees.inscribe > input.maxFee) {
    throw new Error(
      `the inscribe fee is ${config.fees.inscribe} lamports, above the max fee ${input.maxFee}. Nothing was simulated or sent.`,
    );
  }
  checkContent(content, contentType, encoding);

  const number = config.nextInscription;
  const first = content.subarray(0, Math.min(content.length, FIRST_CHUNK_MAX));
  const drafts: Draft[] = [
    {
      label: `inscribe #${number} (${first.length} of ${content.length} bytes)`,
      ixs: [
        inscribeIx({
          creator: payer,
          number,
          treasury: config.treasury,
          contentType,
          totalSize: content.length,
          chunk: first,
          encoding,
          writer: null,
          // The fee just read, not the caller's cap: the program then refuses any increase at all.
          maxFee: config.fees.inscribe,
          programId,
          genesisPool: input.genesisPool,
        }),
      ],
      parts: ["inscribe"],
    },
  ];
  const rest = content.subarray(first.length);
  drafts.push(...appendDrafts(payer, number, rest, programId, 2));
  if (drafts.length > 1) addThaw(payer, number, drafts, budget, programId);
  const txs = finish(payer, drafts, budget);
  const chunks = [first.length];
  for (let off = 0; off < rest.length; off += APPEND_CHUNK_MAX) chunks.push(Math.min(APPEND_CHUNK_MAX, rest.length - off));
  return {
    txs,
    number,
    inscription: inscriptionPda(number, programId),
    asset: inscriptionAssetPda(number, programId),
    uri: inscriptionUri(number),
    fee: config.fees.inscribe,
    chunks,
    sizes: txs.map((tx) => txSize(payer, tx.instructions)),
    recovery: `resume inscription #${number}: re-read it and send only the missing appends (prepareInscribeResume)`,
  };
}

/**
 * Plan the missing appends (plus the thaw) of an inscription whose first
 * transactions landed, from a SNAPSHOT of the account. It checks the creator,
 * writer, size, type, encoding and every byte already written against
 * `content`, and refuses on any mismatch.
 *
 * A snapshot alone is not enough to resume safely: `append` takes only bytes,
 * not an expected offset, so an earlier append that is still in flight and
 * lands after the snapshot would make a resumed append write the same bytes
 * twice and seal wrong content. Only call this through
 * `prepareInscribeResume`, which first proves every earlier attempt is
 * resolved (confirmed, or its blockhash expired) and only then reads the
 * account. Never run two uploads of the same inscription at once.
 */
export function planInscribeResume(input: {
  payer: PublicKey;
  content: Uint8Array;
  contentType: string;
  encoding?: number;
  inscription: InscriptionAccount;
  budget?: TransactionInstruction[];
  programId?: PublicKey;
}): Plan {
  const { payer, content, inscription: ins, budget } = input;
  const encoding = input.encoding ?? ENCODING_RAW;
  const programId = input.programId ?? INSCRIPTION_PROGRAM_ID;
  checkContent(content, input.contentType, encoding);
  const n = ins.number;
  if (!ins.creator.equals(payer)) throw new Error(`inscription #${n} was created by ${ins.creator.toBase58()}, not ${payer.toBase58()}`);
  if (!ins.writer.equals(payer)) throw new Error(`inscription #${n}'s writer is ${ins.writer.toBase58()}, not ${payer.toBase58()}`);
  if (ins.totalSize !== content.length) throw new Error(`inscription #${n} is ${ins.totalSize} bytes, the content is ${content.length}`);
  if (ins.contentType !== input.contentType) throw new Error(`inscription #${n} is ${ins.contentType}, not ${input.contentType}`);
  if (ins.encoding !== encoding) throw new Error(`inscription #${n} has encoding ${ins.encoding}, not ${encoding}`);
  if (ins.content.length !== ins.written) throw new Error(`inscription #${n}'s ${ins.written} written bytes are not all in its account`);
  if (!bytesEqual(ins.content, content.subarray(0, ins.written))) throw new Error(`inscription #${n}'s first ${ins.written} bytes differ from the content`);
  if (ins.sealed !== (ins.written === ins.totalSize)) throw new Error(`inscription #${n}: sealed=${ins.sealed} but written ${ins.written}/${ins.totalSize}`);
  const drafts = appendDrafts(payer, n, content.subarray(ins.written), programId, 1);
  addThaw(payer, n, drafts, budget, programId);
  return { txs: finish(payer, drafts, budget), recovery: `run prepareInscribeResume for #${n} again` };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// ---------------------------------------------------------------------------
// RPC

/** The one RPC method used here. `Connection` satisfies it. */
export interface AccountReader {
  getAccountInfo(
    address: PublicKey,
    commitment: "confirmed",
  ): Promise<{ owner: PublicKey; data: Uint8Array } | null>;
}

/** Read and decode the config. Checks that the program owns the account and that it is the ["config"] PDA. */
export async function fetchInscriptionConfig(
  connection: AccountReader,
  programId: PublicKey = INSCRIPTION_PROGRAM_ID,
): Promise<InscriptionConfig> {
  const address = inscriptionConfigPda(programId);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) throw new Error(`no X1 Inscriptions config at ${address.toBase58()}`);
  if (!info.owner.equals(programId)) throw new Error(`config ${address.toBase58()} is owned by ${info.owner.toBase58()}, not ${programId.toBase58()}`);
  return decodeInscriptionConfig(info.data);
}

export async function fetchInscription(
  connection: AccountReader,
  n: bigint,
  programId: PublicKey = INSCRIPTION_PROGRAM_ID,
): Promise<InscriptionAccount | undefined> {
  const address = inscriptionPda(n, programId);
  const info = await connection.getAccountInfo(address, "confirmed");
  if (!info) return undefined;
  if (!info.owner.equals(programId)) throw new Error(`inscription ${address.toBase58()} is owned by ${info.owner.toBase58()}`);
  const ins = decodeInscription(info.data);
  if (ins.number !== n) throw new Error(`inscription account ${address.toBase58()} says #${ins.number}, expected #${n}`);
  return ins;
}

/** Read the live config, then planInscribe. The predicted number is only as fresh as this read. */
export async function prepareInscribe(
  connection: AccountReader,
  input: Omit<InscribeInput, "config">,
): Promise<InscribePlan> {
  const config = await fetchInscriptionConfig(connection, input.programId);
  const plan = planInscribe({ ...input, config });
  // A stale RPC node could report an n that is already taken. Planning it would
  // only fail on chain, but refusing here gives a clearer error.
  // Anyone can send lamports to the public PDA, leaving a System-owned account
  // with no data; that is not an inscription and does not mean the config is
  // stale. Only an account owned by the inscriptions program counts as taken.
  const existing = await connection.getAccountInfo(plan.inscription, "confirmed");
  const programId = input.programId ?? INSCRIPTION_PROGRAM_ID;
  if (existing && existing.owner.equals(programId)) {
    throw new Error(`inscription #${plan.number} already exists; the RPC's config is stale. Nothing was simulated or sent.`);
  }
  if (existing && !(existing.owner.equals(SystemProgram.programId) && existing.data.length === 0)) {
    throw new Error(
      `the account for inscription #${plan.number} (${plan.inscription.toBase58()}) is owned by ${existing.owner.toBase58()} with ${existing.data.length} bytes; refusing. Nothing was simulated or sent.`,
    );
  }
  return plan;
}

/** An earlier transaction of this upload whose outcome must be settled before resuming. */
export interface PriorAttempt {
  signature: string;
  /** From the PlanSendError (or the blockhash it was signed with). */
  lastValidBlockHeight: number;
}

/** The RPC calls resume needs; `Connection` satisfies it. */
export interface ResumeReader extends AccountReader {
  getSignatureStatuses(
    signatures: string[],
    config: { searchTransactionHistory: boolean },
  ): Promise<{ value: ({ slot: number; confirmationStatus?: string | null; err: unknown } | null)[] }>;
  /** One coherent reading of the confirmed bank: its slot and block height together. */
  getEpochInfo(commitment: "confirmed"): Promise<{ absoluteSlot: number; blockHeight?: number }>;
  getAccountInfoAndContext(
    address: PublicKey,
    config: { commitment: "confirmed"; minContextSlot: number },
  ): Promise<{ context: { slot: number }; value: { owner: PublicKey; data: Uint8Array } | null }>;
}

/**
 * Refuse unless every earlier attempt can no longer land: it is confirmed
 * (or finalized; an on-chain error also counts), or its blockhash has expired
 * (the confirmed bank's block height is past its last valid height). Returns
 * the slot the evidence came from: the highest execution slot of a confirmed
 * attempt, and the bank slot used to prove any expiry. Any account state used
 * to plan the resume must be read at or after this slot; otherwise a lagging
 * or load-balanced RPC backend could serve a snapshot from before an earlier
 * append landed, and the resume would write those bytes again.
 */
export async function assertAttemptsSettled(connection: ResumeReader, attempts: PriorAttempt[]): Promise<number> {
  const bank = await connection.getEpochInfo("confirmed");
  if (bank.blockHeight === undefined) throw new Error("the RPC's getEpochInfo did not report a block height; cannot prove expiry");
  let floor = bank.absoluteSlot;
  if (attempts.length === 0) return floor;
  const statuses = (await connection.getSignatureStatuses(attempts.map((a) => a.signature), { searchTransactionHistory: true })).value;
  const open: string[] = [];
  attempts.forEach((a, i) => {
    const st = statuses[i];
    const settled = !!st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
    if (settled) {
      floor = Math.max(floor, st!.slot);
    } else if (bank.blockHeight! <= a.lastValidBlockHeight) {
      open.push(`${a.signature} (can land until block ${a.lastValidBlockHeight}, now ${bank.blockHeight})`);
    }
  });
  if (open.length > 0) {
    throw new Error(
      `not resuming yet: an earlier transaction may still land and append its bytes: ${open.join("; ")}. ` +
        "Wait until it confirms or its blockhash expires (about a minute), then resume. Nothing was simulated or sent.",
    );
  }
  return floor;
}

/** Read an inscription from a bank at or after `minContextSlot`, and check the RPC honoured it. */
export async function fetchInscriptionAtLeast(
  connection: ResumeReader,
  n: bigint,
  minContextSlot: number,
  programId: PublicKey = INSCRIPTION_PROGRAM_ID,
): Promise<InscriptionAccount | undefined> {
  const address = inscriptionPda(n, programId);
  const res = await connection.getAccountInfoAndContext(address, { commitment: "confirmed", minContextSlot });
  if (res.context.slot < minContextSlot) {
    throw new Error(
      `the RPC answered from slot ${res.context.slot}, older than the settlement evidence at slot ${minContextSlot}; not resuming. Try again. Nothing was simulated or sent.`,
    );
  }
  const info = res.value;
  if (!info) return undefined;
  if (!info.owner.equals(programId)) throw new Error(`inscription ${address.toBase58()} is owned by ${info.owner.toBase58()}`);
  const ins = decodeInscription(info.data);
  if (ins.number !== n) throw new Error(`inscription account ${address.toBase58()} says #${ins.number}, expected #${n}`);
  return ins;
}

export async function prepareInscribeResume(
  connection: ResumeReader,
  input: {
    payer: PublicKey;
    number: bigint;
    content: Uint8Array;
    contentType: string;
    encoding?: number;
    budget?: TransactionInstruction[];
    programId?: PublicKey;
    /** Every earlier transaction of this upload that was signed and may have been submitted. Required, may be empty only if none were. */
    priorAttempts: PriorAttempt[];
  },
): Promise<Plan> {
  const floor = await assertAttemptsSettled(connection, input.priorAttempts);
  // Read only after every earlier attempt is settled, from a bank at least as
  // current as the evidence that settled them.
  const inscription = await fetchInscriptionAtLeast(connection, input.number, floor, input.programId);
  if (!inscription) throw new Error(`inscription #${input.number} does not exist; its inscribe transaction did not land`);
  return planInscribeResume({ ...input, inscription });
}
