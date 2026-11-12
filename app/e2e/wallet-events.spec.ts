/**
 * Real app wiring with mock Wallet Standard wallets. Two wallets, "Mock A"
 * and "Mock B", are registered through the Wallet Standard events, so the
 * real WalletProvider auto-detects them, and they present the SAME public
 * key. Signing happens in Node (exposeFunction) so the test can hold a
 * signature open and fire wallet events at exact moments.
 *
 * Every case expects: no further signature requests, no broadcast
 * (sendTransaction to the RPC) and "not sent" for the remaining transactions.
 */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { expect, test, type Page } from "@playwright/test";
import { connectTo, expectSimsOk, fundWallet, LOCAL_URL, reviewCreateFund } from "./helpers";

const key = Keypair.generate();

/** Runs in the page before the app: registers the two mock wallets. */
function installMockWallets(args: { address: string; publicKey: number[] }) {
  type Listener = (props: { accounts?: unknown[] }) => void;
  const w = window as unknown as {
    __mockWallets: Record<string, { reconnect(): void; disconnect(): void; fireBeforeResolve: boolean }>;
    __mockSign: (name: string, tx: number[]) => Promise<number[]>;
  };
  w.__mockWallets = {};
  const icon =
    "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=";
  for (const name of ["Mock A", "Mock B"]) {
    const listeners: Listener[] = [];
    const newAccount = () => ({
      address: args.address,
      publicKey: new Uint8Array(args.publicKey),
      chains: ["solana:localnet", "solana:mainnet"],
      features: ["solana:signTransaction"],
    });
    const emit = (props: { accounts?: unknown[] }) => listeners.forEach((l) => l(props));
    const control = {
      fireBeforeResolve: false,
      // The wallet drops the account, then offers the same key again (a new account object).
      disconnect() {
        wallet.accounts = [];
        emit({ accounts: wallet.accounts });
      },
      reconnect() {
        wallet.accounts = [newAccount()];
        emit({ accounts: wallet.accounts });
      },
    };
    const wallet = {
      version: "1.0.0" as const,
      name,
      icon,
      chains: ["solana:localnet", "solana:mainnet"],
      accounts: [] as unknown[],
      features: {
        "standard:connect": {
          version: "1.0.0",
          connect: async () => {
            if (wallet.accounts.length === 0) wallet.accounts = [newAccount()];
            return { accounts: wallet.accounts };
          },
        },
        "standard:disconnect": {
          version: "1.0.0",
          disconnect: async () => {
            wallet.accounts = [];
          },
        },
        "standard:events": {
          version: "1.0.0",
          on: (_event: string, l: Listener) => {
            listeners.push(l);
            return () => listeners.splice(listeners.indexOf(l), 1);
          },
        },
        "solana:signTransaction": {
          version: "1.0.0",
          supportedTransactionVersions: ["legacy", 0],
          signTransaction: async (...inputs: Array<{ transaction: Uint8Array }>) => {
            const out = [];
            for (const input of inputs) {
              const signed = await w.__mockSign(name, Array.from(input.transaction));
              out.push({ signedTransaction: new Uint8Array(signed) });
            }
            if (control.fireBeforeResolve) {
              // An account change right before the wallet's promise resolves.
              control.fireBeforeResolve = false;
              control.disconnect();
              control.reconnect();
            }
            return out;
          },
        },
      },
    };
    w.__mockWallets[name] = control;
    const register = (api: { register: (wallet: unknown) => unknown }) => api.register(wallet);
    window.addEventListener("wallet-standard:app-ready", (e) => register((e as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  }
}

interface Harness {
  signs: Record<string, number>;
  broadcasts: number;
  hold: { release: () => void; reached: Promise<void> } | null;
}

async function setup(page: Page): Promise<Harness> {
  const h: Harness = { signs: { "Mock A": 0, "Mock B": 0 }, broadcasts: 0, hold: null };
  await page.exposeFunction("__mockSign", async (name: string, bytes: number[]) => {
    h.signs[name] = (h.signs[name] ?? 0) + 1;
    const hold = h.hold;
    if (hold) {
      h.hold = null;
      await new Promise<void>((release) => {
        hold.release = release;
        (hold as unknown as { arrived: () => void }).arrived();
      });
    }
    const tx = VersionedTransaction.deserialize(Uint8Array.from(bytes));
    tx.sign([key]);
    return Array.from(tx.serialize());
  });
  page.on("request", (r) => {
    if (r.url().startsWith(LOCAL_URL) && (r.postData() ?? "").includes('"sendTransaction"')) h.broadcasts += 1;
  });
  await page.addInitScript(installMockWallets, { address: key.publicKey.toBase58(), publicKey: Array.from(key.publicKey.toBytes()) });
  return h;
}

/** The next signature request blocks until released. */
function holdNextSignature(h: Harness): { reached: Promise<void>; release: () => void } {
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const hold = { reached, release: () => {}, arrived } as { reached: Promise<void>; release: () => void; arrived: () => void };
  h.hold = hold;
  return { reached, release: () => hold.release() };
}

/**
 * Select and connect a mock wallet through the real wallet-adapter UI.
 * Switching wallets makes the library disconnect the old adapter, whose
 * disconnect handler can clear the new selection; so this retries until the
 * app reports the wallet as the signer.
 */
async function connectWallet(page: Page, name: "Mock A" | "Mock B") {
  const trigger = page.locator(".wallet-adapter-button-trigger").first();
  const signer = page.getByTestId("signer");
  await expect(async () => {
    if ((await signer.textContent())?.includes(`Signing as ${name}`)) return;
    const label = ((await trigger.textContent()) ?? "").trim();
    if (/Select Wallet/i.test(label)) {
      await trigger.click();
      await page.getByRole("dialog").getByRole("button", { name: new RegExp(`${name} Detected`) }).click();
    } else if (label.endsWith("Connect") && label.includes(name)) {
      await trigger.click();
    } else if (!/Connecting/i.test(label)) {
      // Another wallet is connected or selected: open the dropdown, "Change wallet".
      await trigger.click();
      await page.getByRole("menuitem", { name: "Change wallet" }).click({ timeout: 2000 });
      await page.getByRole("dialog").getByRole("button", { name: new RegExp(`${name} Detected`) }).click();
    }
    await expect(signer).toContainText(`Signing as ${name}`, { timeout: 2000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByTestId("signer-pubkey")).toHaveText(key.publicKey.toBase58());
}

async function expectStoppedNotSent(page: Page) {
  const rec = page.getByTestId("send-record").first();
  await expect(rec).toHaveAttribute("data-status", "failed");
  await expect(rec.getByTestId("send-failed")).toContainText("session changed");
  await expect(rec.getByTestId("send-failed")).toContainText("not sent: tx 1/2 (create_fund + quote vault), tx 2/2 (target vaults)");
}

test("wallet events during a send stop it: same-key reconnect, adapter swap, event right before resolve", async ({ page }) => {
  const h = await setup(page);
  await page.goto("/");
  await connectTo(page, "local");
  expect(await fundWallet(key.publicKey.toBase58())).toContain("+1000 USDC.X");
  await connectWallet(page, "Mock A");

  // 1. Disconnect, then reconnect the SAME key, while the wallet holds the signature.
  await reviewCreateFund(page);
  await expectSimsOk(page);
  let hold = holdNextSignature(h);
  await page.getByTestId("review").getByTestId("sign-and-send").click();
  await hold.reached;
  await page.evaluate(() => {
    const m = (window as unknown as { __mockWallets: Record<string, { disconnect(): void; reconnect(): void }> }).__mockWallets["Mock A"]!;
    m.disconnect();
    m.reconnect();
  });
  hold.release();
  await expectStoppedNotSent(page);
  expect(h.signs["Mock A"]).toBe(1);
  expect(h.broadcasts).toBe(0);

  // 2. Same-key adapter replacement mid-send: A holds, the owner switches to B.
  await connectWallet(page, "Mock A");
  await reviewCreateFund(page);
  await expectSimsOk(page);
  hold = holdNextSignature(h);
  await page.getByTestId("review").getByTestId("sign-and-send").click();
  await hold.reached;
  await connectWallet(page, "Mock B");
  hold.release();
  await expectStoppedNotSent(page);
  expect(h.signs).toEqual({ "Mock A": 2, "Mock B": 0 });
  expect(h.broadcasts).toBe(0);

  // 3. An account event fired just before the wallet's promise resolves.
  await reviewCreateFund(page); // built under B
  await expectSimsOk(page);
  await page.evaluate(() => {
    (window as unknown as { __mockWallets: Record<string, { fireBeforeResolve: boolean }> }).__mockWallets["Mock B"]!.fireBeforeResolve = true;
  });
  await page.getByTestId("review").getByTestId("sign-and-send").click();
  await expectStoppedNotSent(page);
  expect(h.signs).toEqual({ "Mock A": 2, "Mock B": 1 });
  expect(h.broadcasts).toBe(0);

  // Control: with no events, the same mock wallet signs both transactions and they land.
  await connectWallet(page, "Mock A");
  await reviewCreateFund(page);
  await expectSimsOk(page);
  await page.getByTestId("review").getByTestId("sign-and-send").click();
  await expect(page.getByTestId("send-record").first()).toHaveAttribute("data-status", "done");
  expect(h.signs["Mock A"]).toBe(4);
  expect(h.broadcasts).toBe(2);
});
