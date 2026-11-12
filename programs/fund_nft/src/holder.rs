//! The NFT-holder check shared by `withdraw`, `attach_metadata`, and
//! `update_metadata`.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::errors::FundError;
use crate::state::Fund;

/// The signer holds the fund's NFT: the mint is the fund's decimals-0 mint,
/// owned by `nft_token_program`, and `nft_account` is a token account of that
/// mint, owned by `holder`, with amount exactly 1.
pub fn require_holder(
    fund: &Fund,
    holder: &Pubkey,
    nft_mint: &InterfaceAccount<Mint>,
    nft_account: &InterfaceAccount<TokenAccount>,
    nft_token_program: &Pubkey,
) -> Result<()> {
    require!(
        nft_mint.key() == fund.nft_mint && nft_mint.decimals == 0,
        FundError::BadNft
    );
    require!(
        nft_account.mint == fund.nft_mint
            && nft_account.owner == *holder
            && nft_account.amount == 1
            && nft_mint.to_account_info().owner == nft_token_program,
        FundError::BadNft
    );
    Ok(())
}
