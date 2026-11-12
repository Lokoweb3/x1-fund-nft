/**
 * NFT card actions: button states from wallet / holder / escrow, the
 * program-holder (escrow) check, and the card's button row render.
 * No RPC, no browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  cardActionStates,
  DEPOSIT_NOTE,
  heldByProgram,
  HELD_BY_PROGRAM_NOTE,
  HINT_CONNECT,
  HINT_HELD_BY_PROGRAM,
  HINT_HOLDER_ONLY,
} from "../src/lib/card_actions.js";
import { NftCardActions } from "../src/components/NftCard.js";

const wallet = () => Keypair.generate().publicKey;
const pda = () => PublicKey.findProgramAddressSync([Buffer.from("escrow"), wallet().toBuffer()], wallet())[0];
// The mainnet canary's NFT token account while listed: its own token-account owner.
const LISTED = new PublicKey("C58kZA7J6Lbk2iMFMmPigk4fBarKGnThkqTFnaw9hJtm");

test("escrow: a wallet holder is not a program; an off-curve owner or a self-owned token account is", () => {
  assert.equal(heldByProgram(undefined), false);
  assert.equal(heldByProgram({ address: pda(), owner: wallet() }), false);
  assert.equal(heldByProgram({ address: pda(), owner: pda() }), true);
  assert.equal(heldByProgram({ address: LISTED, owner: LISTED }), true);
  // Self-owned is caught even if the address happened to be on the curve.
  const onCurve = wallet();
  assert.equal(PublicKey.isOnCurve(onCurve.toBytes()), true);
  assert.equal(heldByProgram({ address: onCurve, owner: onCurve }), true);
});

test("states: no wallet -> everything off with 'Connect a wallet'", () => {
  for (const heldBy of [false, true]) {
    const s = cardActionStates({ wallet: undefined, holder: wallet(), heldByProgram: heldBy });
    for (const a of [s.deposit, s.withdraw, s.native]) assert.deepEqual(a, { enabled: false, hint: HINT_CONNECT });
  }
  assert.equal(HINT_CONNECT, "Connect a wallet");
});

test("states: the holder may do everything", () => {
  const w = wallet();
  const s = cardActionStates({ wallet: w, holder: new PublicKey(w.toBytes()), heldByProgram: false });
  assert.deepEqual(s, { deposit: { enabled: true }, withdraw: { enabled: true }, native: { enabled: true } });
});

test("states: any other wallet may deposit but not withdraw; unknown holder is the same", () => {
  for (const holder of [wallet(), undefined]) {
    const s = cardActionStates({ wallet: wallet(), holder, heldByProgram: false });
    assert.deepEqual(s.deposit, { enabled: true });
    assert.deepEqual(s.withdraw, { enabled: false, hint: HINT_HOLDER_ONLY });
    assert.deepEqual(s.native, { enabled: false, hint: HINT_HOLDER_ONLY });
  }
  assert.equal(HINT_HOLDER_ONLY, "Only the NFT holder can withdraw");
});

test("states: held by a program -> withdrawals off even if the holder key equals the wallet", () => {
  const w = wallet();
  const s = cardActionStates({ wallet: w, holder: w, heldByProgram: true });
  assert.deepEqual(s.deposit, { enabled: true });
  assert.deepEqual(s.withdraw, { enabled: false, hint: HINT_HELD_BY_PROGRAM });
  assert.deepEqual(s.native, { enabled: false, hint: HINT_HELD_BY_PROGRAM });
});

const row = (o: Parameters<typeof cardActionStates>[0], open: "deposit" | "withdraw" | "native" | null = null) =>
  renderToString(
    <NftCardActions states={cardActionStates(o)} open={open} onToggle={() => {}} heldByProgram={o.heldByProgram}>
      <span data-testid="the-form" />
    </NftCardActions>,
  );

test("render: three buttons; no wallet disables all with the connect hint and no panel", () => {
  const html = row({ wallet: undefined, holder: wallet(), heldByProgram: false });
  for (const a of ["deposit", "withdraw", "native"]) assert.match(html, new RegExp(`<button[^>]*disabled=""[^>]*data-testid="card-action-${a}"`));
  assert.match(html, />Deposit</);
  assert.match(html, />Withdraw</);
  assert.match(html, />Withdraw XNT</);
  assert.match(html, /data-testid="card-action-hint">Connect a wallet\.</);
  assert.doesNotMatch(html, /card-action-panel|the-form|nft-escrow/);
});

test("render: non-holder sees the holder-only hint; an open action shows its form and a close button", () => {
  const html = row({ wallet: wallet(), holder: wallet(), heldByProgram: false }, "deposit");
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*data-testid="card-action-deposit"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="card-action-withdraw"/);
  assert.match(html, /data-testid="card-action-hint">Only the NFT holder can withdraw\.</);
  assert.match(html, /aria-expanded="true"[^>]*data-testid="card-action-deposit"/);
  assert.match(html, /data-testid="card-action-panel" data-action="deposit"/);
  assert.match(html, /data-testid="card-action-close"/);
  assert.match(html, /data-testid="the-form"/);
});

test("render: held by a program -> the badge, withdrawals off, no duplicate hint line", () => {
  const html = row({ wallet: wallet(), holder: LISTED, heldByProgram: true });
  assert.match(html, /data-testid="nft-escrow"/);
  assert.ok(html.includes(HELD_BY_PROGRAM_NOTE));
  assert.equal(
    HELD_BY_PROGRAM_NOTE,
    "NFT is held by a program (e.g. listed for sale). Withdrawals are blocked until it returns to a wallet. If it sells, the buyer gets everything in the fund.",
  );
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="card-action-withdraw"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*data-testid="card-action-native"/);
  assert.doesNotMatch(html, /card-action-hint/);
});

test("deposit note wording", () => {
  assert.equal(DEPOSIT_NOTE, "Deposits become part of the fund and belong to whoever holds the NFT.");
});
