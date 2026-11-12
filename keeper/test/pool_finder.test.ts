/**
 * core/pool_finder.ts and core/token_info.ts against a mocked RPC: pool
 * discovery in both mint orders, ranking by quote reserve, the planner's own
 * checkPool filter, depth classes, and mint classification.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { XDEX_PROGRAM_ID } from "../src/core/owner.js";
import { findPools, poolDepth, type PoolFinderConnection } from "../src/core/pool_finder.js";
import { POOL_DISCRIMINATOR, POOL_LEN, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../src/core/pool.js";
import { metadataPda, METAPLEX_PROGRAM_ID } from "../src/core/metadata.js";
import { describeNotAMint, readToken2022Metadata, readTokenInfo, walletTokenBalance } from "../src/core/token_info.js";

const key = () => Keypair.generate().publicKey;
const USDC = new PublicKey("B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq");
const TEST = new PublicKey("C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz");
const PEPE = new PublicKey("81LkybSBLvXYMTF6azXohUWyBvDGUXznm4yiXPkYkDTJ");

function poolData(mint0: PublicKey, mint1: PublicKey, vault0: PublicKey, vault1: PublicKey): Uint8Array {
  const d = new Uint8Array(POOL_LEN);
  d.set(POOL_DISCRIMINATOR, 0);
  d.set(vault0.toBytes(), 72);
  d.set(vault1.toBytes(), 104);
  d.set(mint0.toBytes(), 168);
  d.set(mint1.toBytes(), 200);
  return d;
}

function tokenAccount(amount: bigint): Uint8Array {
  const d = new Uint8Array(165);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  return d;
}

interface FakePool {
  key: PublicKey;
  owner: PublicKey;
  data: Uint8Array;
}

function fakeRpc(pools: FakePool[], accounts: Map<string, { owner: PublicKey; data: Uint8Array }>) {
  const calls: Array<{ program: string; filters: unknown }> = [];
  const conn: PoolFinderConnection = {
    async getProgramAccounts(programId, config) {
      calls.push({ program: programId.toBase58(), filters: config.filters });
      const size = config.filters.find((f): f is { dataSize: number } => "dataSize" in f)?.dataSize;
      const memcmps = config.filters.filter((f): f is { memcmp: { offset: number; bytes: string } } => "memcmp" in f);
      return pools
        .filter((p) => (size === undefined || p.data.length === size) && memcmps.every((m) => new PublicKey(p.data.subarray(m.memcmp.offset, m.memcmp.offset + 32)).toBase58() === m.memcmp.bytes))
        .map((p) => ({ pubkey: p.key, account: { owner: p.owner, data: p.data } }));
    },
    async getMultipleAccountsInfo(keys) {
      return keys.map((k) => accounts.get(k.toBase58()) ?? null);
    },
  };
  return { conn, calls };
}

test("pool finder: finds pools in both mint orders, ranks by quote reserve, uses dataSize 637 and offsets 168/200", async () => {
  const accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  const mk = (mint0: PublicKey, mint1: PublicKey, reserve0: bigint, reserve1: bigint, owner = XDEX_PROGRAM_ID): FakePool => {
    const v0 = key();
    const v1 = key();
    accounts.set(v0.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(reserve0) });
    accounts.set(v1.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: tokenAccount(reserve1) });
    return { key: key(), owner, data: poolData(mint0, mint1, v0, v1) };
  };
  const small = mk(USDC, TEST, 5_000_000n, 1n); // quote is token 0, 5 USDC.X
  const big = mk(TEST, USDC, 9n, 1_843_753_487n); // reversed: quote is token 1, 1843 USDC.X
  const foreign = mk(USDC, TEST, 10n ** 15n, 1n, key()); // not owned by XDEX: dropped
  const other = mk(USDC, PEPE, 10n ** 12n, 1n); // another pair: never matched
  const { conn, calls } = fakeRpc([small, big, foreign, other], accounts);

  const found = await findPools(conn, XDEX_PROGRAM_ID, USDC, TEST);
  assert.deepEqual(found.map((c) => c.pool.toBase58()), [big.key.toBase58(), small.key.toBase58()]);
  assert.equal(found[0]!.quoteIsToken1, true);
  assert.equal(found[0]!.quoteReserve, 1_843_753_487n);
  assert.equal(found[0]!.targetReserve, 9n);
  assert.equal(found[1]!.quoteIsToken1, false);
  assert.equal(found[1]!.quoteReserve, 5_000_000n);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.program, XDEX_PROGRAM_ID.toBase58());
  assert.deepEqual(calls[0]!.filters, [
    { dataSize: 637 },
    { memcmp: { offset: 168, bytes: USDC.toBase58() } },
    { memcmp: { offset: 200, bytes: TEST.toBase58() } },
  ]);
  assert.deepEqual(calls[1]!.filters, [
    { dataSize: 637 },
    { memcmp: { offset: 168, bytes: TEST.toBase58() } },
    { memcmp: { offset: 200, bytes: USDC.toBase58() } },
  ]);
});

test("pool finder: no pool for the pair is an empty list; the same mint twice is refused", async () => {
  const { conn } = fakeRpc([], new Map());
  assert.deepEqual(await findPools(conn, XDEX_PROGRAM_ID, USDC, PEPE), []);
  await assert.rejects(findPools(conn, XDEX_PROGRAM_ID, USDC, USDC), /same token as the pay-with token/);
});

test("pool finder: a pool whose vaults are unreadable sorts last with an unknown reserve", async () => {
  const accounts = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  const v0 = key();
  const v1 = key();
  accounts.set(v0.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenAccount(1n) });
  accounts.set(v1.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenAccount(1n) });
  const ok = { key: key(), owner: XDEX_PROGRAM_ID, data: poolData(USDC, TEST, v0, v1) };
  const blind = { key: key(), owner: XDEX_PROGRAM_ID, data: poolData(USDC, TEST, key(), key()) };
  const { conn } = fakeRpc([blind, ok], accounts);
  const found = await findPools(conn, XDEX_PROGRAM_ID, USDC, TEST);
  assert.deepEqual(found.map((c) => c.pool.toBase58()), [ok.key.toBase58(), blind.key.toBase58()]);
  assert.equal(found[1]!.quoteReserve, undefined);
});

test("pool depth: empty, too thin for the deviation guard, thin, ok", () => {
  assert.equal(poolDepth(undefined, 1n, 300), "empty");
  assert.equal(poolDepth(0n, 1n, 300), "empty");
  // PEPE/USDC.X on mainnet (2026-11-12): 0.41158 USDC.X quote reserve; a 0.08 buy is ~19% of it.
  assert.equal(poolDepth(411_580n, 80_000n, 300), "too thin");
  // 1.5% of the reserve with max deviation 3%: half of 3% is 1.5%, so exactly at the limit is "thin".
  assert.equal(poolDepth(1_000_000n, 15_000n, 300), "thin");
  assert.equal(poolDepth(1_000_000n, 15_001n, 300), "too thin");
  assert.equal(poolDepth(1_000_000n, 5_000n, 300), "ok");
  assert.equal(poolDepth(1_000_000n, 5_001n, 300), "thin");
  // USDC.X/TEST: 1843 USDC.X, a 0.08 buy.
  assert.equal(poolDepth(1_843_753_487n, 80_000n, 300), "ok");
});

// ---- token_info ----

function mint2022WithMetadata(mint: PublicKey, decimals: number, name: string, symbol: string, extra: Array<[number, number]> = []): Uint8Array {
  const enc = new TextEncoder();
  const str = (s: string) => {
    const b = enc.encode(s);
    const out = new Uint8Array(4 + b.length);
    new DataView(out.buffer).setUint32(0, b.length, true);
    out.set(b, 4);
    return out;
  };
  const body = [...new Uint8Array(32).fill(9), ...mint.toBytes(), ...str(name), ...str(symbol), ...str("https://example.invalid/x.json"), 0, 0, 0, 0];
  const out: number[] = new Array(166).fill(0);
  out[44] = decimals;
  out[45] = 1;
  out[165] = 1;
  const push = (t: number, data: number[]) => out.push(t & 0xff, t >> 8, data.length & 0xff, data.length >> 8, ...data);
  push(18, [...new Uint8Array(32), ...mint.toBytes()]);
  for (const [t, len] of extra) push(t, new Array(len).fill(0));
  push(19, body);
  return Uint8Array.from(out);
}

function reader(map: Map<string, { owner: PublicKey; data: Uint8Array }>) {
  return { getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => map.get(k.toBase58()) ?? null) };
}

test("token info: Token-2022 metadata name and symbol, decimals, policy, and the Metaplex fallback", async () => {
  const map = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  map.set(TEST.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: mint2022WithMetadata(TEST, 9, "Test", "Test", [[1, 108]]) });
  const r = await readTokenInfo(reader(map), TEST);
  assert.ok(r.ok);
  assert.equal(r.info.decimals, 9);
  assert.equal(r.info.symbol, "Test");
  assert.equal(r.info.nameSource, "token-2022");
  assert.deepEqual(r.info.extensions, [18, 1, 19]);
  assert.deepEqual(r.info.policy, { ok: true });
  assert.ok(r.info.tokenProgram.equals(TOKEN_2022_PROGRAM_ID));
  assert.equal(readToken2022Metadata(map.get(TEST.toBase58())!.data)!.name, "Test");

  // A classic mint with Metaplex metadata.
  const classic = key();
  const base = new Uint8Array(82);
  base[44] = 6;
  base[45] = 1;
  map.set(classic.toBase58(), { owner: TOKEN_PROGRAM_ID, data: base });
  const enc = new TextEncoder();
  const s = (v: string) => [...new Uint8Array(new Uint32Array([enc.encode(v).length]).buffer), ...enc.encode(v)];
  const md = Uint8Array.from([4, ...key().toBytes(), ...classic.toBytes(), ...s("Wrapped Thing"), ...s("WTH"), ...s("u")]);
  map.set(metadataPda(classic).toBase58(), { owner: METAPLEX_PROGRAM_ID, data: md });
  const c = await readTokenInfo(reader(map), classic);
  assert.ok(c.ok);
  assert.equal(c.info.symbol, "WTH");
  assert.equal(c.info.nameSource, "metaplex");

  // A classic mint without any metadata: no name; the app falls back to its curated list.
  const bare = key();
  map.set(bare.toBase58(), { owner: TOKEN_PROGRAM_ID, data: base });
  const b = await readTokenInfo(reader(map), bare);
  assert.ok(b.ok && b.info.symbol === undefined);
});

test("token info: disallowed extensions, wallets, token accounts, other programs and missing accounts", async () => {
  const map = new Map<string, { owner: PublicKey; data: Uint8Array }>();
  const hooked = key();
  map.set(hooked.toBase58(), { owner: TOKEN_2022_PROGRAM_ID, data: mint2022WithMetadata(hooked, 6, "Hook", "HK", [[14, 64]]) });
  const h = await readTokenInfo(reader(map), hooked);
  assert.ok(h.ok);
  assert.deepEqual(h.info.policy, { ok: false, kind: "Disallowed", type: 14 });

  const wallet = key();
  map.set(wallet.toBase58(), { owner: new PublicKey("11111111111111111111111111111111"), data: new Uint8Array() });
  const tokenAcct = key();
  map.set(tokenAcct.toBase58(), { owner: TOKEN_PROGRAM_ID, data: tokenAccount(5n) });
  const prog = key();
  map.set(prog.toBase58(), { owner: XDEX_PROGRAM_ID, data: new Uint8Array(637) });
  const cases: Array<[PublicKey, string]> = [
    [wallet, "wallet"],
    [tokenAcct, "token-account"],
    [prog, "other-program"],
    [key(), "missing"],
  ];
  for (const [k, kind] of cases) {
    const r = await readTokenInfo(reader(map), k);
    assert.ok(!r.ok && r.why.kind === kind, kind);
    if (!r.ok) assert.ok(describeNotAMint(r.why).length > 10);
  }
});

test("token info: wallet balance sums every token account of the mint", async () => {
  const owner = key();
  const conn = {
    getTokenAccountsByOwner: async (o: PublicKey, f: { mint: PublicKey }) => {
      assert.ok(o.equals(owner) && f.mint.equals(USDC));
      return { value: [{ pubkey: key(), account: { data: tokenAccount(3n) } }, { pubkey: key(), account: { data: tokenAccount(4n) } }] };
    },
  };
  assert.equal(await walletTokenBalance(conn, owner, USDC), 7n);
});
