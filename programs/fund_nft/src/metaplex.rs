//! Metaplex Token Metadata for the fund NFT. Display only: nothing in the
//! fund's accounting reads the metadata.
//!
//! X1 mainnet and X1 testnet both run Token Metadata at
//! `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` (upgradeable, authority
//! `X1TMEC99KMa4MGEKfcrSJ6HZTiwvPVyrwQczZjuCoLV`, checked 2026-11-12), so
//! there is one id for both builds. The CPI builders in `anchor_spl::metadata`
//! hard-code the same id as the instruction's program id; a unit test checks
//! they agree.

use anchor_lang::prelude::*;

use crate::errors::FundError;

/// The only metadata program `attach_metadata` and `update_metadata` call.
pub const METAPLEX_PROGRAM_ID: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

/// Token Metadata limits, in bytes (`MAX_NAME_LENGTH`, `MAX_SYMBOL_LENGTH`,
/// `MAX_URI_LENGTH`).
/// Most `attach_metadata` may debit the holder, in lamports (0.03 XNT).
/// Measured honest cost on the cloned X1 Token Metadata program on
/// 2026-11-12: 16,145,680 lamports (metadata 15,115,600 incl. the 0.01 XNT
/// creation fee, plus edition 1,030,080). The holder signer and the System
/// Program are forwarded to the upgradeable Token Metadata program, so this
/// cap bounds what a malicious upgrade could take from the holder's wallet.
pub const MAX_ATTACH_DEBIT_LAMPORTS: u64 = 30_000_000;

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;

pub const METADATA_SEED: &[u8] = b"metadata";
pub const EDITION_SEED: &[u8] = b"edition";

/// Older Token Metadata versions pad stored strings with NUL bytes, and
/// `update_metadata` trims trailing NULs when it keeps an unchanged field.
/// Rejecting NUL in new values keeps that trim lossless.
fn check_field(value: &str, max: usize, too_long: FundError) -> Result<()> {
    if value.len() > max {
        return Err(too_long.into());
    }
    require!(!value.contains('\0'), FundError::MetadataNul);
    Ok(())
}

pub fn validate_name(name: &str) -> Result<()> {
    check_field(name, MAX_NAME_LEN, FundError::MetadataNameTooLong)
}

pub fn validate_symbol(symbol: &str) -> Result<()> {
    check_field(symbol, MAX_SYMBOL_LEN, FundError::MetadataSymbolTooLong)
}

pub fn validate_uri(uri: &str) -> Result<()> {
    check_field(uri, MAX_URI_LEN, FundError::MetadataUriTooLong)
}

pub fn validate_fields(name: &str, symbol: &str, uri: &str) -> Result<()> {
    validate_name(name)?;
    validate_symbol(symbol)?;
    validate_uri(uri)
}

pub fn metadata_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[METADATA_SEED, METAPLEX_PROGRAM_ID.as_ref(), mint.as_ref()],
        &METAPLEX_PROGRAM_ID,
    )
    .0
}

pub fn edition_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            METADATA_SEED,
            METAPLEX_PROGRAM_ID.as_ref(),
            mint.as_ref(),
            EDITION_SEED,
        ],
        &METAPLEX_PROGRAM_ID,
    )
    .0
}

pub fn trim_nul(value: &str) -> String {
    value.trim_end_matches('\0').to_string()
}

#[cfg(test)]
mod tests {
    use super::MAX_ATTACH_DEBIT_LAMPORTS;

    #[test]
    fn attach_cost_cap_covers_the_honest_cost_and_little_more() {
        // Measured on the cloned X1 Token Metadata program (2026-11-12).
        let honest: u64 = 15_115_600 + 1_030_080;
        assert!(MAX_ATTACH_DEBIT_LAMPORTS >= honest * 3 / 2, "headroom for rent changes");
        assert!(MAX_ATTACH_DEBIT_LAMPORTS <= 50_000_000, "cap stays small (0.05 XNT)");
    }

    use super::*;

    fn code(result: Result<()>) -> u32 {
        match result.unwrap_err() {
            Error::AnchorError(err) => err.error_code_number,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn program_id_matches_the_anchor_spl_cpi_builders() {
        assert_eq!(METAPLEX_PROGRAM_ID, anchor_spl::metadata::ID);
        assert_eq!(
            METAPLEX_PROGRAM_ID,
            anchor_spl::metadata::mpl_token_metadata::ID
        );
        assert_eq!(
            MAX_NAME_LEN,
            anchor_spl::metadata::mpl_token_metadata::MAX_NAME_LENGTH
        );
        assert_eq!(
            MAX_SYMBOL_LEN,
            anchor_spl::metadata::mpl_token_metadata::MAX_SYMBOL_LENGTH
        );
        assert_eq!(
            MAX_URI_LEN,
            anchor_spl::metadata::mpl_token_metadata::MAX_URI_LENGTH
        );
    }

    #[test]
    fn bounds_accept_the_limits_and_reject_one_more_byte() {
        let name = "n".repeat(32);
        let symbol = "s".repeat(10);
        let uri = "u".repeat(200);
        assert!(validate_fields(&name, &symbol, &uri).is_ok());
        assert!(validate_fields("", "", "").is_ok());
        assert_eq!(
            code(validate_fields(&"n".repeat(33), &symbol, &uri)),
            u32::from(FundError::MetadataNameTooLong)
        );
        assert_eq!(
            code(validate_fields(&name, &"s".repeat(11), &uri)),
            u32::from(FundError::MetadataSymbolTooLong)
        );
        assert_eq!(
            code(validate_fields(&name, &symbol, &"u".repeat(201))),
            u32::from(FundError::MetadataUriTooLong)
        );
    }

    #[test]
    fn bounds_count_bytes_not_characters() {
        // 11 two-byte characters is 22 bytes: fine for a name, too long for a symbol.
        let wide = "é".repeat(11);
        assert!(validate_name(&wide).is_ok());
        assert_eq!(
            code(validate_symbol(&wide)),
            u32::from(FundError::MetadataSymbolTooLong)
        );
        // 17 two-byte characters is 34 bytes.
        assert_eq!(
            code(validate_name(&"é".repeat(17))),
            u32::from(FundError::MetadataNameTooLong)
        );
    }

    #[test]
    fn nul_bytes_are_rejected_and_padding_is_trimmed() {
        assert_eq!(
            code(validate_name("a\0")),
            u32::from(FundError::MetadataNul)
        );
        assert_eq!(code(validate_uri("\0")), u32::from(FundError::MetadataNul));
        assert_eq!(trim_nul("Fund\0\0\0"), "Fund");
    }

    #[test]
    fn pdas_use_the_token_metadata_seeds() {
        let mint = Pubkey::new_from_array([7u8; 32]);
        let (md, _) = Pubkey::find_program_address(
            &[b"metadata", METAPLEX_PROGRAM_ID.as_ref(), mint.as_ref()],
            &METAPLEX_PROGRAM_ID,
        );
        assert_eq!(metadata_address(&mint), md);
        assert_eq!(
            anchor_spl::metadata::mpl_token_metadata::accounts::Metadata::find_pda(&mint).0,
            md
        );
        assert_eq!(
            anchor_spl::metadata::mpl_token_metadata::accounts::MasterEdition::find_pda(&mint).0,
            edition_address(&mint)
        );
    }
}
