/**
 * Stand-in for src/lib/actions as FundDetail sees it in the browser
 * harness: every review build is a promise the test settles by hand via
 * window.__builds[name][i]. Nothing is built, simulated or sent.
 */
type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
const w = window as unknown as { __builds: Record<string, Deferred[]> };
w.__builds = {};

function deferred(name: string): Promise<never> {
  return new Promise((resolve, reject) => {
    (w.__builds[name] ??= []).push({ resolve: resolve as (v: unknown) => void, reject });
  });
}

export const makeProgram = () => ({});
export const reviewDeposit = () => deferred("deposit");
export const reviewWithdraw = () => deferred("withdraw");
export const reviewWithdrawNative = () => deferred("native");
export const reviewEnsureVaults = () => deferred("ensure");
export const reviewSetMetadata = () => deferred("metadata");
