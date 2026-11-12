/** One-paragraph answers for the "what is this?" buttons. */
export const GLOSSARY = {
  fund: "A fund is an on-chain account that holds tokens and buys other tokens on a schedule. Nobody runs it for you: the program's rules are fixed when you create it.",
  nft: "The fund's NFT is a single token that owns the fund. Whoever holds it can withdraw the fund's tokens and change its picture. Selling or sending the NFT hands the fund over.",
  vault: "A vault is the fund's token account for one token. Deposits land in the pay-with vault; each buy moves tokens into that token's vault. Only the NFT holder can withdraw from them.",
  "pay-with": "The token you deposit. The fund spends it on the tokens you choose to buy. Every pool must trade this token.",
  target: "A token the fund buys with each round, through an XDEX pool that trades it against your pay-with token. The pool is fixed forever once the fund exists.",
  keeper: "A keeper is any bot or person who runs a fund's due buy. It is paid a 0.1% tip from that buy. This app never runs buys; the keeper in keeper/ does.",
  slippage: "How much worse than the recent average price a buy may get. The fund refuses any buy that gets more than this below the average (max deviation, at most 5%).",
  twap: "TWAP is the pool's time-weighted average price over a window (default 1 hour). The fund compares each buy with it, so a sudden price spike cannot make it overpay.",
  cash: "Keep as cash: this share of every deposit stays in the pay-with token and is never spent.",
} as const;

export type GlossaryTerm = keyof typeof GLOSSARY;
