/**
 * Full owner flow in a real browser against scripts/local-validator.sh, with
 * the localnet-only test wallet. Then switch to X1 mainnet (read-only: genesis
 * hash, mint/pool reads, program lookup) and check that the test wallet is
 * gone and a simulate-only create stops at "program not deployed". Nothing is
 * signed or sent on mainnet.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import { E2E_RPC_PORT } from "../playwright.config";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/local-validator.sh", import.meta.url));
const LOCAL_URL = `http://127.0.0.1:${E2E_RPC_PORT}`;
const USDC = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";
const TEST_MINT = "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz";
const POOL = "7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD";

/** scripts/local-validator.sh --fund-wallet, retried until the validator has written its state file. */
async function fundWallet(pubkey: string): Promise<string> {
  let last = "";
  for (let i = 0; i < 60; i++) {
    try {
      const { stdout } = await run("bash", [SCRIPT, "--url", LOCAL_URL, "--fund-wallet", pubkey], {
        env: { ...process.env, LOCAL_SCRATCH: process.env.LOCAL_SCRATCH! },
      });
      return stdout;
    } catch (err) {
      last = String((err as { stderr?: string }).stderr ?? err);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error(`--fund-wallet never succeeded: ${last}`);
}

async function connectTo(page: Page, choice: "local" | "mainnet") {
  await page.getByLabel("Network").selectOption(choice);
  if (choice === "local") {
    await page.getByLabel("Local port").fill(String(E2E_RPC_PORT));
    await page.getByRole("button", { name: "Connect" }).click();
  }
  await expect(page.getByTestId("cluster-banner")).toHaveAttribute("data-cluster", choice === "local" ? "localnet" : "mainnet");
}

async function signAndSend(page: Page) {
  const review = page.getByTestId("review");
  await expect(review.getByTestId("sim-status").first()).toBeVisible();
  for (const status of await review.getByTestId("sim-status").all()) await expect(status).toHaveText("simulation ok");
  await review.getByTestId("sign-and-send").click();
  await expect(review.getByTestId("send-ok")).toBeVisible();
}

/** Full-page screenshot when SCREENSHOT_DIR is set (manual layout review only). */
async function shot(page: Page, name: string) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

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

  // Create a fund: 20% cash slice + 80% TEST on the cloned pool.
  await page.getByRole("button", { name: "Create fund" }).click();
  await page.getByLabel("Quote mint").fill(USDC);
  await expect(page.getByTestId("fit")).toContainText("at most 5 non-cash targets plus a cash slice");
  await page.getByLabel("Cash weight").fill("2000");
  await page.getByLabel("Target 0 mint").fill(TEST_MINT);
  await page.getByLabel("Target 0 pool").fill(POOL);
  await page.getByLabel("Target 0 weight").fill("8000");
  await page.getByLabel("Per run").fill("0.1");
  await page.getByLabel("Interval").fill("3600");
  await page.getByLabel("TWAP window").fill("3600");
  await page.getByLabel("Max deviation").fill("501");
  await expect(page.getByTestId("create-invalid")).toContainText("cannot exceed 500");
  await page.getByLabel("Max deviation").fill("300");
  await page.getByTestId("create-review").click();
  await expect(page.getByTestId("sim")).toHaveCount(2);
  await shot(page, "flow-create-review");
  await signAndSend(page);
  const fund = (await page.getByTestId("created-fund").textContent())!.trim();
  const nft = (await page.getByTestId("created-nft").textContent())!.trim();
  expect(fund).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  // My funds lists it.
  await page.getByRole("button", { name: "My funds" }).click();
  await expect(page.getByTestId("my-funds")).toContainText(fund);
  await page.getByTestId("fund-link").filter({ hasText: fund }).click();
  await expect(page.getByTestId("fund-detail")).toContainText(nft);
  await expect(page.getByTestId("nft-holder")).toContainText(pubkey);

  // Deposit 1 USDC.X and check the budgets: 0.2 cash, 0.8 TEST.
  await page.getByLabel("Deposit amount").fill("1");
  await page.getByTestId("deposit-review").click();
  await signAndSend(page);
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

  // Switch to X1 mainnet: the test wallet disappears with no way back.
  await connectTo(page, "mainnet");
  await expect(page.getByTestId("use-test-wallet")).toHaveCount(0);
  await expect(page.getByTestId("signer")).toContainText("No signer connected");
  await expect(page.getByText("I understand this is X1 mainnet and uses real funds")).toBeVisible();

  // Simulate-only create on mainnet stops at "program not deployed".
  await page.getByRole("button", { name: "Create fund" }).click();
  await page.getByRole("button", { name: /fill example/ }).click();
  await expect(page.getByTestId("fit")).toBeVisible();
  await page.getByLabel("Simulation payer").fill(pubkey);
  await page.getByTestId("create-review").click();
  await expect(page.getByTestId("create-error")).toContainText(
    "program 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM is not deployed on this RPC (https://rpc.mainnet.x1.xyz, mainnet)",
  );
  await expect(page.getByTestId("review")).toHaveCount(0);
  await shot(page, "flow-mainnet-create");

  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
