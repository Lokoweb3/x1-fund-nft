/**
 * core/inscribe.ts, offline: PDAs against known mainnet addresses, decoding
 * against captured mainnet account bytes (test/fixtures, captured 2026-11-12
 * by test/capture-inscription-fixtures.ts), instruction bytes against
 * Anchor's coder and the saved IDL, transaction-size and chunking math, and
 * the refusals.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BorshCoder, type Idl } from "@anchor-lang/core";
import BN from "bn.js";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { MAX_TX_BYTES, txSize } from "../src/core/owner.js";
import {
  APPEND_CHUNK_MAX,
  appendIx,
  COMPUTE_UNITS,
  CORE_PROGRAM_ID,
  decodeInscription,
  decodeInscriptionConfig,
  FIRST_CHUNK_MAX,
  INSCRIPTION_PROGRAM_ID,
  inscribeIx,
  inscriptionAssetPda,
  inscriptionCollectionPda,
  inscriptionConfigPda,
  inscriptionPda,
  inscriptionUri,
  MAINNET_CONFIG,
  MAINNET_GENESIS_POOL,
  MAX_CONTENT_BYTES,
  nftAuthPda,
  planInscribe,
  planInscribeResume,
  prepareInscribe,
  thawInscriptionIx,
  type AccountReader,
  type InscriptionAccount,
  type InscriptionConfig,
} from "../src/core/inscribe.js";

interface Fixture {
  address: string;
  owner: string;
  slot: number;
  fetchedAt: string;
  dataBase64: string;
}
const fixture = (name: string): Fixture & { data: Uint8Array } => {
  const f = JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as Fixture;
  return { ...f, data: Uint8Array.from(Buffer.from(f.dataBase64, "base64")) };
};
const idlJson: unknown = JSON.parse(readFileSync(new URL("../../docs/x1-inscriptions/idl.json", import.meta.url), "utf8"));
const idl = idlJson as {
  address: string;
  instructions: Array<{ name: string; accounts: Array<{ name: string; writable?: boolean; signer?: boolean; address?: string }> }>;
};
const coder = new BorshCoder(idlJson as Idl);

const payer = Keypair.generate().publicKey;
const enc = (s: string) => new TextEncoder().encode(s);
/** A JSON document of exactly `size` bytes. */
function json(size: number): Uint8Array {
  const empty = enc(JSON.stringify({ name: "Fund", d: "" })).length;
  const out = enc(JSON.stringify({ name: "Fund", d: "x".repeat(size - empty) }));
  assert.equal(out.length, size);
  return out;
}
const liveConfig = (): InscriptionConfig => decodeInscriptionConfig(fixture("x1-inscriptions-config.json").data);
const config = (over: Partial<InscriptionConfig> = {}): InscriptionConfig => ({ ...liveConfig(), ...over });
const plan = (size: number, over: Partial<Parameters<typeof planInscribe>[0]> = {}) =>
  planInscribe({ payer, content: json(size), contentType: "application/json", maxFee: 500_000_000n, config: config(), ...over });

test("PDAs: #63's inscription and Core asset, the config, collection and genesis pool match mainnet", () => {
  assert.equal(inscriptionPda(63n).toBase58(), "6CrbZLDfaL2qmEJ66TeiFTccUhqkniVyquGu1nWcs4WU");
  assert.equal(inscriptionAssetPda(63n).toBase58(), "Aej1SC2BZbF5o5FHSu93LjspTwDjToFqBzqZeqbgTpP9");
  assert.equal(inscriptionConfigPda().toBase58(), MAINNET_CONFIG.toBase58());
  assert.equal(inscriptionConfigPda().toBase58(), "E33orhudcHnVwA46WejnDMXZ3HCdGQaf572r2oKcy3HP");
  // The site's network table: collections.inscriptions.
  assert.equal(inscriptionCollectionPda().toBase58(), "8AoC9xrB7LchjfJmdUBxMcyCLjHjSQP8ZVnjDDQadDUy");
  assert.equal(
    PublicKey.findProgramAddressSync([enc("genesis_pool")], INSCRIPTION_PROGRAM_ID)[0].toBase58(),
    MAINNET_GENESIS_POOL.toBase58(),
  );
  assert.equal(inscriptionPda(63n).toBase58(), fixture("x1-inscription-63.json").address);
  // u64 little-endian seeds: #256 is not #1.
  assert.notEqual(inscriptionPda(256n).toBase58(), inscriptionPda(1n).toBase58());
  assert.throws(() => inscriptionPda(-1n), /u64 out of range/);
});

test("the IDL pins the same accounts this file hard-codes", () => {
  const inscribe = idl.instructions.find((i) => i.name === "inscribe")!;
  assert.equal(inscribe.accounts.find((a) => a.name === "core")!.address, CORE_PROGRAM_ID.toBase58());
  assert.equal(inscribe.accounts.find((a) => a.name === "genesis_pool")!.address, MAINNET_GENESIS_POOL.toBase58());
  const append = idl.instructions.find((i) => i.name === "append")!;
  assert.equal(append.accounts.find((a) => a.name === "config")!.address, MAINNET_CONFIG.toBase58());
  assert.equal(idl.address, INSCRIPTION_PROGRAM_ID.toBase58());
});

test("config: decodes the captured live mainnet account", () => {
  const f = fixture("x1-inscriptions-config.json");
  assert.equal(f.address, MAINNET_CONFIG.toBase58());
  assert.equal(f.owner, INSCRIPTION_PROGRAM_ID.toBase58());
  assert.match(f.fetchedAt, /^2026-11-12T/);
  assert.equal(f.data.length, 184);
  const c = decodeInscriptionConfig(f.data);
  assert.equal(c.admin.toBase58(), "HjaGVTXA9az5iu8EdqNHZgm5c3FY3ohNGQZFhnjn28YK");
  assert.equal(c.treasury.toBase58(), "9TzfWeZRy2fjMaJ4o4msUjv8Q8VBL7qUqrDgbwnFxQ7b");
  assert.equal(c.fees.inscribe, 500_000_000n);
  assert.equal(c.fees.claim, 500_000_000n);
  assert.equal(c.fees.deploy, 1_000_000_000n);
  assert.deepEqual(c.fees.premium, [44_000_000_000n, 20_000_000_000n, 8_000_000_000n]);
  assert.equal(c.fees.mint, 250_000_000n);
  assert.equal(c.fees.marketBps, 200);
  assert.equal(c.nextInscription, 67n);
  assert.equal(c.paused, false);
  assert.equal(c.bump, 254);
  assert.equal(PublicKey.createProgramAddressSync([enc("config"), Uint8Array.of(c.bump)], INSCRIPTION_PROGRAM_ID).toBase58(), f.address);
  assert.deepEqual(c.extraFees, { parcel: 500_000_000n, release: 1_000_000_000n, bridge: 500_000_000n });
  assert.deepEqual(c.genesis, { mintBps: 5000, launchBps: 5000, marketBps: 5000, price: 0n, inscribeBps: 5000 });
  assert.equal(Buffer.from(c.unknownTail).toString("hex"), "09000000");
});

test("config: paused byte, short accounts and wrong discriminators", () => {
  const bytes = fixture("x1-inscriptions-config.json").data;
  const paused = Uint8Array.from(bytes);
  paused[138] = 1;
  assert.equal(decodeInscriptionConfig(paused).paused, true);
  paused[138] = 2;
  assert.throws(() => decodeInscriptionConfig(paused), /not a bool/);
  // The bare 140-byte struct (no admin extensions) still decodes.
  const bare = decodeInscriptionConfig(bytes.slice(0, 140));
  assert.equal(bare.nextInscription, 67n);
  assert.equal(bare.extraFees, undefined);
  assert.equal(bare.genesis, undefined);
  assert.throws(() => decodeInscriptionConfig(bytes.slice(0, 139)), /at least 140/);
  const wrong = Uint8Array.from(bytes);
  wrong[0] ^= 1;
  assert.throws(() => decodeInscriptionConfig(wrong), /discriminator/);
  // Cross-check against Anchor's coder for the struct part.
  const anchor = coder.accounts.decode("Config", Buffer.from(bytes.slice(0, 140)));
  assert.equal(anchor.next_inscription.toString(), "67");
  assert.equal(anchor.fees.inscribe.toString(), "500000000");
  assert.equal(anchor.paused, false);
});

test("inscription: decodes a small inline mainnet inscription (#32) and a big header (#63)", () => {
  const small = decodeInscription(fixture("x1-inscription-32.json").data);
  assert.equal(small.number, 32n);
  assert.equal(small.contentType, "text/plain;charset=utf-8");
  assert.equal(small.totalSize, 46);
  assert.equal(small.written, 46);
  assert.equal(small.sealed, true);
  assert.equal(small.encoding, 0);
  assert.equal(small.content.length, 46);
  assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(small.content));
  const big = decodeInscription(fixture("x1-inscription-63.json").data);
  assert.equal(big.number, 63n);
  assert.equal(big.contentType, "video/mp4");
  assert.equal(big.totalSize, 393_222);
  assert.equal(big.encoding, 128); // inscribe_big flag, raw
  assert.equal(big.content.length, 0);
  assert.equal(big.creator.toBase58(), "99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM");
  const anchor = coder.accounts.decode("Inscription", Buffer.from(fixture("x1-inscription-63.json").data));
  assert.equal(anchor.total_size, 393_222);
  assert.equal(anchor.writer.toBase58(), big.writer.toBase58());
});

test("instructions: bytes and accounts match Anchor's coder and the IDL", () => {
  const n = 67n;
  const treasury = Keypair.generate().publicKey;
  const writer = Keypair.generate().publicKey;
  const chunk = json(100);
  const args = { content_type: "application/json", total_size: 1536, chunk: Buffer.from(chunk), encoding: 0, writer: null, max_fee: new BN(500_000_000) };
  const ours = inscribeIx({ creator: payer, number: n, treasury, contentType: "application/json", totalSize: 1536, chunk, encoding: 0, writer: null, maxFee: 500_000_000n });
  assert.deepEqual(Buffer.from(ours.data), coder.instruction.encode("inscribe", args));
  const withWriter = inscribeIx({ creator: payer, number: n, treasury, contentType: "a", totalSize: 1, chunk: enc("{"), encoding: 1, writer, maxFee: 7n });
  assert.deepEqual(
    Buffer.from(withWriter.data),
    coder.instruction.encode("inscribe", { content_type: "a", total_size: 1, chunk: Buffer.from("{"), encoding: 1, writer, max_fee: new BN(7) }),
  );
  assert.deepEqual(Buffer.from(appendIx({ writer: payer, number: n, chunk }).data), coder.instruction.encode("append", { chunk: Buffer.from(chunk) }));
  assert.deepEqual(Buffer.from(thawInscriptionIx({ payer, number: n }).data), coder.instruction.encode("thaw_inscription", { _number: new BN(67) }));

  const expect: Record<string, PublicKey> = {
    config: MAINNET_CONFIG,
    inscription: inscriptionPda(n),
    creator: payer,
    treasury,
    asset: inscriptionAssetPda(n),
    collection: inscriptionCollectionPda(),
    nft_auth: nftAuthPda(),
    core: CORE_PROGRAM_ID,
    system_program: SystemProgram.programId,
    genesis_pool: MAINNET_GENESIS_POOL,
    writer: payer,
    payer,
  };
  for (const [name, ix] of [["inscribe", ours], ["append", appendIx({ writer: payer, number: n, chunk })], ["thaw_inscription", thawInscriptionIx({ payer, number: n })]] as const) {
    const accounts = idl.instructions.find((i) => i.name === name)!.accounts;
    assert.equal(ix.keys.length, accounts.length, name);
    accounts.forEach((a, i) => {
      const key = ix.keys[i]!;
      assert.equal(key.pubkey.toBase58(), expect[a.name]!.toBase58(), `${name}.${a.name}`);
      assert.equal(key.isWritable, a.writable === true, `${name}.${a.name} writable`);
      assert.equal(key.isSigner, a.signer === true, `${name}.${a.name} signer`);
    });
    assert.ok(ix.programId.equals(INSCRIPTION_PROGRAM_ID));
  }
});

test("plan: a 1536-byte JSON is 3 transactions (600 + 900 + 36, thaw in the last), each <= 1232 bytes", () => {
  const p = plan(1536);
  assert.equal(p.number, 67n);
  assert.equal(p.uri, "https://67.x1ins.xyz/content/67");
  assert.equal(p.inscription.toBase58(), inscriptionPda(67n).toBase58());
  assert.equal(p.asset.toBase58(), inscriptionAssetPda(67n).toBase58());
  assert.equal(p.fee, 500_000_000n);
  assert.deepEqual(p.chunks, [600, 900, 36]);
  assert.equal(p.txs.length, 3);
  assert.deepEqual(p.sizes, p.txs.map((tx) => txSize(payer, tx.instructions)));
  assert.ok(p.sizes.every((s) => s <= MAX_TX_BYTES), p.sizes.join(","));
  assert.deepEqual(p.sizes, [1154, 1222, 512]);
  assert.match(p.txs[0]!.label, /^inscribe #67 \(600 of 1536 bytes\)$/);
  assert.match(p.txs[2]!.label, /thaw NFT$/);
  assert.ok(p.txs.every((tx) => tx.extraSigners.length === 0));
  // Each transaction: one compute-unit limit, then the program instructions.
  const limits = p.txs.map((tx) => ComputeBudgetProgram.programId.equals(tx.instructions[0]!.programId) && tx.instructions[0]!.data.readUInt32LE(1));
  assert.deepEqual(limits, [COMPUTE_UNITS.inscribe, COMPUTE_UNITS.append, COMPUTE_UNITS.append + COMPUTE_UNITS.thaw]);
  // max_fee on the wire is the config fee, not the caller's (higher) cap.
  const loose = plan(1536, { maxFee: 10n ** 12n });
  const maxFee = Buffer.from(loose.txs[0]!.instructions[1]!.data).readBigUInt64LE(loose.txs[0]!.instructions[1]!.data.length - 8);
  assert.equal(maxFee, 500_000_000n);
  // The chunks reassemble to the content.
  const content = json(1536);
  const chunks = p.txs.map((tx) => {
    const ix = tx.instructions[1]!;
    const d = Buffer.from(ix.data);
    if (tx.label.startsWith("inscribe")) {
      const typeLen = d.readUInt32LE(8);
      const off = 8 + 4 + typeLen + 4;
      return d.subarray(off + 4, off + 4 + d.readUInt32LE(off));
    }
    return d.subarray(12, 12 + d.readUInt32LE(8));
  });
  assert.deepEqual(Buffer.concat(chunks), Buffer.from(content));
});

test("plan: chunking and thaw placement at the boundaries", () => {
  const shape = (size: number) => {
    const p = plan(size);
    assert.ok(p.sizes.every((s) => s <= MAX_TX_BYTES), `${size}: ${p.sizes.join(",")}`);
    return { chunks: p.chunks, txs: p.txs.map((tx) => tx.label.replace(/ \(.*?\)| to #\d+| #\d+/g, "")) };
  };
  assert.deepEqual(shape(100), { chunks: [100], txs: ["inscribe"] });
  assert.deepEqual(shape(FIRST_CHUNK_MAX), { chunks: [600], txs: ["inscribe"] });
  assert.deepEqual(shape(601), { chunks: [600, 1], txs: ["inscribe", "append chunk 2 + thaw NFT"] });
  // A full 900-byte last append leaves no room for the thaw: it gets its own transaction.
  assert.deepEqual(shape(600 + APPEND_CHUNK_MAX), { chunks: [600, 900], txs: ["inscribe", "append chunk 2", "thaw NFT"] });
  assert.deepEqual(shape(1024), { chunks: [600, 424], txs: ["inscribe", "append chunk 2 + thaw NFT"] });
  assert.deepEqual(shape(2048), { chunks: [600, 900, 548], txs: ["inscribe", "append chunk 2", "append chunk 3 + thaw NFT"] });
  assert.equal(plan(MAX_CONTENT_BYTES).txs.length, 1 + Math.ceil((MAX_CONTENT_BYTES - 600) / 900) + 0);
  // Largest last append that still takes the thaw along.
  let lo = 1;
  let hi = APPEND_CHUNK_MAX;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (plan(600 + mid).txs.length === 2) lo = mid;
    else hi = mid - 1;
  }
  assert.equal(lo, 755, "largest last append that still carries the thaw");
  assert.ok(plan(600 + 755).sizes[1]! > MAX_TX_BYTES - 2);
  assert.equal(plan(600 + 756).txs.length, 3);
});

test("plan: budget [] drops the compute-unit limit; an oversized prefix is refused before any send", () => {
  const bare = plan(1536, { budget: [] });
  assert.ok(bare.txs.every((tx) => !tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))));
  assert.deepEqual(bare.sizes, [1114, 1182, 472]);
  const heavy = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ];
  assert.throws(() => plan(1536, { budget: heavy }), /tx 2\/3 \(append chunk 2 .*\) is 12\d\d bytes; the limit is 1232. Nothing was simulated or sent/);
});

test("refusals: paused, fee above max, bad content", () => {
  assert.throws(() => plan(1536, { config: config({ paused: true }) }), /paused/);
  assert.throws(() => plan(1536, { maxFee: 499_999_999n }), /inscribe fee is 500000000 lamports, above the max fee 499999999/);
  assert.throws(() => plan(1536, { maxFee: -1n }), /non-negative/);
  assert.doesNotThrow(() => plan(1536, { maxFee: 500_000_000n }));
  assert.throws(() => planInscribe({ payer, content: new Uint8Array(), contentType: "application/json", maxFee: 1n << 60n, config: config() }), /empty/);
  assert.throws(() => plan(MAX_CONTENT_BYTES + 1), /at most 16384/);
  assert.throws(() => planInscribe({ payer, content: enc("{not json"), contentType: "application/json", maxFee: 1n << 60n, config: config() }), /does not parse/);
  assert.throws(() => planInscribe({ payer, content: Uint8Array.of(0xff, 0xfe), contentType: "application/json", maxFee: 1n << 60n, config: config() }), /not valid UTF-8/);
  assert.throws(() => plan(100, { contentType: "" }), /1-64 bytes/);
  assert.throws(() => plan(100, { contentType: "x".repeat(65) }), /1-64 bytes/);
  assert.throws(() => plan(100, { contentType: "application/json; x" }), /printable ASCII/);
  assert.throws(() => plan(100, { encoding: 2 }), /encoding must be 0/);
  assert.throws(() => plan(100, { encoding: 128 }), /encoding must be 0/);
  // gzip content is not parsed as JSON.
  assert.doesNotThrow(() => planInscribe({ payer, content: Uint8Array.of(0x1f, 0x8b, 8), contentType: "application/json", encoding: 1, maxFee: 1n << 60n, config: config() }));
});

test("uri: the subdomain gateway form", () => {
  assert.equal(inscriptionUri(0n), "https://0.x1ins.xyz/content/0");
  assert.equal(inscriptionUri(63n), "https://63.x1ins.xyz/content/63");
  assert.throws(() => inscriptionUri(-1n), /negative/);
});

/** A fake RPC: a map of account address -> {owner, data}. */
function reader(accounts: Map<string, { owner: PublicKey; data: Uint8Array }>): AccountReader {
  return { getAccountInfo: async (a) => accounts.get(a.toBase58()) ?? null };
}

test("prepareInscribe: reads the config, refuses a non-program owner and a stale (taken) number", async () => {
  const cfg = fixture("x1-inscriptions-config.json");
  const accounts = new Map([[cfg.address, { owner: INSCRIPTION_PROGRAM_ID, data: cfg.data }]]);
  const p = await prepareInscribe(reader(accounts), { payer, content: json(700), contentType: "application/json", maxFee: 500_000_000n });
  assert.equal(p.number, 67n);
  assert.equal(p.txs.length, 2);
  await assert.rejects(
    prepareInscribe(reader(new Map([[cfg.address, { owner: SystemProgram.programId, data: cfg.data }]])), { payer, content: json(700), contentType: "application/json", maxFee: 500_000_000n }),
    /owned by 11111111111111111111111111111111/,
  );
  await assert.rejects(prepareInscribe(reader(new Map()), { payer, content: json(700), contentType: "application/json", maxFee: 500_000_000n }), /no X1 Inscriptions config/);
  accounts.set(inscriptionPda(67n).toBase58(), { owner: INSCRIPTION_PROGRAM_ID, data: new Uint8Array(212) });
  await assert.rejects(prepareInscribe(reader(accounts), { payer, content: json(700), contentType: "application/json", maxFee: 500_000_000n }), /#67 already exists; the RPC's config is stale/);
});

function partial(content: Uint8Array, written: number, over: Partial<InscriptionAccount> = {}): InscriptionAccount {
  return {
    number: 67n,
    owner: payer,
    creator: payer,
    slot: 1n,
    district: 0n,
    contentType: "application/json",
    totalSize: content.length,
    written,
    sealed: written === content.length,
    price: 0n,
    encoding: 0,
    writer: payer,
    bump: 255,
    content: content.slice(0, written),
    ...over,
  };
}

test("resume: plans only the missing appends, and refuses anything that does not match", () => {
  const content = json(2000);
  const rest = planInscribeResume({ payer, content, contentType: "application/json", inscription: partial(content, 600) });
  assert.deepEqual(rest.txs.map((tx) => tx.label), ["append chunk 1 (900 bytes) to #67", "append chunk 2 (500 bytes) to #67 + thaw NFT"]);
  const done = planInscribeResume({ payer, content, contentType: "application/json", inscription: partial(content, 2000) });
  assert.deepEqual(done.txs.map((tx) => tx.label), ["thaw NFT #67"]);
  const other = Keypair.generate().publicKey;
  const r = (ins: InscriptionAccount, c = content) => () => planInscribeResume({ payer, content: c, contentType: "application/json", inscription: ins });
  assert.throws(r(partial(content, 600, { creator: other })), /created by/);
  assert.throws(r(partial(content, 600, { writer: other })), /writer is/);
  assert.throws(r(partial(content, 600), json(1999)), /is 2000 bytes, the content is 1999/);
  assert.throws(r(partial(content, 600, { contentType: "text/plain" })), /is text\/plain/);
  assert.throws(r(partial(content, 600, { encoding: 1 })), /encoding 1/);
  const tampered = partial(content, 600);
  tampered.content = Uint8Array.from(tampered.content);
  tampered.content[5] ^= 1;
  assert.throws(r(tampered), /first 600 bytes differ/);
  assert.throws(r(partial(content, 600, { sealed: true })), /sealed=true but written 600\/2000/);
  assert.throws(r(partial(content, 600, { content: new Uint8Array() })), /not all in its account/);
});

test("decodeInscription: a growing (unfinished) inline account", () => {
  const content = json(1536);
  const header = Uint8Array.from(fixture("x1-inscription-32.json").data.slice(0, 212));
  const dv = new DataView(header.buffer);
  dv.setBigUint64(8, 67n, true);
  dv.setUint32(161, 1536, true);
  dv.setUint32(165, 600, true);
  header[169] = 0;
  const account = new Uint8Array(212 + 900); // the account grows ahead of `written`
  account.set(header);
  account.set(content.subarray(0, 600), 212);
  const ins = decodeInscription(account);
  assert.equal(ins.written, 600);
  assert.deepEqual(Buffer.from(ins.content), Buffer.from(content.subarray(0, 600)));
  assert.throws(() => decodeInscription(account.slice(0, 212 + 599)), /says 600 bytes are written/);
});
