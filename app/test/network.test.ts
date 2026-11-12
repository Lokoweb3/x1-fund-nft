import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_EXPLORER, explorerLink, rpcUrlFor } from "../src/lib/network.js";

test("RPC choices map to the X1 endpoints and a loopback local URL", () => {
  const base = { localPort: "8899", customUrl: "" };
  assert.equal(rpcUrlFor({ ...base, choice: "mainnet" }), "https://rpc.mainnet.x1.xyz");
  assert.equal(rpcUrlFor({ ...base, choice: "testnet" }), "https://rpc.testnet.x1.xyz");
  assert.equal(rpcUrlFor({ ...base, choice: "local" }), "http://127.0.0.1:8899");
  assert.equal(rpcUrlFor({ ...base, choice: "local", localPort: "18899" }), "http://127.0.0.1:18899");
  assert.throws(() => rpcUrlFor({ ...base, choice: "local", localPort: "0" }), /1-65535/);
  assert.throws(() => rpcUrlFor({ ...base, choice: "local", localPort: "88a" }), /1-65535/);
  assert.equal(rpcUrlFor({ ...base, choice: "custom", customUrl: "https://rpc.example/x" }), "https://rpc.example/x");
  assert.throws(() => rpcUrlFor({ ...base, choice: "custom", customUrl: "ftp://x" }), /http or https/);
  assert.throws(() => rpcUrlFor({ ...base, choice: "custom", customUrl: "nope" }), /full http/);
});

test("explorer links: per-cluster defaults, none for localnet, only http(s) templates", () => {
  assert.equal(explorerLink(DEFAULT_EXPLORER.mainnet, "abc"), "https://explorer.x1.xyz/tx/abc");
  assert.equal(explorerLink(DEFAULT_EXPLORER.testnet, "abc"), "https://explorer.testnet.x1.xyz/tx/abc");
  assert.equal(explorerLink(DEFAULT_EXPLORER.localnet, "abc"), undefined);
  assert.equal(explorerLink("javascript:alert({sig})", "abc"), undefined);
  assert.equal(explorerLink("https://x/tx/", "abc"), undefined, "a template without {sig} gives no link");
});
