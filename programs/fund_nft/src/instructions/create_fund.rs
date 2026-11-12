use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

use crate::errors::FundError;
use crate::mint_policy::require_allowed_mint;
use crate::state::{validate_create, CreateFundParams, Fund, Target, FUND_SEED};

/// Classic SPL Token program. Verified present and executable on X1 mainnet.
pub const NFT_TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/// Remaining accounts: one mint account per non-cash target, in target order
/// (the cash slice, whose mint is the quote mint, is skipped). Each must match
/// the target's mint and pass the mint extension allowlist.
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
        // Token Metadata refuses a master edition for a mint with no freeze
        // authority ("Cannot create NFT with no Freeze Authority"), and moves
        // it to the edition PDA with the mint authority. This program never
        // signs a freeze.
        mint::freeze_authority = fund,
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

pub fn handle_create_fund(ctx: Context<CreateFund>, params: CreateFundParams) -> Result<()> {
    let quote_mint = ctx.accounts.quote_mint.key();
    let nft_mint = ctx.accounts.nft_mint.key();
    require!(quote_mint != nft_mint, FundError::QuoteMintMismatch);
    validate_create(&quote_mint, &params)?;
    // The fund PDA stays the NFT mint and freeze authority until
    // `attach_metadata`.
    // A target with the NFT mint would let a CPI signed by that PDA see the
    // NFT mint, so it is refused. The mint key is chosen by the creator, so
    // it can be known before the targets are.
    require!(
        params.targets.iter().all(|target| target.mint != nft_mint),
        FundError::TargetIsNftMint
    );
    require_allowed_mint(&ctx.accounts.quote_mint.to_account_info())?;
    let mut mint_accounts = ctx.remaining_accounts.iter();
    for target in params.targets.iter().filter(|t| t.mint != quote_mint) {
        let account = mint_accounts.next().ok_or(FundError::TargetMintAccounts)?;
        require!(account.key() == target.mint, FundError::TargetMintAccounts);
        require_allowed_mint(account)?;
    }
    require!(
        mint_accounts.next().is_none(),
        FundError::TargetMintAccounts
    );

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
    // The fund PDA keeps the mint authority. `attach_metadata` uses it to
    // sign Token Metadata's create instructions, and the master edition then
    // takes it over with max supply 0. This program never signs another
    // `mint_to`.
    Ok(())
}
