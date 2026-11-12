/**
 * Numeric wizard inputs never reach BigInt unvalidated during render: a
 * custom interval of "60.5" or "Infinity", or a max deviation of "3.5", used
 * to throw RangeError while rendering. Server-rendered, no browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import { poolDepth } from "@core/pool_finder.js";
import { CustomSecondsField, MaxDeviationField, PerRoundLine, PoolDepthNote } from "../src/components/CreateWizard.js";
import { parseIntervalSecs, parseMaxDevBps } from "../src/lib/wizard.js";

const BAD = ["60.5", "Infinity", "3.5", "", "-1"];
const quote = Keypair.generate().publicKey;
const target = Keypair.generate().publicKey;
const targets = [
  { mint: quote, pool: PublicKey.default, bps: 2000 },
  { mint: target, pool: Keypair.generate().publicKey, bps: 8000 },
];

const perRound = (intervalText: string) =>
  renderToString(
    <PerRoundLine intervalText={intervalText} perRunRaw={100_000n} targets={targets} cashBps={2000} quoteMint={quote} decimals={6} symbol="USDC.X" labels={{}} />,
  );
const depth = (maxDevText: string) => renderToString(<PoolDepthNote quoteReserve={1_000_000_000n} slice={80_000n} maxDevText={maxDevText} />);

test("parsers accept only whole numbers in range", () => {
  for (const bad of [...BAD, "1e3", " 59", "0x40", "NaN"]) assert.equal(parseIntervalSecs(bad), undefined, bad);
  assert.equal(parseIntervalSecs("60"), 60n);
  assert.equal(parseIntervalSecs(" 3600 "), 3600n);
  assert.equal(parseIntervalSecs("9223372036854775808"), undefined);
  for (const bad of [...BAD, "501", "1e2", "NaN"]) assert.equal(parseMaxDevBps(bad), undefined, bad);
  assert.equal(parseMaxDevBps("0"), 0);
  assert.equal(parseMaxDevBps("300"), 300);
  assert.equal(parseMaxDevBps("500"), 500);
  assert.throws(() => poolDepth(1n, 1n, 3.5), /non-negative whole number/);
  assert.throws(() => poolDepth(1n, 1n, Infinity), /non-negative whole number/);
});

for (const bad of BAD) {
  test(`render with ${JSON.stringify(bad)}: an inline message, no RangeError`, () => {
    const custom = renderToString(<CustomSecondsField value={bad} onChange={() => {}} />);
    assert.match(custom, /data-testid="interval-invalid"/);
    assert.match(custom, /whole number of seconds, at least 60/);
    const round = perRound(bad);
    assert.match(round, /data-testid="per-round-invalid"/);
    assert.doesNotMatch(round, /data-testid="per-round"/);
    const dev = renderToString(<MaxDeviationField value={bad} onChange={() => {}} />);
    assert.match(dev, /data-testid="max-dev-invalid"/);
    const d = depth(bad);
    assert.match(d, /data-testid="pool-depth-unknown"/);
    assert.doesNotMatch(d, /data-testid="pool-depth"/);
  });
}

test("valid values render the normal text", () => {
  assert.doesNotMatch(renderToString(<CustomSecondsField value="600" onChange={() => {}} />), /interval-invalid/);
  assert.match(perRound("3600"), /Every <!-- -->1 hour<!-- --> the fund spends/);
  assert.match(perRound("600"), /10 minutes/);
  assert.doesNotMatch(renderToString(<MaxDeviationField value="300" onChange={() => {}} />), /max-dev-invalid/);
  assert.match(depth("300"), /data-testid="pool-depth"/);
  assert.match(depth("300"), /deep enough/);
  // 80_000 of 1_000_000_000 is 0.008%: too thin only with a tiny max deviation (1 bp: half is 0.005%).
  assert.match(depth("1"), /too thin/);
});
