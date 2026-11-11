//! Fund NFT. Each NFT owns a vault that dollar-cost-averages its quote token
//! into a fixed basket. There is no admin, pause, owner, or fee switch.

pub mod errors;
pub mod instructions;
pub mod state;
pub mod twap;

use anchor_lang::prelude::*;

pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("BLMAQdL9dJtDakvDb1vbPpx6LVBbcWJiKThAHkz1g4ck");

#[program]
pub mod fund_nft {
    use super::*;

    pub fn create_fund(ctx: Context<CreateFund>, params: CreateFundParams) -> Result<()> {
        instructions::create_fund::handle(ctx, params)
    }
}
