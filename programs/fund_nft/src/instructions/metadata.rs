//! `attach_metadata` and `update_metadata`: Metaplex Token Metadata for the
//! fund NFT, controlled by the current NFT holder. Display only. Neither
//! instruction touches a vault, a budget, or any fund field.
//!
//! `create_fund` leaves the NFT mint and freeze authorities with the fund
//! PDA so that `attach_metadata` can sign Metaplex's
//! `create_metadata_accounts_v3` as mint authority. `create_master_edition_v3`
//! (max supply 0) then moves both authorities to the edition PDA, owned by
//! Token Metadata, so no further NFT can be minted. Until attach runs, the
//! fund PDA holds both authorities, but this program signs a `mint_to` only
//! once, in `create_fund`, right after initializing the mint, never signs a
//! freeze, and passes the NFT mint to no other CPI it signs (see
//! `create_fund`'s target-mint check).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::metadata::mpl_token_metadata::types::DataV2;
use anchor_spl::metadata::{
    self, CreateMasterEditionV3, CreateMetadataAccountsV3, MetadataAccount,
    UpdateMetadataAccountsV2,
};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::FundError;
use crate::holder::require_holder;
use crate::instructions::create_fund::NFT_TOKEN_PROGRAM_ID;
use crate::metaplex::{self, EDITION_SEED, METADATA_SEED, METAPLEX_PROGRAM_ID};
use crate::state::{Fund, FUND_SEED};

#[event]
pub struct MetadataAttached {
    pub fund: Pubkey,
    pub nft_mint: Pubkey,
    pub holder: Pubkey,
}

#[event]
pub struct MetadataUpdated {
    pub fund: Pubkey,
    pub nft_mint: Pubkey,
    pub holder: Pubkey,
}

#[derive(Accounts)]
pub struct AttachMetadata<'info> {
    /// Current NFT holder. Pays rent for the metadata and edition accounts.
    #[account(mut)]
    pub holder: Signer<'info>,
    pub fund: Account<'info, Fund>,
    #[account(mut)]
    pub nft_mint: InterfaceAccount<'info, Mint>,
    pub nft_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: Token Metadata PDA of `nft_mint` (seeds checked). Must be empty;
    /// Token Metadata creates it.
    #[account(
        mut,
        seeds = [METADATA_SEED, METAPLEX_PROGRAM_ID.as_ref(), nft_mint.key().as_ref()],
        bump,
        seeds::program = METAPLEX_PROGRAM_ID,
    )]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: Token Metadata master-edition PDA of `nft_mint` (seeds checked).
    /// Must be empty; Token Metadata creates it.
    #[account(
        mut,
        seeds = [METADATA_SEED, METAPLEX_PROGRAM_ID.as_ref(), nft_mint.key().as_ref(), EDITION_SEED],
        bump,
        seeds::program = METAPLEX_PROGRAM_ID,
    )]
    pub master_edition: UncheckedAccount<'info>,
    #[account(constraint = nft_token_program.key() == NFT_TOKEN_PROGRAM_ID @ FundError::NftTokenProgram)]
    pub nft_token_program: Interface<'info, TokenInterface>,
    /// CHECK: must be `metaplex::METAPLEX_PROGRAM_ID` and executable.
    pub metadata_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct UpdateMetadata<'info> {
    pub holder: Signer<'info>,
    pub fund: Account<'info, Fund>,
    pub nft_mint: InterfaceAccount<'info, Mint>,
    pub nft_account: InterfaceAccount<'info, TokenAccount>,
    /// Owned by Token Metadata (checked by the account type), at the PDA of
    /// `nft_mint`.
    #[account(
        mut,
        seeds = [METADATA_SEED, METAPLEX_PROGRAM_ID.as_ref(), nft_mint.key().as_ref()],
        bump,
        seeds::program = METAPLEX_PROGRAM_ID,
    )]
    pub metadata: Account<'info, MetadataAccount>,
    #[account(constraint = nft_token_program.key() == NFT_TOKEN_PROGRAM_ID @ FundError::NftTokenProgram)]
    pub nft_token_program: Interface<'info, TokenInterface>,
    /// CHECK: must be `metaplex::METAPLEX_PROGRAM_ID` and executable.
    pub metadata_program: UncheckedAccount<'info>,
}

fn require_metadata_program(program: &AccountInfo) -> Result<()> {
    require!(
        program.key() == METAPLEX_PROGRAM_ID && program.executable,
        FundError::BadMetadataProgram
    );
    Ok(())
}

pub fn handle_attach_metadata(
    ctx: Context<AttachMetadata>,
    name: String,
    symbol: String,
    uri: String,
) -> Result<()> {
    metaplex::validate_fields(&name, &symbol, &uri)?;
    require_metadata_program(&ctx.accounts.metadata_program.to_account_info())?;
    require_holder(
        &ctx.accounts.fund,
        &ctx.accounts.holder.key(),
        &ctx.accounts.nft_mint,
        &ctx.accounts.nft_account,
        &ctx.accounts.nft_token_program.key(),
    )?;
    require!(
        ctx.accounts.metadata.data_is_empty() && ctx.accounts.master_edition.data_is_empty(),
        FundError::MetadataExists
    );
    let fund_key = ctx.accounts.fund.key();
    require!(
        ctx.accounts.nft_mint.mint_authority == COption::Some(fund_key)
            && ctx.accounts.nft_mint.supply == 1,
        FundError::NftMintAuthority
    );

    let nft_mint = ctx.accounts.nft_mint.key();
    let bump_seed = [ctx.accounts.fund.bump];
    let signer: &[&[u8]] = &[FUND_SEED, nft_mint.as_ref(), &bump_seed];
    let fund_info = ctx.accounts.fund.to_account_info();

    metadata::create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            METAPLEX_PROGRAM_ID,
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.nft_mint.to_account_info(),
                mint_authority: fund_info.clone(),
                payer: ctx.accounts.holder.to_account_info(),
                update_authority: fund_info.clone(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &[signer],
        ),
        DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        true,
        true,
        None,
    )?;
    metadata::create_master_edition_v3(
        CpiContext::new_with_signer(
            METAPLEX_PROGRAM_ID,
            CreateMasterEditionV3 {
                edition: ctx.accounts.master_edition.to_account_info(),
                mint: ctx.accounts.nft_mint.to_account_info(),
                update_authority: fund_info.clone(),
                mint_authority: fund_info,
                payer: ctx.accounts.holder.to_account_info(),
                metadata: ctx.accounts.metadata.to_account_info(),
                token_program: ctx.accounts.nft_token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &[signer],
        ),
        Some(0),
    )?;

    // Token Metadata must have taken the mint and freeze authorities and left
    // supply at 1.
    ctx.accounts.nft_mint.reload()?;
    let edition = COption::Some(ctx.accounts.master_edition.key());
    require!(
        ctx.accounts.nft_mint.mint_authority == edition
            && ctx.accounts.nft_mint.freeze_authority == edition
            && ctx.accounts.nft_mint.supply == 1,
        FundError::NftMintAuthority
    );
    emit!(MetadataAttached {
        fund: fund_key,
        nft_mint,
        holder: ctx.accounts.holder.key(),
    });
    Ok(())
}

pub fn handle_update_metadata(
    ctx: Context<UpdateMetadata>,
    name: Option<String>,
    symbol: Option<String>,
    uri: Option<String>,
) -> Result<()> {
    require!(
        name.is_some() || symbol.is_some() || uri.is_some(),
        FundError::NothingToUpdate
    );
    if let Some(name) = &name {
        metaplex::validate_name(name)?;
    }
    if let Some(symbol) = &symbol {
        metaplex::validate_symbol(symbol)?;
    }
    if let Some(uri) = &uri {
        metaplex::validate_uri(uri)?;
    }
    require_metadata_program(&ctx.accounts.metadata_program.to_account_info())?;
    require_holder(
        &ctx.accounts.fund,
        &ctx.accounts.holder.key(),
        &ctx.accounts.nft_mint,
        &ctx.accounts.nft_account,
        &ctx.accounts.nft_token_program.key(),
    )?;
    let fund_key = ctx.accounts.fund.key();
    let current = &ctx.accounts.metadata;
    require!(
        current.mint == ctx.accounts.nft_mint.key() && current.update_authority == fund_key,
        FundError::BadMetadata
    );
    // Unchanged fields keep their stored value (minus any NUL padding older
    // Token Metadata versions add). Royalty, creators, collection, and uses
    // are carried over as stored.
    let data = DataV2 {
        name: name.unwrap_or_else(|| metaplex::trim_nul(&current.name)),
        symbol: symbol.unwrap_or_else(|| metaplex::trim_nul(&current.symbol)),
        uri: uri.unwrap_or_else(|| metaplex::trim_nul(&current.uri)),
        seller_fee_basis_points: current.seller_fee_basis_points,
        creators: current.creators.clone(),
        collection: current.collection.clone(),
        uses: current.uses.clone(),
    };

    let nft_mint = ctx.accounts.nft_mint.key();
    let bump_seed = [ctx.accounts.fund.bump];
    let signer: &[&[u8]] = &[FUND_SEED, nft_mint.as_ref(), &bump_seed];
    metadata::update_metadata_accounts_v2(
        CpiContext::new_with_signer(
            METAPLEX_PROGRAM_ID,
            UpdateMetadataAccountsV2 {
                metadata: ctx.accounts.metadata.to_account_info(),
                update_authority: ctx.accounts.fund.to_account_info(),
            },
            &[signer],
        ),
        None,
        Some(data),
        None,
        None,
    )?;
    emit!(MetadataUpdated {
        fund: fund_key,
        nft_mint,
        holder: ctx.accounts.holder.key(),
    });
    Ok(())
}
