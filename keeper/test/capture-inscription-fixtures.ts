/**
 * Re-capture the X1 Inscriptions account fixtures that test/inscribe.test.ts
 * decodes. Read-only: getAccountInfo against X1 mainnet RPC.
 *
 *   cd keeper && npx tsx test/capture-inscription-fixtures.ts
 *
 * After a re-capture, update the expected values in inscribe.test.ts
 * (next_inscription and the fees can change).
 */
import { writeFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import { inscriptionConfigPda, inscriptionPda } from "../src/core/inscribe.js";

const RPC = "https://rpc.mainnet.x1.xyz";
const connection = new Connection(RPC, "confirmed");
const targets: Array<[string, PublicKey, string]> = [
  ["x1-inscriptions-config.json", inscriptionConfigPda(), "the program's Config PDA [\"config\"]"],
  ["x1-inscription-32.json", inscriptionPda(32n), "inscription #32: small, inline, text/plain"],
  ["x1-inscription-63.json", inscriptionPda(63n), "inscription #63: inscribe_big header, video/mp4"],
];
for (const [file, address, what] of targets) {
  const res = await connection.getAccountInfoAndContext(address, "confirmed");
  if (!res.value) throw new Error(`${address.toBase58()} not found`);
  const fixture = {
    what,
    address: address.toBase58(),
    owner: res.value.owner.toBase58(),
    lamports: res.value.lamports,
    slot: res.context.slot,
    fetchedAt: new Date().toISOString(),
    rpc: RPC,
    dataBase64: Buffer.from(res.value.data).toString("base64"),
  };
  writeFileSync(new URL(`fixtures/${file}`, import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${file}: ${address.toBase58()} ${res.value.data.length} bytes at slot ${res.context.slot}`);
}
