# Inscribing the fund NFT's metadata on X1

The fund NFT's Metaplex metadata JSON (1-2 KB) can live on chain. The X1 Inscriptions program, which a third party runs, stores the bytes in an account. The NFT's metadata `uri` then points at that program's HTTP gateway. The code is in `keeper/src/core/inscribe.ts`. The tests are in `keeper/test/inscribe*.{ts,sh}`.

Everything below was checked on 2026-11-12 against `https://rpc.mainnet.x1.xyz` and the live site, unless a line says otherwise. Nothing was signed or sent to a public network. Mainnet was only read, plus `simulateTransaction`.

## Sources

- Site: https://www.x1inscriptions.io. The JS bundle https://www.x1inscriptions.io/assets/index-BJdLofbI.js (1,992,500 bytes, sha256 `3d9d0834be66595a10caa65c25150c430bca752c68a2e461af0c6ff4652d00da`, fetched 2026-11-12) embeds two Anchor IDLs as JS object literals:
  - `program_v0.json` is the testnet IDL for `EXB36ZzVukbEQ2hHRVPDyqKV8eTrkT3fLvi65dZLiTfT`.
  - `program_v0_mainnet.json` is the mainnet IDL for `X1insUpfkQqtsuUJvwA8A3kbnixk3qtuexex1NDJWvN`.

  The bundle checks at load time that the selected IDL's `address` equals its network table's `program`.
- `docs/x1-inscriptions/idl.json` is the mainnet IDL. A parser that evaluates no code converted it from the JS literal to JSON. A `_source` key records the URL, hash and date.
- The program also has an on-chain Anchor IDL account, `6k18rmC3pk2Yeqm26pW1FaEG4Z841s76HccshUFq76DB` (authority `HjaGVTXA9az5iu8EdqNHZgm5c3FY3ohNGQZFhnjn28YK`). Its IDL is identical to the bundle's, ignoring key order and nulls. Only `metadata.name` and `metadata.description` differ.
- The bundle's network table:

  | | testnet | mainnet |
  | --- | --- | --- |
  | program | `EXB36ZzVukbEQ2hHRVPDyqKV8eTrkT3fLvi65dZLiTfT` | `X1insUpfkQqtsuUJvwA8A3kbnixk3qtuexex1NDJWvN` |
  | config | `GYpnqhhH39kUqCy6hm1rQeTU7wtDAy7nwD91S1VGeEkA` | `E33orhudcHnVwA46WejnDMXZ3HCdGQaf572r2oKcy3HP` |
  | genesis pool | `EGm3Ye67T1HwWhv1zizZ2t9cg5uT4S4ijWxQ1hAm7Hzm` | `6z9rZwLdrvkpj1zmgXvgi3znvu1b8rZqH4vmXY6z3TUe` |
  | inscriptions collection | `B3n1LKYXrGeHBJC2NK6UGbKoZh6UfM3DKVUnGh2on9T1` | `8AoC9xrB7LchjfJmdUBxMcyCLjHjSQP8ZVnjDDQadDUy` |
  | admin | `CCcJuC3B7EwAq47VCPfgbvHvjf2xkuCj6wAKxNZ7vcY2` | `HjaGVTXA9az5iu8EdqNHZgm5c3FY3ohNGQZFhnjn28YK` |
  | treasury | same as admin | `9TzfWeZRy2fjMaJ4o4msUjv8Q8VBL7qUqrDgbwnFxQ7b` |

## Which program is live

The live program is `X1insUpfkQqtsuUJvwA8A3kbnixk3qtuexex1NDJWvN`. `EXB36ZzVukbEQ2hHRVPDyqKV8eTrkT3fLvi65dZLiTfT` is the testnet deployment. On mainnet, neither EXB36... nor its config GYpnqh... exists (`getAccountInfo` returns null). On X1 testnet, EXB36... has a config with 900+ inscriptions.

- Loader: `BPFLoaderUpgradeab1e11111111111111111111111`. Programdata is `7n4GBEokJGBoNhS2baw321TKfdGA3QC52DdJjevBm1bB`.
- Upgrade authority: `HjaGVTXA9az5iu8EdqNHZgm5c3FY3ohNGQZFhnjn28YK`. This key is also the config `admin` and the IDL authority.
- Last deployed at slot 92,506,316 (2026-11-11 13:52 UTC), about 18 hours before these checks. The program is being upgraded actively.

## Accounts the inscribe path uses

`inscribe(content_type: string, total_size: u32, chunk: bytes, encoding: u8, writer: Option<pubkey>, max_fee: u64)` takes these accounts, in this order:

| # | Account | W | S | How it is derived | Mainnet |
| --- | --- | --- | --- | --- | --- |
| 0 | `config` | w | | PDA `["config"]` | `E33orhudcHnVwA46WejnDMXZ3HCdGQaf572r2oKcy3HP` |
| 1 | `inscription` | w | | PDA `["ins", u64le(config.next_inscription)]` | n=63: `6CrbZLDfaL2qmEJ66TeiFTccUhqkniVyquGu1nWcs4WU` |
| 2 | `creator` | w | s | the payer. It becomes the inscription's creator, owner and (with `writer` = None) writer | |
| 3 | `treasury` | w | | must be `config.treasury`. The site passes `new PublicKey(config.treasury)` | `9TzfWeZRy2fjMaJ4o4msUjv8Q8VBL7qUqrDgbwnFxQ7b` |
| 4 | `asset` | w | | PDA `["nft_i", u64le(config.next_inscription)]`, the Metaplex Core asset | n=63: `Aej1SC2BZbF5o5FHSu93LjspTwDjToFqBzqZeqbgTpP9` |
| 5 | `collection` | w | | PDA `["coll_i"]`, the Core collection | `8AoC9xrB7LchjfJmdUBxMcyCLjHjSQP8ZVnjDDQadDUy` |
| 6 | `nft_auth` | | | PDA `["nftauth"]`, the program's signer (no account data) | `3K1wNC1AUhV2mGSKZ4W6mqsBNPRfQB6AoefuWZAXzZmo` |
| 7 | `core` | | | pinned `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` (Metaplex Core, upgradeable on X1) | |
| 8 | `system_program` | | | `11111111111111111111111111111111` | |
| 9 | `genesis_pool` | w | | pinned by `address` in the mainnet IDL; also PDA `["genesis_pool"]` | `6z9rZwLdrvkpj1zmgXvgi3znvu1b8rZqH4vmXY6z3TUe` |

`append(chunk: bytes)` takes `inscription` (w, PDA `["ins", inscription.number]`), `writer` (w, s), `system_program`, and `config` (pinned `E33or...`).

`thaw_inscription(_number: u64)` takes `inscription`, `asset` (w), `collection` (w), `nft_auth`, `payer` (w, s), `core`, `system_program`, and `config`.

All PDAs use the program ID above. The unit tests check that n=63 derives the known inscription and asset, and that `["config"]`, `["coll_i"]` and `["genesis_pool"]` derive the addresses in the site's network table.

## How n is chosen

The program chooses n; the caller does not. Anchor derives the `inscription` and `asset` seeds from `config.next_inscription` (`"kind": "account", "path": "config.next_inscription"` in the IDL), and `inscribe` increments the counter. The client can only predict n. `planInscribe` reads it from the config and names the matching PDAs in transaction 1.

Config layout (Anchor struct, 140 bytes), then admin extensions:

| Offset | Field | Live value (2026-11-12, slot 92,669,965) |
| --- | --- | --- |
| 0 | discriminator `9b0caae01efacc82` | |
| 8 | `admin` | `HjaGVTXA9az5iu8EdqNHZgm5c3FY3ohNGQZFhnjn28YK` |
| 40 | `treasury` | `9TzfWeZRy2fjMaJ4o4msUjv8Q8VBL7qUqrDgbwnFxQ7b` |
| 72 | `fees.inscribe` u64 | **500,000,000 (0.5 XNT)** |
| 80 | `fees.claim` | 500,000,000 |
| 88 | `fees.deploy` | 1,000,000,000 |
| 96 | `fees.premium` [u64; 3] | 44, 20 and 8 XNT |
| 120 | `fees.mint` | 250,000,000 |
| 128 | `fees.market_bps` u16 | 200 |
| 130 | `next_inscription` u64 | **67** |
| 138 | `paused` bool | **0 (not paused)** |
| 139 | `bump` | 254 |
| 140 | extra fees (`set_extra_fees`): parcel, release, bridge, 3 x u64 | 0.5, 1, 0.5 XNT |
| 164 | genesis settings (`set_genesis_settings`): mint_bps, launch_bps, market_bps u16, price u64, inscribe_bps u16 | 5000, 5000, 5000, 0, **5000** |
| 180 | 4 bytes the IDL does not describe | `09000000` |

The account is 184 bytes. The `set_genesis_settings` doc comment says it adds 14 bytes, but its five arguments take 16. The decoder reads 16, which accounts for the live account's length up to its last 4 unknown bytes. `decodeInscriptionConfig` returns those 4 bytes as `unknownTail`. A fixture of this account is in `keeper/test/fixtures/x1-inscriptions-config.json`, with its slot and fetch time.

## Race safety

If someone else inscribes between our config read and our transaction 1, the config's `next_inscription` has moved on. The PDAs in our transaction then no longer match the seeds, so Anchor fails the transaction with `ConstraintSeeds` (2006). Nothing is created, and no fee or rent is charged. With preflight on (sendPlan's setting), the RPC rejects it before it lands, so not even the network fee is spent. Sent with skipPreflight, it would land, fail, and cost only the network fee. `sendPlan` stops at the first failure, so no `append` is sent. An `append` to #n also checks that #n's writer signed (`ConstraintHasOne`, 2001). The plan therefore cannot write into anyone else's inscription, and it never writes to a number other than the one it predicted.

The local e2e test shows this. Two plans are made from the same config read, both predicting #67. The first one lands. The second fails at transaction 1 with 0x7d6, and the rival's balance is unchanged. The rival's stray `append` to #67, sent on its own, fails with 0x7d1. #67 still holds the first payer's bytes.

On such a failure, read the config again and plan again. The new plan gets the next number and a new uri.

## Fee model and max_fee

What the payer pays for one inscription (simulated on mainnet for a 1536-byte JSON, payer `99jYyWGJwnj9yZX7KmELKyKA3bNg5epgN8S3933WY2tM`):

| | Lamports | Where it goes |
| --- | --- | --- |
| inscribe fee (`config.fees.inscribe`) | 500,000,000 | 250,000,000 to the treasury and 250,000,000 to the genesis pool (`inscribe_bps` 5000) |
| inscription account rent | 8,630,400 after tx 1 (1112 bytes). 13,056,960 once complete (1748 bytes = 212 + 1536) | rent, held in the inscription account |
| Core asset | 6,483,360 after tx 1 (588 bytes). 6,406,800 after thaw (545 bytes) | 4,983,360 is rent-exemption for 588 bytes. The other 1,500,000 matches Metaplex Core's create fee, which Core keeps in the asset account. That attribution is an inference |
| network fees | 1,201,500 + 201,500 + 1,001,500 = 2,404,500 with the default compute limits | validators |

The total is about 0.522 XNT. On the local validator, where the network fee is 5,000 per transaction, the payer spent 519,478,784 lamports.

`max_fee` protection: the program refuses with `FeeChanged` (6069, "The fee changed since you looked") if `config.fees.inscribe` is above `max_fee`. The e2e test checks this: `max_fee = fee - 1` is refused and nothing is created. `planInscribe` sends `max_fee` = the fee it just read, not the caller's cap. Any increase before the transaction lands is therefore refused on chain. `planInscribe` also refuses up front if the fee it read is above the caller's `maxFee`.

What `max_fee` does not cover:

- Rent. It is fixed by the size: 212 + `total_size` bytes for the inscription, plus about 545-588 bytes for the asset.
- Core's create fee (1,500,000).
- Network fees.

X1 sets the network fee by the requested compute-unit limit, about 10 lamports per CU. Without `setComputeUnitLimit`, each instruction counts as 200,000 CU and costs 2,000,000 lamports. `planInscribe` therefore sets a limit per transaction: `COMPUTE_UNITS` = inscribe 120,000, append 20,000, thaw 80,000. Measured usage on the local validator was 79,284-79,460 for inscribe, 7,726-7,876 for a 900-byte append, and 59,661-59,811 for append + thaw. Mainnet simulation measured 79,627 for inscribe.

The admin can change every fee, the treasury, and the genesis share. `update_config` takes a whole new `Fees` struct. The IDL documents caps only for the extra fees and the genesis claim price (each at most 200 XNT) and for `market_bps` (at most 10%). It shows no cap on `fees.inscribe`. That is why the per-transaction `max_fee` matters. `max_fee` limits only the inscribe fee.

## Chunk size and transaction limits

- `inscribe` carries the first chunk. `append` carries each later chunk, in order, from the writer only. The inscription seals when `written == total_size`. The account is not allocated at full size up front. For the 1536-byte plan it was 1112 bytes (212 + 900) after tx 1 and 1748 (212 + 1536) at the end. A 600-byte single-transaction inscription was 812 bytes. The writer pays the rent for the growth (`append` takes the system program).
- Chunk sizes are the site's own: first chunk at most 600 bytes, then at most 900 per `append`. The bundle uses `r.subarray(0,600)` and `Math.ceil((size-600)/900)`. `planInscribe` uses the same sizes and checks every transaction against 1232 bytes (`assertPlanFits`).
- Transaction sizes, with the payer as the only signer and one compute-limit instruction:

  | Transaction | Size |
  | --- | --- |
  | inscribe with a 600-byte chunk | 1154 |
  | append of 900 bytes | 1222 |
  | append of 36 bytes + thaw | 512 |

  The largest final append that still carries the thaw is 755 bytes. Above that, the thaw gets its own transaction.
- `inscribe_big` writes only the header. Its content goes to `Part` accounts through `write_chunk`, in any order. The site uses it for big files (encoding 128/129 on chain). It is not needed for metadata JSON, so this code does not use it.
- The program's size limit is 1 byte to 400 KB for `inscribe` (error 6002). This planner caps content at 16 KiB.

## Is 1.5 KB one transaction?

No. A 1536-byte JSON takes **3 transactions**:

1. inscribe with 600 bytes.
2. append 900 bytes.
3. append 36 bytes + thaw.

1500 bytes also takes 3, because the final 900-byte append leaves no room for the thaw, so the thaw is sent alone. Content up to 600 bytes is 1 transaction, sealed at once, and its NFT is never frozen. 601 to 1355 bytes takes 2 transactions.

With gzip (`encoding` 1), 1.5 KB of JSON would probably fit in 2. On mainnet, the gateway served gzip inscription #21 (42,298 bytes stored) decompressed, as 84,345 bytes of `image/jpeg`. `planInscribe` accepts `encoding: 1`, but then it cannot check that the content is JSON. The default stays raw.

## Encoding values

The `encoding` argument is 0 for raw and 1 for gzip (error 6026 for anything else). The stored `Inscription.encoding` also sets bit 7 for `inscribe_big` inscriptions. Mainnet has 128 (big, raw) and 129 (big, gzip), for example #63 = 128. `ENCODING_BIG_FLAG` = 0x80.

## The paused flag

`config.paused` is the bool at byte 138. "Every user action is refused while paused" (error 6000 `Paused`). The admin sets it with `update_config`. It was 0 on 2026-11-12. `planInscribe` refuses a paused config before building anything. `prepareInscribe` reads the config right before planning. A pause between that read and the send makes transaction 1 fail on chain, charging only the network fee, or nothing if preflight catches it.

## What the payer receives

- The **inscription account** `["ins", n]`. The payer is its `creator`, `owner` and `writer`. The 212-byte header holds the number, owner, creator, slot, district, content_type (64-byte array plus length), total_size, written, sealed, price, encoding, writer and bump. The content follows the header in the same account.
- A **Metaplex Core asset** `["nft_i", n]`, owned by the payer. Its name is "Inscription #n", it is in the `["coll_i"]` collection, and its uri is `https://www.x1inscriptions.io/api/nft/ins/<n>.json`, the site's own NFT JSON. While the upload is unfinished, the asset has a FreezeDelegate plugin, held by `["nftauth"]`, with frozen = true. `thaw_inscription`, which anyone may call once the inscription is sealed, unfreezes it and revokes the program's authority. `planInscribe` adds the thaw to its last transaction. The e2e test checks that the asset is frozen after transaction 1 of a multi-transaction upload and not frozen at the end.
- The inscription can be listed, sold and transferred through the same program. Its ownership is separate from the fund NFT. The fund NFT only points at it by URL.

## Gateway

Three forms serve the same bytes:

| URL | `fetch()` | Browser navigation |
| --- | --- | --- |
| `https://<n>.x1ins.xyz/content/<n>` | 200 | 200, with `content-security-policy: sandbox; default-src 'none'; ...` |
| `https://www.x1inscriptions.io/api/ins/<n>` | 200 | 307 to the first form |
| `https://www.x1inscriptions.io/content/<n>` | 200 | 307 to the first form |

All three send `access-control-allow-origin: *` and `x-content-type-options: nosniff`. They send `cache-control: public, max-age=86400`, except #61 (text/html), which got `max-age=300`. `/api/ins` also answers range requests (206).

**Chosen: `https://<n>.x1ins.xyz/content/<n>`** (`inscriptionUri`). Reasons:

- The site itself uses this form in Core NFT metadata. `https://www.x1inscriptions.io/api/nft/ins/63.json` has `"animation_url": "https://63.x1ins.xyz/content/63"`.
- It never redirects. The `/api/ins` form sends browsers to it anyway, so `/api/ins` depends on both domains, while this form depends on one.
- The site's docs say that "a file never shows under our address": content gets its own origin per number.

Content type: **no inscription with content type `application/json` exists on mainnet yet**. #0-#66 were scanned on 2026-11-12. Their types are text/javascript, font/woff2, image/png, image/jpeg, video/mp4, image/webp, text/plain;charset=utf-8 and text/html. So I could not confirm that the gateway serves JSON as `application/json`. What I could check:

- The gateway does not always pass the stored type through. #61 is stored as `text/html` and is served as `text/plain; charset=utf-8` on both forms.
- #32 (`text/plain;charset=utf-8`, 46 bytes) is served with that type. Its body equals the on-chain bytes.
- #21 (gzip `image/jpeg`) is served decompressed as `image/jpeg`.
- The gateway only serves mainnet. Testnet has `application/json` inscriptions (#430 raw, 7 bytes, and 10 gzip ones), but `/api/ins/430?net=testnet` and the subdomain form both return 404 "no such inscription".
- The site lists `application/json` among text types it uploads and previews. It also treats `application/json` like `text/*` when uploading.

The first real fund-metadata inscription should be followed by a check of `curl -sI https://<n>.x1ins.xyz/content/<n>` for its `content-type`. Most Metaplex consumers parse the body as JSON whatever the header says, but a `text/plain` answer would be a compatibility risk with strict clients.

## Trust assumptions

1. **A third-party, upgradeable program.** `X1ins...` is upgradeable by `HjaGVTXA9az5iu8EdqNHZgm5c3FY3ohNGQZFhnjn28YK`, which was last used 2026-11-11. An upgrade could change any behavior described here, including the seeds, the fee checks, the instruction layout, or whether bytes stay put. The source is not public. Everything here comes from the IDL plus observed behavior. The e2e test runs the program bytes cloned at test time, so it tests the current version only.
2. **One admin key.** The same key can pause the program (stopping new inscriptions and every other user action), change all fees and the treasury, and redirect the genesis share. Pausing does not delete existing inscriptions as far as the IDL shows: there is no instruction that closes or edits a sealed inscription's bytes. That is an inference from the IDL, not a guarantee.
3. **Metaplex Core** (`CoREENxT...`) is also an upgradeable program on X1. The inscription's NFT depends on it. The fund NFT's metadata does not.
4. **The gateway is off-chain HTTP.** `x1ins.xyz` and `www.x1inscriptions.io` are operated by the same third party (served by Vercel). They can go down, change their URL scheme, rewrite content types (as with text/html served as text/plain), filter content (the site describes a "scam scan" for pages), or serve bytes that differ from the chain. The fund NFT's `uri` is only as available as that domain. The bytes on chain stay readable by anyone with an RPC (`fetchInscription`), but wallets follow the URL, not the chain.
5. **The predicted number is a prediction.** It is safe (see "Race safety") but not guaranteed. The metadata uri can only be set on the fund NFT after the inscription lands at a known n.
6. **The IDL comes from the site's bundle** and was cross-checked with the on-chain IDL account. Both are published by the same operator. Neither proves what the deployed bytecode does; the local e2e test does that, for the version cloned at test time.
7. **Fees go to the third party's treasury and genesis pool.** That is 0.5 XNT per inscription at today's config.

## Tests

- `keeper/test/inscribe.test.ts` (part of `npm test`) covers:
  - PDAs against known mainnet addresses.
  - Decoding of the captured config, #32 and #63 accounts (`test/fixtures/*.json`, captured 2026-11-12 by `test/capture-inscription-fixtures.ts`), cross-checked with Anchor's coder.
  - Instruction bytes and account metas against Anchor's coder and the IDL.
  - Chunking, thaw placement and transaction sizes.
  - Refusals (paused, fee over max, bad content, oversized budget prefix), stale-config refusal, and resume checks.
- `keeper/test/inscribe-simulate.ts` (`npm run simulate:inscribe`) is a mainnet SIMULATE-ONLY run for a 1536-byte JSON. Only tx 1 can succeed in isolation: the appends need the account tx 1 would create, so they fail with `AccountNotInitialized`.
- `keeper/test/inscribe-e2e.sh` (`E2E_SCRATCH=/abs/dir npm run e2e:inscribe`) clones the program, Core, the config, genesis pool, collection and treasury onto a loopback validator. It inscribes JSON with throwaway payers, reads the bytes back from chain and compares them. It also exercises the race, `FeeChanged`, resume and freeze/thaw paths, then checks with `pgrep` that no validator from the run is left. It uses the same isolation as `e2e-local.sh`, on ports from 19139.
