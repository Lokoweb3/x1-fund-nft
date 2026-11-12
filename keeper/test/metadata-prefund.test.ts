import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { isInitializedPda } from "../src/core/rpc.js";
import { METAPLEX_PROGRAM_ID } from "../src/core/metadata.js";

const addr = Keypair.generate().publicKey;

test("a prefunded, empty, System-owned PDA counts as uninitialized (codex r: SF2)", () => {
  assert.equal(isInitializedPda({ owner: SystemProgram.programId, data: new Uint8Array(0) }, addr, "metadata"), false);
  assert.equal(isInitializedPda(null, addr, "metadata"), false);
  assert.equal(isInitializedPda(undefined, addr, "master edition"), false);
});

test("a Token Metadata-owned account with data is initialized", () => {
  assert.equal(isInitializedPda({ owner: METAPLEX_PROGRAM_ID, data: new Uint8Array([4, 1, 2]) }, addr, "metadata"), true);
});

test("a non-empty account owned by anything else is rejected", () => {
  assert.throws(
    () => isInitializedPda({ owner: SystemProgram.programId, data: new Uint8Array([1]) }, addr, "metadata"),
    /not Token Metadata/,
  );
  assert.throws(
    () => isInitializedPda({ owner: Keypair.generate().publicKey, data: new Uint8Array(0) }, addr, "master edition"),
    /not Token Metadata/,
  );
});

test("set-metadata recovery round-trips values that start with -- (codex NIT 2)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { setMetadataCommandLine } = await import("../src/core/owner.js");
  const { parseCli } = await import("../src/owner.js");
  const fields = { name: "--Fund", symbol: "-X", uri: "https://h/x.json?a=1&b='q'" };
  const line = setMetadataCommandLine({
    fund: Keypair.generate().publicKey,
    payer: Keypair.generate().publicKey,
    rpcUrl: "http://127.0.0.1:8899",
    send: false,
    cluster: undefined,
    iUnderstandMainnet: false,
    fields,
  });
  // Let bash do the word splitting exactly as the owner's shell would.
  const out = execFileSync("bash", ["-c", `set -- ${line}; printf '%s\\0' "$@"`], { encoding: "utf8" });
  const argv = out.split("\0").filter((a) => a.length > 0).slice(3); // drop "npx tsx src/cli.ts"
  const parsed = parseCli(argv) as unknown as { command: string; update: Record<string, string> };
  assert.equal(parsed.command, "set-metadata");
  const got = JSON.stringify(parsed);
  for (const v of Object.values(fields)) assert.ok(got.includes(JSON.stringify(v).slice(1, -1)), v);
});
