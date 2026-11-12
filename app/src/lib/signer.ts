/**
 * The app's signing interface: one fee payer and the TxSigner that sendPlan
 * (keeper/src/core/owner.ts) calls. A browser wallet and the localnet-only
 * test wallet both implement it. The app never asks for or handles a secret
 * key from the user.
 */
import { Keypair, type PublicKey, type VersionedTransaction } from "@solana/web3.js";
import type { DetectedCluster } from "@core/cluster.js";
import type { TxSigner } from "@core/owner.js";

export interface AppSigner {
  kind: "wallet" | "local-test";
  label: string;
  publicKey: PublicKey;
  sign: TxSigner;
}

/** Wrap a wallet adapter's signTransaction. */
export function walletSigner(
  label: string,
  publicKey: PublicKey,
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>,
): AppSigner {
  return { kind: "wallet", label, publicKey, sign: (tx) => signTransaction(tx) };
}

export class LocalTestWalletRefused extends Error {
  constructor(cluster: DetectedCluster) {
    super(`the local test wallet exists only on a loopback localnet; this RPC is ${cluster}`);
    this.name = "LocalTestWalletRefused";
  }
}

/**
 * For automated tests on a local validator only. Generates a keypair in
 * browser memory (never stored, never exported). Refused unless the detected
 * cluster is localnet, and every signature re-checks the live cluster, so a
 * later RPC switch cannot make it sign for another chain.
 */
export function createLocalTestWallet(cluster: DetectedCluster, currentCluster: () => DetectedCluster): AppSigner {
  if (cluster !== "localnet") throw new LocalTestWalletRefused(cluster);
  const keypair = Keypair.generate();
  return {
    kind: "local-test",
    label: "Local test wallet (in memory)",
    publicKey: keypair.publicKey,
    sign: async (tx) => {
      const now = currentCluster();
      if (now !== "localnet") throw new LocalTestWalletRefused(now);
      tx.sign([keypair]);
      return tx;
    },
  };
}
