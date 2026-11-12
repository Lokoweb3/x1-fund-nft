use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::accounting::{self, AccountingError};
use crate::errors::FundError;
use crate::mint_policy::require_allowed_mint;
use crate::state::{Fund, FUND_SEED, TIP_BPS};
use crate::token_fee::{self, FeeParseError};
use crate::twap::{self, QuoteInput, SwapDirection, TransferFee};
use crate::xdex::{self, PoolAccounts};

/// Token-2022 program id, verified executable on X1 mainnet.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

#[event]
pub struct DcaExecuted {
    pub fund: Pubkey,
    pub target_index: u8,
    pub slice: u64,
    pub tip: u64,
    pub amount_in: u64,
    pub min_out: u64,
    pub received: u64,
    pub budget_after: u64,
    pub unix_timestamp: i64,
}

#[derive(Accounts)]
pub struct ExecuteDca<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub fund: Account<'info, Fund>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    pub target_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub target_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub caller_quote_account: InterfaceAccount<'info, TokenAccount>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub target_token_program: Interface<'info, TokenInterface>,
    /// CHECK: must be `xdex::XDEX_PROGRAM_ID` and the executable owner of the pinned pool.
    pub pool_program: UncheckedAccount<'info>,
    /// CHECK: decoded from the verified PoolState layout.
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: decoded from the verified AmmConfig layout.
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: must own both pool vaults. The pool program signs for it.
    pub authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub pool_input_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub pool_output_vault: InterfaceAccount<'info, TokenAccount>,
    pub pool_input_mint: InterfaceAccount<'info, Mint>,
    pub pool_output_mint: InterfaceAccount<'info, Mint>,
    pub pool_input_token_program: Interface<'info, TokenInterface>,
    pub pool_output_token_program: Interface<'info, TokenInterface>,
    /// CHECK: decoded from the verified ObservationState layout.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,
}

pub fn handle_execute_dca(ctx: Context<ExecuteDca>, target_index: u8) -> Result<()> {
    let clock = Clock::get()?;
    let fund_key = ctx.accounts.fund.key();
    let bump = ctx.accounts.fund.bump;
    let nft_mint = ctx.accounts.fund.nft_mint;
    let quote_mint = ctx.accounts.fund.quote_mint;
    let per_run_quote = ctx.accounts.fund.per_run_quote;
    let twap_window_secs = ctx.accounts.fund.twap_window_secs;
    let max_dev_bps = ctx.accounts.fund.max_dev_bps;
    let index = usize::from(target_index);
    require!(
        index < ctx.accounts.fund.targets.len(),
        FundError::TargetIndex
    );
    let target_mint_key = ctx.accounts.fund.targets[index].mint;
    let target_pool = ctx.accounts.fund.targets[index].pool;
    let target_bps = ctx.accounts.fund.targets[index].bps;
    let target_budget = ctx.accounts.fund.targets[index].budget;
    let target_last_run = ctx.accounts.fund.targets[index].last_run;

    require!(target_mint_key != quote_mint, FundError::CashSlice);
    require!(target_budget > 0, FundError::EmptyBudget);
    let due_at = target_last_run
        .checked_add(ctx.accounts.fund.interval_secs)
        .ok_or(FundError::Math)?;
    require!(clock.unix_timestamp >= due_at, FundError::NotDue);
    require!(
        ctx.accounts.quote_mint.key() == quote_mint,
        FundError::QuoteMintMismatch
    );
    require!(
        ctx.accounts.target_mint.key() == target_mint_key,
        FundError::PoolMintMismatch
    );
    require_token_program(
        &ctx.accounts.quote_mint.to_account_info(),
        &ctx.accounts.quote_token_program.key(),
    )?;
    require_token_program(
        &ctx.accounts.target_mint.to_account_info(),
        &ctx.accounts.target_token_program.key(),
    )?;
    // Same policy as create_fund, checked before the tip and swap CPIs.
    // Token-2022 fixes most mint extensions at initialization, but the
    // re-check costs little and also covers metadata/group entries added later.
    require_allowed_mint(&ctx.accounts.quote_mint.to_account_info())?;
    require_allowed_mint(&ctx.accounts.target_mint.to_account_info())?;
    require!(
        ctx.accounts.quote_vault.key()
            == ata(
                &fund_key,
                &quote_mint,
                &ctx.accounts.quote_token_program.key(),
            ),
        FundError::BadVault
    );
    require!(
        ctx.accounts.target_vault.key()
            == ata(
                &fund_key,
                &target_mint_key,
                &ctx.accounts.target_token_program.key(),
            ),
        FundError::BadVault
    );
    require!(
        ctx.accounts.caller_quote_account.mint == quote_mint
            && ctx.accounts.caller_quote_account.owner == ctx.accounts.caller.key(),
        FundError::BadTipDestination
    );

    let plan = accounting::plan_slice(
        target_budget,
        per_run_quote,
        target_bps,
        ctx.accounts.quote_vault.amount,
        TIP_BPS,
    )
    .map_err(map_accounting)?;

    let pool = {
        let data = ctx.accounts.pool_state.try_borrow_data()?;
        xdex::read_pool(&data)?
    };
    require!(
        ctx.accounts.pool_program.key() == xdex::XDEX_PROGRAM_ID,
        FundError::BadPoolProgram
    );
    require!(
        ctx.accounts.pool_program.executable
            && ctx.accounts.pool_state.owner == &ctx.accounts.pool_program.key()
            && ctx.accounts.amm_config.owner == &ctx.accounts.pool_program.key()
            && ctx.accounts.observation_state.owner == &ctx.accounts.pool_program.key(),
        FundError::BadPool
    );
    require!(
        ctx.accounts.pool_state.key() == target_pool,
        FundError::BadPool
    );
    require!(
        ctx.accounts.amm_config.key() == pool.amm_config,
        FundError::BadPool
    );
    let trade_fee_rate = {
        let data = ctx.accounts.amm_config.try_borrow_data()?;
        xdex::read_trade_fee_rate(&data)?
    };
    let (input_is_token_0, input_vault, output_vault, input_program, output_program) =
        match_side(&pool, quote_mint, target_mint_key)?;
    require!(
        ctx.accounts.pool_input_vault.key() == input_vault
            && ctx.accounts.pool_output_vault.key() == output_vault
            && ctx.accounts.pool_input_token_program.key() == input_program
            && ctx.accounts.pool_output_token_program.key() == output_program
            && ctx.accounts.pool_input_mint.key() == quote_mint
            && ctx.accounts.pool_output_mint.key() == target_mint_key
            && ctx.accounts.pool_input_vault.mint == quote_mint
            && ctx.accounts.pool_output_vault.mint == target_mint_key
            && ctx.accounts.pool_input_vault.owner == ctx.accounts.authority.key()
            && ctx.accounts.pool_output_vault.owner == ctx.accounts.authority.key(),
        FundError::BadAuthority
    );

    let input_fee = mint_fee(
        &ctx.accounts.quote_mint.to_account_info(),
        &ctx.accounts.quote_token_program.key(),
        clock.epoch,
    )?;
    let output_fee = mint_fee(
        &ctx.accounts.target_mint.to_account_info(),
        &ctx.accounts.target_token_program.key(),
        clock.epoch,
    )?;
    let amount_after_input_fee = twap::amount_after_transfer_fee(plan.amount_in, input_fee)
        .map_err(|_| FundError::TwapRejected)?;
    let direction = if input_is_token_0 {
        SwapDirection::Token0ToToken1
    } else {
        SwapDirection::Token1ToToken0
    };
    let min_out = {
        let data = ctx.accounts.observation_state.try_borrow_data()?;
        let observation = xdex::read_observation(&data)?;
        require!(
            observation.pool_id == target_pool
                && ctx.accounts.observation_state.key() == pool.observation,
            FundError::BadObservation
        );
        twap::quote_min_out(QuoteInput {
            ring: observation.ring,
            observation_index: observation.index,
            now: clock.unix_timestamp,
            twap_window_secs,
            amount_in_after_input_fee: amount_after_input_fee,
            trade_fee_rate,
            direction,
            output_transfer_fee: output_fee,
            max_dev_bps,
        })
        .map_err(|_| error!(FundError::TwapRejected))?
        .min_out
    };
    // A zero minimum would let the pool return nothing.
    require!(min_out > 0, FundError::ZeroMinOut);

    let bump_seed = [bump];
    let signer: &[&[u8]] = &[FUND_SEED, nft_mint.as_ref(), &bump_seed];
    let quote_before = ctx.accounts.quote_vault.amount;
    if plan.tip > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.quote_token_program.key(),
                TransferChecked {
                    from: ctx.accounts.quote_vault.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.caller_quote_account.to_account_info(),
                    authority: ctx.accounts.fund.to_account_info(),
                },
                &[signer],
            ),
            plan.tip,
            ctx.accounts.quote_mint.decimals,
        )?;
    }

    let before_out = ctx.accounts.target_vault.amount;
    swap_base_input(&ctx, plan.amount_in, min_out, signer)?;
    ctx.accounts.quote_vault.reload()?;
    ctx.accounts.target_vault.reload()?;
    // The pool program receives the fund's signature. Check that it moved
    // exactly `amount_in` out of the quote vault and left both vaults owned
    // by the fund with no delegate and no close authority.
    let expected_quote = quote_before
        .checked_sub(plan.tip)
        .and_then(|left| left.checked_sub(plan.amount_in))
        .ok_or(FundError::Math)?;
    require!(
        ctx.accounts.quote_vault.amount == expected_quote,
        FundError::QuoteVaultDelta
    );
    for vault in [&ctx.accounts.quote_vault, &ctx.accounts.target_vault] {
        require!(vault.owner == fund_key, FundError::VaultOwner);
        require!(vault.delegate.is_none(), FundError::VaultDelegate);
        require!(vault.close_authority.is_none(), FundError::VaultCloseAuthority);
    }
    let received = ctx
        .accounts
        .target_vault
        .amount
        .checked_sub(before_out)
        .ok_or(FundError::Math)?;
    require!(received >= min_out, FundError::Slippage);

    let budget_after = target_budget
        .checked_sub(plan.slice)
        .ok_or(FundError::Math)?;
    let target = &mut ctx.accounts.fund.targets[index];
    target.budget = budget_after;
    target.last_run = clock.unix_timestamp;
    emit!(DcaExecuted {
        fund: fund_key,
        target_index,
        slice: plan.slice,
        tip: plan.tip,
        amount_in: plan.amount_in,
        min_out,
        received,
        budget_after,
        unix_timestamp: clock.unix_timestamp,
    });
    Ok(())
}

fn swap_base_input(
    ctx: &Context<ExecuteDca>,
    amount_in: u64,
    min_out: u64,
    signer: &[&[u8]],
) -> Result<()> {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&xdex::SWAP_BASE_INPUT_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    // Account order is the reference transaction's inner SwapBaseInput,
    // which matches the XDEX IDL. The payer is a signer and is not writable.
    let accounts = vec![
        AccountMeta::new_readonly(ctx.accounts.fund.key(), true),
        AccountMeta::new_readonly(ctx.accounts.authority.key(), false),
        AccountMeta::new_readonly(ctx.accounts.amm_config.key(), false),
        AccountMeta::new(ctx.accounts.pool_state.key(), false),
        AccountMeta::new(ctx.accounts.quote_vault.key(), false),
        AccountMeta::new(ctx.accounts.target_vault.key(), false),
        AccountMeta::new(ctx.accounts.pool_input_vault.key(), false),
        AccountMeta::new(ctx.accounts.pool_output_vault.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_input_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_output_token_program.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_input_mint.key(), false),
        AccountMeta::new_readonly(ctx.accounts.pool_output_mint.key(), false),
        AccountMeta::new(ctx.accounts.observation_state.key(), false),
    ];
    let ix = Instruction {
        program_id: ctx.accounts.pool_program.key(),
        accounts,
        data,
    };
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.fund.to_account_info(),
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.amm_config.to_account_info(),
            ctx.accounts.pool_state.to_account_info(),
            ctx.accounts.quote_vault.to_account_info(),
            ctx.accounts.target_vault.to_account_info(),
            ctx.accounts.pool_input_vault.to_account_info(),
            ctx.accounts.pool_output_vault.to_account_info(),
            ctx.accounts.pool_input_token_program.to_account_info(),
            ctx.accounts.pool_output_token_program.to_account_info(),
            ctx.accounts.pool_input_mint.to_account_info(),
            ctx.accounts.pool_output_mint.to_account_info(),
            ctx.accounts.observation_state.to_account_info(),
        ],
        &[signer],
    )?;
    Ok(())
}

fn match_side(
    pool: &PoolAccounts,
    quote_mint: Pubkey,
    target_mint: Pubkey,
) -> Result<(bool, Pubkey, Pubkey, Pubkey, Pubkey)> {
    if pool.token_0_mint == quote_mint && pool.token_1_mint == target_mint {
        Ok((
            true,
            pool.token_0_vault,
            pool.token_1_vault,
            pool.token_0_program,
            pool.token_1_program,
        ))
    } else if pool.token_1_mint == quote_mint && pool.token_0_mint == target_mint {
        Ok((
            false,
            pool.token_1_vault,
            pool.token_0_vault,
            pool.token_1_program,
            pool.token_0_program,
        ))
    } else {
        err!(FundError::PoolMintMismatch)
    }
}

fn require_token_program(mint: &AccountInfo, program: &Pubkey) -> Result<()> {
    require!(mint.owner == program, FundError::BadTokenProgram);
    require!(
        *program == crate::instructions::create_fund::NFT_TOKEN_PROGRAM_ID
            || *program == TOKEN_2022_PROGRAM_ID,
        FundError::BadTokenProgram
    );
    Ok(())
}

fn mint_fee(mint: &AccountInfo, program: &Pubkey, epoch: u64) -> Result<TransferFee> {
    if *program != TOKEN_2022_PROGRAM_ID {
        return Ok(TransferFee::none());
    }
    let data = mint.try_borrow_data()?;
    let config = token_fee::read_transfer_fee_config(&data).map_err(map_fee)?;
    Ok(token_fee::fee_for_epoch(config, epoch))
}

fn ata(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, token_program)
}

fn map_accounting(err: AccountingError) -> Error {
    match err {
        AccountingError::ZeroSlice => error!(FundError::ZeroSlice),
        AccountingError::Shape | AccountingError::Overflow => error!(FundError::Math),
    }
}

fn map_fee(err: FeeParseError) -> Error {
    match err {
        FeeParseError::Truncated | FeeParseError::AccountType => error!(FundError::TwapRejected),
    }
}
