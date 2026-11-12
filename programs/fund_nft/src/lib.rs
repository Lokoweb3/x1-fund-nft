//! Fund NFT. Each NFT owns a vault that dollar-cost-averages its quote token
//! into a fixed basket. There is no admin, pause, owner, or fee switch.

pub mod accounting;
pub mod errors;
pub mod holder;
pub mod instructions;
pub mod metaplex;
pub mod mint_policy;
pub mod state;
pub mod token_fee;
pub mod twap;
pub mod xdex;

use anchor_lang::prelude::*;

pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("6dmHtarR9KGE4CtkjhmXQLp4o8xXWAHuG11KeeN2nrUM");

#[program]
pub mod fund_nft {
    use super::*;

    pub fn create_fund(ctx: Context<CreateFund>, params: CreateFundParams) -> Result<()> {
        instructions::create_fund::handle_create_fund(ctx, params)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handle_deposit(ctx, amount)
    }

    pub fn execute_dca(ctx: Context<ExecuteDca>, target_index: u8) -> Result<()> {
        instructions::execute_dca::handle_execute_dca(ctx, target_index)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handle_withdraw(ctx, amount)
    }

    pub fn attach_metadata(
        ctx: Context<AttachMetadata>,
        name: String,
        symbol: String,
        uri: String,
    ) -> Result<()> {
        instructions::metadata::handle_attach_metadata(ctx, name, symbol, uri)
    }

    pub fn update_metadata(
        ctx: Context<UpdateMetadata>,
        name: Option<String>,
        symbol: Option<String>,
        uri: Option<String>,
    ) -> Result<()> {
        instructions::metadata::handle_update_metadata(ctx, name, symbol, uri)
    }

    pub fn withdraw_native(ctx: Context<WithdrawNative>, amount: u64) -> Result<()> {
        instructions::withdraw_native::handle_withdraw_native(ctx, amount)
    }
}
