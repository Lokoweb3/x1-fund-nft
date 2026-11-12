/**
 * In a real Chromium: an approved picture host that answers with a
 * redirect is NOT followed (the redirect target records no request), for
 * the image and for the metadata JSON, and the result is "error", which
 * the card renders as the generated placeholder. A direct image on the
 * same approved host still loads (control).
 *
 * Everything is on loopback. Needs a Playwright chromium:
 *   PLAYWRIGHT_BROWSERS_PATH=/abs/pw npm run test:browser
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import { transformWithEsbuild } from "vite";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; origin: string; host: string }> {
  const server = createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
    }),
  );
}

let browser: Browser | undefined;
let skip = "";
const servers: Server[] = [];
let page: { origin: string };
let pics: { origin: string; host: string };
let target: { origin: string };
const targetHits: string[] = [];

before(async () => {
  try {
    browser = await chromium.launch();
  } catch (err) {
    skip = `no Playwright chromium (${String(err).split("\n")[0]})`;
    return;
  }
  const src = readFileSync(fileURLToPath(new URL("../src/lib/nft_picture.ts", import.meta.url)), "utf8");
  const js = (await transformWithEsbuild(src, "nft_picture.ts", { format: "esm", target: "es2022" })).code;
  // The redirect target: must never be contacted.
  const t = await serve((req, res) => {
    targetHits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "image/png", "access-control-allow-origin": "*" }).end(PNG);
  });
  target = t;
  // The approved picture host.
  const p = await serve((req, res) => {
    const cors = { "access-control-allow-origin": "*" };
    const u = req.url ?? "";
    if (u === "/meta-redirect-image.json") return res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ image: `${pics.origin}/redirect.png` }));
    if (u === "/meta-direct.json") return res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ image: `${pics.origin}/direct.png` }));
    if (u === "/meta-redirect.json") return res.writeHead(302, { ...cors, location: `${target.origin}/meta.json` }).end();
    if (u === "/redirect.png") return res.writeHead(302, { ...cors, location: `${target.origin}/unapproved-pixel.png` }).end();
    if (u === "/direct.png") return res.writeHead(200, { ...cors, "content-type": "image/png" }).end(PNG);
    res.writeHead(404, cors).end();
  });
  pics = p;
  const app = await serve((req, res) => {
    if (req.url === "/nft_picture.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(js);
    res
      .writeHead(200, { "content-type": "text/html" })
      .end('<!doctype html><script type="module">import * as P from "/nft_picture.js"; window.P = P; window.ready = true;</script>');
  });
  page = app;
  servers.push(t.server, p.server, app.server);
});

after(async () => {
  await browser?.close();
  for (const s of servers) s.close();
});

async function resolveIn(uri: string): Promise<{ status: string; size?: number; type?: string }> {
  const ctx = await browser!.newContext();
  const tab = await ctx.newPage();
  await tab.goto(`${page.origin}/`);
  await tab.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true);
  const r = await tab.evaluate(
    async ([u, host]) => {
      const P = (window as unknown as { P: { resolvePicture: (u: string, a: Set<string>, s: AbortSignal) => Promise<{ status: string; blob?: Blob }> } }).P;
      const out = await P.resolvePicture(u, new Set([host]), new AbortController().signal);
      return { status: out.status, size: out.blob?.size, type: out.blob?.type };
    },
    [uri, pics.host] as const,
  );
  await ctx.close();
  return r;
}

test("an approved image URL that redirects is not followed: the target sees no request, the result is the placeholder", async (t) => {
  if (skip) return t.skip(skip);
  targetHits.length = 0;
  assert.deepEqual(await resolveIn(`${pics.origin}/meta-redirect-image.json`), { status: "error", size: undefined, type: undefined });
  assert.deepEqual(targetHits, []);
});

test("an approved metadata URL that redirects is not followed either", async (t) => {
  if (skip) return t.skip(skip);
  targetHits.length = 0;
  assert.equal((await resolveIn(`${pics.origin}/meta-redirect.json`)).status, "error");
  assert.deepEqual(targetHits, []);
});

test("control: a direct image on the approved host loads as a PNG blob", async (t) => {
  if (skip) return t.skip(skip);
  targetHits.length = 0;
  assert.deepEqual(await resolveIn(`${pics.origin}/meta-direct.json`), { status: "ok", size: PNG.length, type: "image/png" });
  assert.deepEqual(targetHits, []);
});
