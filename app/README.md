# Fund NFT owner app (local)

A local web app for the fund owner: connect an X1 wallet, list the funds whose NFT it holds, look a fund up, create a fund, deposit, withdraw, create missing vaults, and see what the keeper would crank. It is an alternative to the owner CLI (`keeper/src/cli.ts`) and builds every transaction with the same reviewed code.

```sh
cd app
npm install
npm run dev        # http://127.0.0.1:5173
```

The dev server (`npm run dev`) and the preview server (`npm run build && npm run preview`, port 4173) bind to 127.0.0.1 only. The app has no analytics or telemetry, and it loads no external fonts or CDN scripts. The only hosts it talks to are the RPC you pick and, if you click a signature, the explorer.

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
4. **At send time** the app fetches the genesis hash again and runs the CLI's `assertSendAllowed` against the cluster detected at connect. It then hands the plan to the shared `sendPlan`. `sendPlan` refuses a wallet that changes the transaction message, so what is sent is what was simulated. It sends the transactions in order. If something goes wrong part-way, the app reports honestly what confirmed, what may have landed (with its signature to check), what was not sent, and the recovery step: **Ensure vaults** on the fund page.
5. **Explorer links.** Signatures link to `https://explorer.x1.xyz/tx/<sig>` on mainnet, which redirects to `explorer.mainnet.x1.xyz/tx/<sig>`, checked 2026-11-12. On testnet they link to `https://explorer.testnet.x1.xyz/tx/<sig>`. Localnet has no default link. Change the templates under **Settings**.

There is no crank button. The **Keeper status** panel is read-only. It shows which targets are due now and gives a copyable `npx tsx src/index.ts --dry-run` command. Cranking stays in the keeper.

## Shared code

The app imports the keeper's browser-safe core through the `@core` alias (`vite.config.ts`, `tsconfig.json` paths). The core lives in `keeper/src/core/` and has no `node:` imports:

| File | What the app uses |
| --- | --- |
| `cluster.ts` | genesis-hash classification, `assertSendAllowed` |
| `owner.ts` | bounds (`validateCreateFund`, mirrors `state.rs`), `planCreateFund` / `buildCreateFundIx`, `fundPda`, `fundVaults`, `assertPlanFits`, `checkPool`, transfer-fee math, `sendPlan` with an injected signer |
| `rpc.ts` | `prepareCreateFund` / `prepareDeposit` / `prepareWithdraw` / `prepareEnsureVaults`, `loadFundView`, `findFundsHeldBy`, `maxTargetsThatFit`, `simulateTx`, `assertProgramDeployed` |
| `fund.ts`, `pool.ts` | Fund decoding, due targets, XDEX pool layout |

The CLI prints the same planners' summaries, and both are covered by `cd keeper && npm test` and `keeper/test/e2e-local.sh`. The app adds no transaction builder of its own.

**My funds** lists the classic SPL token accounts the wallet holds with amount 1 and 0 decimals. For each one it derives the fund PDA `["fund", mint]` and keeps the accounts that exist, are owned by the program, and decode as a Fund. **Look up a fund** accepts a fund PDA or an NFT mint.

The **Create fund** form runs the same bounds check as the CLI and `state.rs` on every edit. When you review, it also runs the CLI's XDEX pool check: the pool must be owned by XDEX and trade quote/target. It shows the honest size limit for the chosen quote mint, which is how many non-cash targets fit in one 1232-byte transaction with and without a cash slice. That limit is computed with the real builders.

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

`--fund-wallet` airdrops 10 XNT and mints 1000 local USDC.X to that pubkey. It refuses any non-loopback URL and any chain whose genesis hash is X1 mainnet or testnet. Use `--port N` to move the validator. It uses ports N to N+41.

In the app, choose **Local validator** and enter the port (or paste the URL as a custom URL), then press **Connect**. The banner turns green. Point your wallet at the same local RPC if it shows balances; signing does not depend on the wallet's network setting. A ready-made basket is on the Create page: **fill example**, a 20% USDC.X cash slice plus 80% TEST through the cloned pool.

### Local test wallet (automation only)

On a localnet, and only there, **Use local test wallet** creates a keypair in browser memory that implements the same signing interface as a wallet. It is refused on any other cluster, checks the live cluster again on every signature, and disappears when you switch network. `app/test/signer.test.ts` covers this.

## Tests

```sh
cd app
npx tsc --noEmit && npm run build    # type-check (app + shared core) and production build
npm test                              # unit tests: test wallet refusal, RPC/explorer settings

# Browser smoke + e2e (Playwright 1.56.1, chromium). It starts
# scripts/local-validator.sh on port 18799 and the dev server on 5179 itself.
export LOCAL_SCRATCH=/abs/scratch PLAYWRIGHT_BROWSERS_PATH=/abs/scratch/pw-browsers
npx playwright install chromium
npm run e2e
```

The e2e flow:

1. connect the test wallet and fund it with `--fund-wallet`
2. create a fund: cash slice plus TEST on the cloned pool, both transactions confirmed
3. find it in **My funds**
4. deposit 1 USDC.X and check the budgets, 0.2 cash and 0.8 TEST
5. withdraw 0.1 USDC.X and check the budgets, 0.18 and 0.72
6. run **Ensure vaults**: nothing to do
7. switch to X1 mainnet and check that the test wallet is gone, the acknowledgement box appears, and a simulate-only create stops at "program … is not deployed on this RPC (https://rpc.mainnet.x1.xyz, mainnet)"

The mainnet steps are read-only: genesis hash, mint and pool reads, and the program lookup. The test also fails if the page requests any host other than loopback and `rpc.mainnet.x1.xyz`.
