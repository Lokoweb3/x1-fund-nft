/** Reordered and failed replies from an older context never reach the screen. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLatest, sameView } from "../src/lib/latest.js";

const LOCAL = "http://127.0.0.1:8899";
const MAINNET = "https://rpc.mainnet.x1.xyz";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("reordered replies: an old network's reply never overwrites the new one (decimals 9 vs 6)", async () => {
  const latest = createLatest();
  const oldNet = deferred<{ decimals: number }>();
  const newNet = deferred<{ decimals: number }>();
  const first = latest.run(oldNet.promise); // started on the old network
  const second = latest.run(newNet.promise); // started after the switch
  newNet.resolve({ decimals: 6 });
  oldNet.resolve({ decimals: 9 }); // the old reply arrives last
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, { stale: true });
  assert.deepEqual(b, { stale: false, value: { decimals: 6 } });

  // invalidate (network/fund/wallet change) makes an in-flight load stale, including its failure.
  const pending = deferred<number>();
  const third = latest.run(pending.promise);
  latest.invalidate();
  pending.reject(new Error("RPC error from the old network"));
  assert.deepEqual(await third, { stale: true });

  // The newest call's failure is still reported.
  await assert.rejects(latest.run(Promise.reject(new Error("current failure"))), /current failure/);
});

test("fund actions are enabled only for a view of the current generation, RPC and fund", () => {
  const v = { generation: 2, rpcUrl: LOCAL, fund: "F" };
  assert.equal(sameView(v, { ...v }), true);
  assert.equal(sameView(v, { ...v, generation: 3 }), false);
  assert.equal(sameView(v, { ...v, rpcUrl: MAINNET }), false);
  assert.equal(sameView(v, { ...v, fund: "G" }), false);
  assert.equal(sameView(undefined, v), false);
});
