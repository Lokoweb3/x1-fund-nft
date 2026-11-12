#![allow(dead_code, unused_imports)]
//! Mainnet-clone integration test.
//!
//! A local `solana-test-validator` (Agave 4.1.2) clones the XDEX program, the
//! USDC.X/TEST pool, its config, vaults, observation, authority, and the TEST
//! mint from X1 mainnet. The USDC.X mint is the cloned account with one labeled
//! change: the mint authority is overwritten to the test payer so the test can
//! mint itself USDC.X. The transfer-fee extension bytes are left untouched.
//! USDC.X has no transfer fee. TEST keeps its real 5% fee.
//!
//! The validator also clones X1 mainnet's Tokenkeg, Token-2022, and ATA
//! programs. `FUND_NFT_FEATURES` picks the feature set:
//!
//! - unset or `x1` (default): Agave defaults, with `--deactivate-feature` for
//!   every feature X1 mainnet reports inactive, read from X1 RPC at test
//!   time, except `X1_SYSVAR_SYSCALL_EXCEPTION` (see its comment).
//! - `clone`: plain `--clone-feature-set`. Known to fail: X1's own Tokenkeg
//!   imports `sol_get_sysvar`, which Agave 4.1.2 does not register while
//!   SIMD-0127 is inactive, so the first Tokenkeg call fails with
//!   "unsupported BPF instruction".
//! - `agave`: Agave 4.1.2 defaults.
//!
//! The program must be built with `anchor build --ignore-keys --arch v0`;
//! X1 has SBPF v1 and v3 deployment inactive.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anchor_client::{Client, Cluster, CommitmentConfig};
use anchor_lang::prelude::{AccountMeta, Pubkey, System};
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::Id;
use base64::Engine;
use fund_nft::state::{CreateFundParams, TargetParams};
use fund_nft::twap::{QuoteInput, SwapDirection, TransferFee};
use fund_nft::{xdex, ID as PROGRAM_ID};
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_associated_token_account_interface::address::get_associated_token_address_with_program_id;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;

const RPC: &str = "https://rpc.mainnet.x1.xyz";
const LOCAL: &str = "http://127.0.0.1:18999";
const XDEX: &str = "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN";
const USDC: &str = "B69chRzqzDCmdB5WYB8NRu5Yv5ZA95ABiZcdzCgGm9Tq";
const TEST_MINT: &str = "C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz";
const POOL: &str = "7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD";
const AMM: &str = "2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c";
const OBS: &str = "6EV7aqfYx15yVPdBANkaEBdLpKUkyQrC6thUAy5CCi4y";
const VAULT_0: &str = "E52PrH4XT4fTdPZMPXwtwigdQv9C2yQF8stm2EReUbHL";
const VAULT_1: &str = "Hyvb75SAvMof44331mgAhpAT59jxP2DVe9fTFXXLUoRp";
const AUTHORITY: &str = "9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU";
const CLASSIC_TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/// Metaplex Token Metadata. Upgradeable on X1 mainnet (BPFLoaderUpgradeab1e,
/// authority X1TMEC99KMa4MGEKfcrSJ6HZTiwvPVyrwQczZjuCoLV, checked 2026-11-12).
const METAPLEX: &str = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
/// SIMD-0127, "Enable syscall for fetching Sysvar bytes". X1 mainnet's feature
/// account reports it inactive, yet X1's own Tokenkeg (upgradeable, last
/// deployed in slot 85798112) imports `sol_get_sysvar` and its transactions
/// succeed on X1 mainnet. Agave 4.1.2 with this feature inactive does not
/// register the syscall, so that Tokenkeg fails with "unsupported BPF
/// instruction". The x1 feature mode therefore leaves this one feature
/// active. The test asserts fund_nft.so does not import `sol_get_sysvar`, so
/// the exception cannot hide a problem in this program.
const X1_SYSVAR_SYSCALL_EXCEPTION: &str = "CLCoTADvV64PSrnR6QXty6Fwrt9Xc6EdxSJE4wLRePjq";

struct Validator(Child, PathBuf);

impl Drop for Validator {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
        let _ = fs::remove_dir_all(&self.1);
    }
}

#[test]
fn cloned_usdc_test_pool_create_deposit_dca_withdraw() {
    let payer = Keypair::new();
    let nft_mint = Keypair::new();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/clone-test");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let usdc_file = root.join("usdc-mint.authority-overridden.json");
    dump_account(USDC, &usdc_file);
    // Labeled local mutation: the cloned mint authority becomes the test payer.
    // Every other byte, including the metadata extension, stays as cloned.
    override_mint_authority(&usdc_file, &payer.pubkey());

    let ledger = root.join("ledger");
    let log_path = root.join("validator.log");
    let log = fs::File::create(&log_path).unwrap();
    let so = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/deploy/fund_nft.so");
    assert!(
        so.exists(),
        "run `anchor build --ignore-keys --arch v0` first; missing {}",
        so.display()
    );
    let so_bytes = fs::read(&so).unwrap();
    // The x1 feature mode keeps SIMD-0127 active for X1's Tokenkeg. Our own
    // program must not rely on that exception.
    assert!(
        !imports_symbol(&so_bytes, "sol_get_sysvar"),
        "fund_nft.so imports sol_get_sysvar, which X1 mainnet reports inactive (SIMD-0127)"
    );
    assert_eq!(
        u32::from_le_bytes(so_bytes[0x30..0x34].try_into().unwrap()),
        0,
        "fund_nft.so is not SBPF v0 (e_flags != 0); build with --arch v0"
    );

    let validator_bin = solana_bin("solana-test-validator");
    let mut cmd = Command::new(&validator_bin);
    cmd.arg("--reset")
        .arg("--bind-address")
        .arg("127.0.0.1")
        .arg("--rpc-port")
        .arg("18999")
        .arg("--faucet-port")
        .arg("19901")
        .arg("--ledger")
        .arg(&ledger)
        .arg("--bpf-program")
        .arg(PROGRAM_ID.to_string())
        .arg(&so)
        .arg("--url")
        .arg(RPC);
    match std::env::var("FUND_NFT_FEATURES").as_deref() {
        Err(_) | Ok("x1") => {
            let inactive = x1_inactive_features();
            println!(
                "feature mode x1: deactivating {} X1-inactive features, keeping {X1_SYSVAR_SYSCALL_EXCEPTION} active",
                inactive.len() - 1
            );
            for feature in inactive {
                if feature != X1_SYSVAR_SYSCALL_EXCEPTION {
                    cmd.arg("--deactivate-feature").arg(feature);
                }
            }
        }
        Ok("clone") => {
            println!("feature mode clone: --clone-feature-set (known to fail, see module docs)");
            cmd.arg("--clone-feature-set");
        }
        Ok("agave") => println!("feature mode agave: Agave defaults"),
        Ok(other) => panic!("FUND_NFT_FEATURES must be x1, clone, or agave, not {other}"),
    }
    // Use the token programs X1 mainnet actually runs. The validator's
    // bundled Tokenkeg fails under X1's feature set with "unsupported BPF
    // instruction". On X1 mainnet (checked 2026-11-11) Tokenkeg and
    // Token-2022 are owned by BPFLoaderUpgradeab1e, and the ATA program by
    // BPFLoader2, so it is a plain account clone.
    cmd.arg("--clone-upgradeable-program")
        .arg(CLASSIC_TOKEN)
        .arg("--clone-upgradeable-program")
        .arg(TOKEN_2022)
        .arg("--clone")
        .arg(ATA_PROGRAM);
    cmd.arg("--clone-upgradeable-program").arg(METAPLEX);
    cmd.arg("--clone-upgradeable-program")
        .arg(XDEX)
        .arg("--account")
        .arg(USDC)
        .arg(&usdc_file);
    for address in [POOL, AMM, OBS, VAULT_0, VAULT_1, TEST_MINT, AUTHORITY] {
        cmd.arg("--clone").arg(address);
    }
    let child = cmd
        .stdout(Stdio::from(log.try_clone().unwrap()))
        .stderr(Stdio::from(log))
        .spawn()
        .unwrap_or_else(|err| panic!("failed to spawn {}: {err}", validator_bin.display()));
    let mut validator = Validator(child, root.clone());
    if let Err(err) = wait_until_healthy(&mut validator.0) {
        panic!("{err}\n{}", log_tail(&log_path));
    }

    let cluster = Cluster::Custom(LOCAL.into(), "ws://127.0.0.1:19000".into());
    let client = Client::new_with_options(cluster, &payer, CommitmentConfig::confirmed());
    let program = client.program(PROGRAM_ID).expect("program client");
    let rpc = program.rpc();
    let airdrop = rpc
        .request_airdrop(&payer.pubkey(), 5_000_000_000)
        .expect("airdrop");
    rpc.poll_for_signature(&airdrop).expect("airdrop confirm");

    let usdc = pubkey(USDC);
    let test_mint = pubkey(TEST_MINT);
    let token_2022 = fund_nft::TOKEN_2022_PROGRAM_ID;
    let classic = fund_nft::NFT_TOKEN_PROGRAM_ID;
    let payer_usdc = ata(&payer.pubkey(), &usdc, &token_2022);

    let mint_ix = spl_token_2022_interface::instruction::mint_to_checked(
        &token_2022,
        &usdc,
        &payer_usdc,
        &payer.pubkey(),
        &[],
        2_000_000,
        6,
    )
    .expect("mint_to_checked");
    program
        .request()
        .instruction(to_ix(create_associated_token_account_idempotent(
            &payer.pubkey(),
            &payer.pubkey(),
            &usdc,
            &token_2022,
        )))
        .instruction(to_ix(mint_ix))
        .send()
        .expect("mint test usdc");
    assert_eq!(token_amount(&account_data(&rpc, &payer_usdc)), 2_000_000);

    let payer_test = ata(&payer.pubkey(), &test_mint, &token_2022);
    program
        .request()
        .instruction(to_ix(create_associated_token_account_idempotent(
            &payer.pubkey(),
            &payer.pubkey(),
            &test_mint,
            &token_2022,
        )))
        .send()
        .expect("payer test ata");

    // The TWAP must be fresh relative to the validator clock (which follows
    // wall clock), so the window depends on how old the cloned history is.
    // Try the cloned ring first. If no legal window fits, one small direct
    // swap writes a fresh observation (the pool writes one when the last is
    // at least 15 s old) and the choice is retried.
    let mut window = None;
    // Raw USDC.X the payer spends on the fallback swap, if it runs; the
    // payer-balance assertions below subtract it.
    let mut fallback_spent: u64 = 0;
    for attempt in 0..2 {
        let obs = account_data(&rpc, &pubkey(OBS));
        let view = xdex::read_observation(&obs).expect("cloned observation");
        assert_eq!(view.pool_id, pubkey(POOL));
        let now = clock_unix_timestamp(&rpc);
        let newest = observation_timestamp(view.ring, view.index);
        window = choose_window(view.ring, view.index, now);
        println!(
            "window probe {attempt}: validator now {now}, newest observation {newest} (age {} s), window {window:?}",
            now - newest as i64
        );
        if window.is_some() || attempt == 1 {
            break;
        }
        program
            .request()
            .instruction(direct_swap(
                &payer.pubkey(),
                &payer_usdc,
                &payer_test,
                1_000,
                1,
            ))
            .send()
            .expect("swap to write a fresh observation");
        fallback_spent += 1_000;
    }
    let window = window.unwrap_or_else(|| {
        panic!(
            "no TWAP window in {WINDOWS:?} fits the observation history, even after a fresh swap. {}",
            log_tail(&log_path)
        )
    });

    // Parameter bounds are enforced on chain: max_dev_bps 501 is rejected.
    let loose_nft = Keypair::new();
    let (loose_fund, _) =
        Pubkey::find_program_address(&[b"fund", loose_nft.pubkey().as_ref()], &PROGRAM_ID);
    let loose = program
        .request()
        .accounts(fund_nft::accounts::CreateFund {
            creator: payer.pubkey(),
            fund: loose_fund,
            nft_mint: loose_nft.pubkey(),
            creator_nft_account: ata(&payer.pubkey(), &loose_nft.pubkey(), &classic),
            quote_mint: usdc,
            token_program: classic,
            associated_token_program: spl_associated_token_account_interface::program::ID,
            system_program: System::id(),
        })
        .accounts(AccountMeta::new_readonly(test_mint, false))
        .args(fund_nft::instruction::CreateFund {
            params: fund_params(usdc, test_mint, window, 501),
        })
        .signer(&loose_nft)
        .send();
    expect_fund_error(loose, fund_nft::FundError::BadDeviation, "max_dev_bps 501");

    // The non-cash target mint must be passed as a remaining account.
    let bare_nft = Keypair::new();
    let (bare_fund, _) =
        Pubkey::find_program_address(&[b"fund", bare_nft.pubkey().as_ref()], &PROGRAM_ID);
    let bare = program
        .request()
        .accounts(fund_nft::accounts::CreateFund {
            creator: payer.pubkey(),
            fund: bare_fund,
            nft_mint: bare_nft.pubkey(),
            creator_nft_account: ata(&payer.pubkey(), &bare_nft.pubkey(), &classic),
            quote_mint: usdc,
            token_program: classic,
            associated_token_program: spl_associated_token_account_interface::program::ID,
            system_program: System::id(),
        })
        .args(fund_nft::instruction::CreateFund {
            params: fund_params(usdc, test_mint, window, 500),
        })
        .signer(&bare_nft)
        .send();
    expect_fund_error(
        bare,
        fund_nft::FundError::TargetMintAccounts,
        "missing target mint account",
    );

    // A target cannot be the NFT mint itself (its key is the creator's choice).
    let self_nft = Keypair::new();
    let (self_fund, _) =
        Pubkey::find_program_address(&[b"fund", self_nft.pubkey().as_ref()], &PROGRAM_ID);
    let self_target = program
        .request()
        .accounts(fund_nft::accounts::CreateFund {
            creator: payer.pubkey(),
            fund: self_fund,
            nft_mint: self_nft.pubkey(),
            creator_nft_account: ata(&payer.pubkey(), &self_nft.pubkey(), &classic),
            quote_mint: usdc,
            token_program: classic,
            associated_token_program: spl_associated_token_account_interface::program::ID,
            system_program: System::id(),
        })
        .accounts(AccountMeta::new_readonly(self_nft.pubkey(), false))
        .args(fund_nft::instruction::CreateFund {
            params: fund_params(usdc, self_nft.pubkey(), window, 500),
        })
        .signer(&self_nft)
        .send();
    expect_fund_error(
        self_target,
        fund_nft::FundError::TargetIsNftMint,
        "target mint equal to the NFT mint",
    );

    let stranger = Keypair::new();
    let drop_sig = rpc
        .request_airdrop(&stranger.pubkey(), 1_000_000_000)
        .unwrap();
    rpc.poll_for_signature(&drop_sig).unwrap();

    let (fund, _) =
        Pubkey::find_program_address(&[b"fund", nft_mint.pubkey().as_ref()], &PROGRAM_ID);
    let creator_nft = ata(&payer.pubkey(), &nft_mint.pubkey(), &classic);
    let params = fund_params(usdc, test_mint, window, 500);
    program
        .request()
        .accounts(fund_nft::accounts::CreateFund {
            creator: payer.pubkey(),
            fund,
            nft_mint: nft_mint.pubkey(),
            creator_nft_account: creator_nft,
            quote_mint: usdc,
            token_program: classic,
            associated_token_program: spl_associated_token_account_interface::program::ID,
            system_program: System::id(),
        })
        // Remaining accounts: non-cash target mints in target order.
        .accounts(AccountMeta::new_readonly(test_mint, false))
        .args(fund_nft::instruction::CreateFund { params })
        .signer(&nft_mint)
        .send()
        .expect("create_fund");

    let nft_data = account_data(&rpc, &nft_mint.pubkey());
    // Until attach_metadata, the fund PDA keeps the mint authority.
    assert_eq!(
        mint_authority(&nft_data),
        Some(fund),
        "mint authority is the fund"
    );
    assert_eq!(
        freeze_authority(&nft_data),
        Some(fund),
        "freeze authority is the fund"
    );
    assert_eq!(nft_data[44], 0, "nft decimals");
    assert_eq!(mint_supply(&nft_data), 1);
    assert_eq!(token_amount(&account_data(&rpc, &creator_nft)), 1);
    // Nobody but the fund PDA can mint, and only this program signs for it.
    let early_mint = program
        .request()
        .instruction(nft_mint_to(
            &nft_mint.pubkey(),
            &creator_nft,
            &payer.pubkey(),
        ))
        .send();
    assert!(
        early_mint.is_err(),
        "payer minted a second NFT before attach"
    );
    assert_eq!(mint_supply(&account_data(&rpc, &nft_mint.pubkey())), 1);

    check_metadata_flow(
        &program,
        &rpc,
        &payer,
        &stranger,
        fund,
        nft_mint.pubkey(),
        creator_nft,
    );

    let quote_vault = ata(&fund, &usdc, &token_2022);
    let target_vault = ata(&fund, &test_mint, &token_2022);
    program
        .request()
        .instruction(to_ix(create_associated_token_account_idempotent(
            &payer.pubkey(),
            &fund,
            &usdc,
            &token_2022,
        )))
        .instruction(to_ix(create_associated_token_account_idempotent(
            &payer.pubkey(),
            &fund,
            &test_mint,
            &token_2022,
        )))
        .send()
        .expect("vault atas");

    program
        .request()
        .accounts(fund_nft::accounts::Deposit {
            depositor: payer.pubkey(),
            fund,
            quote_mint: usdc,
            depositor_quote: payer_usdc,
            quote_vault,
            token_program: token_2022,
        })
        .args(fund_nft::instruction::Deposit { amount: 1_000_000 })
        .send()
        .expect("deposit");
    let stored: fund_nft::Fund = program.account(fund).expect("fund");
    assert_eq!(stored.targets[0].budget, 200_000);
    assert_eq!(stored.targets[1].budget, 800_000);

    let dca_accounts = |pool_program: Pubkey| fund_nft::accounts::ExecuteDca {
        caller: payer.pubkey(),
        fund,
        quote_mint: usdc,
        target_mint: test_mint,
        quote_vault,
        target_vault,
        caller_quote_account: payer_usdc,
        quote_token_program: token_2022,
        target_token_program: token_2022,
        pool_program,
        pool_state: pubkey(POOL),
        amm_config: pubkey(AMM),
        authority: pubkey(AUTHORITY),
        pool_input_vault: pubkey(VAULT_0),
        pool_output_vault: pubkey(VAULT_1),
        pool_input_mint: usdc,
        pool_output_mint: test_mint,
        pool_input_token_program: token_2022,
        pool_output_token_program: token_2022,
        observation_state: pubkey(OBS),
    };
    // Any program other than the allowlisted XDEX id is refused, even an
    // executable one. Token-2022 stands in for an attacker's program.
    let wrong_program = program
        .request()
        .instruction(compute_limit(1_400_000))
        .accounts(dca_accounts(token_2022))
        .args(fund_nft::instruction::ExecuteDca { target_index: 1 })
        .send();
    expect_fund_error(
        wrong_program,
        fund_nft::FundError::BadPoolProgram,
        "wrong pool_program",
    );

    let pool_out_before = token_amount(&account_data(&rpc, &pubkey(VAULT_1)));
    let exec = program
        .request()
        .instruction(compute_limit(1_400_000))
        .accounts(dca_accounts(pubkey(XDEX)))
        .args(fund_nft::instruction::ExecuteDca { target_index: 1 })
        .send();
    let sig = match exec {
        Ok(sig) => sig,
        Err(err) => panic!("execute_dca failed: {err:#}\n{}", log_tail(&log_path)),
    };

    let received = token_amount(&account_data(&rpc, &target_vault));
    let gross = pool_out_before - token_amount(&account_data(&rpc, &pubkey(VAULT_1)));
    let fee = ceil_fee(gross, 500);
    assert!(gross > 0, "pool vault did not pay TEST");
    assert_eq!(
        received,
        gross - fee,
        "5% TEST transfer fee was not the amount withheld. gross {gross} fee {fee} received {received}"
    );
    let after: fund_nft::Fund = program.account(fund).unwrap();
    assert_eq!(after.targets[1].budget, 400_000);
    assert_eq!(after.targets[0].budget, 200_000);
    assert_eq!(token_amount(&account_data(&rpc, &quote_vault)), 600_000);
    // The tip is 400 raw USDC, paid back to the caller. Started at 2_000_000,
    // deposited 1_000_000, so 1_000_000 remained, plus the 400 tip.
    assert_eq!(
        token_amount(&account_data(&rpc, &payer_usdc)),
        1_000_400 - fallback_spent,
        "payer USDC.X after deposit and tip (fallback swap spent {fallback_spent})"
    );

    // sha256("event:DcaExecuted")[..8], the tag Anchor writes for this event.
    let min_out = match min_out_from_chain(&rpc, &sig) {
        Ok(min_out) => min_out,
        Err(err) => panic!("{err}\n{}", log_tail(&log_path)),
    };
    assert!(
        received >= min_out,
        "received {received} < min_out {min_out}"
    );
    // min_out already subtracts the 5% fee, so it is below the pre-fee gross
    // even before the deviation haircut.
    assert!(min_out < gross);

    // The reference swap's min-out was below both the pre-fee and post-fee
    // amounts, so it did not show which one the pool enforces. Ask the cloned
    // program directly. First confirm the reserve formula on a fresh quote,
    // then submit the same-sized swap with min-out one unit above the
    // post-fee amount and still far below the pre-fee amount.
    let probe_in = 20_000u64;
    let (predicted_gross, predicted_recv) =
        quote_pool_swap(&account_data(&rpc, &pubkey(POOL)), &rpc, probe_in);
    let vault1_before = token_amount(&account_data(&rpc, &pubkey(VAULT_1)));
    let user_before = token_amount(&account_data(&rpc, &payer_test));
    program
        .request()
        .instruction(direct_swap(
            &payer.pubkey(),
            &payer_usdc,
            &payer_test,
            probe_in,
            1,
        ))
        .send()
        .expect("control swap with min_out 1");
    let actual_gross = vault1_before - token_amount(&account_data(&rpc, &pubkey(VAULT_1)));
    let actual_recv = token_amount(&account_data(&rpc, &payer_test)) - user_before;
    assert_eq!(
        actual_gross, predicted_gross,
        "reserve formula did not match the cloned pool"
    );
    assert_eq!(actual_recv, predicted_recv, "5% fee on the direct swap");
    let (tight_gross, tight_recv) =
        quote_pool_swap(&account_data(&rpc, &pubkey(POOL)), &rpc, probe_in);
    assert!(
        tight_recv + 1 < tight_gross,
        "probe min-out is not strictly between post-fee and pre-fee"
    );
    let tight = program
        .request()
        .instruction(direct_swap(
            &payer.pubkey(),
            &payer_usdc,
            &payer_test,
            probe_in,
            tight_recv + 1,
        ))
        .send();
    let err = tight.expect_err("pool accepted a min-out above the post-fee amount");
    let err_text = format!("{err:#}");
    assert!(
        err_text.contains("ExceededSlippage")
            || err_text.contains("6005")
            || err_text.contains("slippage"),
        "min-out one above the post-fee amount failed for a different reason: {err_text}"
    );

    let withdraw_test = received / 2;
    program
        .request()
        .accounts(fund_nft::accounts::Withdraw {
            holder: payer.pubkey(),
            fund,
            nft_mint: nft_mint.pubkey(),
            nft_account: creator_nft,
            nft_token_program: classic,
            mint: test_mint,
            vault: target_vault,
            destination: payer_test,
            token_program: token_2022,
        })
        .args(fund_nft::instruction::Withdraw {
            amount: withdraw_test,
        })
        .send()
        .expect("withdraw test");
    let mid: fund_nft::Fund = program.account(fund).unwrap();
    assert_eq!(mid.targets[0].budget, 200_000);
    assert_eq!(
        mid.targets[1].budget, 400_000,
        "token withdraw must not touch budgets"
    );

    program
        .request()
        .accounts(fund_nft::accounts::Withdraw {
            holder: payer.pubkey(),
            fund,
            nft_mint: nft_mint.pubkey(),
            nft_account: creator_nft,
            nft_token_program: classic,
            mint: usdc,
            vault: quote_vault,
            destination: payer_usdc,
            token_program: token_2022,
        })
        .args(fund_nft::instruction::Withdraw { amount: 100_000 })
        .send()
        .expect("withdraw quote");
    let end: fund_nft::Fund = program.account(fund).unwrap();
    assert_eq!(end.targets[0].budget, 166_666);
    assert_eq!(end.targets[1].budget, 333_334);
    assert_eq!(token_amount(&account_data(&rpc, &quote_vault)), 500_000);

    let stranger_client = Client::new_with_options(
        Cluster::Custom(LOCAL.into(), "ws://127.0.0.1:19000".into()),
        &stranger,
        CommitmentConfig::confirmed(),
    );
    let stranger_program = stranger_client.program(PROGRAM_ID).unwrap();
    let stranger_usdc = ata(&stranger.pubkey(), &usdc, &token_2022);
    let rejected = stranger_program
        .request()
        .instruction(to_ix(create_associated_token_account_idempotent(
            &stranger.pubkey(),
            &stranger.pubkey(),
            &usdc,
            &token_2022,
        )))
        .accounts(fund_nft::accounts::Withdraw {
            holder: stranger.pubkey(),
            fund,
            nft_mint: nft_mint.pubkey(),
            nft_account: creator_nft,
            nft_token_program: classic,
            mint: usdc,
            vault: quote_vault,
            destination: stranger_usdc,
            token_program: token_2022,
        })
        .args(fund_nft::instruction::Withdraw { amount: 1 })
        .send();
    assert!(rejected.is_err(), "a non-holder must not withdraw");

    check_withdraw_native_flow(
        &program,
        &rpc,
        &payer,
        &stranger,
        fund,
        nft_mint.pubkey(),
        creator_nft,
        &[quote_vault, target_vault],
    );
    drop(validator);
}

fn withdraw_native_accounts(
    holder: Pubkey,
    fund: Pubkey,
    nft_mint: Pubkey,
    nft_account: Pubkey,
) -> fund_nft::accounts::WithdrawNative {
    fund_nft::accounts::WithdrawNative {
        holder,
        fund,
        nft_mint,
        nft_account,
        nft_token_program: fund_nft::NFT_TOKEN_PROGRAM_ID,
    }
}

/// System Program `Transfer` (instruction 2): how a reflection bot pays the
/// owner of a token account, which for a fund vault is the fund PDA.
fn system_transfer(from: &Pubkey, to: &Pubkey, lamports: u64) -> Instruction {
    let mut data = 2u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    Instruction {
        program_id: System::id(),
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, false)],
        data,
    }
}

/// Fee and `Program data:` payloads of a confirmed transaction.
fn tx_fee_and_events(
    rpc: &solana_client::rpc_client::RpcClient,
    signature: &solana_signature::Signature,
) -> (u64, Vec<Vec<u8>>) {
    use solana_transaction_status_client_types::option_serializer::OptionSerializer;
    use solana_transaction_status_client_types::UiTransactionEncoding;
    let tx = rpc
        .get_transaction_with_config(
            signature,
            solana_client::rpc_config::RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Json),
                commitment: Some(anchor_client::CommitmentConfig::confirmed()),
                max_supported_transaction_version: Some(0),
            },
        )
        .expect("get_transaction");
    let meta = tx.transaction.meta.expect("transaction meta");
    let logs = match meta.log_messages {
        OptionSerializer::Some(logs) => logs,
        _ => Vec::new(),
    };
    let events = logs
        .iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .filter_map(|b64| base64::engine::general_purpose::STANDARD.decode(b64).ok())
        .collect();
    (meta.fee, events)
}

/// Native XNT on the fund PDA (a reflection payout or any System transfer):
/// a non-holder is refused, zero is refused, the holder takes part, one
/// lamport above what is available is refused, the holder takes the rest, and
/// the fund ends exactly at its rent-exempt minimum. Vaults, budgets, and
/// every other fund field are unchanged throughout.
#[allow(clippy::too_many_arguments)]
fn check_withdraw_native_flow(
    program: &ProgramClient,
    rpc: &solana_client::rpc_client::RpcClient,
    payer: &Keypair,
    stranger: &Keypair,
    fund: Pubkey,
    nft_mint: Pubkey,
    creator_nft: Pubkey,
    vaults: &[Pubkey],
) {
    use anchor_lang::{AccountSerialize, Discriminator};
    let holder = payer.pubkey();
    let fund_bytes = |rpc: &solana_client::rpc_client::RpcClient| account_data(rpc, &fund);
    let vault_balances = |rpc: &solana_client::rpc_client::RpcClient| -> Vec<u64> {
        vaults
            .iter()
            .map(|v| token_amount(&account_data(rpc, v)))
            .collect()
    };
    let data_before = fund_bytes(rpc);
    let vaults_before = vault_balances(rpc);
    let rent_minimum = rpc
        .get_minimum_balance_for_rent_exemption(data_before.len())
        .unwrap();
    let lamports_before = rpc.get_balance(&fund).unwrap();
    // Anchor's init funds exactly the rent-exempt minimum.
    assert_eq!(lamports_before, rent_minimum, "fund starts at rent minimum");

    // Nothing is available yet.
    let empty = program
        .request()
        .accounts(withdraw_native_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative { amount: 1 })
        .send();
    expect_fund_error(
        empty,
        fund_nft::FundError::NativeAboveAvailable,
        "withdraw_native with nothing above rent",
    );

    // A reflection-style System transfer to the fund PDA.
    let reflected: u64 = 250_000_000;
    program
        .request()
        .instruction(system_transfer(&holder, &fund, reflected))
        .send()
        .expect("system transfer to the fund PDA");
    assert_eq!(rpc.get_balance(&fund).unwrap(), rent_minimum + reflected);

    // A stranger signing as holder with the real holder's NFT account.
    let stranger_try = program
        .request()
        .accounts(withdraw_native_accounts(
            stranger.pubkey(),
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative { amount: 1 })
        .signer(stranger)
        .send();
    expect_fund_error(
        stranger_try,
        fund_nft::FundError::BadNft,
        "non-holder withdraw_native",
    );
    // The NFT token program must be classic SPL Token.
    let mut wrong_program = withdraw_native_accounts(holder, fund, nft_mint, creator_nft);
    wrong_program.nft_token_program = fund_nft::TOKEN_2022_PROGRAM_ID;
    let wrong = program
        .request()
        .accounts(wrong_program)
        .args(fund_nft::instruction::WithdrawNative { amount: 1 })
        .send();
    expect_fund_error(
        wrong,
        fund_nft::FundError::NftTokenProgram,
        "withdraw_native with Token-2022 as the NFT program",
    );
    let zero = program
        .request()
        .accounts(withdraw_native_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative { amount: 0 })
        .send();
    expect_fund_error(zero, fund_nft::FundError::ZeroAmount, "withdraw_native 0");
    assert_eq!(rpc.get_balance(&fund).unwrap(), rent_minimum + reflected);

    // The holder withdraws part.
    let part: u64 = 100_000_000;
    let holder_before = rpc.get_balance(&holder).unwrap();
    let sig = program
        .request()
        .accounts(withdraw_native_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative { amount: part })
        .send()
        .expect("holder withdraw_native part");
    let (fee, events) = tx_fee_and_events(rpc, &sig);
    assert_eq!(
        rpc.get_balance(&holder).unwrap(),
        holder_before + part - fee,
        "holder receives exactly the amount, less the tx fee"
    );
    assert_eq!(
        rpc.get_balance(&fund).unwrap(),
        rent_minimum + reflected - part
    );
    let mut expected_event = fund_nft::NativeWithdrawn::DISCRIMINATOR.to_vec();
    expected_event.extend_from_slice(fund.as_ref());
    expected_event.extend_from_slice(holder.as_ref());
    expected_event.extend_from_slice(&part.to_le_bytes());
    assert!(
        events.contains(&expected_event),
        "NativeWithdrawn event missing: {events:?}"
    );

    // One lamport above what is left is refused.
    let available = reflected - part;
    let over = program
        .request()
        .accounts(withdraw_native_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative {
            amount: available + 1,
        })
        .send();
    expect_fund_error(
        over,
        fund_nft::FundError::NativeAboveAvailable,
        "withdraw_native available + 1",
    );
    let huge = program
        .request()
        .accounts(withdraw_native_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative { amount: u64::MAX })
        .send();
    expect_fund_error(
        huge,
        fund_nft::FundError::NativeAboveAvailable,
        "withdraw_native u64::MAX",
    );

    // The holder withdraws everything available.
    let holder_before = rpc.get_balance(&holder).unwrap();
    let sig = program
        .request()
        .accounts(withdraw_native_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative { amount: available })
        .send()
        .expect("holder withdraw_native all");
    let (fee, _) = tx_fee_and_events(rpc, &sig);
    assert_eq!(
        rpc.get_balance(&holder).unwrap(),
        holder_before + available - fee
    );
    assert_eq!(
        rpc.get_balance(&fund).unwrap(),
        rent_minimum,
        "the fund stays exactly rent-exempt"
    );
    let after_all = program
        .request()
        .accounts(withdraw_native_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
        ))
        .args(fund_nft::instruction::WithdrawNative { amount: 1 })
        .send();
    expect_fund_error(
        after_all,
        fund_nft::FundError::NativeAboveAvailable,
        "withdraw_native after withdrawing all",
    );

    // Vaults, budgets, targets, and every fund byte are unchanged.
    assert_eq!(
        vault_balances(rpc),
        vaults_before,
        "vault balances unchanged"
    );
    let data_after = fund_bytes(rpc);
    assert_eq!(data_after, data_before, "fund account data unchanged");
    let account: fund_nft::Fund = program.account(fund).unwrap();
    let mut reserialized = Vec::new();
    account.try_serialize(&mut reserialized).unwrap();
    assert_eq!(&data_after[..reserialized.len()], &reserialized[..]);
    let owner = rpc.get_account(&fund).unwrap().owner;
    assert_eq!(owner, PROGRAM_ID, "fund still owned by the program");
}

type ProgramClient<'a> = anchor_client::Program<&'a Keypair>;

fn attach_accounts(
    holder: Pubkey,
    fund: Pubkey,
    nft_mint: Pubkey,
    nft_account: Pubkey,
    metadata_program: Pubkey,
) -> fund_nft::accounts::AttachMetadata {
    fund_nft::accounts::AttachMetadata {
        holder,
        fund,
        nft_mint,
        nft_account,
        metadata: fund_nft::metaplex::metadata_address(&nft_mint),
        master_edition: fund_nft::metaplex::edition_address(&nft_mint),
        nft_token_program: fund_nft::NFT_TOKEN_PROGRAM_ID,
        metadata_program,
        system_program: System::id(),
        rent: anchor_lang::prelude::rent::ID,
    }
}

fn update_accounts(
    holder: Pubkey,
    fund: Pubkey,
    nft_mint: Pubkey,
    nft_account: Pubkey,
    metadata_program: Pubkey,
) -> fund_nft::accounts::UpdateMetadata {
    fund_nft::accounts::UpdateMetadata {
        holder,
        fund,
        nft_mint,
        nft_account,
        metadata: fund_nft::metaplex::metadata_address(&nft_mint),
        nft_token_program: fund_nft::NFT_TOKEN_PROGRAM_ID,
        metadata_program,
    }
}

fn read_metadata(
    rpc: &solana_client::rpc_client::RpcClient,
    nft_mint: &Pubkey,
) -> anchor_spl::metadata::mpl_token_metadata::accounts::Metadata {
    let address = fund_nft::metaplex::metadata_address(nft_mint);
    let account = rpc.get_account(&address).expect("metadata account");
    assert_eq!(account.owner, pubkey(METAPLEX), "metadata owner");
    anchor_spl::metadata::mpl_token_metadata::accounts::Metadata::safe_deserialize(&account.data)
        .expect("decode metadata")
}

/// create -> attach -> contents -> holder update -> non-holder update
/// rejected -> attach twice rejected -> master edition -> mint authority is
/// the edition -> minting fails.
fn check_metadata_flow(
    program: &ProgramClient,
    rpc: &solana_client::rpc_client::RpcClient,
    payer: &Keypair,
    stranger: &Keypair,
    fund: Pubkey,
    nft_mint: Pubkey,
    creator_nft: Pubkey,
) {
    let metaplex = pubkey(METAPLEX);
    let holder = payer.pubkey();
    let name = "X1 Fund NFT".to_string();
    let symbol = "XFUND".to_string();
    let uri = "https://example.invalid/fund-nft/1.json".to_string();

    // Bounds are checked before any CPI.
    let long_name = program
        .request()
        .accounts(attach_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::AttachMetadata {
            name: "n".repeat(33),
            symbol: symbol.clone(),
            uri: uri.clone(),
        })
        .send();
    expect_fund_error(
        long_name,
        fund_nft::FundError::MetadataNameTooLong,
        "33-byte name",
    );
    let long_uri = program
        .request()
        .accounts(attach_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::AttachMetadata {
            name: name.clone(),
            symbol: symbol.clone(),
            uri: "u".repeat(201),
        })
        .send();
    expect_fund_error(
        long_uri,
        fund_nft::FundError::MetadataUriTooLong,
        "201-byte uri",
    );
    // Only the allowlisted Token Metadata program.
    let wrong_program = program
        .request()
        .accounts(attach_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            fund_nft::TOKEN_2022_PROGRAM_ID,
        ))
        .args(fund_nft::instruction::AttachMetadata {
            name: name.clone(),
            symbol: symbol.clone(),
            uri: uri.clone(),
        })
        .send();
    expect_fund_error(
        wrong_program,
        fund_nft::FundError::BadMetadataProgram,
        "attach with a non-Metaplex program",
    );
    // A non-holder cannot attach.
    let stranger_attach = program
        .request()
        .accounts(attach_accounts(
            stranger.pubkey(),
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::AttachMetadata {
            name: name.clone(),
            symbol: symbol.clone(),
            uri: uri.clone(),
        })
        .signer(stranger)
        .send();
    expect_fund_error(
        stranger_attach,
        fund_nft::FundError::BadNft,
        "non-holder attach",
    );

    let attach_sig = program
        .request()
        .instruction(compute_limit(400_000))
        .accounts(attach_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::AttachMetadata {
            name: name.clone(),
            symbol: symbol.clone(),
            uri: uri.clone(),
        })
        .send()
        .unwrap_or_else(|err| panic!("attach_metadata failed: {err:#}"));
    println!("attach_metadata: {attach_sig}");

    let md = read_metadata(rpc, &nft_mint);
    assert_eq!(
        md.update_authority, fund,
        "update authority is the fund PDA"
    );
    assert_eq!(md.mint, nft_mint);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.name), name);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.symbol), symbol);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.uri), uri);
    assert_eq!(md.seller_fee_basis_points, 0);
    assert!(md.creators.is_none(), "no creators");
    assert!(md.collection.is_none() && md.uses.is_none());
    assert!(md.is_mutable, "metadata stays mutable");
    assert!(!md.primary_sale_happened);

    let edition = fund_nft::metaplex::edition_address(&nft_mint);
    let edition_account = rpc.get_account(&edition).expect("master edition account");
    assert_eq!(edition_account.owner, metaplex, "edition owner");
    let master =
        anchor_spl::metadata::mpl_token_metadata::accounts::MasterEdition::safe_deserialize(
            &edition_account.data,
        )
        .expect("decode master edition");
    let md_account = rpc
        .get_account(&fund_nft::metaplex::metadata_address(&nft_mint))
        .unwrap();
    println!(
        "metadata account {} bytes, {} lamports; master edition {} bytes, {} lamports (paid by the holder)",
        md_account.data.len(),
        md_account.lamports,
        edition_account.data.len(),
        edition_account.lamports
    );
    assert_eq!(master.max_supply, Some(0), "no prints");
    assert_eq!(master.supply, 0);

    let mint_data = account_data(rpc, &nft_mint);
    assert_eq!(
        mint_authority(&mint_data),
        Some(edition),
        "mint authority is the edition"
    );
    assert_eq!(
        freeze_authority(&mint_data),
        Some(edition),
        "freeze authority is the edition"
    );
    assert_eq!(mint_supply(&mint_data), 1);
    let late_mint = program
        .request()
        .instruction(nft_mint_to(&nft_mint, &creator_nft, &holder))
        .send();
    assert!(
        late_mint.is_err(),
        "minted after the master edition took the authority"
    );
    let fund_mint = program
        .request()
        .instruction(nft_mint_to(&nft_mint, &creator_nft, &fund))
        .send();
    assert!(
        fund_mint.is_err(),
        "a mint naming the fund PDA cannot be signed"
    );
    assert_eq!(mint_supply(&account_data(rpc, &nft_mint)), 1);

    // Attach twice is rejected.
    let again = program
        .request()
        .instruction(compute_limit(400_000))
        .accounts(attach_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::AttachMetadata {
            name: name.clone(),
            symbol: symbol.clone(),
            uri: uri.clone(),
        })
        .send();
    expect_fund_error(again, fund_nft::FundError::MetadataExists, "second attach");

    // Holder update: only the URI changes; name and symbol are kept.
    let new_uri = "https://example.invalid/fund-nft/1-v2.json".to_string();
    program
        .request()
        .instruction(compute_limit(200_000))
        .accounts(update_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::UpdateMetadata {
            name: None,
            symbol: None,
            uri: Some(new_uri.clone()),
        })
        .send()
        .unwrap_or_else(|err| panic!("holder update_metadata failed: {err:#}"));
    let md = read_metadata(rpc, &nft_mint);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.name), name);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.symbol), symbol);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.uri), new_uri);
    assert_eq!(md.update_authority, fund);
    assert!(md.is_mutable);

    let new_name = "Renamed fund".to_string();
    program
        .request()
        .instruction(compute_limit(200_000))
        .accounts(update_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::UpdateMetadata {
            name: Some(new_name.clone()),
            symbol: None,
            uri: None,
        })
        .send()
        .expect("holder rename");
    let md = read_metadata(rpc, &nft_mint);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.name), new_name);
    assert_eq!(fund_nft::metaplex::trim_nul(&md.uri), new_uri);

    let empty = program
        .request()
        .accounts(update_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::UpdateMetadata {
            name: None,
            symbol: None,
            uri: None,
        })
        .send();
    expect_fund_error(empty, fund_nft::FundError::NothingToUpdate, "empty update");
    let long_symbol = program
        .request()
        .accounts(update_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::UpdateMetadata {
            name: None,
            symbol: Some("s".repeat(11)),
            uri: None,
        })
        .send();
    expect_fund_error(
        long_symbol,
        fund_nft::FundError::MetadataSymbolTooLong,
        "11-byte symbol",
    );

    // A non-holder cannot update, with the holder's NFT account or without one.
    let stranger_update = program
        .request()
        .accounts(update_accounts(
            stranger.pubkey(),
            fund,
            nft_mint,
            creator_nft,
            metaplex,
        ))
        .args(fund_nft::instruction::UpdateMetadata {
            name: None,
            symbol: None,
            uri: Some("https://example.invalid/stolen.json".into()),
        })
        .signer(stranger)
        .send();
    expect_fund_error(
        stranger_update,
        fund_nft::FundError::BadNft,
        "non-holder update",
    );
    // Only the allowlisted Token Metadata program is called.
    let wrong_program = program
        .request()
        .accounts(update_accounts(
            holder,
            fund,
            nft_mint,
            creator_nft,
            fund_nft::TOKEN_2022_PROGRAM_ID,
        ))
        .args(fund_nft::instruction::UpdateMetadata {
            name: None,
            symbol: None,
            uri: Some("https://example.invalid/x.json".into()),
        })
        .send();
    expect_fund_error(
        wrong_program,
        fund_nft::FundError::BadMetadataProgram,
        "update with a non-Metaplex program",
    );
    assert_eq!(
        fund_nft::metaplex::trim_nul(&read_metadata(rpc, &nft_mint).uri),
        new_uri
    );
}

/// `mint_to` of one NFT unit signed by `authority` (which must sign the
/// transaction; a PDA cannot, so naming the fund PDA always fails to sign).
fn nft_mint_to(mint: &Pubkey, destination: &Pubkey, authority: &Pubkey) -> Instruction {
    to_ix(
        spl_token_2022_interface::instruction::mint_to(
            &fund_nft::NFT_TOKEN_PROGRAM_ID,
            mint,
            destination,
            authority,
            &[],
            1,
        )
        .expect("mint_to"),
    )
}

fn mint_authority(mint: &[u8]) -> Option<Pubkey> {
    match u32::from_le_bytes(mint[0..4].try_into().unwrap()) {
        0 => None,
        1 => Some(Pubkey::new_from_array(mint[4..36].try_into().unwrap())),
        tag => panic!("bad COption tag {tag}"),
    }
}

fn freeze_authority(mint: &[u8]) -> Option<Pubkey> {
    match u32::from_le_bytes(mint[46..50].try_into().unwrap()) {
        0 => None,
        1 => Some(Pubkey::new_from_array(mint[50..82].try_into().unwrap())),
        tag => panic!("bad COption tag {tag}"),
    }
}

fn mint_supply(mint: &[u8]) -> u64 {
    u64::from_le_bytes(mint[36..44].try_into().unwrap())
}

/// Legal windows (900..=86_400) tried in order, shortest first.
const WINDOWS: [u32; 7] = [900, 3_600, 7_200, 14_400, 21_600, 43_200, 86_400];

/// First window the program's own quote accepts now and still accepts two
/// minutes later, so the create/deposit/execute round trip cannot age it out.
fn choose_window(ring: &[u8], index: u16, now: i64) -> Option<u32> {
    WINDOWS.into_iter().find(|window| {
        [now, now + 120].into_iter().all(|at| {
            fund_nft::twap::quote_min_out(QuoteInput {
                ring,
                observation_index: index,
                now: at,
                twap_window_secs: *window,
                amount_in_after_input_fee: 399_600,
                trade_fee_rate: 2_800,
                direction: SwapDirection::Token0ToToken1,
                output_transfer_fee: TransferFee {
                    basis_points: 500,
                    maximum_fee: u64::MAX,
                },
                max_dev_bps: 500,
            })
            .is_ok_and(|quote| quote.min_out > 0)
        })
    })
}

fn observation_timestamp(ring: &[u8], index: u16) -> u64 {
    let start = usize::from(index) * fund_nft::twap::OBSERVATION_BYTES;
    u64::from_le_bytes(ring[start..start + 8].try_into().unwrap())
}

/// `Clock::unix_timestamp` as the validator sees it (sysvar byte 32).
fn clock_unix_timestamp(rpc: &solana_client::rpc_client::RpcClient) -> i64 {
    let data = account_data(rpc, &pubkey("SysvarC1ock11111111111111111111111111111111"));
    i64::from_le_bytes(data[32..40].try_into().unwrap())
}

fn fund_params(usdc: Pubkey, test_mint: Pubkey, window: u32, max_dev_bps: u16) -> CreateFundParams {
    CreateFundParams {
        per_run_quote: 500_000,
        interval_secs: 60,
        twap_window_secs: window,
        max_dev_bps,
        targets: vec![
            TargetParams {
                mint: usdc,
                pool: Pubkey::default(),
                bps: 2_000,
            },
            TargetParams {
                mint: test_mint,
                pool: pubkey(POOL),
                bps: 8_000,
            },
        ],
    }
}

/// The transaction must fail with this program error. The client error
/// carries the simulation logs, which name the Anchor error and its code.
fn expect_fund_error<T: std::fmt::Debug, E: std::fmt::Debug>(
    result: Result<T, E>,
    expected: fund_nft::FundError,
    what: &str,
) {
    let code = u32::from(expected);
    let name = format!("{expected:?}");
    let err = match result {
        Ok(ok) => panic!("{what}: expected {name} ({code}), got success {ok:?}"),
        Err(err) => format!("{err:?}"),
    };
    assert!(
        err.contains(&format!("Error Code: {name}"))
            || err.contains(&format!("Custom({code})"))
            || err.contains(&format!("0x{code:x}")),
        "{what}: expected {name} ({code}), got {err}"
    );
}

fn min_out_from_chain(
    rpc: &solana_client::rpc_client::RpcClient,
    signature: &solana_signature::Signature,
) -> Result<u64, String> {
    use solana_transaction_status_client_types::option_serializer::OptionSerializer;
    use solana_transaction_status_client_types::UiTransactionEncoding;
    const DISC: [u8; 8] = [0x16, 0x1e, 0x9a, 0xd7, 0x78, 0x92, 0x1a, 0x45];
    let tx = rpc
        .get_transaction_with_config(
            signature,
            solana_client::rpc_config::RpcTransactionConfig {
                encoding: Some(UiTransactionEncoding::Json),
                commitment: Some(anchor_client::CommitmentConfig::confirmed()),
                max_supported_transaction_version: Some(0),
            },
        )
        .map_err(|err| format!("get_transaction: {err}"))?;
    let meta = tx
        .transaction
        .meta
        .ok_or_else(|| "transaction has no meta".to_string())?;
    let logs = match meta.log_messages {
        OptionSerializer::Some(logs) => logs,
        other => return Err(format!("no logs: {other:?}")),
    };
    let mut seen = Vec::new();
    for line in &logs {
        let Some(rest) = line.strip_prefix("Program data: ") else {
            continue;
        };
        let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(rest) else {
            continue;
        };
        if raw.len() >= 8 {
            seen.push(hex8(&raw[..8]));
        }
        if raw.len() >= 8 + 32 + 1 + 8 * 4 && raw[..8] == DISC {
            let min_out_at = 8 + 32 + 1 + 8 * 3;
            return Ok(u64::from_le_bytes(
                raw[min_out_at..min_out_at + 8].try_into().unwrap(),
            ));
        }
    }
    Err(format!(
        "event disc not in logs. discs={seen:?}\n{}",
        logs.join("\n")
    ))
}

fn hex8(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ceil_fee(amount: u64, bps: u64) -> u64 {
    ((amount as u128 * bps as u128 + 9_999) / 10_000) as u64
}

/// Protocol and fund fees sit at the offsets decoded from the USDC.X/TEST pool:
/// five `u8`s after `observation_key`, then `lp_supply`, then the four fee u64s.
fn quote_pool_swap(
    pool: &[u8],
    rpc: &solana_client::rpc_client::RpcClient,
    amount_in: u64,
) -> (u64, u64) {
    let proto0 = u64::from_le_bytes(pool[341..349].try_into().unwrap());
    let proto1 = u64::from_le_bytes(pool[349..357].try_into().unwrap());
    let fund0 = u64::from_le_bytes(pool[357..365].try_into().unwrap());
    let fund1 = u64::from_le_bytes(pool[365..373].try_into().unwrap());
    let reserve_in = token_amount(&account_data(rpc, &pubkey(VAULT_0))) - proto0 - fund0;
    let reserve_out = token_amount(&account_data(rpc, &pubkey(VAULT_1))) - proto1 - fund1;
    let net = (amount_in as u128) * 997_200 / 1_000_000;
    let gross = (reserve_out as u128 * net / (reserve_in as u128 + net)) as u64;
    (gross, gross - ceil_fee(gross, 500))
}

fn direct_swap(
    payer: &Pubkey,
    user_in: &Pubkey,
    user_out: &Pubkey,
    amount_in: u64,
    min_out: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&xdex::SWAP_BASE_INPUT_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    let meta = |key: Pubkey, signer: bool, writable: bool| AccountMeta {
        pubkey: key,
        is_signer: signer,
        is_writable: writable,
    };
    Instruction {
        program_id: pubkey(XDEX),
        accounts: vec![
            meta(*payer, true, false),
            meta(pubkey(AUTHORITY), false, false),
            meta(pubkey(AMM), false, false),
            meta(pubkey(POOL), false, true),
            meta(*user_in, false, true),
            meta(*user_out, false, true),
            meta(pubkey(VAULT_0), false, true),
            meta(pubkey(VAULT_1), false, true),
            meta(fund_nft::TOKEN_2022_PROGRAM_ID, false, false),
            meta(fund_nft::TOKEN_2022_PROGRAM_ID, false, false),
            meta(pubkey(USDC), false, false),
            meta(pubkey(TEST_MINT), false, false),
            meta(pubkey(OBS), false, true),
        ],
        data,
    }
}

fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, token_program)
}

fn token_amount(data: &[u8]) -> u64 {
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

fn account_data(rpc: &solana_client::rpc_client::RpcClient, address: &Pubkey) -> Vec<u8> {
    rpc.get_account(address)
        .unwrap_or_else(|err| panic!("missing {address}: {err}"))
        .data
}

fn pubkey(text: &str) -> Pubkey {
    text.parse().unwrap()
}

fn to_ix(ix: solana_instruction::Instruction) -> Instruction {
    Instruction {
        program_id: ix.program_id,
        accounts: ix
            .accounts
            .into_iter()
            .map(|meta| anchor_lang::prelude::AccountMeta {
                pubkey: meta.pubkey,
                is_signer: meta.is_signer,
                is_writable: meta.is_writable,
            })
            .collect(),
        data: ix.data,
    }
}

fn compute_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: pubkey("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

fn dump_account(address: &str, path: &Path) {
    let bin = solana_bin("solana");
    let status = Command::new(&bin)
        .args(["account", address, "--url", RPC, "--output", "json", "-o"])
        .arg(path)
        .status()
        .unwrap_or_else(|err| panic!("solana account dump failed to start: {err}"));
    assert!(status.success(), "could not dump {address} from {RPC}");
}

fn override_mint_authority(path: &Path, authority: &Pubkey) {
    let text = fs::read_to_string(path).unwrap();
    let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
    let encoded = value["account"]["data"][0].as_str().unwrap().to_string();
    let mut data = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .unwrap();
    assert!(
        data.len() > 36,
        "mint account is shorter than a mint header"
    );
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(authority.as_ref());
    value["account"]["data"][0] =
        serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(&data));
    fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

/// Every feature X1 mainnet does not report active, as known to the local
/// Agave CLI, read from X1 RPC now so the list tracks X1.
fn x1_inactive_features() -> Vec<String> {
    let output = Command::new(solana_bin("solana"))
        .args([
            "feature",
            "status",
            "--display-all",
            "--output",
            "json",
            "--url",
            RPC,
        ])
        .output()
        .unwrap_or_else(|err| panic!("solana feature status failed to start: {err}"));
    assert!(
        output.status.success(),
        "solana feature status against {RPC} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("feature status json");
    let features = value["features"].as_array().expect("features array");
    let inactive: Vec<String> = features
        .iter()
        .filter(|feature| feature["status"].as_str() != Some("active"))
        .map(|feature| feature["id"].as_str().expect("feature id").to_string())
        .collect();
    assert!(
        features.len() > 100 && !inactive.is_empty(),
        "unexpected feature status from {RPC}: {} features, {} inactive",
        features.len(),
        inactive.len()
    );
    assert!(
        inactive.iter().any(|id| id == X1_SYSVAR_SYSCALL_EXCEPTION),
        "X1 now reports {X1_SYSVAR_SYSCALL_EXCEPTION} active; drop the exception"
    );
    inactive
}

/// True when the ELF's symbol strings contain `name` as a whole entry.
fn imports_symbol(elf: &[u8], name: &str) -> bool {
    let mut needle = vec![0u8];
    needle.extend_from_slice(name.as_bytes());
    needle.push(0);
    elf.windows(needle.len())
        .any(|window| window == needle.as_slice())
}

fn solana_bin(name: &str) -> PathBuf {
    if let Ok(home) = std::env::var("HOME") {
        let installed = PathBuf::from(home)
            .join(".local/share/solana/install/active_release/bin")
            .join(name);
        if installed.exists() {
            return installed;
        }
    }
    PathBuf::from(name)
}

fn wait_until_healthy(child: &mut Child) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(120) {
        if let Some(status) = child.try_wait().map_err(|err| err.to_string())? {
            return Err(format!("validator exited early: {status}"));
        }
        let ok = Command::new(solana_bin("solana"))
            .args(["cluster-version", "--url", LOCAL])
            .output();
        if let Ok(output) = ok {
            if output.status.success() {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(500));
    }
    Err("validator did not become healthy within 120s".into())
}

fn log_tail(path: &Path) -> String {
    let mut file = fs::File::open(path).unwrap_or_else(|_| fs::File::create(path).unwrap());
    let mut buf = String::new();
    let _ = file.read_to_string(&mut buf);
    let start = buf.len().saturating_sub(4000);
    buf[start..].to_string()
}
