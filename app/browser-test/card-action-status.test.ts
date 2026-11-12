/**
 * In a real Chromium, the mounted FundDetail: a card action's progress and
 * error show only inside that action's own panel. Switching to another
 * action while a build is pending, or after it failed, moves the status
 * under Actions (labelled with its action), never into the other panel,
 * and it renders exactly once.
 *
 * The page is a Vite bundle of browser-test/fixtures/fund-detail-harness.tsx
 * with @core/rpc.js and src/lib/actions replaced by fixtures for FundDetail
 * and NftCard; review builds are promises the test settles. Loopback only.
 *   PLAYWRIGHT_BROWSERS_PATH=/abs/pw npm run test:browser
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { build, type Plugin } from "vite";

const APP = fileURLToPath(new URL("..", import.meta.url));
const FIX = join(APP, "browser-test", "fixtures");

/** Swap rpc and actions for the fixtures, only where FundDetail and NftCard import them. */
function harnessMocks(): Plugin {
  return {
    name: "fund-detail-harness-mocks",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !/src[\\/]components[\\/](FundDetail|NftCard)\.tsx$/.test(importer)) return null;
      if (source === "@core/rpc.js" || /keeper[\\/]src[\\/]core[\\/]rpc\.js$/.test(source)) return join(FIX, "mock-rpc.ts");
      if (source === "../lib/actions") return join(FIX, "mock-actions.ts");
      return null;
    },
  };
}

let browser: Browser | undefined;
let skip = "";
let out = "";
let server: Server | undefined;
let origin = "";

before(async () => {
  try {
    browser = await chromium.launch();
  } catch (err) {
    skip = `no Playwright chromium (${String(err).split("\n")[0]})`;
    return;
  }
  out = mkdtempSync(join(tmpdir(), "fund-detail-harness-"));
  await build({
    configFile: join(APP, "vite.config.ts"),
    root: APP,
    base: "./",
    logLevel: "silent",
    plugins: [harnessMocks()],
    build: { outDir: out, emptyOutDir: true, minify: false, rollupOptions: { input: join(FIX, "fund-detail.html") } },
  });
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  server = createServer((req, res) => {
    const path = normalize(join(out, decodeURIComponent((req.url ?? "/").split("?")[0]!)));
    if (!path.startsWith(out + sep)) return res.writeHead(403).end();
    try {
      res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await browser?.close();
  server?.close();
  if (out) rmSync(out, { recursive: true, force: true });
});

const panel = (p: Page) => p.getByTestId("card-action-panel");
const actions = (p: Page) => p.locator("section.actions");

async function open(p: Page, a: "deposit" | "withdraw" | "native") {
  await p.getByTestId(`card-action-${a}`).click();
  await p.locator(`[data-testid="card-action-panel"][data-action="${a}"]`).waitFor();
}

test("a deposit's status never shows in another action's panel: switch during the build, then after the error", async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser!.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${origin}/browser-test/fixtures/fund-detail.html`);

  // Start a deposit review; the build stays pending.
  await open(page, "deposit");
  await page.getByLabel("Deposit amount").fill("1");
  await page.getByTestId("deposit-review").click();
  await panel(page).getByText("Building and simulating deposit...").waitFor();

  // Switch during the build: the progress line moves under Actions.
  await open(page, "withdraw");
  await actions(page).getByText("Building and simulating deposit...").waitFor();
  assert.equal(await panel(page).getByText(/Building and simulating/).count(), 0);
  assert.equal(await page.getByText(/Building and simulating/).count(), 1);

  // The late failure lands under Actions, labelled Deposit, not in the Withdraw panel.
  await page.evaluate(() => (window as unknown as { __builds: Record<string, Array<{ reject: (e: unknown) => void }>> }).__builds.deposit![0]!.reject(new Error("insufficient wallet funds")));
  await actions(page).getByTestId("action-error").waitFor();
  assert.equal(await page.getByTestId("action-error").count(), 1);
  assert.equal(await panel(page).getByTestId("action-error").count(), 0);
  assert.equal(await panel(page).getByText("insufficient wallet funds").count(), 0);
  assert.equal((await actions(page).getByTestId("action-error-for").textContent())?.trim(), "Deposit:");
  assert.match((await actions(page).getByTestId("action-error").textContent()) ?? "", /insufficient wallet funds/);

  // Back on Deposit, its own error shows in its panel (once, no label needed).
  await open(page, "deposit");
  await panel(page).getByTestId("action-error").waitFor();
  assert.equal(await page.getByTestId("action-error").count(), 1);
  assert.equal(await page.getByTestId("action-error-for").count(), 0);

  // Switch after the error: out of the Withdraw XNT panel, under Actions again.
  await open(page, "native");
  await actions(page).getByTestId("action-error").waitFor();
  assert.equal(await panel(page).getByTestId("action-error").count(), 0);
  assert.equal(await page.getByTestId("action-error").count(), 1);
  assert.equal((await actions(page).getByTestId("action-error-for").textContent())?.trim(), "Deposit:");

  // Closing the panel keeps it under Actions.
  await page.getByTestId("card-action-close").click();
  assert.equal(await panel(page).count(), 0);
  assert.equal(await actions(page).getByTestId("action-error").count(), 1);

  assert.deepEqual(errors, []);
  await page.close();
});
