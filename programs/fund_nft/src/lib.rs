//! Fund NFT. Each NFT owns a vault that dollar-cost-averages its quote token
//! into a fixed basket. There is no admin, pause, owner, or fee switch.

pub mod accounting;
pub mod errors;
pub mod instructions;
pub mod mint_policy;
pub mod state;
pub mod token_fee;
pub mod twap;
pub mod xdex;

use anchor_lang::prelude::*;

pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("BLMAQdL9dJtDakvDb1vbPpx6LVBbcWJiKThAHkz1g4ck");

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
}
