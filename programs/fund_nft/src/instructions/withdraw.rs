use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::accounting::{self, AccountingError};
use crate::errors::FundError;
use crate::holder::require_holder;
use crate::state::Fund;

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub holder: Signer<'info>,
    #[account(mut)]
    pub fund: Account<'info, Fund>,
    pub nft_mint: InterfaceAccount<'info, Mint>,
    pub nft_account: InterfaceAccount<'info, TokenAccount>,
    pub nft_token_program: Interface<'info, TokenInterface>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub destination: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, FundError::ZeroAmount);
    let fund_key = ctx.accounts.fund.key();
    let quote_mint = ctx.accounts.fund.quote_mint;
    require_holder(
        &ctx.accounts.fund,
        &ctx.accounts.holder.key(),
        &ctx.accounts.nft_mint,
        &ctx.accounts.nft_account,
        &ctx.accounts.nft_token_program.key(),
    )?;
    require!(
        ctx.accounts.mint.to_account_info().owner == &ctx.accounts.token_program.key(),
        FundError::BadTokenProgram
    );
    let mint = ctx.accounts.mint.key();
    require!(
        ctx.accounts.vault.key()
            == get_associated_token_address_with_program_id(
                &fund_key,
                &mint,
                &ctx.accounts.token_program.key(),
            )
            && ctx.accounts.vault.mint == mint,
        FundError::BadVault
    );
    require!(
        ctx.accounts.destination.mint == mint
            && ctx.accounts.destination.owner == ctx.accounts.holder.key()
            && ctx.accounts.destination.key() != ctx.accounts.vault.key(),
        FundError::BadDestination
    );

    let bump = ctx.accounts.fund.bump;
    let nft_mint = ctx.accounts.fund.nft_mint;
    let bump_seed = [bump];
    let signer: &[&[u8]] = &[crate::state::FUND_SEED, nft_mint.as_ref(), &bump_seed];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.fund.to_account_info(),
            },
            &[signer],
        ),
        amount,
        ctx.accounts.mint.decimals,
    )?;

    if mint == quote_mint {
        let fund = &mut ctx.accounts.fund;
        let mut budgets: Vec<u64> = fund.targets.iter().map(|target| target.budget).collect();
        accounting::debit_budgets(&mut budgets, amount).map_err(map_accounting)?;
        for (target, budget) in fund.targets.iter_mut().zip(budgets) {
            target.budget = budget;
        }
    }
    Ok(())
}

fn map_accounting(err: AccountingError) -> Error {
    match err {
        AccountingError::Shape | AccountingError::Overflow | AccountingError::ZeroSlice => {
            error!(FundError::Math)
        }
    }
}
