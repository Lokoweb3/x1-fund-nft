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
import {
  checkImageType,
  fetchImageBlob,
  fetchNftJson,
  isAutoFetchUrl,
  mayFetch,
  NFT_IMAGE_MAX_BYTES,
  NFT_JSON_MAX_BYTES,
  parseNftJson,
  resolvePicture,
} from "../src/lib/nft_picture.js";
import { NftCardView, NftPicture, NftThumb, PictureConsent } from "../src/components/NftCard.js";
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

const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200, headers: { "content-type": "image/png" } });

test("image fetch: same hardened options, raster image/* only, 2 MB cap enforced while streaming, body cancelled on rejection", async () => {
  const ac = new AbortController();
  let seen: RequestInit | undefined;
  const blob = await fetchImageBlob("https://www.x1inscriptions.io/api/ins/66", ac.signal, async (_u, init) => {
    seen = init;
    return png();
  });
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, 4);
  assert.equal(seen?.credentials, "omit");
  assert.equal(seen?.referrerPolicy, "no-referrer");
  assert.equal(seen?.mode, "cors");
  assert.equal(seen?.redirect, "error");
  for (const t of ["image/png", "image/jpeg; charset=binary", "IMAGE/GIF", "image/webp", "image/avif"]) assert.doesNotThrow(() => checkImageType(t), t);
  for (const t of ["image/svg+xml", "text/html", "application/json", "", null, "image/", "image/png, text/html"]) assert.throws(() => checkImageType(t), Error, String(t));

  // Rejected content type: the body is cancelled, not read.
  let cancelled = false;
  const html = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(1024)), cancel: () => void (cancelled = true) });
  await assert.rejects(fetchImageBlob("https://x/i", ac.signal, async () => new Response(html, { headers: { "content-type": "text/html" } })), /not a raster image/);
  assert.equal(cancelled, true);

  // Declared too large: rejected before reading.
  await assert.rejects(
    fetchImageBlob("https://x/i", ac.signal, async () => new Response("x", { headers: { "content-type": "image/png", "content-length": String(NFT_IMAGE_MAX_BYTES + 1) } })),
    /too large/,
  );
  // Undeclared but endless: stopped past the cap while streaming, and cancelled.
  let sent = 0;
  let stopped = false;
  const endless = new ReadableStream<Uint8Array>({
    pull: (c) => {
      sent += 65536;
      c.enqueue(new Uint8Array(65536));
    },
    cancel: () => void (stopped = true),
  });
  await assert.rejects(fetchImageBlob("https://x/i", ac.signal, async () => new Response(endless, { headers: { "content-type": "image/png" } })), /too large/);
  assert.equal(stopped, true);
  assert.ok(sent <= NFT_IMAGE_MAX_BYTES + 2 * 65536);
  // A response that says it was redirected is refused.
  const redirected = png();
  Object.defineProperty(redirected, "redirected", { value: true });
  await assert.rejects(fetchImageBlob("https://x/i", ac.signal, async () => redirected), /redirect/);
});

test("resolvePicture asks before contacting other hosts, for the JSON and for the image; fetches the image bytes itself", async () => {
  const ac = new AbortController();
  const urls: string[] = [];
  const routes = async (u: string) => {
    urls.push(u);
    if (u.endsWith(".json") || u.includes("/content/")) return new Response(JSON.stringify({ image: "https://cdn.example/i.png" }), { status: 200 });
    if (u === "https://cdn.example/i.png") return png();
    return new Response("no", { status: 404 });
  };
  assert.deepEqual(await resolvePicture("https://meta.example/1.json", new Set(), ac.signal, routes), { status: "ask", host: "meta.example" });
  assert.deepEqual(urls, []);
  assert.deepEqual(await resolvePicture("https://67.x1ins.xyz/content/67", new Set(), ac.signal, routes), { status: "ask", host: "cdn.example" });
  assert.deepEqual(urls, ["https://67.x1ins.xyz/content/67"]);
  const ok = await resolvePicture("https://67.x1ins.xyz/content/67", new Set(["cdn.example"]), ac.signal, routes);
  assert.equal(ok.status, "ok");
  assert.ok(ok.status === "ok" && ok.blob.type === "image/png" && ok.source === "https://cdn.example/i.png");
  assert.deepEqual(await resolvePicture(undefined, new Set(), ac.signal, routes), { status: "none" });
  assert.deepEqual(await resolvePicture("ar://x", new Set(), ac.signal, routes), { status: "none" });
  const broken = async () => new Response("{", { status: 200 });
  assert.deepEqual(await resolvePicture("https://67.x1ins.xyz/content/67", new Set(), ac.signal, broken), { status: "error" });
  // The image is not an image: placeholder (error), never a broken <img>.
  const svg = async (u: string) =>
    u.includes("/content/")
      ? new Response(JSON.stringify({ image: "https://www.x1inscriptions.io/a.svg" }))
      : new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
  assert.deepEqual(await resolvePicture("https://67.x1ins.xyz/content/67", new Set(), ac.signal, svg), { status: "error" });
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
      picture={{ status: "ok", src: "blob:http://127.0.0.1/abc", source: "https://www.x1inscriptions.io/api/ins/66?card=1&v=1", animationUrl: "https://www.x1inscriptions.io/v.mp4" }}
      onAllow={() => {}}
      holdings={{ status: "ok", valuation }}
      view={view}
      labels={labels}
    />,
  );
  assert.match(html, /<img[^>]+data-testid="nft-image"/);
  // Only a local blob: URL reaches <img>; the remote URL is just a tooltip.
  assert.match(html, /src="blob:http:\/\/127.0.0.1\/abc"/);
  assert.doesNotMatch(html, /src="https?:/);
  assert.doesNotMatch(html, /<(iframe|object|embed|video)/);
  assert.match(html, /X1-FUND/);
  assert.match(html, /≈ 10.40 WXNT/);
  assert.match(html, /data-testid="nft-allocation"/);
  assert.match(html, /WXNT<!-- --> <strong>94%<\/strong>/);
  assert.match(html, /Test<!-- --> <strong>6%<\/strong>/);
  assert.doesNotMatch(html, /0.6000|9.80/); // no raw amounts or per-token values in the card
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

test("list consent names the host it authorizes; the compact thumbnail has no host-less button", () => {
  const thumb = renderToString(<NftThumb picture={{ status: "ask", host: "meta.example" }} name="My fund" />);
  assert.doesNotMatch(thumb, /<button/);
  assert.match(thumb, /data-testid="nft-placeholder"/);
  const consent = renderToString(<PictureConsent picture={{ status: "ask", host: "meta.example" }} onAllow={() => {}} />);
  assert.match(consent, />Load picture \(contacts meta.example\)<\/button>/);
  assert.match(consent, /aria-label="Load picture \(contacts meta.example\)"/);
  assert.match(consent, /title="Load picture \(contacts meta.example\)"/);
  assert.equal(renderToString(<PictureConsent picture={{ status: "loading" }} onAllow={() => {}} />), "");
});
