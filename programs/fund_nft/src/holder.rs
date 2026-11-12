//! The NFT-holder check shared by `withdraw`, `withdraw_native`,
//! `attach_metadata`, and `update_metadata`.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::errors::FundError;
use crate::state::Fund;

/// The signer holds the fund's NFT: the mint is the fund's decimals-0 mint
/// with total supply exactly 1, owned by `nft_token_program`, and
/// `nft_account` is a token account of that mint, owned by `holder`, with
/// amount exactly 1.
///
/// The supply check matters after `attach_metadata`: mint authority then sits
/// with the Metaplex edition PDA, so a malicious Metaplex upgrade could mint a
/// second unit. Without `supply == 1`, that second account would also pass
/// `amount == 1` and could withdraw the fund. With it, an inflated NFT blocks
/// every holder action (funds stay in the vaults) instead of letting a second
/// holder drain them.
pub fn require_holder(
    fund: &Fund,
    holder: &Pubkey,
    nft_mint: &InterfaceAccount<Mint>,
    nft_account: &InterfaceAccount<TokenAccount>,
    nft_token_program: &Pubkey,
) -> Result<()> {
    require!(
        holder_ok(HolderFacts {
            fund_nft_mint: fund.nft_mint,
            mint_key: nft_mint.key(),
            mint_decimals: nft_mint.decimals,
            mint_supply: nft_mint.supply,
            mint_owner: *nft_mint.to_account_info().owner,
            account_mint: nft_account.mint,
            account_owner: nft_account.owner,
            account_amount: nft_account.amount,
            account_program: *nft_account.to_account_info().owner,
            holder: *holder,
            nft_token_program: *nft_token_program,
        }),
        FundError::BadNft
    );
    Ok(())
}

/// Plain facts read from the accounts, so the rule can be unit-tested.
#[derive(Clone, Copy)]
pub struct HolderFacts {
    pub fund_nft_mint: Pubkey,
    pub mint_key: Pubkey,
    pub mint_decimals: u8,
    pub mint_supply: u64,
    pub mint_owner: Pubkey,
    pub account_mint: Pubkey,
    pub account_owner: Pubkey,
    pub account_amount: u64,
    /// Owner program of the holder's token account; must equal the NFT's token program.
    pub account_program: Pubkey,
    pub holder: Pubkey,
    pub nft_token_program: Pubkey,
}

pub fn holder_ok(f: HolderFacts) -> bool {
    f.mint_key == f.fund_nft_mint
        && f.mint_decimals == 0
        && f.mint_supply == 1
        && f.mint_owner == f.nft_token_program
        && f.account_mint == f.fund_nft_mint
        && f.account_owner == f.holder
        && f.account_amount == 1
        && f.account_program == f.nft_token_program
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok() -> HolderFacts {
        let mint = Pubkey::new_from_array([7u8; 32]);
        let program = Pubkey::new_from_array([9u8; 32]);
        let holder = Pubkey::new_from_array([3u8; 32]);
        HolderFacts {
            fund_nft_mint: mint,
            mint_key: mint,
            mint_decimals: 0,
            mint_supply: 1,
            mint_owner: program,
            account_mint: mint,
            account_owner: holder,
            account_amount: 1,
            account_program: program,
            holder,
            nft_token_program: program,
        }
    }

    #[test]
    fn the_single_holder_passes() {
        assert!(holder_ok(ok()));
    }

    #[test]
    fn an_inflated_nft_supply_blocks_every_holder() {
        // A second unit minted by anyone (e.g. a compromised Metaplex upgrade
        // holding mint authority after attach) must not create a second
        // account that passes amount == 1.
        for supply in [0u64, 2, 3, u64::MAX] {
            let mut f = ok();
            f.mint_supply = supply;
            assert!(!holder_ok(f), "supply {supply}");
        }
    }

    #[test]
    fn every_other_field_is_checked() {
        let other = Pubkey::new_from_array([1u8; 32]);
        let cases: [fn(&mut HolderFacts, Pubkey); 8] = [
            |f, o| f.mint_key = o,
            |f, _| f.mint_decimals = 1,
            |f, o| f.mint_owner = o,
            |f, o| f.account_mint = o,
            |f, o| f.account_owner = o,
            |f, _| f.account_amount = 2,
            |f, _| f.account_amount = 0,
            |f, o| f.account_program = o,
        ];
        for (i, mutate) in cases.iter().enumerate() {
            let mut f = ok();
            mutate(&mut f, other);
            assert!(!holder_ok(f), "case {i}");
        }
    }
}
