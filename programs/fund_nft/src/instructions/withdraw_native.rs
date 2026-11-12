//! `withdraw_native`: the NFT holder takes native XNT (lamports) held by the
//! Fund account above its rent-exempt minimum.
//!
//! Lamports reach a fund PDA from outside the program: a reflection token
//! that pays native XNT to the owner of each token account pays the fund PDA
//! for the fund's vaults, and anyone can System-transfer to the PDA. No other
//! instruction moves them. The Fund account is owned by this program, so the
//! debit is a direct lamport change, not a System CPI. Nothing else changes:
//! no vault, budget, target, or fund field.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::FundError;
use crate::holder::require_holder;
use crate::instructions::create_fund::NFT_TOKEN_PROGRAM_ID;
use crate::state::Fund;

#[event]
pub struct NativeWithdrawn {
    pub fund: Pubkey,
    pub holder: Pubkey,
    pub amount: u64,
}

#[derive(Accounts)]
pub struct WithdrawNative<'info> {
    /// Current NFT holder. Receives the lamports.
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut)]
    pub fund: Account<'info, Fund>,
    pub nft_mint: InterfaceAccount<'info, Mint>,
    pub nft_account: InterfaceAccount<'info, TokenAccount>,
    #[account(constraint = nft_token_program.key() == NFT_TOKEN_PROGRAM_ID @ FundError::NftTokenProgram)]
    pub nft_token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw_native(ctx: Context<WithdrawNative>, amount: u64) -> Result<()> {
    require!(amount > 0, FundError::ZeroAmount);
    require_holder(
        &ctx.accounts.fund,
        &ctx.accounts.holder.key(),
        &ctx.accounts.nft_mint,
        &ctx.accounts.nft_account,
        &ctx.accounts.nft_token_program.key(),
    )?;

    let fund_info = ctx.accounts.fund.to_account_info();
    let holder_info = ctx.accounts.holder.to_account_info();
    let rent_minimum = Rent::get()?.minimum_balance(fund_info.data_len());
    let (fund_after, holder_after) = plan_native_withdraw(
        fund_info.lamports(),
        rent_minimum,
        holder_info.lamports(),
        amount,
    )?;
    **fund_info.try_borrow_mut_lamports()? = fund_after;
    **holder_info.try_borrow_mut_lamports()? = holder_after;

    emit!(NativeWithdrawn {
        fund: ctx.accounts.fund.key(),
        holder: ctx.accounts.holder.key(),
        amount,
    });
    Ok(())
}

/// Lamports above the rent-exempt minimum. A fund below the minimum (not
/// possible for an Anchor-created account) has none available.
pub fn native_available(fund_lamports: u64, rent_minimum: u64) -> u64 {
    fund_lamports.saturating_sub(rent_minimum)
}

/// New (fund, holder) lamport balances after moving `amount`. Refuses zero,
/// anything that would leave the fund below `rent_minimum`, and overflow.
pub fn plan_native_withdraw(
    fund_lamports: u64,
    rent_minimum: u64,
    holder_lamports: u64,
    amount: u64,
) -> Result<(u64, u64)> {
    require!(amount > 0, FundError::ZeroAmount);
    require!(
        amount <= native_available(fund_lamports, rent_minimum),
        FundError::NativeAboveAvailable
    );
    let fund_after = fund_lamports.checked_sub(amount).ok_or(FundError::Math)?;
    let holder_after = holder_lamports.checked_add(amount).ok_or(FundError::Math)?;
    Ok((fund_after, holder_after))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RENT: u64 = 3_000_000;

    fn code(result: Result<(u64, u64)>) -> u32 {
        match result.expect_err("expected an error") {
            Error::AnchorError(e) => e.error_code_number,
            other => panic!("unexpected error {other:?}"),
        }
    }

    #[test]
    fn available_is_lamports_above_rent() {
        assert_eq!(native_available(RENT, RENT), 0);
        assert_eq!(native_available(RENT + 1, RENT), 1);
        assert_eq!(native_available(RENT + 5_000, RENT), 5_000);
        assert_eq!(native_available(RENT - 1, RENT), 0);
        assert_eq!(native_available(0, RENT), 0);
        assert_eq!(native_available(u64::MAX, 0), u64::MAX);
    }

    #[test]
    fn withdrawing_exactly_the_available_amount_leaves_the_rent_minimum() {
        let (fund, holder) = plan_native_withdraw(RENT + 5_000, RENT, 10, 5_000).unwrap();
        assert_eq!(fund, RENT);
        assert_eq!(holder, 5_010);
    }

    #[test]
    fn a_partial_withdrawal_moves_exactly_the_amount() {
        let (fund, holder) = plan_native_withdraw(RENT + 5_000, RENT, 0, 1).unwrap();
        assert_eq!(fund, RENT + 4_999);
        assert_eq!(holder, 1);
    }

    #[test]
    fn one_lamport_above_available_is_refused() {
        assert_eq!(
            code(plan_native_withdraw(RENT + 5_000, RENT, 0, 5_001)),
            u32::from(FundError::NativeAboveAvailable)
        );
        // At the exact rent boundary nothing is available.
        assert_eq!(
            code(plan_native_withdraw(RENT, RENT, 0, 1)),
            u32::from(FundError::NativeAboveAvailable)
        );
        // Below the boundary nothing is available either.
        assert_eq!(
            code(plan_native_withdraw(RENT - 1, RENT, 0, 1)),
            u32::from(FundError::NativeAboveAvailable)
        );
    }

    #[test]
    fn zero_is_refused() {
        assert_eq!(
            code(plan_native_withdraw(RENT + 5_000, RENT, 0, 0)),
            u32::from(FundError::ZeroAmount)
        );
    }

    #[test]
    fn a_holder_balance_overflow_is_refused() {
        assert_eq!(
            code(plan_native_withdraw(
                RENT + 5_000,
                RENT,
                u64::MAX - 4_999,
                5_000
            )),
            u32::from(FundError::Math)
        );
        assert_eq!(
            plan_native_withdraw(RENT + 5_000, RENT, u64::MAX - 5_000, 5_000).unwrap(),
            (RENT, u64::MAX)
        );
    }

    #[test]
    fn u64_max_amounts_are_refused_without_panicking() {
        assert_eq!(
            code(plan_native_withdraw(u64::MAX, RENT, 0, u64::MAX)),
            u32::from(FundError::NativeAboveAvailable)
        );
        assert_eq!(
            plan_native_withdraw(u64::MAX, RENT, 0, u64::MAX - RENT).unwrap(),
            (RENT, u64::MAX - RENT)
        );
    }
}
