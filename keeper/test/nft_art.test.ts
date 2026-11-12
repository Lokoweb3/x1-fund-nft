/**
 * core/nft_art.ts: inscription links, the #63 PDAs, decoding the captured
 * #63 inscription and Core asset (test/fixtures, mainnet 2026-11-12), the
 * gateway comparison with a mocked fetch, and the metadata JSON (compact form
 * within 600 bytes).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { CORE_PROGRAM_ID, FIRST_CHUNK_MAX, INSCRIPTION_PROGRAM_ID, inscriptionAssetPda, inscriptionPda, planInscribe, u64le, decodeInscriptionConfig } from "../src/core/inscribe.js";
import {
  buildFundNftJson,
  checkInscriptionGateway,
  guessContentType,
  inscriptionArtUrls,
  parseInscriptionRef,
  readCoreAssetOwner,
  readInscriptionArt,
  type FetchLike,
  type FundNftJsonInput,
} from "../src/core/nft_art.js";

const fixture = (name: string) => {
  const f = JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as { address: string; owner: string; dataBase64: string };
  return { address: new PublicKey(f.address), owner: new PublicKey(f.owner), data: Uint8Array.from(Buffer.from(f.dataBase64, "base64")) };
};
const ins63 = fixture("x1-inscription-63.json");
const asset63 = fixture("x1-inscription-63-asset.json");

test("art: inscription links and numbers", () => {
  assert.equal(parseInscriptionRef("https://www.x1inscriptions.io/i/63"), 63n);
  assert.equal(parseInscriptionRef("https://x1inscriptions.io/i/63/"), 63n);
  assert.equal(parseInscriptionRef("www.x1inscriptions.io/i/7"), 7n);
  assert.equal(parseInscriptionRef(" 63 "), 63n);
  assert.equal(parseInscriptionRef("#0"), 0n);
  for (const bad of ["", "abc", "-1", "6.3", "https://evil.example/i/63", "https://www.x1inscriptions.io/x/63", "https://www.x1inscriptions.io/i/63?x=1/../64", "99999999999999999"]) {
    assert.throws(() => parseInscriptionRef(bad), /inscription number|too large/, bad);
  }
  assert.deepEqual(inscriptionArtUrls(63n), {
    page: "https://www.x1inscriptions.io/i/63",
    nftJson: "https://www.x1inscriptions.io/api/nft/ins/63.json",
    content: "https://63.x1ins.xyz/content/63",
    card: "https://www.x1inscriptions.io/api/ins/63?card=1&v=1",
  });
});

test("art: #63 PDAs are [ins, u64le(63)] and [nft_i, u64le(63)] under X1ins...", () => {
  const seeds = (s: string) => [new TextEncoder().encode(s), u64le(63n)];
  const ins = PublicKey.findProgramAddressSync(seeds("ins"), INSCRIPTION_PROGRAM_ID)[0];
  const nft = PublicKey.findProgramAddressSync(seeds("nft_i"), INSCRIPTION_PROGRAM_ID)[0];
  assert.equal(ins.toBase58(), "6CrbZLDfaL2qmEJ66TeiFTccUhqkniVyquGu1nWcs4WU");
  assert.equal(nft.toBase58(), "Aej1SC2BZbF5o5FHSu93LjspTwDjToFqBzqZeqbgTpP9");
  assert.ok(inscriptionPda(63n).equals(ins));
  assert.ok(inscriptionAssetPda(63n).equals(nft));
  assert.ok(ins63.address.equals(ins) && asset63.address.equals(nft));
});

test("art: reads #63's header and its Core asset owner at offset 1 from the captured accounts", async () => {
  assert.ok(asset63.owner.equals(CORE_PROGRAM_ID));
  const owner = readCoreAssetOwner(asset63.data);
  assert.equal(owner.toBase58(), "6P5dGdd3RLajZboiLGATkUHiiVxKn6544zUdFTk2AZKC");
  assert.throws(() => readCoreAssetOwner(ins63.data), /not a Metaplex Core AssetV1/);
  const conn = {
    async getMultipleAccountsInfo(keys: PublicKey[]) {
      return keys.map((k) => (k.equals(ins63.address) ? ins63 : k.equals(asset63.address) ? asset63 : null));
    },
  };
  const art = await readInscriptionArt(conn, 63n);
  assert.equal(art.contentType, "video/mp4");
  assert.equal(art.totalSize, 393_222);
  assert.equal(art.sealed, true);
  assert.equal(art.encoding, 128);
  // The asset's owner and the inscription's owner field are the same key.
  assert.ok(art.assetOwner!.equals(art.inscriptionOwner));
  await assert.rejects(readInscriptionArt(conn, 64n), /inscription #64 does not exist on this network/);
});

function fakeFetch(responses: Record<string, { status?: number; headers?: Record<string, string>; json?: unknown } | Error>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fn: FetchLike = async (url, init) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    const r = responses[`${method} ${url}`];
    if (!r) throw new Error(`unexpected ${method} ${url}`);
    if (r instanceof Error) throw r;
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null }, json: async () => r.json };
  };
  return { fn, calls };
}

const art63 = async () =>
  readInscriptionArt(
    { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (k.equals(ins63.address) ? ins63 : k.equals(asset63.address) ? asset63 : null)) },
    63n,
  );

test("art: gateway check keeps the site's animation_url and files, and warns on a type or length mismatch", async () => {
  const art = await art63();
  // The live answers on 2026-11-12: JSON with animation_url/files; HEAD video/mp4 without a content-length.
  const live = fakeFetch({
    "GET https://www.x1inscriptions.io/api/nft/ins/63.json": {
      json: {
        animation_url: "https://63.x1ins.xyz/content/63",
        properties: { category: "video", files: [{ uri: "https://63.x1ins.xyz/content/63", type: "video/mp4" }, { uri: "https://evil.example/x", type: "video/mp4" }] },
      },
    },
    "HEAD https://63.x1ins.xyz/content/63": { headers: { "content-type": "video/mp4" } },
  });
  const ok = await checkInscriptionGateway(live.fn, art);
  assert.equal(ok.animationUrl, "https://63.x1ins.xyz/content/63");
  assert.deepEqual(ok.files, [{ uri: "https://63.x1ins.xyz/content/63", type: "video/mp4" }]);
  assert.deepEqual(ok.warnings, ["the gateway did not report a content length, so the size could not be compared"]);
  assert.deepEqual(live.calls, [
    { url: "https://www.x1inscriptions.io/api/nft/ins/63.json", method: "GET" },
    { url: "https://63.x1ins.xyz/content/63", method: "HEAD" },
  ]);

  const off = fakeFetch({
    "GET https://www.x1inscriptions.io/api/nft/ins/63.json": { json: { animation_url: "https://elsewhere.example/63.mp4" } },
    "HEAD https://63.x1ins.xyz/content/63": { headers: { "content-type": "text/plain; charset=utf-8", "content-length": "12" } },
  });
  const bad = await checkInscriptionGateway(off.fn, art);
  assert.equal(bad.animationUrl, undefined);
  assert.ok(bad.warnings.some((w) => /ignored the site's animation_url/.test(w)));
  assert.ok(bad.warnings.some((w) => /serves this as text\/plain; charset=utf-8, but the chain says video\/mp4/.test(w)));
  assert.ok(bad.warnings.some((w) => /reports 12 bytes, but the chain says 393222/.test(w)));

  const down = fakeFetch({ "GET https://www.x1inscriptions.io/api/nft/ins/63.json": new Error("Failed to fetch"), "HEAD https://63.x1ins.xyz/content/63": { status: 404 } });
  const d = await checkInscriptionGateway(down.fn, art);
  assert.ok(d.warnings.some((w) => /could not read the site's NFT JSON: Failed to fetch/.test(w)));
  assert.ok(d.warnings.some((w) => /HTTP 404/.test(w)));
});

const usdc = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const test2 = new PublicKey("C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz");

function input63(compact: boolean, description = "A fund that buys TEST every hour."): FundNftJsonInput {
  return {
    name: "X1 Fund NFT",
    symbol: "XFUND",
    description,
    image: { uri: "https://www.x1inscriptions.io/api/ins/63?card=1&v=1", type: "image/jpeg" },
    animation: { uri: "https://63.x1ins.xyz/content/63", type: "video/mp4" },
    inscription: { number: 63n, inscription: inscriptionPda(63n), asset: inscriptionAssetPda(63n), contentType: "video/mp4", totalSize: 393_222 },
    fund: Keypair.generate().publicKey,
    quote: { mint: usdc, label: "USDC.X" },
    targets: [
      { mint: test2, label: "TEST", bps: 8000, cash: false },
      { mint: usdc, label: "USDC.X", bps: 2000, cash: true },
    ],
    compact,
  };
}

test("art: metadata JSON is Metaplex-shaped; compact fits one inscription transaction", () => {
  const full = buildFundNftJson(input63(false));
  const doc = JSON.parse(full.json) as Record<string, unknown> & { attributes: Array<{ trait_type: string; value: unknown }>; properties: { files: unknown[]; category: string } };
  assert.equal(doc.name, "X1 Fund NFT");
  assert.equal(doc.image, "https://www.x1inscriptions.io/api/ins/63?card=1&v=1");
  assert.equal(doc.animation_url, "https://63.x1ins.xyz/content/63");
  assert.equal(doc.properties.category, "video");
  assert.deepEqual(doc.properties.files, [
    { uri: "https://www.x1inscriptions.io/api/ins/63?card=1&v=1", type: "image/jpeg" },
    { uri: "https://63.x1ins.xyz/content/63", type: "video/mp4" },
  ]);
  const traits = Object.fromEntries(doc.attributes.map((a) => [a.trait_type, a.value]));
  assert.equal(traits["Inscription"], 63);
  assert.equal(traits["Inscription account"], "6CrbZLDfaL2qmEJ66TeiFTccUhqkniVyquGu1nWcs4WU");
  assert.equal(traits["Inscription NFT"], "Aej1SC2BZbF5o5FHSu93LjspTwDjToFqBzqZeqbgTpP9");
  assert.equal(traits["Content type"], "video/mp4");
  assert.equal(traits["Size"], 393222);
  assert.equal(traits["Pay with"], `USDC.X ${usdc.toBase58()}`);
  assert.equal(traits["Buy 1"], `TEST ${test2.toBase58()} 80%`);
  assert.equal(traits["Cash"], "20%");
  assert.ok(full.bytes.length > FIRST_CHUNK_MAX);

  const compact = buildFundNftJson(input63(true));
  assert.ok(compact.bytes.length <= FIRST_CHUNK_MAX, `${compact.bytes.length}`);
  assert.equal(compact.descriptionTrimmedTo, undefined);
  const cdoc = JSON.parse(compact.json) as typeof doc;
  assert.equal(cdoc.description, "A fund that buys TEST every hour.");
  assert.deepEqual(
    cdoc.attributes.map((a) => a.trait_type),
    ["Inscription", "Fund", "Pay with", "Buy 1", "Cash"],
  );
  assert.deepEqual(cdoc.properties.files, [{ uri: "https://63.x1ins.xyz/content/63", type: "video/mp4" }]);
  assert.equal(cdoc.properties.category, "video");

  // A long description is shortened to fit, never over 600 bytes, and the result is still valid JSON.
  const long = buildFundNftJson(input63(true, "Ünïcødé \"quoted\" ".repeat(60)));
  assert.ok(long.bytes.length <= FIRST_CHUNK_MAX, `${long.bytes.length}`);
  assert.ok(long.descriptionTrimmedTo!.endsWith("…"));
  JSON.parse(long.json);

  // A compact plan is a single inscribe transaction.
  const config = decodeInscriptionConfig(fixture("x1-inscriptions-config.json").data);
  const plan = planInscribe({ payer: Keypair.generate().publicKey, content: compact.bytes, contentType: "application/json", maxFee: config.fees.inscribe, config });
  assert.equal(plan.txs.length, 1);
  // The pretty-printed full form needs more than one.
  assert.ok(planInscribe({ payer: Keypair.generate().publicKey, content: full.bytes, contentType: "application/json", maxFee: config.fees.inscribe, config }).txs.length > 1);
});

test("art: compact refuses when even an empty description cannot fit", () => {
  const many = input63(true);
  many.targets = Array.from({ length: 8 }, (_, i) => ({ mint: Keypair.generate().publicKey, label: `TOKEN${i}XYZW`, bps: 1250, cash: false }));
  many.maxBytes = 400;
  assert.throws(() => buildFundNftJson(many), /even without a description/);
});

test("art: plain URLs guess their content type", () => {
  assert.equal(guessContentType("https://example.invalid/a/b.PNG"), "image/png");
  assert.equal(guessContentType("https://example.invalid/clip.mp4?x=1"), "video/mp4");
  assert.equal(guessContentType("https://example.invalid/noext"), undefined);
  const plain = buildFundNftJson({ ...input63(true), inscription: undefined, image: { uri: "https://example.invalid/fund.png", type: "image/png" }, animation: undefined });
  const doc = JSON.parse(plain.json);
  assert.equal(doc.properties.category, "image");
  assert.equal(doc.animation_url, undefined);
  assert.deepEqual(doc.properties.files, [{ uri: "https://example.invalid/fund.png", type: "image/png" }]);
});
