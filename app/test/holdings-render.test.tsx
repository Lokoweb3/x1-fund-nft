/**
 * The My funds value line and the holdings card render estimates, and say
 * "value unknown" instead of breaking. Server-rendered, no browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Keypair } from "@solana/web3.js";
import type { MintMeta } from "@core/owner.js";
import type { FundView } from "@core/rpc.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@core/pool.js";
import { HoldingsCard, ValueLine } from "../src/components/Holdings.js";
import { valueHoldings } from "../src/lib/value.js";

const k = () => Keypair.generate().publicKey;
const quote: MintMeta = { address: k(), decimals: 9, tokenProgram: TOKEN_PROGRAM_ID, transferFee: undefined };
const target: MintMeta = {
  address: k(),
  decimals: 9,
  tokenProgram: TOKEN_2022_PROGRAM_ID,
  transferFee: { older: { epoch: 0n, maximumFee: 10n ** 18n, basisPoints: 500 }, newer: { epoch: 0n, maximumFee: 10n ** 18n, basisPoints: 500 } },
};
const vaults = [
  { mint: quote, vault: k(), balance: 9_800_000_000n },
  { mint: target, vault: k(), balance: 1_000_000_000n },
];
const view = { quote, vaults, account: { quoteMint: quote.address } } as unknown as FundView;
const valuation = valueHoldings({
  quote,
  vaults,
  pools: { [target.address.toBase58()]: { side0: { mint: quote.address, reserve: 600n }, side1: { mint: target.address, reserve: 1_000n } } },
});
const labels = { [quote.address.toBase58()]: { symbol: "WXNT" }, [target.address.toBase58()]: { symbol: "Test" } } as never;

test("value line: total and quote left", () => {
  const html = renderToString(<ValueLine state={{ status: "ok", valuation }} view={view} quoteSymbol="WXNT" />);
  assert.match(html, /≈ <!-- -->10.4<!-- --> <!-- -->WXNT/);
  assert.match(html, /9.8<!-- --> <!-- -->WXNT<!-- --> left to spend/);
  assert.match(renderToString(<ValueLine state={{ status: "error" }} view={null} quoteSymbol="WXNT" />), /value unknown/);
  assert.match(renderToString(<ValueLine state={{ status: "loading" }} view={null} quoteSymbol="WXNT" />), /valuing/);
});

test("holdings card: total, per-token value, share, transfer-fee note, estimate label", () => {
  const html = renderToString(<HoldingsCard state={{ status: "ok", valuation }} view={view} labels={labels} />);
  assert.match(html, /data-testid="holdings-total"/);
  assert.match(html, /10.4/);
  assert.match(html, /≈ 0.6 WXNT/);
  assert.match(html, /5.7%/);
  assert.match(html, /Test<!-- -->: withdrawing pays its <!-- -->5<!-- -->% transfer fee/);
  assert.match(html, /Display only/);
  const err = renderToString(<HoldingsCard state={{ status: "error" }} view={view} labels={labels} />);
  assert.match(err, /unknown/);
});
