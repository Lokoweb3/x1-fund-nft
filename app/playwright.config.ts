/**
 * Browser smoke + e2e against a loopback validator started by
 * scripts/local-validator.sh. Needs LOCAL_SCRATCH (absolute) for the
 * validator's throwaway work dir, and a Playwright chromium, e.g.:
 *
 *   export LOCAL_SCRATCH=/abs/scratch PLAYWRIGHT_BROWSERS_PATH=/abs/scratch/pw
 *   npx playwright install chromium
 *   npm run e2e
 */
import { defineConfig } from "@playwright/test";

const scratch = process.env.LOCAL_SCRATCH;
if (!scratch || !scratch.startsWith("/")) throw new Error("set LOCAL_SCRATCH to an absolute directory");
export const E2E_RPC_PORT = Number(process.env.E2E_RPC_PORT ?? "18799");
export const E2E_APP_PORT = Number(process.env.E2E_APP_PORT ?? "5179");

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 60_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${E2E_APP_PORT}`,
    browserName: "chromium",
    headless: true,
    trace: "off",
  },
  webServer: [
    {
      command: `bash ../scripts/local-validator.sh --port ${E2E_RPC_PORT}`,
      url: `http://127.0.0.1:${E2E_RPC_PORT}/health`,
      timeout: 240_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: { LOCAL_SCRATCH: scratch },
      gracefulShutdown: { signal: "SIGTERM", timeout: 15_000 },
    },
    {
      command: `npx vite --port ${E2E_APP_PORT} --strictPort`,
      url: `http://127.0.0.1:${E2E_APP_PORT}/`,
      timeout: 120_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
