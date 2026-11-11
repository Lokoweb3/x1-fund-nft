use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, SetAuthority, TokenAccount, TokenInterface};

use crate::errors::FundError;
use crate::state::{validate_create, CreateFundParams, Fund, Target, FUND_SEED};

/// Classic SPL Token program. Verified present and executable on X1 mainnet.
pub const NFT_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

#[derive(Accounts)]
pub struct CreateFund<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Fund::INIT_SPACE,
        seeds = [FUND_SEED, nft_mint.key().as_ref()],
        bump
    )]
    pub fund: Account<'info, Fund>,
    #[account(
        init,
        payer = creator,
        mint::decimals = 0,
        mint::authority = fund,
        mint::token_program = token_program,
    )]
    pub nft_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = creator,
        associated_token::mint = nft_mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program,
    )]
    pub creator_nft_account: InterfaceAccount<'info, TokenAccount>,
    pub quote_mint: InterfaceAccount<'info, Mint>,
    #[account(constraint = token_program.key() == NFT_TOKEN_PROGRAM_ID @ FundError::NftTokenProgram)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle(ctx: Context<CreateFund>, params: CreateFundParams) -> Result<()> {
    let quote_mint = ctx.accounts.quote_mint.key();
    let nft_mint = ctx.accounts.nft_mint.key();
    require!(quote_mint != nft_mint, FundError::QuoteMintMismatch);
    validate_create(&quote_mint, &params)?;

    let bump = ctx.bumps.fund;
    {
        let fund = &mut ctx.accounts.fund;
        fund.nft_mint = nft_mint;
        fund.quote_mint = quote_mint;
        fund.bump = bump;
        fund.per_run_quote = params.per_run_quote;
        fund.interval_secs = params.interval_secs;
        fund.twap_window_secs = params.twap_window_secs;
        fund.max_dev_bps = params.max_dev_bps;
        fund.targets = params
            .targets
            .into_iter()
            .map(|target| Target {
                mint: target.mint,
                pool: target.pool,
                bps: target.bps,
                budget: 0,
                last_run: 0,
            })
            .collect();
    }

    let bump_seed = [bump];
    let signer: &[&[u8]] = &[FUND_SEED, nft_mint.as_ref(), &bump_seed];
    // anchor-spl 1.2.2's `token_interface::mint_to` passes account infos as
    // [destination, mint, authority]. The Token instruction itself is
    // [mint, destination, authority], so the helper cannot succeed. The
    // instruction bytes come from the same `spl_token_2022` crate the helper uses.
    let mint_ix = token_interface::spl_token_2022::instruction::mint_to(
        &ctx.accounts.token_program.key(),
        &nft_mint,
        &ctx.accounts.creator_nft_account.key(),
        &ctx.accounts.fund.key(),
        &[],
        1,
    )?;
    anchor_lang::solana_program::program::invoke_signed(
        &mint_ix,
        &[
            ctx.accounts.nft_mint.to_account_info(),
            ctx.accounts.creator_nft_account.to_account_info(),
            ctx.accounts.fund.to_account_info(),
        ],
        &[signer],
    )?;
    token_interface::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            SetAuthority {
                current_authority: ctx.accounts.fund.to_account_info(),
                account_or_mint: ctx.accounts.nft_mint.to_account_info(),
            },
            &[signer],
        ),
        anchor_spl::token_interface::spl_token_2022::instruction::AuthorityType::MintTokens,
        None,
    )?;
    Ok(())
}
