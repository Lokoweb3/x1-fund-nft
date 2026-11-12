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

Pool and config discriminators match `sha256("account:PoolState")`, `account:AmmConfig`, and `account:ObservationState`. The published IDL's `metadata.address` is `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf`, not the mainnet program. The spec said to ignore that address. `execute_dca` requires the pool program to be `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN`, or `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf` when built with the `testnet` feature, and checks that it owns the pool, config, and observation.

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
- The fund NFT is a classic SPL token mint (decimals 0, supply 1). `create_fund` leaves its mint and freeze authority with the fund PDA. `attach_metadata` hands both to the Token Metadata master-edition PDA (see "Fund NFT metadata" below). `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` was executable on X1 mainnet at verification time. Token-2022 was also executable, at `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. The associated-token program `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` was executable there too.
- `create_fund` takes the quote mint as a named account and every non-cash target mint as a remaining account, in target order, skipping the cash slice. Each key must match and each mint must pass the extension allowlist below. A bad pool is still permanent and fails at `execute_dca`.
- The cash slice is the target whose mint equals the quote mint. Its pool must be the all-zero pubkey. Every other target must pin a non-default pool. Mints are unique, pools other than the default are unique, each weight is non-zero, and the weights sum to 10_000. At most 8 targets.
- `dt == 0` is rejected even when `twap_window_secs / 2` is 0, because the average divides by `dt`.
- The quote always uses the cumulative that prices the swap direction (output per input). It never inverts the opposite side. A directional x32 average below `1 << 16` is rejected, so flooring the average costs at most 2^-16 of the price.
- Parameter bounds: `max_dev_bps` at most 500, `twap_window_secs` in 900..=86_400, `interval_secs` at least 60. `execute_dca` rejects a min-out of 0.
- The tip token account must be owned by the crank signer and use the quote mint.
- A quote withdrawal's destination must be owned by the NFT holder. The NFT token account must contain amount 1 and name the holder as owner.
- `anchor-spl` 1.2.2 `token_interface::mint_to` passes account infos as `[destination, mint, authority]`. `spl_token_2022::instruction::mint_to` orders them `[mint, destination, authority]`. `create_fund` invokes that instruction directly. `transfer_checked` and `set_authority` use the helpers; their account order matches the instruction builders.
- The pool authority is not a field in `PoolState`. The keeper reads the owner at byte 32 of the input vault token account. On the USDC.X/TEST pool that owner is the authority in the spec.
- Epoch selection for a transfer fee uses the Token-2022 rule: the newer schedule once `clock.epoch >= newer.epoch`, otherwise the older one. TEST's two schedules are identical, so mainnet does not show which branch is live. The field layout itself was read off the mint.
- `minimum_amount_out` in the reference swap (5083957157322) is below both the pre-fee output and the post-fee amount, so that transaction alone does not show which side the pool compares. A direct swap on the cloned pool does. A 20_000 raw USDC.X swap matched the reserve formula exactly, including the 5% ceiling fee. The same size swap with `minimum_amount_out` set to one raw unit above that post-fee amount, and still below the pre-fee amount, was rejected with XDEX error 6005 `ExceededSlippage` ("Exceeds desired slippage limit"). The pool therefore compares the minimum to the amount the destination receives after the output transfer fee. The fund program passes that post-fee figure, and the clone test checks the rejection.
- The XDEX IDL does not document the pool-authority seeds. Deriving `["vault_and_lp_mint_auth_seed"]` — the seed string from Raydium cp-swap, not from the XDEX IDL — against mainnet program `sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN` yields `9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU` with bump 255, which is the reference-swap authority and the pool's `auth_bump` byte. The same seed against testnet program `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf` yields `2HbqjtA9gB9c95c8KkUUWxhtNjCfYcPbvfdhcdobbq1C` with bump 251, which is the owner of testnet pool `5vfq8dsnMqnP4w9WmZYCv4VjcwXK1sfTQy6rprvHK6ah`'s token-0 vault and that pool's `auth_bump`. The program and the keeper still take the authority from the vault token-account owner rather than deriving it.

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

- The transfer-fee epoch rule, as noted above. The byte layout is verified. Both of TEST's schedules are 500 bps, so the branch is not observable on that mint.
- That every XDEX pool uses this same 637-byte layout. Only the USDC.X/TEST pool was decoded.
- Behavior of a classic (non-Token-2022) quote or target mint on X1, other than the fund NFT itself.
- Whether `solana airdrop` is served by `https://rpc.testnet.x1.xyz`. The testnet pool program id is no longer unknown: three X1 Testnet pools (`5vfq8dsnMqnP4w9WmZYCv4VjcwXK1sfTQy6rprvHK6ah`, `8LS7wHkFTozCYcqPwF51Hdd3PJvxzMB5uTah3A73tSav`, `HgoLsyGfYULwSBA1P3jnUGiTnkUSYqY79Pr4ZWccH1JX`) are 637-byte `PoolState` accounts owned by `7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf`, which is the address in the XDEX IDL. That is not the mainnet program id.
- The API's `tvl` units and how it picks among several pools for one pair. The numbers above are the raw field.
- Agave 4.4.1 and Anchor's `solana-v4` feature were not built or tested.
- `anchor-spl` 1.2.2's `mint_to` account order was read from the crate source and avoided. It was not executed.

## Fund NFT metadata

Owner decision: each fund NFT can carry Metaplex Token Metadata (name, symbol, and a `uri` pointing to a JSON document with the image). It is display only. No instruction reads it for accounting, and neither metadata instruction touches a vault, a budget or a fund field.

- Token Metadata is `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` on both X1 mainnet and X1 testnet. It is upgradeable (`BPFLoaderUpgradeab1e`), with authority `X1TMEC99KMa4MGEKfcrSJ6HZTiwvPVyrwQczZjuCoLV`, read on 2026-11-12. The program allowlists that one id, the same way it allowlists XDEX, and requires it to be executable. The `anchor-spl` 1.2.2 CPI builders hard-code the same id; a unit test checks they agree.
- `create_fund` no longer removes the NFT mint authority. The fund PDA stays mint authority and is also freeze authority, because Token Metadata refuses a master edition for a mint with no freeze authority ("Cannot create NFT with no Freeze Authority", seen on the cloned program). `create_fund` signs `mint_to` once, for the single NFT, right after it initializes the mint. No other instruction signs a `mint_to` or a freeze, and `create_fund` refuses a target whose mint is the NFT mint, so no CPI signed by the fund PDA is handed the NFT mint. The creator picks the NFT mint key, so it can be known before the targets are.
- `attach_metadata(name, symbol, uri)` uses the same holder check as `withdraw` (the decimals-0 fund mint, a token account owned by the signer with amount 1), now shared in `holder.rs`. It requires both Token Metadata PDAs to be empty, the fund PDA to be mint authority, and the supply to be 1. It CPIs `create_metadata_accounts_v3` with update authority = fund PDA, `is_mutable` true, seller fee 0, and creators, collection and uses all None. Then it CPIs `create_master_edition_v3` with max supply 0. Afterwards it requires the mint and freeze authorities to be the edition PDA and the supply to still be 1. The holder pays. On the cloned program that was a 607-byte metadata account holding 15,115,600 lamports, which is rent plus 10,000,000, consistent with Token Metadata's 0.01 creation fee, and a 20-byte edition holding 1,030,080 lamports: about 0.0161 XNT in total.
- `update_metadata(name?, symbol?, uri?)` is holder only. It requires the stored metadata to name this mint and the fund PDA as update authority. It keeps any field it is not given (trimming NUL padding), carries the stored royalty, creators, collection and uses over unchanged, and CPIs `update_metadata_accounts_v2` signed by the fund PDA. An update with no fields is rejected.
- Bounds: name at most 32, symbol at most 10, uri at most 200 bytes (Token Metadata's `MAX_NAME_LENGTH`, `MAX_SYMBOL_LENGTH` and `MAX_URI_LENGTH`), and no NUL characters, so the NUL trim on unchanged fields is lossless. Empty strings are allowed, as Token Metadata allows them.
- Creators None: the program has no creator to verify, an unverified creator entry is something anyone can write, and with a 0 royalty it would carry no payout. Leaving creators out keeps the account smaller and claims nothing.
- Who controls it: whoever holds the NFT. A transfer of the NFT moves control of the metadata with it, because the update authority is the fund PDA and only this program signs for it, after the holder check.
- Funds created before this change, if any, have no mint authority and cannot get metadata. No such fund exists on mainnet; the program has not been deployed there.
- `create_fund`'s transaction is unchanged in size. The CLI sends `attach_metadata` as a separate transaction 2 when `--name/--symbol/--uri` are given. It cannot be simulated before transaction 1 confirms, because it needs the fund, so the CLI size-checks it, says so, and relies on the RPC's preflight simulation when it sends it.

## Token-2022 mint extension allowlist

`create_fund` (quote mint and every non-cash target mint), `deposit` (quote mint), and `execute_dca` (both mints, before any CPI) reject a Token-2022 mint whose TLV data has any extension type other than the ones below. Classic SPL Token mints pass. `withdraw` does not check, so a holder can always try to take out what the vault holds. The numbers are `ExtensionType` discriminants in `spl-token-2022-interface` 2.1.0, the version `Cargo.lock` resolves (`src/extension/mod.rs`). A unit test compares each constant with that enum.

| Type | Extension |
| --- | --- |
| 1 | TransferFeeConfig |
| 3 | MintCloseAuthority |
| 10 | InterestBearingConfig |
| 18 | MetadataPointer |
| 19 | TokenMetadata |
| 20 | GroupPointer |
| 21 | TokenGroup |
| 22 | GroupMemberPointer |
| 23 | TokenGroupMember |
| 25 | ScaledUiAmount |

The scan stops at the first type-0 (`Uninitialized`) entry, as Token-2022 does. Unknown and future types are rejected. Excluded types include TransferHook, PermanentDelegate, Pausable, NonTransferable, DefaultAccountState, and the confidential-transfer extensions.

## Design risks

- **Stale TWAP (fixed).** The quote now requires the newest observation to be no older than `twap_window_secs` before `Clock::unix_timestamp` and not in the future. The older sample is the latest at or before `now - window` (else the oldest), and the span must be within `[window / 2, 2 * window]`, so a 24 hour gap no longer passes a 1 hour window. Entries are still written only on swaps, at least 15 seconds apart. A pool nobody trades for longer than the window cannot be cranked until someone swaps.
- **Inverted TWAP (fixed).** The quote used to pick the larger of the two cumulatives and invert it, which priced the reverse direction at `1 / E[P]` instead of `E[1/P]`. It now always uses the directional cumulative and rejects one below `1 << 16`.
- **Observation manipulation (narrowed).** Anyone who can trade the pinned pool can still move the cumulatives. A thin pool, or a window that only has the attacker's swaps, sets min-out. `max_dev_bps` is now capped at 500 and the window is at least 900 seconds, so a creator can no longer disable the guard. The keeper still cannot tighten it.
- **Upgradeable pool program (narrowed).** `execute_dca` now calls only the allowlisted XDEX program id (mainnet by default, testnet under the `testnet` feature). After the swap it requires the quote vault to have dropped by exactly the tip plus the swap input, and both vaults to still be owned by the fund with no delegate and no close authority. These checks only bound token movement and vault authority within one call. They do **not** bound economic loss from a compromised XDEX. XDEX owns the observation and amm-config accounts that `execute_dca` reads to compute min-out, so a malicious upgrade can write fake observations (during one swap or any other XDEX instruction), make the next min-out tiny but positive, and keep each authorized input slice. Repeated over successive cranks, that can consume **all scheduled quote funds**, not just `max_dev_bps` per run. It can also fail every swap. Removing this trust needs an independent price oracle or an immutable, verified XDEX; the post-swap checks are not a substitute. Treat the XDEX upgrade authority as a custodian of every fund's quote budget.
- **Token Metadata upgrade (display only, plus NFT freeze).** Token Metadata's upgrade authority can change what the metadata says or how it is shown. It cannot move vault funds: it never receives a vault account and never gets a fund-PDA signature outside `attach_metadata` and `update_metadata`, whose CPIs carry only the NFT mint, metadata, edition, payer and system accounts. After `attach_metadata` its edition PDA is the NFT's mint and freeze authority. A malicious upgrade could therefore freeze the holder's NFT token account. That blocks transfers of the NFT, but not withdrawals: `withdraw` checks only the account's owner and amount 1, and a frozen account keeps both. Max supply 0 is enforced by Token Metadata's code, so a malicious upgrade could also mint a second NFT unit. The `amount == 1` check means a second unit split across two accounts would let either account withdraw, and two units in one account would let neither.
- **Hostile mint extensions (fixed for new funds).** Quote and target mints must pass the extension allowlist above.
- **Tip and schedule griefing.** The first caller after the interval takes 10 bps and sets `last_run`. A dust budget still counts as a run when the slice is non-zero, which pushes the next buy out by a full interval. The caller cannot set the price, but they choose the moment inside the deviation band.
- **Rounding.** Deposit dust always accrues to target 0. Over many small deposits that target's budget runs ahead of its weight.
- **Withdraw versus budgets.** Withdrawing the quote shrinks every remaining budget, including targets that have not bought yet. Withdrawing a bought token does not put quote budget back. A direct transfer of quote into the vault is not added to budgets; the holder can withdraw it, and a withdrawal at least as large as the budget sum zeros the budgets even if some quote is left over. That leftover cannot be swapped until a later deposit credits new budget.
- **Pinned pool is forever.** A pool with a bad fee, a disabled status bit, or a thin book cannot be replaced. There is no admin to pause the fund.
