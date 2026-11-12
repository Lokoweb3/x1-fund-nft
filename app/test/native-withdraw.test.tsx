/**
 * Native XNT withdraw on the fund page: amount parsing, disabled states, the
 * review sentences, the holdings row, and the friendly errors for an old
 * program (Anchor 101) and NativeAboveAvailable (6054). No RPC, no browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { MintMeta } from "@core/owner.js";
import type { FundView, InexactNativeBalance, NativeBalance, WithdrawNativeSummary } from "@core/rpc.js";
import { TOKEN_PROGRAM_ID } from "@core/pool.js";
import { NativeWithdrawForm } from "../src/components/FundDetail.js";
import { HoldingsCard } from "../src/components/Holdings.js";
import { ReviewPanel } from "../src/components/ReviewPanel.js";
import type { AppState } from "../src/App.js";
import { withdrawNativeSentences, type Review } from "../src/lib/actions.js";
import { friendlyError, friendlySim, NATIVE_WITHDRAW_MISSING } from "../src/lib/errors.js";
import { exactAvailable, NATIVE_NOT_HOLDER, NATIVE_NOTHING, nativeBlocker, nativeLine, parseNativeAmount } from "../src/lib/native.js";
import { createLocalTestWallet } from "../src/lib/signer.js";
import { signerId } from "../src/lib/session.js";
import { valueHoldings, withNative, WXNT_MINT } from "../src/lib/value.js";

const k = () => Keypair.generate().publicKey;
// 2^53 + 2 lamports: above Number.MAX_SAFE_INTEGER, so the core cannot read it exactly.
const inexact: InexactNativeBalance = { exact: false, approxLamports: 9_007_199_254_740_994, dataLength: 708 };
const balance: NativeBalance = { exact: true, lamports: 2_501_559_040n, dataLength: 708, rentMinimum: 5_819_040n, available: 2_495_740_000n };

test("amount: XNT decimal to exact lamports, 'all', and refusals", () => {
  assert.equal(parseNativeAmount("1.5", false, balance), 1_500_000_000n);
  assert.equal(parseNativeAmount("0.000000001", false, balance), 1n);
  assert.equal(parseNativeAmount(" 2.49574 ", false, balance), 2_495_740_000n);
  assert.equal(parseNativeAmount("", true, balance), "all");
  assert.equal(parseNativeAmount("junk", true, balance), "all"); // the input is ignored with "all"
  assert.throws(() => parseNativeAmount("0", false, balance), /greater than zero/);
  assert.throws(() => parseNativeAmount("0.0000000001", false, balance), /more than 9 decimal places/);
  assert.throws(() => parseNativeAmount("-1", false, balance), /non-negative decimal/);
  assert.throws(() => parseNativeAmount("1e3", false, balance), /non-negative decimal/);
  assert.throws(() => parseNativeAmount("", false, balance), /non-negative decimal/);
  assert.throws(() => parseNativeAmount("2.495740001", false, balance), /more than the 2.49574 XNT available/);
});

test("the balance line and the blockers", () => {
  assert.equal(nativeLine(balance), "Native XNT on the fund: 2.50155904 (available to withdraw: 2.49574; 0.00581904 stays for rent)");
  assert.equal(nativeBlocker({ holder: true, balance }), undefined);
  assert.equal(nativeBlocker({ holder: false, balance }), NATIVE_NOT_HOLDER);
  assert.equal(nativeBlocker({ holder: true, balance: { ...balance, available: 0n } }), NATIVE_NOTHING);
  assert.match(nativeBlocker({ holder: true, balance: undefined, readError: "fund does not exist" })!, /could not be read: fund does not exist/);
  assert.match(nativeBlocker({ holder: true, balance: undefined })!, /Reading/);
  assert.equal(NATIVE_NOTHING, "Nothing to withdraw yet. Native XNT arrives here from reflection tokens like Test or from direct transfers.");
});

const form = (o: { holder: boolean; available?: bigint; disabled?: boolean; error?: string; inexact?: boolean }) =>
  renderToString(
    <NativeWithdrawForm
      native={o.error ? { error: o.error } : { balance: o.inexact ? inexact : { ...balance, available: o.available ?? balance.available } }}
      holder={o.holder}
      disabled={o.disabled ?? false}
      onReview={() => {}}
    />,
  );

test("form: not the holder -> disabled with the holder-only message", () => {
  const html = form({ holder: false });
  assert.match(html, /data-testid="native-line"/);
  assert.match(html, /Only the wallet that holds the fund NFT can withdraw native XNT./);
  assert.match(html, /<button disabled=""[^>]*data-testid="native-withdraw-review"/);
  assert.match(html, /type="checkbox" disabled=""[^>]*aria-label="Withdraw all native XNT"/);
});

test("form: nothing available -> disabled with the explanation", () => {
  const html = form({ holder: true, available: 0n });
  assert.match(html, /Nothing to withdraw yet. Native XNT arrives here from reflection tokens like Test or from direct transfers./);
  assert.match(html, /<button disabled=""[^>]*data-testid="native-withdraw-review"/);
});

test("form: holder with XNT available -> inputs enabled, no blocker; still disabled while actions are off", () => {
  const html = form({ holder: true });
  assert.doesNotMatch(html, /native-blocker/);
  assert.doesNotMatch(html, /aria-label="Native XNT amount"[^>]*disabled/);
  assert.doesNotMatch(html, /type="checkbox" disabled/);
  // No amount typed yet: the review button waits for one.
  assert.match(html, /<button disabled=""[^>]*data-testid="native-withdraw-review"/);
  assert.match(form({ holder: true, disabled: true }), /<button disabled=""[^>]*data-testid="native-withdraw-review"/);
  assert.match(form({ holder: true, error: "fund X balance (1e20) is too large to read exactly" }), /could not be read/);
});

test("review sentences: what moves, that the rent stays, what is left", () => {
  const holder = k();
  const s = { fund: k(), holder, nftAccount: undefined, balance, amount: 1_000_000_000n, payerHoldsNft: true } as unknown as WithdrawNativeSummary;
  assert.deepEqual(withdrawNativeSentences(s), [
    `You move 1 XNT (native) from the fund account to your wallet ${holder.toBase58()}.`,
    "The fund account holds 2.50155904 XNT. 0.00581904 XNT stays there for rent and can never be withdrawn; after this, 1.49574 XNT is left to withdraw.",
    "The fund's token vaults, budgets and targets are not touched.",
  ]);
});

const FALLBACK_LOGS = [
  "Program 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM invoke [1]",
  "Program log: AnchorError occurred. Error Code: InstructionFallbackNotFound. Error Number: 101. Error Message: Fallback functions are not supported.",
  "Program 6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM failed: custom program error: 0x65",
];

test("Anchor 101 on withdraw_native -> 'upgrade the program first'", () => {
  const err = { InstructionError: [1, { Custom: 101 }] };
  assert.equal(friendlySim({ label: "withdraw_native", err, logs: FALLBACK_LOGS })?.title, NATIVE_WITHDRAW_MISSING);
  // Without logs, the label and the bare code are enough.
  assert.equal(friendlySim({ label: "withdraw_native", err, logs: [] })?.title, NATIVE_WITHDRAW_MISSING);
  assert.equal(friendlyError(new Error(FALLBACK_LOGS[1])).title, NATIVE_WITHDRAW_MISSING);
  assert.equal(
    NATIVE_WITHDRAW_MISSING,
    "This program version has no native withdraw yet. The owner must upgrade the program first (docs/UPGRADE_WITHDRAW_NATIVE.md).",
  );
  // Another program's own error 101 (e.g. Token Metadata) is not read as a missing instruction.
  assert.equal(friendlySim({ label: "attach_metadata", err, logs: [] }), undefined);
  assert.notEqual(friendlyError("attach_metadata failed: custom program error: 0x65").title, NATIVE_WITHDRAW_MISSING);
  assert.equal(friendlySim({ label: "withdraw_native", err: null, logs: FALLBACK_LOGS }), undefined);
});

test("6054 NativeAboveAvailable -> plain words, nothing changed", () => {
  const want = /no longer has that much native XNT above its rent reserve, so the program refused\. Refresh the page and try a smaller amount or "all"\. Nothing was changed\./;
  assert.match(friendlySim({ label: "withdraw_native", err: { InstructionError: [1, { Custom: 6054 }] }, logs: [] })!.title, want);
  assert.match(friendlyError("Transaction simulation failed: custom program error: 0x17a6").title, want);
  assert.match(friendlyError("Error Code: NativeAboveAvailable. Error Number: 6054.").title, want);
});

const LOCAL = "http://127.0.0.1:8899";
const signer = createLocalTestWallet("localnet", () => "localnet");

function state(): AppState {
  const live = { generation: 1, rpcUrl: LOCAL, cluster: "localnet" as const, signerId: signerId(signer), signer, signerEpoch: 3, mainnetAck: false };
  return {
    net: { generation: 1, rpcUrl: LOCAL, cluster: "localnet", genesisHash: "g", loopback: true, connection: {} as never },
    signer,
    mainnetAck: false,
    explorer: { mainnet: "", testnet: "", localnet: "" },
    go: () => {},
    sendPending: false,
    startSend: () => {},
    sends: [],
    sendTick: 0,
    live: () => live,
    attempted: new Set(),
    unresolved: [],
    switchNetwork: () => {},
  };
}

test("review panel: an old program's failed simulation shows the upgrade message and no Sign & send", () => {
  const review: Review = {
    id: 7,
    title: "Withdraw native XNT",
    generation: 1,
    signerEpoch: 3,
    rpcUrl: LOCAL,
    cluster: "localnet",
    payer: signer.publicKey,
    plan: { txs: [], fund: k() },
    rows: [],
    sentences: ["You move 1 XNT (native) from the fund account to your wallet."],
    warnings: [],
    sims: [{ label: "withdraw_native", size: 250, signers: [signer.publicKey], logs: FALLBACK_LOGS, err: { InstructionError: [1, { Custom: 101 }] }, unitsConsumed: 1 }],
    accounts: [],
    simOk: false,
    nothingToDo: false,
  };
  const html = renderToString(<ReviewPanel s={state()} review={review} onClose={() => {}} />);
  assert.match(html, /data-testid="sim-friendly">This program version has no native withdraw yet\./);
  assert.match(html, /Review: <!-- -->Withdraw native XNT/);
  assert.doesNotMatch(html, /sign-and-send/);
  // A passing simulation shows no extra error line.
  const ok = renderToString(<ReviewPanel s={state()} review={{ ...review, simOk: true, sims: [{ ...review.sims[0]!, err: null }] }} onClose={() => {}} />);
  assert.doesNotMatch(ok, /sim-friendly/);
  assert.match(ok, /data-testid="sign-and-send"/);
});

test("holdings: native XNT is a labelled row, 1:1 in a WXNT fund, unpriced otherwise, absent when zero", () => {
  const wxnt: MintMeta = { address: new PublicKey(WXNT_MINT), decimals: 9, tokenProgram: TOKEN_PROGRAM_ID, transferFee: undefined };
  const vaults = [{ mint: wxnt, vault: k(), balance: 3_000_000_000n }];
  const base = valueHoldings({ quote: wxnt, vaults, pools: {} });
  const v = withNative(base, wxnt.address, 1_000_000_000n);
  assert.equal(v.total, 4_000_000_000n);
  assert.equal(v.complete, true);
  assert.deepEqual(v.native, { amount: 1_000_000_000n, value: 1_000_000_000n });
  assert.equal(withNative(base, wxnt.address, 0n), base);
  assert.equal(withNative(base, wxnt.address, undefined), base);
  const other = withNative(base, k(), 1_000_000_000n);
  assert.equal(other.total, base.total);
  assert.equal(other.complete, false);
  assert.equal(other.native?.value, undefined);

  const view = { quote: wxnt, vaults, account: { quoteMint: wxnt.address } } as unknown as FundView;
  const labels = { [WXNT_MINT]: { symbol: "WXNT" } } as never;
  const html = renderToString(<HoldingsCard state={{ status: "ok", valuation: v }} view={view} labels={labels} />);
  assert.match(html, /data-testid="holding-native"/);
  assert.match(html, /XNT \(native, e\.g\. reflections\)/);
  assert.match(html, /≈ <!-- -->4\.00/);
  assert.match(html, /25%/);
  assert.match(html, /counts 1:1 as WXNT/);
  const none = renderToString(<HoldingsCard state={{ status: "ok", valuation: base }} view={view} labels={labels} />);
  assert.doesNotMatch(none, /holding-native/);
});

test("inexact balance: approximate line, 'all' refused, typed amount allowed without an upper bound", () => {
  assert.equal(nativeLine(inexact), "Native XNT on the fund: balance too large to display exactly (~9,007,199.255 XNT)");
  assert.equal(exactAvailable(inexact), undefined);
  assert.equal(exactAvailable(balance), balance.available);
  assert.equal(exactAvailable(undefined), undefined);
  assert.throws(() => parseNativeAmount("", true, inexact), /"all" is not available: the balance is too large/);
  assert.equal(parseNativeAmount("1.5", false, inexact), 1_500_000_000n);
  // No app-side upper bound: the program enforces the rent floor.
  assert.equal(parseNativeAmount("10000000", false, inexact), 10_000_000_000_000_000n);
  assert.throws(() => parseNativeAmount("0", false, inexact), /greater than zero/);
  assert.throws(() => parseNativeAmount("0.0000000001", false, inexact), /more than 9 decimal places/);
  assert.equal(nativeBlocker({ holder: true, balance: inexact }), undefined);
  assert.equal(nativeBlocker({ holder: false, balance: inexact }), NATIVE_NOT_HOLDER);
});

test("inexact balance form: 'all' disabled, amount enabled, rent-floor note shown", () => {
  const html = form({ holder: true, inexact: true });
  assert.match(html, /data-available="inexact"/);
  assert.match(html, /balance too large to display exactly \(~9,007,199.255 XNT\)/);
  assert.match(html, /type="checkbox" disabled=""[^>]*aria-label="Withdraw all native XNT"/);
  assert.doesNotMatch(html, /aria-label="Native XNT amount"[^>]*disabled/);
  assert.doesNotMatch(html, /native-blocker/);
  assert.match(html, /data-testid="native-inexact"/);
  assert.match(html, /The program enforces the rent floor/);
  // Not the holder: still the holder-only message.
  assert.match(form({ holder: false, inexact: true }), /Only the wallet that holds the fund NFT can withdraw native XNT./);
  // Exact balances show no inexact note.
  assert.doesNotMatch(form({ holder: true }), /native-inexact/);
});

test("inexact review sentences say the amount was not checked and the program enforces the rent floor", () => {
  const holder = k();
  const s = { fund: k(), holder, nftAccount: undefined, balance: inexact, amount: 2_000_000_000n, payerHoldsNft: true } as unknown as WithdrawNativeSummary;
  assert.deepEqual(withdrawNativeSentences(s), [
    `You move 2 XNT (native) from the fund account to your wallet ${holder.toBase58()}.`,
    "The fund's balance is too large to read exactly here (~9,007,199.255 XNT), so this amount was not checked in the app. " +
      "The program enforces the rent floor: it refuses any amount that would take the fund account below its rent-exempt minimum.",
    "The fund's token vaults, budgets and targets are not touched.",
  ]);
});
