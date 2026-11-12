import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { DetectedCluster } from "../../keeper/src/core/cluster.js";
import { createLocalTestWallet, LocalTestWalletRefused } from "../src/lib/signer.js";

function unsignedTx(payer: Keypair["publicKey"]): VersionedTransaction {
  const ix = SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 });
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [ix],
  }).compileToLegacyMessage();
  return new VersionedTransaction(message);
}

test("the local test wallet is refused on every cluster except localnet", () => {
  for (const cluster of ["mainnet", "testnet", "unknown"] as DetectedCluster[]) {
    assert.throws(
      () => createLocalTestWallet(cluster, () => cluster),
      (err: unknown) => err instanceof LocalTestWalletRefused && /only on a loopback localnet; this RPC is/.test(err.message),
      cluster,
    );
  }
  const w = createLocalTestWallet("localnet", () => "localnet");
  assert.equal(w.kind, "local-test");
});

test("the local test wallet signs on localnet and refuses after the RPC switches away", async () => {
  let current: DetectedCluster = "localnet";
  const w = createLocalTestWallet("localnet", () => current);
  const signed = await w.sign(unsignedTx(w.publicKey));
  assert.ok(signed.signatures[0]!.some((b) => b !== 0), "signed on localnet");
  for (const next of ["mainnet", "testnet", "unknown"] as DetectedCluster[]) {
    current = next;
    const tx = unsignedTx(w.publicKey);
    await assert.rejects(w.sign(tx), LocalTestWalletRefused);
    assert.ok(tx.signatures[0]!.every((b) => b === 0), `nothing signed on ${next}`);
  }
});

test("each local test wallet is a fresh in-memory key", () => {
  const a = createLocalTestWallet("localnet", () => "localnet");
  const b = createLocalTestWallet("localnet", () => "localnet");
  assert.ok(!a.publicKey.equals(b.publicKey));
  // No secret key is exposed on the signer object.
  assert.deepEqual(Object.keys(a).sort(), ["kind", "label", "publicKey", "sign"]);
});
