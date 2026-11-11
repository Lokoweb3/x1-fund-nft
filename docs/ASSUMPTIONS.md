# Assumptions and verification

Checked on 2026-11-11 against `https://rpc.mainnet.x1.xyz` unless a row says otherwise. Nothing in the program hard-codes a JACK, PEPE, or GOOGL.X mint or pool.

## Layouts that matched

| Item | Spec | On chain |
| --- | --- | --- |
| Pool `7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD` | 637 bytes, discriminator `f7ede3f5d7c3de46` | 637 bytes, same discriminator, owner `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` |
| `amm_config` at offset 8 | `2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c` | matches |
| `token_0_vault` at 72 | not named in the spec | `E52PrH4XT4fTdPZMPXwtwigdQv9C2yQF8stm2EReUbHL`, owner is the authority below |
| `token_1_vault` at 104 | not named | `Hyvb75SAvMof44331mgAhpAT59jxP2DVe9fTFXXLUoRp`, same owner |
| `token_0_mint` at 168 | USDC.X | `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq` |
| `token_1_mint` at 200 | TEST | `C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz` |
| token programs at 232 and 264 | not named | both `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| `observation_key` at 296 | `6EV7aqfYx15yVPdBANkaEBdLpKUkyQrC6thUAy5CCi4y` | matches |
| Amm config | 236 bytes, `trade_fee_rate` u64 at offset 12, value 2800 | 236 bytes, discriminator `daf42168cbcb2b6f` (`account:AmmConfig`), value 2800. Also read, not used: `protocol_fee_rate` 250000 at 20, `fund_fee_rate` 50000 at 28 |
| Observation | 4075 bytes, discriminator `7aaec5358109a584` | matches (`account:ObservationState`). `initialized` 1 at byte 8, `observation_index` 79 at byte 9, `pool_id` is the pool at byte 11. 100 entries start at byte 43. Bytes 4043..4075 are zeros |
| USDC.X | Token-2022, 6 decimals, no transfer fee | owner Token-2022, decimals 6, supply present, no TLV type 1 |
| TEST | Token-2022, 9 decimals, 5% fee, no fee cap | decimals 9, TLV type 1 length 108, both schedules epoch 391, maximum `u64::MAX`, 500 bps |
| `swap_base_input` | discriminator `8fbe5adac41e33de`, then `amount_in` u64, `minimum_amount_out` u64, 13 accounts in the listed order | reference tx `5Uf4bGC8H9QP4B8ghwYkz66iebg1VURKVso6qnizC2yQgU78s8Emt1u5AJMsgdCvvZbNdVDRFoYiByS4jToGe3bT` inner instruction matches, including authority `9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU`. Data is amount 200000 and min-out 5083957157322. IDL account order matches. IDL marks the payer as signer and not writable |

The reference swap's `SwapEvent` (`sha256("event:SwapEvent")[:8] = 40c6cde8260871e2`) reports `input_amount` 200000, `output_amount` 10272680604408 (10,272.680604408 TEST), `input_transfer_fee` 0, `output_transfer_fee` 513634030221. That output fee is `ceil(output_amount * 500 / 10000)`.

Pool and config discriminators match `sha256("account:PoolState")`, `account:AmmConfig`, and `account:ObservationState`. The published IDL's `metadata.address` is `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf`, not the mainnet program. The spec said to ignore that address. The program does not hard-code either id; the caller passes the pool and the program checks it owns the pool, config, and observation.

## Trade-fee denominator

`trade_fee_rate` 2800 with denominator `1_000_000` reproduces the reference swap exactly.

The event's vault-before fields are the reserves after protocol and fund fees, not the raw vault balances. Raw token-1 vault minus the event's output reserve equals the current `protocol_fees_token_1 + fund_fees_token_1` (`227880638040372`). Using those reserves:

- fee = 200000 * 2800 / 1_000_000 = 560
- net = 199440
- `floor(reserve_out * 199440 / (reserve_in + 199440))` = 10272680604408, the executed output

Denominators 10_000, 100_000, 10_000_000, and 1_000_000_000 with rate 2800 do not match. Rates 2796 through 2800 also truncate to net 199440 on this one trade, so this swap alone does not separate 2796 from 2800. The account stores 2800, and 2800 / 1_000_000 is the unique conventional rate that both matches the stored value and the output. The program uses `1_000_000`.

`floor(amount * (denom - rate) / denom)` equals `amount - ceil(amount * rate / denom)`. That is the net input used above.

## What the spec did not spell out, and what the code does

- Quote withdrawals reduce budgets in proportion to the **current** budgets, not the original weights. Flooring remainder is taken from the earliest budget that still has room. A withdrawal of at least the sum of budgets sets every budget to zero. The integration test checks 100_000 against budgets 200_000 and 400_000 becomes 166_666 and 333_334.
- Deposit rounding remainder goes to target 0, as specified.
- `last_run` starts at 0, so the first crank is due immediately for any normal interval.
- The fund NFT is a classic SPL token mint (decimals 0, no freeze authority, mint authority removed). `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` was executable on X1 mainnet at verification time. Token-2022 was also executable, at `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. The associated-token program `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` was executable there too.
- `create_fund` does not require the target mint accounts to be present. A bad mint or pool is permanent and fails at `execute_dca`.
- The cash slice is the target whose mint equals the quote mint. Its pool must be the all-zero pubkey. Every other target must pin a non-default pool. Mints are unique, pools other than the default are unique, each weight is non-zero, and the weights sum to 10_000. At most 8 targets.
- `dt == 0` is rejected even when `twap_window_secs / 2` is 0, because the average divides by `dt`.
- When the direct x32 price and the opposite x32 price are equal, the quote uses the direct side.
- The tip token account must be owned by the crank signer and use the quote mint.
- A quote withdrawal's destination must be owned by the NFT holder. The NFT token account must contain amount 1 and name the holder as owner.
- `anchor-spl` 1.2.2 `token_interface::mint_to` passes account infos as `[destination, mint, authority]`. `spl_token_2022::instruction::mint_to` orders them `[mint, destination, authority]`. `create_fund` invokes that instruction directly. `transfer_checked` and `set_authority` use the helpers; their account order matches the instruction builders.
- The pool authority is not a field in `PoolState`. The keeper reads the owner at byte 32 of the input vault token account. On the USDC.X/TEST pool that owner is the authority in the spec.
- Epoch selection for a transfer fee uses the Token-2022 rule: the newer schedule once `clock.epoch >= newer.epoch`, otherwise the older one. TEST's two schedules are identical, so mainnet does not show which branch is live. The field layout itself was read off the mint.
- `minimum_amount_out` in the reference swap (5083957157322) is below both the pre-fee output and the post-fee amount, so that transaction does not show which side the pool compares. The program passes the post-fee TWAP minimum, which is what the spec describes, and then requires the vault's balance increase to be at least that minimum. The cloned-pool test's swap was accepted with that minimum.

## JACK, PEPE, GOOGL.X

`GET https://api.xdex.xyz/api/xendex/pool/list?network=mainnet` returned HTTP 200 with `total: 0` and an empty `data` array (`network=devnet` and `network=testnet` did the same). The same path with no `network` parameter returned 297 rows: 135 `X1 Mainnet`, 119 `X1 Testnet`, 43 `Solana Devnet`. Those rows are listed here so they can be reviewed. They are not used by the program or the tests.

X1 Mainnet mints that appear under those symbols:

| Symbol in the API | Mint | Pools |
| --- | --- | --- |
| JACK | `54uAdhRHZmbGnD1tATH7F7Qp5us7xsXJQTf6MpMEdFbg` | 5 |
| PEPE | `81LkybSBLvXYMTF6azXohUWyBvDGUXznm4yiXPkYkDTJ` | 2 |
| GOOGL.X (the API does not use the string GOOGLE.X) | `E3v5m81RLR3ZAjNuCeMjbniCmwBUd1j2iWsvtpXiBVe5` | 5 |

X1 Mainnet pools, with the API's `tvl` field:

| Pair | Pool | TVL |
| --- | --- | --- |
| WXNT / JACK | `wdLWfF28MtU6Tns7nix5xnfGPZufFKoME4FpFyaf3VW` | 676.20 |
| JACK / Test | `BkydiVjKjbuV8CJKeokn7N6LCTu3fVJfMR6wzTGQtjci` | 628.24 |
| JACK / SPCX.X | `CP2bEJEwdoyjd93juBuEms8kfXAmW9kfFx312KfmadPZ` | 290.91 |
| JACK / GOOGL.X | `EZAj2REkBY3b9pvwvmxnomV7xpBSHosZFH5t8tH6X9Cu` | 663.97 |
| JACK / USDC.X | `FKVrYhtiiehe8HdzHd6nBerPp9khcRaxvttDghzuzP1z` | 268.08 |
| WXNT / PEPE | `VmZfZnHzFTKSf19ZvAxa4duzChve3JYHVCPq1FvezhN` | 3482.28 |
| PEPE / Test | `E7QDpTZCPFnrw3a4nDkpTYSmVD6yMq3vpUTxAhNvarMu` | 155.79 |
| Test / GOOGL.X | `RbAdtoqyPqKMzNvyPPW68MsEFBGa4P56KmapSCVhSv5` | 1397.76 |
| USDC.X / GOOGL.X | `8MFEMQNdgES25bfhNuo2xAmbES6kiPHhKD27cZwkT2dj` | 1469.78 |
| SPCX.X / GOOGL.X | `9jzzBgbFTxBL65DhrFVwvmiYMnk73MKUJLB3r8qUtG4t` | 209.41 |
| WXNT / GOOGL.X | `HqKGLmKZ2r8qVbnwdQ5n9bYoyRKjwX25oebtuuAEn5b8` | 1142.97 |

`Test` in the API is mint `C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz`, the spec's TEST mint. USDC.X is `B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq`. The USDC.X/TEST pool in the same response is `7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD` with TVL 3732.19, which matches the account reads. There is also an X1 Testnet WXNT/PEPE pool `5vfq8dsnMqnP4w9WmZYCv4VjcwXK1sfTQy6rprvHK6ah` (TVL 431.01); that mint is not the mainnet PEPE mint above.

## Unverified

- Whether XDEX compares `minimum_amount_out` to the pre-fee or post-fee amount. The clone test only shows that a post-fee minimum was accepted.
- The transfer-fee epoch rule, as noted above. The byte layout is verified.
- PDA seeds for the pool authority. The address was taken from the reference transaction and from the vault token-account owner, not derived.
- That every XDEX pool uses this same 637-byte layout. Only the USDC.X/TEST pool was decoded.
- Behavior of a classic (non-Token-2022) quote or target mint on X1, other than the fund NFT itself.
- Testnet XDEX program id, pool addresses, and whether `solana airdrop` is served by `https://rpc.testnet.x1.xyz`.
- The API's `tvl` units and how it picks among several pools for one pair. The numbers above are the raw field.
- Agave 4.4.1 and Anchor's `solana-v4` feature were not built or tested.
- `anchor-spl` 1.2.2's `mint_to` account order was read from the crate source and avoided. It was not executed.

## Design risks

- **Stale TWAP.** The quote never checks that the newest observation is close to `Clock::unix_timestamp`. Entries are written only on swaps, at least 15 seconds apart, and the cloned history had a gap of 86610 seconds. The rule "use the latest sample at or before `now - window`, else the oldest, and require `dt >= window/2`" accepts a 24 hour gap for a 1 hour window. The average then includes prices from that whole gap.
- **Observation manipulation.** Anyone who can trade the pinned pool can move the cumulatives. A thin pool, or a window that only has the attacker's swaps, sets min-out. `max_dev_bps` is the only slack, and it is fixed at creation. A creator who sets it to 10_000 disables the guard. The keeper cannot tighten it.
- **Upgradeable pool program.** The fund PDA signs the swap CPI. An upgrade of XDEX can change what that signature is allowed to do, including draining the vault, even if this program has been made immutable.
- **Tip and schedule griefing.** The first caller after the interval takes 10 bps and sets `last_run`. A dust budget still counts as a run when the slice is non-zero, which pushes the next buy out by a full interval. The caller cannot set the price, but they choose the moment inside the deviation band.
- **Rounding.** Deposit dust always accrues to target 0. Over many small deposits that target's budget runs ahead of its weight.
- **Withdraw versus budgets.** Withdrawing the quote shrinks every remaining budget, including targets that have not bought yet. Withdrawing a bought token does not put quote budget back. A direct transfer of quote into the vault is not added to budgets; the holder can withdraw it, and a withdrawal at least as large as the budget sum zeros the budgets even if some quote is left over. That leftover cannot be swapped until a later deposit credits new budget.
- **Pinned pool is forever.** A pool with a bad fee, a disabled status bit, or a thin book cannot be replaced. There is no admin to pause the fund.
