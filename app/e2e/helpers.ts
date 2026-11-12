/** Shared Playwright helpers for the local-validator e2e specs. */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { Connection, PublicKey } from "@solana/web3.js";
import { E2E_RPC_PORT } from "../playwright.config";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../../scripts/local-validator.sh", import.meta.url));
export const LOCAL_URL = `http://127.0.0.1:${E2E_RPC_PORT}`;
export const USDC = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";
export const TEST_MINT = "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz";
export const POOL = "7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD";

/** scripts/local-validator.sh --fund-wallet, retried until the validator has written its state file. */
export async function fundWallet(pubkey: string): Promise<string> {
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

/** Airdrop native XNT straight to any account (e.g. a Fund PDA) on the local validator, confirmed. */
export async function airdrop(to: string, lamports: number): Promise<void> {
  const connection = new Connection(LOCAL_URL, "confirmed");
  const sig = await connection.requestAirdrop(new PublicKey(to), lamports);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
}

export async function connectTo(page: Page, choice: "local" | "mainnet") {
  await page.getByLabel("Network").selectOption(choice);
  if (choice === "local") {
    await page.getByLabel("Local port").fill(String(E2E_RPC_PORT));
    await page.getByRole("button", { name: "Connect" }).click();
  }
  await expect(page.getByTestId("cluster-banner")).toHaveAttribute("data-cluster", choice === "local" ? "localnet" : "mainnet");
}

/**
 * Wait for every simulation to pass. A transaction that depends on an
 * earlier one (attach_metadata) says "not simulated yet" instead.
 */
export async function expectSimsOk(page: Page) {
  const review = page.getByTestId("review");
  await expect(review.getByTestId("sim-status").first()).toBeVisible();
  for (const status of await review.getByTestId("sim-status").all()) await expect(status).toHaveText(/^(simulation ok|not simulated yet)$/);
  await expect(review.getByTestId("sim-status").filter({ hasText: "FAILED" })).toHaveCount(0);
}

export async function signAndSend(page: Page) {
  await expectSimsOk(page);
  await page.getByTestId("review").getByTestId("sign-and-send").click();
  // The receipt lives in the app-level Transactions panel (newest first).
  await expect(page.getByTestId("send-record").first()).toHaveAttribute("data-status", "done");
}

/**
 * Drive the Create Fund wizard: paste USDC.X as pay-with, paste TEST, check
 * that the pool is auto-selected, 80% TEST (so 20% is kept as cash), 0.1 per
 * buy every hour.
 */
export async function fillWizard(page: Page) {
  await page.getByRole("button", { name: "Create fund", exact: true }).click();
  await page.getByLabel("Pay-with token", { exact: true }).fill(USDC);
  await expect(page.getByTestId("quote-input").getByTestId("mint-facts")).toContainText("USDC.X");
  await expect(page.getByTestId("fit")).toBeVisible();
  await page.getByLabel("Token 1 to buy", { exact: true }).fill(TEST_MINT);
  await expect(page.getByTestId("target-0-pool").getByTestId("pool-address")).toHaveText(POOL);
  await page.getByLabel("Token 1 share").fill("80");
  await expect(page.getByTestId("cash-share")).toContainText("keep as cash 20%");
  await page.getByLabel("Amount per buy").fill("0.1");
  await page.getByLabel("How often").selectOption("3600");
}

/** The wizard with no NFT metadata (2 transactions), up to a simulated review. */
export async function reviewCreateFund(page: Page) {
  await fillWizard(page);
  await page.getByLabel("No metadata now").check();
  await page.getByTestId("create-review").click();
  await expect(page.getByTestId("sim")).toHaveCount(2);
}

/** Full-page screenshot when SCREENSHOT_DIR is set (manual layout review only). */
export async function shot(page: Page, name: string) {
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}
