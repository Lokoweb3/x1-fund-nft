/**
 * Stand-in for @core/rpc.js as FundDetail and NftCard see it in the browser
 * harness: a fixed fund held by window.__harness.holder. No RPC.
 */
import { Keypair, PublicKey } from "@solana/web3.js";

const k = () => Keypair.generate().publicKey;
const quoteMint = k();
const nftMint = k();
const nftAccount = k();
const vault = k();

export async function loadFundView(_connection: unknown, _program: unknown, fund: PublicKey, now: bigint) {
  const { holder } = (window as unknown as { __harness: { holder: PublicKey } }).__harness;
  return {
    fund,
    now,
    account: { nftMint, quoteMint, targets: [], twapWindowSecs: 600, maxDevBps: 100 },
    quote: { address: quoteMint, decimals: 6, tokenProgram: k(), transferFee: undefined },
    nftAccount: { address: nftAccount, owner: holder },
    perRun: 1_000_000n,
    interval: 3600n,
    budgetTotal: 0n,
    targets: [],
    vaults: [{ mint: { address: quoteMint, decimals: 6 }, vault, balance: 5_000_000n }],
    keeperDue: [],
  };
}

export async function readNativeBalance() {
  return { exact: true, lamports: 2_501_559_040n, dataLength: 708, rentMinimum: 5_819_040n, available: 2_495_740_000n };
}

export async function readFundMetadata() {
  return { stored: undefined };
}
