/**
 * NFT picture: host policy (auto only for X1 Inscriptions over https),
 * defensive metadata JSON parsing, request options, and the card render
 * with a picture and with the generated placeholder.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Keypair } from "@solana/web3.js";
import type { MintMeta } from "@core/owner.js";
import type { FundView } from "@core/rpc.js";
import type { StoredMetadata } from "@core/metadata.js";
import { TOKEN_PROGRAM_ID } from "@core/pool.js";
import { fetchNftJson, isAutoFetchUrl, mayFetch, NFT_JSON_MAX_BYTES, parseNftJson, resolvePicture } from "../src/lib/nft_picture.js";
import { NftCardView, NftPicture } from "../src/components/NftCard.js";
import { valueHoldings } from "../src/lib/value.js";

test("auto-fetch hosts: https www.x1inscriptions.io and <n>.x1ins.xyz only", () => {
  for (const ok of ["https://www.x1inscriptions.io/api/ins/66?card=1&v=1", "https://67.x1ins.xyz/content/67"]) assert.equal(isAutoFetchUrl(ok), true, ok);
  for (const bad of [
    "http://67.x1ins.xyz/content/67",
    "https://x1inscriptions.io/x",
    "https://evil.x1ins.xyz/content/1",
    "https://67.x1ins.xyz.evil.com/content/67",
    "https://www.x1inscriptions.io:8443/x",
    "https://user@www.x1inscriptions.io/x",
    "https://example.com/a.json",
    "javascript:alert(1)",
    "data:image/png;base64,AA",
    "",
    42,
  ])
    assert.equal(isAutoFetchUrl(bad), false, String(bad));
  assert.equal(mayFetch("https://example.com/a.json", new Set()), false);
  assert.equal(mayFetch("https://example.com/a.json", new Set(["example.com"])), true);
  assert.equal(mayFetch("ipfs://abc", new Set(["abc"])), false);
});

test("metadata JSON: image, files fallback, http(s) only, size cap", () => {
  assert.deepEqual(parseNftJson(JSON.stringify({ image: "https://a.example/i.png", animation_url: "https://a.example/v.mp4" })), {
    image: "https://a.example/i.png",
    animationUrl: "https://a.example/v.mp4",
  });
  assert.equal(parseNftJson(JSON.stringify({ properties: { files: [{ uri: "https://b.example/f.jpg" }] } })).image, "https://b.example/f.jpg");
  assert.equal(parseNftJson(JSON.stringify({ image: "javascript:alert(1)", properties: { files: [{ uri: "https://b.example/f.jpg" }] } })).image, "https://b.example/f.jpg");
  assert.equal(parseNftJson(JSON.stringify({ image: "https://a.example/i.png", animation_url: "javascript:x" })).animationUrl, undefined);
  for (const bad of [
    JSON.stringify({ image: "data:image/png;base64,AA" }),
    JSON.stringify({ image: "ipfs://x" }),
    JSON.stringify({ properties: { files: ["https://x"] } }),
    JSON.stringify(["https://a.example/i.png"]),
    "null",
    "not json",
    JSON.stringify({ image: "https://a.example/i.png", pad: "x".repeat(NFT_JSON_MAX_BYTES) }),
  ])
    assert.throws(() => parseNftJson(bad), Error, bad.slice(0, 40));
});

test("fetch options: no credentials, no referrer, cors, no redirects; oversized body rejected", async () => {
  let seen: RequestInit | undefined;
  const ok = async (_u: string, init: RequestInit) => {
    seen = init;
    return new Response(JSON.stringify({ image: "https://www.x1inscriptions.io/api/ins/66" }), { status: 200 });
  };
  const ac = new AbortController();
  assert.equal((await fetchNftJson("https://67.x1ins.xyz/content/67", ac.signal, ok)).image, "https://www.x1inscriptions.io/api/ins/66");
  assert.equal(seen?.credentials, "omit");
  assert.equal(seen?.referrerPolicy, "no-referrer");
  assert.equal(seen?.mode, "cors");
  assert.equal(seen?.redirect, "error");
  assert.ok(seen?.signal);
  const big = async () => new Response("x".repeat(NFT_JSON_MAX_BYTES + 10), { status: 200 });
  await assert.rejects(fetchNftJson("https://67.x1ins.xyz/content/67", ac.signal, big), /too large/);
  const fail = async () => new Response("no", { status: 404 });
  await assert.rejects(fetchNftJson("https://67.x1ins.xyz/content/67", ac.signal, fail), /404/);
});

test("resolvePicture asks before contacting other hosts, for the JSON and for the image", async () => {
  const ac = new AbortController();
  let calls = 0;
  const imgElsewhere = async () => {
    calls++;
    return new Response(JSON.stringify({ image: "https://cdn.example/i.png" }), { status: 200 });
  };
  assert.deepEqual(await resolvePicture("https://meta.example/1.json", new Set(), ac.signal, imgElsewhere), { status: "ask", host: "meta.example" });
  assert.equal(calls, 0);
  assert.deepEqual(await resolvePicture("https://67.x1ins.xyz/content/67", new Set(), ac.signal, imgElsewhere), { status: "ask", host: "cdn.example" });
  assert.deepEqual(await resolvePicture("https://67.x1ins.xyz/content/67", new Set(["cdn.example"]), ac.signal, imgElsewhere), {
    status: "ok",
    image: "https://cdn.example/i.png",
    animationUrl: undefined,
  });
  assert.deepEqual(await resolvePicture(undefined, new Set(), ac.signal, imgElsewhere), { status: "none" });
  assert.deepEqual(await resolvePicture("ar://x", new Set(), ac.signal, imgElsewhere), { status: "none" });
  const broken = async () => new Response("{", { status: 200 });
  assert.deepEqual(await resolvePicture("https://67.x1ins.xyz/content/67", new Set(), ac.signal, broken), { status: "error" });
});

const k = () => Keypair.generate().publicKey;
const quote: MintMeta = { address: k(), decimals: 9, tokenProgram: TOKEN_PROGRAM_ID, transferFee: undefined };
const target: MintMeta = { address: k(), decimals: 9, tokenProgram: TOKEN_PROGRAM_ID, transferFee: undefined };
const vaults = [
  { mint: quote, vault: k(), balance: 9_800_000_000n },
  { mint: target, vault: k(), balance: 1_000_000_000n },
];
const view = { quote, vaults, fund: k(), account: { quoteMint: quote.address, nftMint: k() } } as unknown as FundView;
const valuation = valueHoldings({
  quote,
  vaults,
  pools: { [target.address.toBase58()]: { side0: { mint: quote.address, reserve: 600n }, side1: { mint: target.address, reserve: 1_000n } } },
});
const labels = { [quote.address.toBase58()]: { symbol: "WXNT" }, [target.address.toBase58()]: { symbol: "Test" } } as never;
const stored = { name: "X1-FUND", symbol: "XF", uri: "https://67.x1ins.xyz/content/67" } as StoredMetadata;

test("card with a picture: <img> with no referrer, name, tokens inside, total", () => {
  const html = renderToString(
    <NftCardView
      stored={stored}
      picture={{ status: "ok", image: "https://www.x1inscriptions.io/api/ins/66?card=1&v=1", animationUrl: "https://www.x1inscriptions.io/v.mp4" }}
      onAllow={() => {}}
      holdings={{ status: "ok", valuation }}
      view={view}
      labels={labels}
    />,
  );
  assert.match(html, /<img[^>]+data-testid="nft-image"/);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
  assert.match(html, /src="https:\/\/www.x1inscriptions.io\/api\/ins\/66\?card=1&amp;v=1"/);
  assert.doesNotMatch(html, /<(iframe|object|embed|video)/);
  assert.match(html, /X1-FUND/);
  assert.match(html, /≈ 10.4 WXNT/);
  assert.match(html, /Test/);
  assert.match(html, /≈ <!-- -->0.6/);
  assert.match(html, /Open animation \(external link\)/);
});

test("card placeholder: no metadata, failure, and a host that needs a click", () => {
  const none = renderToString(
    <NftCardView stored={undefined} picture={{ status: "none" }} onAllow={() => {}} holdings={{ status: "error" }} view={view} labels={labels} />,
  );
  assert.match(none, /data-testid="nft-placeholder"/);
  assert.doesNotMatch(none, /<img/);
  assert.match(none, /Unnamed fund/);
  assert.match(none, /value unknown/);
  const ask = renderToString(<NftPicture picture={{ status: "ask", host: "meta.example" }} name="My fund" onAllow={() => {}} />);
  assert.match(ask, /Load picture \(contacts meta.example\)/);
  assert.match(ask, /MF/);
  const err = renderToString(<NftPicture picture={{ status: "error" }} name="My fund" onAllow={() => {}} />);
  assert.match(err, /nft-placeholder/);
  assert.doesNotMatch(err, /<img/);
});
