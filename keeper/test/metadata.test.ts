/**
 * Fund NFT metadata: CLI parsing, client bounds (metaplex.rs), PDAs, the
 * attach/update builders, the create-fund plan with metadata as tx 2, the
 * recovery command, and the stored-metadata decoder. Offline.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { createProgram } from "../src/fund.js";
import {
  associatedTokenAddress,
  assertPlanFits,
  buildAttachMetadataIx,
  buildUpdateMetadataIx,
  computeBudget,
  decodeMetadata,
  fundPda,
  masterEditionPda,
  MAX_NAME_LEN,
  MAX_SYMBOL_LEN,
  MAX_TX_BYTES,
  MAX_URI_LEN,
  metadataPda,
  METAPLEX_PROGRAM_ID,
  NFT_TOKEN_PROGRAM_ID,
  parseCli,
  partialFailureMessage,
  planCreateFund,
  PROGRAM_ID,
  setMetadataCommandLine,
  txSize,
  utf8Length,
  validateMetadataUpdate,
  type MintMeta,
} from "../src/owner.js";
import { TOKEN_2022_PROGRAM_ID } from "../src/pool.js";

const require = createRequire(import.meta.url);
const { AnchorProvider, Wallet } = require("@anchor-lang/core") as typeof import("@anchor-lang/core");

const QUOTE = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";
const TEST_MINT = "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz";
const POOL = "7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD";
const program = createProgram(
  new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {}),
);

const CREATE = [
  "create-fund",
  "--quote",
  QUOTE,
  "--target",
  `${QUOTE}:default:2000`,
  "--target",
  `${TEST_MINT}:${POOL}:8000`,
  "--per-run",
  "100000",
  "--interval",
  "3600",
  "--window",
  "3600",
  "--max-dev-bps",
  "300",
];

test("bounds match metaplex.rs and count UTF-8 bytes", () => {
  assert.deepEqual([MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN], [32, 10, 200]);
  assert.doesNotThrow(() => validateMetadataUpdate({ name: "n".repeat(32), symbol: "s".repeat(10), uri: "u".repeat(200) }));
  assert.doesNotThrow(() => validateMetadataUpdate({ name: "", symbol: "", uri: "" }));
  assert.throws(() => validateMetadataUpdate({ name: "n".repeat(33) }), /--name is 33 bytes; the limit is 32/);
  assert.throws(() => validateMetadataUpdate({ symbol: "s".repeat(11) }), /--symbol is 11 bytes; the limit is 10/);
  assert.throws(() => validateMetadataUpdate({ uri: "u".repeat(201) }), /--uri is 201 bytes; the limit is 200/);
  // 11 two-byte characters: 22 bytes.
  assert.equal(utf8Length("é".repeat(11)), 22);
  assert.doesNotThrow(() => validateMetadataUpdate({ name: "é".repeat(11) }));
  assert.throws(() => validateMetadataUpdate({ symbol: "é".repeat(6) }), /12 bytes/);
  assert.throws(() => validateMetadataUpdate({ name: "a\0b" }), /NUL/);
});

test("create-fund parses --name/--symbol/--uri all together or not at all", () => {
  const none = parseCli(CREATE);
  assert.equal(none.command, "create-fund");
  assert.equal((none as Extract<typeof none, { command: "create-fund" }>).metadata, undefined);
  const all = parseCli([...CREATE, "--name", "My fund", "--symbol", "FUND", "--uri", "https://example.invalid/a.json"]);
  assert.deepEqual((all as Extract<typeof all, { command: "create-fund" }>).metadata, {
    name: "My fund",
    symbol: "FUND",
    uri: "https://example.invalid/a.json",
  });
  assert.throws(() => parseCli([...CREATE, "--name", "x"]), /all three or none/);
  assert.throws(() => parseCli([...CREATE, "--name", "x", "--symbol", "y"]), /all three or none/);
  assert.throws(
    () => parseCli([...CREATE, "--name", "n".repeat(33), "--symbol", "y", "--uri", "z"]),
    /--name is 33 bytes/,
  );
  assert.throws(() => parseCli([...CREATE, "--name", "a", "--name", "b", "--symbol", "y", "--uri", "z"]), /more than once/);
});

test("set-metadata parses any non-empty subset of fields", () => {
  const fund = Keypair.generate().publicKey.toBase58();
  const p = parseCli(["set-metadata", "--fund", fund, "--uri", "https://example.invalid/b.json"]);
  assert.equal(p.command, "set-metadata");
  assert.deepEqual((p as Extract<typeof p, { command: "set-metadata" }>).update, { uri: "https://example.invalid/b.json" });
  // An empty string is a value, not an omission.
  const empty = parseCli(["set-metadata", "--fund", fund, "--symbol", ""]);
  assert.deepEqual((empty as Extract<typeof empty, { command: "set-metadata" }>).update, { symbol: "" });
  assert.throws(() => parseCli(["set-metadata", "--fund", fund]), /at least one of --name, --symbol, --uri/);
  assert.throws(() => parseCli(["set-metadata", "--fund", fund, "--uri", "u".repeat(201)]), /201 bytes/);
  assert.throws(() => parseCli(["set-metadata", "--uri", "x"]), /requires --fund/);
  assert.throws(() => parseCli(["set-metadata", "--fund", fund, "--quote", QUOTE]), /unknown or misplaced/);
});

test("PDAs use the Token Metadata seeds", () => {
  const mint = Keypair.generate().publicKey;
  const [md] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID,
  );
  const [ed] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from("edition")],
    METAPLEX_PROGRAM_ID,
  );
  assert.ok(metadataPda(mint).equals(md));
  assert.ok(masterEditionPda(mint).equals(ed));
  assert.equal(METAPLEX_PROGRAM_ID.toBase58(), "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
});

test("attach and update builders name the program's accounts in IDL order", async () => {
  const holder = Keypair.generate().publicKey;
  const nftMint = Keypair.generate().publicKey;
  const nftAccount = associatedTokenAddress(holder, nftMint, NFT_TOKEN_PROGRAM_ID);
  const fields = { name: "Fund", symbol: "F", uri: "https://example.invalid/c.json" };
  const attach = await buildAttachMetadataIx(program, { holder, nftMint, nftAccount }, fields);
  assert.ok(attach.programId.equals(PROGRAM_ID));
  assert.deepEqual(
    attach.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [holder.toBase58(), true, true],
      [fundPda(nftMint).toBase58(), false, false],
      [nftMint.toBase58(), false, true],
      [nftAccount.toBase58(), false, false],
      [metadataPda(nftMint).toBase58(), false, true],
      [masterEditionPda(nftMint).toBase58(), false, true],
      [NFT_TOKEN_PROGRAM_ID.toBase58(), false, false],
      [METAPLEX_PROGRAM_ID.toBase58(), false, false],
      ["11111111111111111111111111111111", false, false],
      [SYSVAR_RENT_PUBKEY.toBase58(), false, false],
    ],
  );
  await assert.rejects(
    buildAttachMetadataIx(program, { holder, nftMint, nftAccount }, { ...fields, uri: "u".repeat(201) }),
    /201 bytes/,
  );

  const update = await buildUpdateMetadataIx(program, { holder, nftMint, nftAccount }, { uri: "https://example.invalid/d.json" });
  assert.deepEqual(
    update.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    [
      [holder.toBase58(), true, false],
      [fundPda(nftMint).toBase58(), false, false],
      [nftMint.toBase58(), false, false],
      [nftAccount.toBase58(), false, false],
      [metadataPda(nftMint).toBase58(), false, true],
      [NFT_TOKEN_PROGRAM_ID.toBase58(), false, false],
      [METAPLEX_PROGRAM_ID.toBase58(), false, false],
    ],
  );
  // Args: discriminator, then Option<String> x3 (None = 0, Some = 1 + u32 len + bytes).
  const data = update.data;
  const tail = data.subarray(8);
  const uri = Buffer.from("https://example.invalid/d.json");
  assert.deepEqual(
    [...tail],
    [0, 0, 1, ...new Uint8Array(new Uint32Array([uri.length]).buffer), ...uri],
  );
  await assert.rejects(buildUpdateMetadataIx(program, { holder, nftMint, nftAccount }, {}), /at least one/);
});

function mintMeta(): MintMeta {
  return { address: Keypair.generate().publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID, decimals: 6, transferFee: undefined };
}

test("create-fund with metadata: create, then attach (depends on tx 1), then target vaults", async () => {
  const payer = Keypair.generate().publicKey;
  const nft = Keypair.generate();
  const quote = mintMeta();
  const fields = { name: "n".repeat(32), symbol: "s".repeat(10), uri: "u".repeat(200) };
  const budget = computeBudget({}).instructions;
  // The largest create_fund that fits without metadata still fits: tx 1 is unchanged.
  for (const n of [1, 6]) {
    const mints = Array.from({ length: n }, mintMeta);
    const targets = mints.map((m) => ({ mint: m.address, pool: Keypair.generate().publicKey, bps: 1 }));
    const args = { quote: quote.address, targets, perRun: 1n, interval: 60n, window: 900, maxDevBps: 0 };
    const without = await planCreateFund(program, payer, nft, args, quote, mints, budget);
    const withMd = await planCreateFund(program, payer, nft, args, quote, mints, budget, fields);
    assert.deepEqual(
      withMd.map((tx) => tx.label),
      ["create_fund + quote vault", "attach_metadata", "target vaults"],
    );
    assert.equal(txSize(payer, withMd[0]!.instructions), txSize(payer, without[0]!.instructions), "tx 1 unchanged");
    assert.equal(withMd[1]!.dependsOnPrevious, true);
    assert.equal(withMd[1]!.extraSigners.length, 0, "the NFT mint keypair signs only tx 1");
    assert.ok(!withMd[0]!.dependsOnPrevious && !withMd[2]!.dependsOnPrevious);
    const attachSize = txSize(payer, withMd[1]!.instructions);
    assert.ok(attachSize <= MAX_TX_BYTES, `attach tx is ${attachSize} bytes with maximum-length fields`);
    assert.doesNotThrow(() => assertPlanFits(payer, withMd));
    const attachIx = withMd[1]!.instructions.at(-1)!;
    assert.ok(attachIx.keys[3]!.pubkey.equals(associatedTokenAddress(payer, nft.publicKey, NFT_TOKEN_PROGRAM_ID)));
  }
  // Cash-only fund with metadata: two transactions.
  const cashOnly = await planCreateFund(
    program,
    payer,
    nft,
    { quote: quote.address, targets: [{ mint: quote.address, pool: PublicKey.default, bps: 10_000 }], perRun: 1n, interval: 60n, window: 900, maxDevBps: 0 },
    quote,
    [],
    budget,
    fields,
  );
  assert.deepEqual(cashOnly.map((tx) => tx.label), ["create_fund + quote vault", "attach_metadata"]);
});

test("set-metadata recovery command quotes the fields and keeps the key a placeholder", async () => {
  const fund = Keypair.generate().publicKey;
  const payer = Keypair.generate().publicKey;
  const line = setMetadataCommandLine({
    fund,
    payer,
    rpcUrl: "http://127.0.0.1:18989",
    send: true,
    cluster: "localnet",
    iUnderstandMainnet: false,
    fields: { name: "Bob's fund", symbol: "BF", uri: "https://example.invalid/x.json?a=1&b=2" },
  });
  assert.match(line, /^KEYPAIR='REPLACE_WITH_THE_SAME_KEYPAIR_PATH' npx tsx src\/cli\.ts set-metadata /);
  assert.match(line, /--name='Bob'\\''s fund'/);
  assert.match(line, /--symbol=BF /);
  assert.match(line, /--uri='https:\/\/example\.invalid\/x\.json\?a=1&b=2'/);
  assert.match(line, /--send --cluster localnet$/);

  // Partial failure after tx 1: both recovery commands are shown.
  const nft = Keypair.generate();
  const quote = mintMeta();
  const t = mintMeta();
  const txs = await planCreateFund(
    program,
    payer,
    nft,
    {
      quote: quote.address,
      targets: [{ mint: t.address, pool: Keypair.generate().publicKey, bps: 10_000 }],
      perRun: 1n,
      interval: 60n,
      window: 900,
      maxDevBps: 0,
    },
    quote,
    [t],
    computeBudget({}).instructions,
    { name: "a", symbol: "b", uri: "c" },
  );
  const recovery = `${line}\n  then: npx tsx src/cli.ts ensure-vaults --fund ${fund.toBase58()}`;
  const msg = partialFailureMessage({ txs, fund, recovery }, [{ label: txs[0]!.label, signature: "SIG1" }], 1, "was refused", "not sent");
  assert.match(msg, /not sent: tx 2\/3 \(attach_metadata\), tx 3\/3 \(target vaults\)/);
  assert.match(msg, /recovery: KEYPAIR=.* set-metadata .*\n {2}then: .*ensure-vaults/);
});

test("decodeMetadata reads the head of a MetadataV1 account and trims NUL padding", () => {
  const authority = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const str = (s: string, pad: number) => {
    const bytes = Buffer.concat([Buffer.from(s), Buffer.alloc(pad)]);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(bytes.length);
    return Buffer.concat([len, bytes]);
  };
  const data = Buffer.concat([
    Buffer.from([4]),
    authority.toBuffer(),
    mint.toBuffer(),
    str("Fund", 28),
    str("F", 9),
    str("https://example.invalid/e.json", 0),
    Buffer.from([0, 0, 0]),
  ]);
  const md = decodeMetadata(data);
  assert.ok(md.updateAuthority.equals(authority));
  assert.ok(md.mint.equals(mint));
  assert.deepEqual([md.name, md.symbol, md.uri], ["Fund", "F", "https://example.invalid/e.json"]);
  assert.throws(() => decodeMetadata(Buffer.concat([Buffer.from([6]), data.subarray(1)])), /MetadataV1/);
  assert.throws(() => decodeMetadata(data.subarray(0, 80)), /truncated/);
});
