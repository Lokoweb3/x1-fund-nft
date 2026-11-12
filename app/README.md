# Fund NFT owner app (local)

A local web app for the fund owner: connect an X1 wallet, list the funds whose NFT it holds, look a fund up, create a fund, deposit, withdraw, create missing vaults, and see what the keeper would crank. It is an alternative to the owner CLI (`keeper/src/cli.ts`) and builds every transaction with the same reviewed code.

```sh
cd app
npm ci             # installs exactly what package-lock.json pins
npm run dev        # http://127.0.0.1:5173
```

The dev server (`npm run dev`) and the preview server (`npm run build && npm run preview`, port 4173) bind to 127.0.0.1 only. The app has no analytics or telemetry, and it loads no external fonts or CDN scripts. The hosts it talks to:

| Host | When |
| --- | --- |
| the RPC you pick | always (reads, simulations, sends). Mint names, pools, inscription accounts and metadata are all read from it |
| the explorer (`explorer.x1.xyz`, `explorer.testnet.x1.xyz`, or your template) | only when you click a signature link |
| `www.x1inscriptions.io` and `<n>.x1ins.xyz` | only after you press **Check** on an inscription in the NFT image step: the site's NFT JSON (`/api/nft/ins/<n>.json`), a HEAD of `https://<n>.x1ins.xyz/content/<n>`, then the card image and video previews |

Nothing else. Plain image/video links you type are never loaded; the app shows them as links you can open yourself. The metadata uri of a fund NFT is shown as text, never fetched. Playwright fails a run if the page requests any other host (see Tests).

## Wallet

Backpack and any other [Wallet Standard](https://github.com/wallet-standard/wallet-standard) wallet installed in the browser appear under **Select Wallet**. They are detected automatically (`wallets=[]`). The wallet signs every transaction. The app never asks for, reads, or stores a secret key. Mobile Wallet Adapter is not bundled, because it loads Google Fonts and a remote-connection UI. A wallet's in-app browser on a phone still works.

The NFT mint of a new fund is a fresh keypair held in browser memory for that one review. It signs after your wallet signs, then it is discarded.

## Safety model

It works the same way as the CLI:

1. **Network.** Pick X1 mainnet, X1 testnet, a local validator (`http://127.0.0.1:<port>`, default 8899), or a custom URL, then press **Connect**. The app calls `getGenesisHash` and classifies the result with the keeper's `cluster.ts`. Mainnet and testnet are identified by their genesis hashes. Any other hash counts as localnet only if the URL is a loopback address. Everything else is **unknown**, and an unknown chain can never be sent to. A coloured banner shows the result: **mainnet is red**, testnet amber, localnet green, unknown grey.
2. **Mainnet acknowledgement.** On mainnet, **Sign & send** stays disabled until you tick "I understand this is X1 mainnet and uses real funds". The tick lasts for this page session only and is cleared whenever you change network.
3. **Every action** runs these steps before anything is signed:
   - build the plan with the shared planners
   - check the size with `assertPlanFits`
   - check that the program account exists and is executable. If it doesn't, you get "program … is not deployed on this RPC"
   - simulate every transaction
   - show a review: amounts in UI units, gross, fee and net for Token-2022 transfer-fee mints, the fund PDA, accounts touched, compute units, and collapsible simulation logs

   **Sign & send** appears only after every simulation passes.
4. **At send time** the app fetches the genesis hash again and runs the CLI's `assertSendAllowed` against the cluster detected at connect. It then hands the plan to the shared `sendPlan`, which sends the transactions in order. `sendPlan` compares each message before and after the wallet call and refuses one that the wallet changed. That check only covers the wallet's return value; it does not attest to what was simulated (see "Trust boundary" below). If something goes wrong part-way, the app reports what confirmed, what may have landed (with its signature to check), what was not sent, and the recovery step, **Ensure vaults** on the fund page.
5. **A send belongs to its session.** A session is the detected network (a new generation on every **Connect**), the signer, and on mainnet the acknowledgement tick. The signer is its adapter object plus a connection epoch that the adapter's own connect, disconnect and account events bump, not just its public key: another wallet with the same key, or a disconnect and reconnect of the same account, counts as a change. The session is checked after the genesis re-check, before each signature, right after the wallet returns a signature, and before each broadcast. If anything changed, the remaining transactions are reported "not sent". Transactions already submitted keep their real status and are never reported as cancelled. While a send is pending, the app blocks network changes, **Connect**, navigation, new reviews, closing the review and the test-wallet buttons, and it asks before you leave the page. Receipts and partial failures stay under **Transactions** until you dismiss them. A review is single-use: after it was sent, dismissing its receipt does not bring **Sign & send** back; a retry needs a newly built and simulated review. If a transaction's status was unknown, every later review of the same action on that fund shows the signature to check first.
6. **No stale data.** Fund views, the fund list, the quote-mint details and reviews are tagged with the network generation, RPC, fund and wallet they were read under. A reply for an older one is dropped, and a failed read clears the old view. Fund actions are enabled only for a view that matches the current network and fund.
7. **Explorer links.** Signatures link to `https://explorer.x1.xyz/tx/<sig>` on mainnet, which redirects to `explorer.mainnet.x1.xyz/tx/<sig>`, checked 2026-11-12. On testnet they link to `https://explorer.testnet.x1.xyz/tx/<sig>`. Localnet has no default link. Change the templates under **Settings**.

### Trust boundary

- **This page and its dependencies are trusted code.** They build, simulate and display every transaction. A compromised page or dependency could show one thing and ask the wallet to sign another; nothing in the page can rule that out.
- **The wallet's own prompt is your final authority.** Read what the wallet says it will sign: the network, the accounts and the amounts. If it disagrees with the review, reject it.
- **A simulation is not a guarantee.** It runs against the state at that moment. The chain can change before the transaction lands, and it can then fail or produce a different result.
- **Pinned versions are not a supply-chain proof.** `npm ci` installs exactly what `package-lock.json` pins, with integrity hashes. That makes builds reproducible; it does not show the pinned code is safe.

There is no crank button. The **Keeper status** panel is read-only. It shows which targets are due now and gives a copyable `npx tsx src/index.ts --dry-run` command. Cranking stays in the keeper.

## Shared code

The app imports the keeper's browser-safe core through the `@core` alias (`vite.config.ts`, `tsconfig.json` paths). The core lives in `keeper/src/core/` and has no `node:` imports:

| File | What the app uses |
| --- | --- |
| `cluster.ts` | genesis-hash classification, `assertSendAllowed` |
| `owner.ts` | bounds (`validateCreateFund`, mirrors `state.rs`), `planCreateFund` / `buildCreateFundIx`, `fundPda`, `fundVaults`, `assertPlanFits`, `checkPool`, transfer-fee math, `sendPlan` with an injected signer |
| `rpc.ts` | `prepareCreateFund` / `prepareDeposit` / `prepareWithdraw` / `prepareEnsureVaults`, `loadFundView`, `findFundsHeldBy`, `maxTargetsThatFit`, `simulateTx`, `assertProgramDeployed` |
| `fund.ts`, `pool.ts` | Fund decoding, due targets, XDEX pool layout |
| `mint_policy.ts` | TypeScript port of `programs/fund_nft/src/mint_policy.rs` (the mint extension allowlist), to explain a refusal before simulating |
| `token_info.ts` | what a pasted mint is: decimals, token program, transfer fee, policy, name (Token-2022 TokenMetadata, else Metaplex), wallet balance |
| `pool_finder.ts` | finds the XDEX pool for a pair with `getProgramAccounts` (dataSize 637, memcmp at 168/200 in both orders), filtered by `checkPool`, ranked by quote-side reserve; `poolDepth` |
| `nft_art.ts` | inscription links and art checks (#n PDAs, Core asset owner at offset 1, gateway comparison with an injected fetch), the fund NFT's Metaplex JSON |
| `metadata.ts`, `inscribe.ts` | attach/update metadata builders; inscribe and resume planners |

The CLI prints the same planners' summaries, and both are covered by `cd keeper && npm test` and `keeper/test/e2e-local.sh`. The app adds no transaction builder of its own.

**My funds** lists the classic SPL token accounts the wallet holds with amount 1 and 0 decimals. For each one it derives the fund PDA `["fund", mint]` and keeps the accounts that exist, are owned by the program, and decode as a Fund. **Look up a fund** accepts a fund PDA or an NFT mint.

### Create Fund wizard

**Create fund** is a plain-language wizard. It only collects answers; they become the same `CreateFundArgs` the CLI builds, pass the same bounds check (`validateCreateFund`, mirroring `state.rs`) on every edit, and go through `prepareCreateFund`, the review and `sendPlan` like every other action.

1. **Pay with.** Paste a mint (the main input), or pick one of the shortcuts in `src/lib/tokens.ts`: USDC.X, TEST, JACK, GOOGL.X, PEPE and WXNT, all X1 **mainnet** addresses from `docs/ASSUMPTIONS.md`. A local validator from `scripts/local-validator.sh` has only USDC.X and TEST. On paste the app checks that the address is a mint (and says so plainly when it is a wallet, a token account or missing), shows the name and symbol (Token-2022 TokenMetadata, else Metaplex metadata, else the curated list, else the short address; the source is shown, because a name is only a label), decimals, token program, transfer fee and your wallet's balance, and runs the client port of the program's mint extension allowlist. It also shows the size limit: "up to N tokens to buy with this pay-with token", computed with the real builders.
2. **Buy.** Paste each token. The XDEX pool is found automatically from chain data (`pool_finder.ts`), the deepest by pay-with reserve first; the depth is shown, a thin pool is flagged ("too thin" when one buy is more than half the max deviation of the reserve), and **Change pool** lists the others. Plain messages for: not a mint, the same token as pay-with, no pool for the pair, a refused extension. The review runs the planner's `checkPool` again.
3. **Shares.** Percentages (up to two decimals) for each token; whatever is left is **keep as cash**, so the total is always 100%. Converted to bps exactly (sum 10000); the cash slice is the first target, as in the CLI examples.
4. **How much and how often.** Amount per buy in UI units, and every 5 min / 15 min / 1 h / 4 h / 1 day / 1 week or a custom interval (at least 60 s). It shows what each round spends per token and "if you deposit X it lasts about N" from the program's slice arithmetic.
5. **Advanced** (collapsed): TWAP window (default 3600 s, 900-86400) and max deviation (default 300 bps, at most 500), each with one sentence; the bounds are enforced.
6. **The NFT** (see below), or "No name or picture now".
7. **Review.** Sentences first ("Every 1 hour this fund spends 0.08 USDC.X on TEST.", the cash share, the deviation guard and keeper tip, "You receive an NFT that owns this fund", rent, the metadata cost and the RPC-quoted network fees), the technical rows under **Technical details**.

The NFT mint key is generated when the wizard opens (in memory only), so the fund PDA is known before the metadata JSON is written. It is replaced once a create with it has landed.

With metadata, create is three transactions: create_fund + quote vault, `attach_metadata`, the target vaults. `attach_metadata` cannot be simulated before transaction 1 lands, because it needs the fund. The review says so ("not simulated yet") and, like the CLI, size-checks it and relies on the RPC's preflight simulation when it is sent. If a later transaction does not land, the fund page's **Set image / edit metadata** and **Ensure vaults** finish the job.

### NFT image step

Name (at most 32 bytes), symbol (at most 10), description, and the picture:

- **An X1 inscription**: `https://www.x1inscriptions.io/i/<n>` or just `<n>`. **Check** reads `["ins", u64le(n)]` and `["nft_i", u64le(n)]` under `X1insUpfkQqtsuUJvwA8A3kbnixk3qtuexex1NDJWvN` from the RPC (#63 is `6CrbZLDf…` and `Aej1SC2B…`), takes the content type and size from the on-chain header, then fetches the site's NFT JSON for `animation_url`/`files` (kept only if they point at the site or `<n>.x1ins.xyz`), sends a HEAD to the gateway, and warns if its type or length disagrees with the chain. The image is `https://www.x1inscriptions.io/api/ins/<n>?card=1&v=1`; the card and the video are previewed. **Only allow inscriptions I own** (off by default) compares the owner of the inscription's Core asset (offset 1) with your wallet.
- **Plain links** to an image and optionally a video. They are not loaded.

The app writes a Metaplex-standard JSON (name, symbol, description, image, animation_url, properties.files with types, category, and attributes: inscription number, account, NFT, content type, size, fund PDA, pay-with and buys). **Compact** (on by default) keeps it at most 600 bytes, so it fits one inscription transaction: minified, the derivable inscription fields and mint addresses left out, only the main file listed, and the description shortened if needed. The byte count is shown.

Where the metadata lives:

- **(a) Inscribe on X1** (`inscribe.ts`). Shows the live fee read from the config (0.5 XNT on 2026-11-12), a max fee (default: the current fee), the predicted number, the transaction count, the total (about **0.52 XNT** for a compact JSON: fee, rent and network fees) and the uri `https://<n>.x1ins.xyz/content/<n>`, with the trust note from `docs/X1_INSCRIPTIONS.md`. It warns prominently that signing gives the third-party, upgradeable X1 Inscriptions program access to the wallet's whole XNT balance, so inscribe from a separate wallet holding about 0.53 XNT; any wallet can pay, and **copy link** lets you attach the uri from the NFT holder's wallet with option (c). It is its own reviewed plan. After it lands the app reads the bytes back from chain and compares them before it uses the uri. If part of it failed, **Resume** goes through `prepareInscribeResume` with every earlier signed attempt, which refuses ("try again in about a minute") until each is confirmed or expired.
- **(b) Download the JSON**, host it yourself, paste its link.
- **(c) Paste an existing metadata uri.**

Costs: `attach_metadata` costs the holder about **0.016 XNT** (the metadata account's rent plus Token Metadata's 0.01 XNT fee, and the master edition); the program refuses more than 0.03 XNT. Inscribing costs about **0.52 XNT**.

**Fund detail** describes the fund in words ("Every 1 hour it spends…", "Next buy of TEST in 23 min", what is left to spend) above the tables, and has **Set image / edit metadata** for the NFT holder only (`prepareSetMetadata`: attach when there is none, otherwise an update of only the changed fields). **My funds** shows each NFT's stored name, symbol and uri, and "Create your first fund" when there are none. A dismissable **How it works** card (remembered in localStorage, inside try/catch) explains the model; "?" buttons explain fund, NFT, vault, pay-with, target, keeper, slippage and TWAP. Errors are explained with an action (for example "program not deployed" offers **Switch to Local validator to try it**), with the original text under "details".

## Local testing before the program is deployed

`scripts/local-validator.sh` starts a long-running loopback validator in X1 feature mode. It loads:

- `target/deploy/fund_nft.so` at `6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM` (build it with `anchor build --ignore-keys --arch v0`)
- the cloned XDEX program, USDC.X/TEST pool and TEST mint
- X1's Token, Token-2022 and ATA programs
- a USDC.X clone whose mint authority is a key generated in the work dir

The script uses the same isolation as `keeper/test/e2e-local.sh`: its own `-C` config, HOME and XDG isolated, a generated `--mint` key, and a validated temp work dir under the required absolute `LOCAL_SCRATCH`, deleted on exit.

```sh
# Terminal 1: start it, and fund your real browser wallet's address on the LOCAL chain.
LOCAL_SCRATCH="$HOME/fund-nft-scratch" scripts/local-validator.sh --fund-wallet <your wallet pubkey>
# It prints the RPC URL (default http://127.0.0.1:8899).

# Fund another address later, while it runs:
LOCAL_SCRATCH="$HOME/fund-nft-scratch" scripts/local-validator.sh --url http://127.0.0.1:8899 --fund-wallet <pubkey>

# Terminal 2:
cd app && npm run dev
```

`--fund-wallet` airdrops 10 XNT and mints 1000 local USDC.X to that pubkey. It refuses any non-loopback URL and any chain whose genesis hash is X1 mainnet or testnet. Use `--port N` to move the validator. It uses ports N to N+41. The script runs the real validator binary as its own child process and stops it (SIGTERM, then SIGKILL after 15 s) on exit, Ctrl-C, SIGTERM or a startup error. `LOCAL_SCRATCH=/abs/scratch scripts/test-local-validator-cleanup.sh` checks that no validator process is left, the ports are free and the work dir is gone in each case.

In the app, choose **Local validator** and enter the port (or paste the URL as a custom URL), then press **Connect**. The banner turns green. Point your wallet at the same local RPC if it shows balances; signing does not depend on the wallet's network setting. A ready-made basket is on the Create page: **fill example**, a 20% USDC.X cash slice plus 80% TEST through the cloned pool. The script also clones X1 Inscriptions (program, Metaplex Core, config, genesis pool, collection, treasury) and inscription #63 with its Core asset, so option (a) and **Check** work locally; the gateway itself serves mainnet only.

### Local test wallet (automation only)

On a localnet, and only there, **Use local test wallet** creates a keypair in browser memory that implements the same signing interface as a wallet. It is refused on any other cluster, checks the live cluster again on every signature, and disappears when you switch network. `app/test/signer.test.ts` covers this.

## Tests

```sh
cd app
npx tsc --noEmit && npm run build    # type-check (app + shared core) and production build
npm test                              # unit tests: test wallet refusal, RPC/explorer settings,
                                      # session guards on sends, stale-reply handling, wizard bps,
                                      # schedules, projections, labels, friendly errors, review
                                      # sentences, the image step's options (mock RPCs;
                                      # tsconfig.test.json resolves the shared core to app/node_modules)

# Browser smoke + e2e (Playwright 1.56.1, chromium). It starts
# scripts/local-validator.sh on port 18799 and the dev server on 5179 itself.
export LOCAL_SCRATCH=/abs/scratch PLAYWRIGHT_BROWSERS_PATH=/abs/scratch/pw-browsers
npx playwright install chromium
npm run e2e
```

The e2e flow (`e2e/app.spec.ts`):

1. connect the test wallet and fund it with `--fund-wallet`; the empty state and the How it works card show
2. the wizard: paste USDC.X (balance 1000), paste TEST, and the pool `7drPqaqc…` is selected automatically; 80% TEST so 20% is kept as cash; 0.1 per buy every hour (projection "about 4 days"); a second token equal to the pay-with token and a wallet address get plain errors; max deviation 501 is refused
3. the NFT: name, symbol, a plain image link (not loaded), option (c) a metadata uri; the review reads as sentences and says `attach_metadata` is not simulated yet; three transactions confirm
4. **My funds** shows the NFT's name, symbol and uri; the fund page describes it in words
5. **Set image / edit metadata**: change the uri (update_metadata)
6. deposit 1 USDC.X (budgets 0.2 / 0.8), withdraw 0.1 (0.18 / 0.72), **Ensure vaults**: nothing to do
7. a deposit while the test wallet holds its "prompt" open: network, **Connect**, navigation, closing the review, new reviews and the test-wallet buttons are locked; the receipt survives navigation until dismissed
8. switch to X1 mainnet: the test wallet is gone, the acknowledgement box appears, the wizard finds the USDC.X/TEST pool on mainnet (read-only `getProgramAccounts`), and a simulate-only create stops at "program … is not deployed on this RPC (https://rpc.mainnet.x1.xyz, mainnet)" with **Switch to Local validator to try it**, which works

A second test uses the X1 Inscriptions program that `scripts/local-validator.sh` clones (with Metaplex Core, the config, genesis pool, collection, treasury and inscription #63): **Check** of `https://www.x1inscriptions.io/i/63` (the two inscription hosts are answered by `page.route`, so nothing leaves the machine), the owner toggle, a compact JSON (≤ 600 bytes) inscribed as its own reviewed plan and read back from chain, then a 3-transaction create with that `https://<n>.x1ins.xyz/content/<n>` uri. `e2e/wallet-events.spec.ts` drives the wizard with mock Wallet Standard wallets.

Network assertion: the owner-flow test fails on any request to a host other than loopback and `rpc.mainnet.x1.xyz`; the inscription test also allows `www.x1inscriptions.io` and `63.x1ins.xyz`, and fails if either is requested before the Check click. The mainnet steps are read-only: genesis hash, mint and pool reads, and the program lookup.

Unverified in a browser against the real hosts: CORS on `www.x1inscriptions.io` and `<n>.x1ins.xyz` (curl with an `Origin` header got `access-control-allow-origin: *` on the NFT JSON, the content HEAD and the card on 2026-11-12), and which content type the gateway serves for an `application/json` inscription (none existed on mainnet; see `docs/X1_INSCRIPTIONS.md`). The gateway's HEAD sent no `content-length` for #63, so the size check says it could not compare.
