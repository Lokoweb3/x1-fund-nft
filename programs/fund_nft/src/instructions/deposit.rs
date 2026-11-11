use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::accounting::{self, AccountingError};
use crate::errors::FundError;
use crate::state::Fund;

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(mut)]
    pub fund: Account<'info, Fund>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub depositor_quote: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, FundError::ZeroAmount);
    let fund = &ctx.accounts.fund;
    require!(
        ctx.accounts.quote_mint.key() == fund.quote_mint,
        FundError::QuoteMintMismatch
    );
    require!(
        ctx.accounts.quote_mint.to_account_info().owner == &ctx.accounts.token_program.key(),
        FundError::BadTokenProgram
    );
    require!(
        ctx.accounts.depositor_quote.mint == fund.quote_mint
            && ctx.accounts.depositor_quote.owner == ctx.accounts.depositor.key(),
        FundError::BadVault
    );
    let expected_vault = get_associated_token_address_with_program_id(
        &fund.key(),
        &fund.quote_mint,
        &ctx.accounts.token_program.key(),
    );
    require!(
        ctx.accounts.quote_vault.key() == expected_vault,
        FundError::BadVault
    );
    require!(
        ctx.accounts.quote_vault.mint == fund.quote_mint,
        FundError::BadVault
    );

    let before = ctx.accounts.quote_vault.amount;
    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.depositor_quote.to_account_info(),
                mint: ctx.accounts.quote_mint.to_account_info(),
                to: ctx.accounts.quote_vault.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.quote_mint.decimals,
    )?;
    ctx.accounts.quote_vault.reload()?;
    let received = ctx
        .accounts
        .quote_vault
        .amount
        .checked_sub(before)
        .ok_or(FundError::Math)?;
    require!(received > 0, FundError::ZeroAmount);

    let fund = &mut ctx.accounts.fund;
    let weights: Vec<u16> = fund.targets.iter().map(|target| target.bps).collect();
    let mut budgets: Vec<u64> = fund.targets.iter().map(|target| target.budget).collect();
    accounting::credit_budgets(&mut budgets, &weights, received).map_err(map_accounting)?;
    for (target, budget) in fund.targets.iter_mut().zip(budgets) {
        target.budget = budget;
    }
    Ok(())
}

fn map_accounting(err: AccountingError) -> Error {
    match err {
        AccountingError::Shape | AccountingError::Overflow => error!(FundError::Math),
    }
}
