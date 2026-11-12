/**
 * Full owner flow in a real browser against scripts/local-validator.sh, with
 * the localnet-only test wallet. Then switch to X1 mainnet (read-only: genesis
 * hash, mint/pool reads, program lookup) and check that the test wallet is
 * gone and a simulate-only create stops at "program not deployed". Nothing is
 * signed or sent on mainnet.
 */
import { expect, test, type Page } from "@playwright/test";
import { connectTo, fillWizard, fundWallet, POOL, shot, signAndSend, USDC } from "./helpers";

async function budgets(page: Page): Promise<string[]> {
  await page.getByTestId("refresh").click();
  await expect(page.getByTestId("refresh")).toHaveText("Refresh");
  return [
    (await page.getByTestId("budget-0").getAttribute("data-raw")) ?? "",
    (await page.getByTestId("budget-1").getAttribute("data-raw")) ?? "",
  ];
}

test("smoke: loads at phone width in light and dark mode without horizontal scroll", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    await connectTo(page, "local");
    await page.getByTestId("use-test-wallet").click();
    for (const tab of ["My funds", "Create fund", "Settings"]) {
      await page.getByRole("button", { name: tab, exact: true }).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${tab} (${colorScheme})`).toBeLessThanOrEqual(0);
      if (process.env.SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${colorScheme}-${tab.replace(" ", "-")}.png`, fullPage: true });
      }
    }
  }
  expect(errors).toEqual([]);
});

test("owner flow on a local validator, then mainnet is read-only and the test wallet is gone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // No request may leave the machine except the X1 mainnet RPC used at the end.
  const external: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "rpc.mainnet.x1.xyz") external.push(r.url());
  });

  if (process.env.E2E_PHONE) await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/");
  await connectTo(page, "local");

  // Connect the in-memory test wallet and fund it via the script.
  await page.getByTestId("use-test-wallet").click();
  const pubkey = (await page.getByTestId("signer-pubkey").textContent())!.trim();
  expect(pubkey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  expect(await fundWallet(pubkey)).toContain("+1000 USDC.X");

  // Empty state, then the first-run card can be dismissed.
  await expect(page.getByTestId("create-first")).toBeVisible();
  await expect(page.getByTestId("how-it-works")).toBeVisible();
  await page.getByTestId("dismiss-how").click();
  await expect(page.getByTestId("how-it-works")).toHaveCount(0);

  // Create a fund with the wizard: paste USDC.X, paste TEST (the pool is
  // found on chain), 80% TEST so 20% is kept as cash, 0.1 per buy hourly.
  await fillWizard(page);
  await expect(page.getByTestId("fit")).toContainText("Up to 5 tokens to buy");
  await expect(page.getByTestId("quote-input").getByTestId("mint-balance")).toHaveText("1000");
  await expect(page.getByTestId("target-0-pool").getByTestId("pool-depth")).toContainText("deep enough");
  await expect(page.getByTestId("per-round")).toContainText("Every 1 hour the fund spends 0.08 USDC.X on Test");
  await expect(page.getByTestId("projection")).toContainText("it lasts about 4 days (100 buys");
  // Plain messages for a bad target and the bounds.
  await page.getByRole("button", { name: "Add another token" }).click();
  await page.getByLabel("Token 2 to buy", { exact: true }).fill(USDC);
  await expect(page.getByTestId("target-row").nth(1).getByTestId("target-error")).toContainText("same token you pay with");
  await page.getByLabel("Token 2 to buy", { exact: true }).fill(pubkey);
  await expect(page.getByTestId("target-row").nth(1).getByTestId("mint-error")).toContainText("this is a wallet address, not a token mint");
  await page.getByRole("button", { name: "Remove token 2" }).click();
  await page.getByText("5. Advanced").click();
  await page.getByLabel("Max deviation", { exact: true }).fill("501");
  await expect(page.getByTestId("create-invalid")).toContainText("cannot exceed 500");
  await page.getByLabel("Max deviation", { exact: true }).fill("300");
  await page.getByLabel("TWAP window", { exact: true }).fill("3600");
  // The NFT: name, a plain image link (never loaded by the app), option (c) an existing metadata link.
  await page.getByLabel("NFT name").fill("Wizard Fund");
  await page.getByLabel("NFT symbol").fill("WFUND");
  await page.getByLabel("Image URL").fill("https://example.invalid/fund.png");
  await page.getByLabel("Paste a metadata link").check();
  await page.getByLabel("Metadata URI").fill("https://example.invalid/fund-v1.json");
  await expect(page.getByTestId("art-ready")).toContainText("https://example.invalid/fund-v1.json");
  await expect(page.getByTestId("json-bytes")).toContainText("bytes (limit 600)");
  await page.getByTestId("create-review").click();
  await expect(page.getByTestId("sim")).toHaveCount(3);
  await expect(page.getByTestId("review-sentences")).toContainText("Every 1 hour this fund spends 0.08 USDC.X on Test.");
  await expect(page.getByTestId("review-sentences")).toContainText("You receive an NFT that owns this fund");
  await expect(page.getByTestId("review-sentences")).toContainText("about 0.016 XNT; the program refuses more than 0.03 XNT");
  await expect(page.getByTestId("sim-skipped")).toHaveCount(1);
  await shot(page, "flow-create-review");
  await signAndSend(page);
  const fund = (await page.getByTestId("created-fund").first().textContent())!.trim();
  const nft = (await page.getByTestId("created-nft").first().textContent())!.trim();
  expect(fund).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  await expect(page.getByTestId("send-record").first().getByTestId("send-ok")).toContainText("All 3 transaction(s) confirmed.");

  // My funds lists it with the NFT's metadata.
  await page.getByRole("button", { name: "My funds" }).click();
  await expect(page.getByTestId("my-funds")).toContainText(fund);
  const item = page.getByTestId("fund-item").filter({ hasText: fund });
  await expect(item.getByTestId("fund-name")).toHaveText("Wizard Fund (WFUND)");
  await expect(item.getByTestId("fund-uri")).toHaveText("https://example.invalid/fund-v1.json");
  await expect(item).toContainText("pays with USDC.X, buys Test 80%, keeps 20% as cash");
  await page.getByTestId("fund-link").filter({ hasText: fund }).click();
  await expect(page.getByTestId("fund-detail")).toContainText(nft);
  await expect(page.getByTestId("nft-holder")).toContainText(pubkey);
  await expect(page.getByTestId("fund-summary")).toContainText("Every 1 hour it spends 0.08 USDC.X on Test and keeps 20% of deposits as cash");
  await expect(page.getByTestId("next-1")).toContainText("Test: nothing left to spend");

  // Set image / edit metadata: change only the link (holder only).
  await expect(page.getByTestId("current-metadata")).toContainText("Wizard Fund");
  await page.getByTestId("edit-metadata").click();
  await page.getByLabel("Metadata link").fill("https://example.invalid/fund-v2.json");
  await page.getByTestId("metadata-review").click();
  await expect(page.getByTestId("review-sentences")).toContainText("This changes the fund NFT's metadata link");
  await signAndSend(page);
  await expect(page.getByTestId("current-metadata")).toContainText("https://example.invalid/fund-v2.json");
  await page.getByTestId("close-review").click();

  // Deposit 1 USDC.X and check the budgets: 0.2 cash, 0.8 TEST.
  await page.getByLabel("Deposit amount").fill("1");
  await page.getByTestId("deposit-review").click();
  await signAndSend(page);
  // Dismissing the receipt (without navigating) must not make this review
  // sendable again: a retry needs a freshly built and simulated review.
  await page.getByTestId("send-record").first().getByTestId("dismiss-send").click();
  await expect(page.getByTestId("send-record").filter({ hasText: "Deposit" })).toHaveCount(0);
  await expect(page.getByTestId("review")).toBeVisible();
  await expect(page.getByTestId("review").getByTestId("sign-and-send")).toHaveCount(0);
  await expect(page.getByTestId("review-used")).toBeVisible();
  expect(await budgets(page)).toEqual(["200000", "800000"]);
  await shot(page, "flow-fund-after-deposit");
  await expect(page.getByTestId(`vault-${USDC}`).getByTestId("vault-balance")).toHaveAttribute("data-raw", "1000000");
  await expect(page.getByTestId("keeper-due")).toContainText("target 1");
  await expect(page.getByTestId("keeper-cmd")).toContainText("npx tsx src/index.ts --dry-run");

  // Withdraw part of the quote: 0.1 USDC.X; budgets shrink in proportion.
  await page.getByLabel("Withdraw mint").selectOption(USDC);
  await page.getByLabel("Withdraw amount").fill("0.1");
  await page.getByTestId("withdraw-review").click();
  await signAndSend(page);
  expect(await budgets(page)).toEqual(["180000", "720000"]);
  await expect(page.getByTestId(`vault-${USDC}`).getByTestId("vault-balance")).toHaveAttribute("data-raw", "900000");

  // Ensure vaults: every vault exists, nothing to do, no send button.
  await page.getByTestId("ensure-vaults").click();
  await expect(page.getByTestId("nothing-to-do")).toBeVisible();
  await expect(page.getByTestId("sign-and-send")).toHaveCount(0);

  // A pending send locks the context: the test wallet keeps its "prompt"
  // open for 4 s. Network, navigation, closing the review, new reviews and
  // discarding the signer are all blocked until it settles.
  await page.evaluate(() => {
    (window as unknown as { __FUND_NFT_TEST_WALLET_DELAY_MS: number }).__FUND_NFT_TEST_WALLET_DELAY_MS = 4000;
  });
  await page.getByLabel("Deposit amount").fill("0.5");
  await page.getByTestId("deposit-review").click();
  await expect(page.getByTestId("review").getByTestId("sim-status")).toHaveText("simulation ok");
  await page.getByTestId("review").getByTestId("sign-and-send").click();
  const pending = page.getByTestId("send-record").first();
  await expect(pending).toHaveAttribute("data-status", "pending");
  await expect(page.getByTestId("send-lock")).toBeVisible();
  await expect(page.getByLabel("Network")).toBeDisabled();
  await expect(page.getByLabel("Local port")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Connect" })).toBeDisabled();
  for (const tab of ["My funds", "Create fund", "Settings"]) {
    await expect(page.getByRole("button", { name: tab, exact: true })).toBeDisabled();
  }
  await expect(page.getByTestId("close-review")).toBeDisabled();
  await expect(page.getByTestId("ensure-vaults")).toBeDisabled();
  await expect(page.getByTestId("deposit-review")).toBeDisabled();
  await expect(page.getByTestId("drop-test-wallet")).toBeDisabled();
  await expect(page.getByTestId("dismiss-send")).toHaveCount(3, { timeout: 1000 }); // create, set metadata, withdraw (deposit was dismissed); not the pending one
  await expect(pending).toHaveAttribute("data-status", "done");
  await page.evaluate(() => {
    (window as unknown as { __FUND_NFT_TEST_WALLET_DELAY_MS: number }).__FUND_NFT_TEST_WALLET_DELAY_MS = 0;
  });
  expect(await budgets(page)).toEqual(["280000", "1120000"]);
  // The receipt survives navigation and stays until dismissed.
  await page.getByRole("button", { name: "Create fund", exact: true }).click();
  await page.getByRole("button", { name: "My funds", exact: true }).click();
  await expect(page.getByTestId("send-record").first()).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("send-record").first()).toContainText("Deposit");
  const before = await page.getByTestId("send-record").count();
  await page.getByTestId("send-record").first().getByTestId("dismiss-send").click();
  await expect(page.getByTestId("send-record")).toHaveCount(before - 1);

  // Switch to X1 mainnet: the test wallet disappears with no way back.
  await connectTo(page, "mainnet");
  await expect(page.getByTestId("use-test-wallet")).toHaveCount(0);
  await expect(page.getByTestId("signer")).toContainText("No signer connected");
  await expect(page.getByText("I understand this is X1 mainnet and uses real funds")).toBeVisible();

  // Simulate-only create on mainnet stops at "program not deployed".
  await page.getByRole("button", { name: "Create fund" }).click();
  await page.getByRole("button", { name: /fill example/ }).click();
  await expect(page.getByTestId("fit")).toBeVisible();
  // The pool is found on mainnet from chain data (read-only getProgramAccounts).
  await expect(page.getByTestId("target-0-pool").getByTestId("pool-address")).toHaveText(POOL);
  await page.getByLabel("Simulation payer").fill(pubkey);
  await page.getByTestId("create-review").click();
  await expect(page.getByTestId("create-error")).toContainText("The fund program is not deployed on this network yet");
  await expect(page.getByTestId("create-error")).toContainText(
    "program 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM is not deployed on this RPC (https://rpc.mainnet.x1.xyz, mainnet)",
  );
  await expect(page.getByTestId("review")).toHaveCount(0);
  await shot(page, "flow-mainnet-create");
  // The friendly error's action switches to the local validator.
  await page.getByTestId("error-action").filter({ hasText: "Switch to Local validator to try it" }).click();
  await expect(page.getByTestId("cluster-banner")).toHaveAttribute("data-cluster", "localnet");

  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

/**
 * On-chain art and an inscribed metadata JSON, on the local validator, which
 * clones X1 Inscriptions, Metaplex Core, the inscription config accounts and
 * inscription #63 (scripts/local-validator.sh). The two inscription hosts are
 * answered by page.route, so nothing leaves the machine; the test checks
 * they are contacted only after the explicit Check click.
 */
test("NFT art from inscription #63 (Check), JSON inscribed on localnet, then create with it", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let checked = false;
  const early: string[] = [];
  const disallowed: string[] = [];
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    // The app connects to its default RPC (X1 mainnet) on load, before the test picks the local one.
    if (host === "127.0.0.1" || host === "localhost" || host === "rpc.mainnet.x1.xyz") return;
    if (host === "www.x1inscriptions.io" || host === "63.x1ins.xyz") {
      if (!checked) early.push(r.url());
      return;
    }
    disallowed.push(r.url());
  });
  const cors = { "access-control-allow-origin": "*" };
  await page.route("https://www.x1inscriptions.io/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("/api/nft/ins/63.json")) {
      return route.fulfill({
        headers: cors,
        contentType: "application/json",
        body: JSON.stringify({ animation_url: "https://63.x1ins.xyz/content/63", properties: { files: [{ uri: "https://63.x1ins.xyz/content/63", type: "video/mp4" }] } }),
      });
    }
    // The card image: a 1x1 GIF.
    return route.fulfill({ headers: cors, contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAAAAACw=", "base64") });
  });
  await page.route("https://63.x1ins.xyz/**", (route) => route.fulfill({ headers: { ...cors, "content-length": "393222" }, contentType: "video/mp4", body: "" }));

  await page.goto("/");
  await connectTo(page, "local");
  await page.getByTestId("use-test-wallet").click();
  const pubkey = (await page.getByTestId("signer-pubkey").textContent())!.trim();
  expect(await fundWallet(pubkey)).toContain("+1000 USDC.X");
  await fillWizard(page);
  await page.getByLabel("NFT name").fill("Merchant Fund");
  await page.getByLabel("NFT symbol").fill("MFUND");
  await page.getByLabel("NFT description").fill("Buys TEST every hour.");
  await page.getByLabel("Art from an X1 inscription").check();
  await page.getByLabel("Inscription", { exact: true }).fill("https://www.x1inscriptions.io/i/63");
  await page.waitForTimeout(500);
  expect(early).toEqual([]);
  checked = true;
  await page.getByTestId("check-inscription").click();
  const result = page.getByTestId("inscription-check");
  await expect(result).toContainText("#63: video/mp4, 393222 bytes on chain");
  await expect(page.getByTestId("card-preview")).toHaveAttribute("src", "https://www.x1inscriptions.io/api/ins/63?card=1&v=1");
  await expect(page.getByTestId("video-preview")).toHaveAttribute("src", "https://63.x1ins.xyz/content/63");
  await expect(page.getByTestId("gateway-warning")).toHaveCount(0);
  // "Only allow inscriptions I own": the test wallet does not own #63.
  await page.getByLabel("Only allow inscriptions I own").check();
  await expect(page.getByTestId("json-pending")).toContainText("not your wallet");
  await page.getByLabel("Only allow inscriptions I own").uncheck();
  await expect(page.getByTestId("json-preview")).toContainText('"image":"https://www.x1inscriptions.io/api/ins/63?card=1&v=1"');
  await expect(page.getByTestId("json-preview")).toContainText('"animation_url":"https://63.x1ins.xyz/content/63"');
  const bytes = Number(/(\d+) bytes/.exec((await page.getByTestId("json-bytes").textContent())!)![1]);
  expect(bytes).toBeLessThanOrEqual(600);

  // (a) Inscribe on X1: live fee, prediction, the wallet warning, its own reviewed plan.
  await page.getByLabel("Inscribe on X1").check();
  await expect(page.getByTestId("inscribe-wallet-warning")).toContainText("access to this wallet's whole XNT balance");
  await expect(page.getByTestId("inscribe-fee")).toContainText("Live inscription fee:");
  await expect(page.getByTestId("inscribe-estimate")).toContainText("1 transaction");
  await expect(page.getByTestId("inscribe-estimate")).toContainText(".x1ins.xyz/content/");
  await page.getByTestId("inscribe-review").click();
  const insReview = page.getByTestId("review").filter({ hasText: "Review: Inscribe metadata" });
  await expect(insReview.getByTestId("sim-status")).toHaveText("simulation ok");
  await expect(insReview.getByTestId("review-sentences")).toContainText("third-party, upgradeable program");
  await insReview.getByTestId("sign-and-send").click();
  await expect(page.getByTestId("send-record").first()).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("inscribe-verified")).toContainText("holds exactly this JSON");
  const uri = (await page.getByTestId("inscribed-uri").textContent())!.trim();
  expect(uri).toMatch(/^https:\/\/(\d+)\.x1ins\.xyz\/content\/\1$/);
  await insReview.getByTestId("close-review").click();
  await expect(page.getByTestId("art-ready")).toContainText(uri);

  // Create with that uri: create, attach_metadata, target vaults.
  await page.getByTestId("create-review").click();
  await expect(page.getByTestId("sim")).toHaveCount(3);
  await signAndSend(page);
  const fund = (await page.getByTestId("created-fund").first().textContent())!.trim();
  await page.getByRole("button", { name: "My funds" }).click();
  const item = page.getByTestId("fund-item").filter({ hasText: fund });
  await expect(item.getByTestId("fund-name")).toHaveText("Merchant Fund (MFUND)");
  await expect(item.getByTestId("fund-uri")).toHaveText(uri);

  expect(errors).toEqual([]);
  expect(disallowed).toEqual([]);
});

test("an inscription upload cut off mid-way: Resume offered, then disabled with an explanation after a reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Let the first sendTransaction through and drop the second one in the
  // browser, so its status is unknown (it never reaches the validator).
  let sends = 0;
  await page.route(/^http:\/\/127\.0\.0\.1:\d+\/?$/, async (route) => {
    const body = route.request().postData() ?? "";
    if (route.request().method() === "POST" && body.includes('"sendTransaction"') && ++sends === 2) return route.abort("connectionreset");
    return route.continue();
  });

  await page.goto("/");
  await connectTo(page, "local");
  await page.getByTestId("use-test-wallet").click();
  const pubkey = (await page.getByTestId("signer-pubkey").textContent())!.trim();
  expect(await fundWallet(pubkey)).toContain("+1000 USDC.X");
  await fillWizard(page);
  await page.getByLabel("NFT name").fill("Resume Fund");
  await page.getByLabel("NFT symbol").fill("RFUND");
  await page.getByLabel("NFT description").fill("A description long enough that the JSON needs two inscription transactions. ".repeat(8));
  await page.getByLabel("Image URL").fill("https://example.com/fund.png");
  await page.getByLabel("Compact JSON").uncheck();
  await page.getByLabel("Inscribe on X1").check();
  await expect(page.getByTestId("inscribe-estimate")).toContainText("2 transactions");
  await page.getByTestId("inscribe-review").click();
  const insReview = page.getByTestId("review").filter({ hasText: "Review: Inscribe metadata" });
  await expect(insReview.getByTestId("sim-status").first()).toHaveText("simulation ok");
  await insReview.getByTestId("sign-and-send").click();
  const rec = page.getByTestId("send-record").first();
  await expect(rec).toHaveAttribute("data-status", "failed");
  await expect(rec.getByTestId("send-failed")).toContainText("status is unknown");
  // In this page the registry holds both transactions: Resume is offered.
  await expect(page.getByTestId("inscribe-resume")).toBeVisible();
  await expect(page.getByTestId("inscribe-resume-section")).toContainText("2 earlier transactions");

  // After a reload the history is gone: Resume is disabled and says what to do.
  await page.reload();
  await connectTo(page, "local");
  await page.getByTestId("use-test-wallet").click();
  await page.getByRole("button", { name: "Create fund", exact: true }).click();
  const blocked = page.getByTestId("resume-blocked");
  await expect(blocked).toBeVisible();
  await expect(blocked.getByTestId("inscribe-resume-disabled")).toBeDisabled();
  await expect(blocked).toContainText("before the page was reloaded");
  await expect(blocked).toContainText("wait until every earlier transaction of this upload has confirmed or expired");
  await expect(blocked).toContainText("start a fresh inscription");
  await expect(page.getByTestId("inscribe-resume")).toHaveCount(0);
  // Hiding the note never enables a resume.
  await blocked.getByTestId("forget-resume-note").click();
  await expect(page.getByTestId("resume-blocked")).toHaveCount(0);
  await expect(page.getByTestId("inscribe-resume")).toHaveCount(0);
  expect(errors).toEqual([]);
});
