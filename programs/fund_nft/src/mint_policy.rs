//! Mint extension allowlist for the quote and target mints.
//!
//! Classic SPL Token mints pass. A Token-2022 mint passes only if every TLV
//! entry after the account-type byte is on `ALLOWED_EXTENSIONS`. Anything
//! else (transfer hooks, permanent delegates, pausable, non-transferable,
//! default-frozen state, confidential transfers, ...) can block or claw back
//! the fund's tokens, so `create_fund`, `deposit`, and `execute_dca` refuse
//! such mints. `withdraw` does not call this, so a holder can always try to
//! take out what is already in the vault.
//!
//! The numeric `ExtensionType` values come from the `spl-token-2022-interface`
//! version that `Cargo.lock` resolves (2.1.0, pulled in by anchor-spl 1.2.2):
//! `~/.cargo/registry/src/index.crates.io-*/spl-token-2022-interface-2.1.0/src/extension/mod.rs`,
//! `pub enum ExtensionType` (`#[repr(u16)]`, implicit discriminants from 0).
//! The unit test below checks each constant against that enum through
//! `anchor_spl::token_interface::spl_token_2022`.

use anchor_lang::prelude::*;

use crate::instructions::create_fund::NFT_TOKEN_PROGRAM_ID;
use crate::instructions::execute_dca::TOKEN_2022_PROGRAM_ID;

pub const EXT_TRANSFER_FEE_CONFIG: u16 = 1;
pub const EXT_MINT_CLOSE_AUTHORITY: u16 = 3;
pub const EXT_INTEREST_BEARING_CONFIG: u16 = 10;
pub const EXT_METADATA_POINTER: u16 = 18;
pub const EXT_TOKEN_METADATA: u16 = 19;
pub const EXT_GROUP_POINTER: u16 = 20;
pub const EXT_TOKEN_GROUP: u16 = 21;
pub const EXT_GROUP_MEMBER_POINTER: u16 = 22;
pub const EXT_TOKEN_GROUP_MEMBER: u16 = 23;
pub const EXT_SCALED_UI_AMOUNT: u16 = 25;

pub const ALLOWED_EXTENSIONS: [u16; 10] = [
    EXT_TRANSFER_FEE_CONFIG,
    EXT_MINT_CLOSE_AUTHORITY,
    EXT_INTEREST_BEARING_CONFIG,
    EXT_METADATA_POINTER,
    EXT_TOKEN_METADATA,
    EXT_GROUP_POINTER,
    EXT_TOKEN_GROUP,
    EXT_GROUP_MEMBER_POINTER,
    EXT_TOKEN_GROUP_MEMBER,
    EXT_SCALED_UI_AMOUNT,
];

/// Base mint length shared by both token programs.
pub const BASE_MINT_LEN: usize = 82;
const IS_INITIALIZED_OFFSET: usize = 45;
const ACCOUNT_TYPE_OFFSET: usize = 165;
const TLV_START: usize = 166;
const ACCOUNT_TYPE_MINT: u8 = 1;
/// `ExtensionType::Uninitialized`. Token-2022 stops reading TLV entries here.
const EXT_UNINITIALIZED: u16 = 0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MintPolicyError {
    /// The account is not owned by either token program.
    NotATokenProgram,
    /// The bytes are not an initialized mint of the owner's layout.
    Malformed,
    /// A Token-2022 extension type that is not on the allowlist.
    Disallowed(u16),
}

pub fn check_mint_bytes(owner: &Pubkey, data: &[u8]) -> core::result::Result<(), MintPolicyError> {
    if *owner == NFT_TOKEN_PROGRAM_ID {
        if data.len() != BASE_MINT_LEN || data[IS_INITIALIZED_OFFSET] != 1 {
            return Err(MintPolicyError::Malformed);
        }
        return Ok(());
    }
    if *owner != TOKEN_2022_PROGRAM_ID {
        return Err(MintPolicyError::NotATokenProgram);
    }
    if data.len() < BASE_MINT_LEN || data[IS_INITIALIZED_OFFSET] != 1 {
        return Err(MintPolicyError::Malformed);
    }
    if data.len() == BASE_MINT_LEN {
        return Ok(());
    }
    if data.len() < TLV_START || data[ACCOUNT_TYPE_OFFSET] != ACCOUNT_TYPE_MINT {
        return Err(MintPolicyError::Malformed);
    }
    // Mirrors spl-token-2022-interface `get_tlv_data_info`: a single trailing
    // byte is realloc padding, a zero type ends the entries, and a non-zero
    // type without its two-byte length is malformed.
    let mut offset = TLV_START;
    while offset < data.len() {
        if data.len() - offset < 2 {
            break;
        }
        let typ = u16::from_le_bytes([data[offset], data[offset + 1]]);
        if typ == EXT_UNINITIALIZED {
            break;
        }
        if data.len() - offset < 4 {
            return Err(MintPolicyError::Malformed);
        }
        let len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        let next = offset + 4 + len;
        if next > data.len() {
            return Err(MintPolicyError::Malformed);
        }
        if !ALLOWED_EXTENSIONS.contains(&typ) {
            return Err(MintPolicyError::Disallowed(typ));
        }
        offset = next;
    }
    Ok(())
}

/// Checks a mint account against the policy and maps failures to `FundError`.
pub fn require_allowed_mint(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    check_mint_bytes(mint.owner, &data).map_err(|err| match err {
        MintPolicyError::Disallowed(typ) => {
            msg!("mint {} has disallowed extension type {}", mint.key, typ);
            error!(crate::errors::FundError::DisallowedMintExtension)
        }
        MintPolicyError::NotATokenProgram | MintPolicyError::Malformed => {
            error!(crate::errors::FundError::BadMintAccount)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_spl::token_interface::spl_token_2022::extension::ExtensionType;

    #[test]
    fn constants_match_the_resolved_spl_token_2022_enum() {
        let pairs = [
            (EXT_TRANSFER_FEE_CONFIG, ExtensionType::TransferFeeConfig),
            (EXT_MINT_CLOSE_AUTHORITY, ExtensionType::MintCloseAuthority),
            (EXT_INTEREST_BEARING_CONFIG, ExtensionType::InterestBearingConfig),
            (EXT_METADATA_POINTER, ExtensionType::MetadataPointer),
            (EXT_TOKEN_METADATA, ExtensionType::TokenMetadata),
            (EXT_GROUP_POINTER, ExtensionType::GroupPointer),
            (EXT_TOKEN_GROUP, ExtensionType::TokenGroup),
            (EXT_GROUP_MEMBER_POINTER, ExtensionType::GroupMemberPointer),
            (EXT_TOKEN_GROUP_MEMBER, ExtensionType::TokenGroupMember),
            (EXT_SCALED_UI_AMOUNT, ExtensionType::ScaledUiAmount),
        ];
        for (value, ext) in pairs {
            assert_eq!(value, u16::from(ext), "{ext:?}");
        }
        assert_eq!(EXT_UNINITIALIZED, u16::from(ExtensionType::Uninitialized));
        assert_eq!(crate::token_fee::TRANSFER_FEE_CONFIG_TYPE, EXT_TRANSFER_FEE_CONFIG);
    }

    #[test]
    fn rejects_every_other_known_extension() {
        for ext in [
            ExtensionType::TransferFeeAmount,
            ExtensionType::ConfidentialTransferMint,
            ExtensionType::ConfidentialTransferAccount,
            ExtensionType::DefaultAccountState,
            ExtensionType::ImmutableOwner,
            ExtensionType::MemoTransfer,
            ExtensionType::NonTransferable,
            ExtensionType::CpiGuard,
            ExtensionType::PermanentDelegate,
            ExtensionType::NonTransferableAccount,
            ExtensionType::TransferHook,
            ExtensionType::TransferHookAccount,
            ExtensionType::ConfidentialTransferFeeConfig,
            ExtensionType::ConfidentialTransferFeeAmount,
            ExtensionType::ConfidentialMintBurn,
            ExtensionType::Pausable,
            ExtensionType::PausableAccount,
        ] {
            let typ = u16::from(ext);
            assert!(!ALLOWED_EXTENSIONS.contains(&typ), "{ext:?}");
            let data = mint_2022(&[(EXT_METADATA_POINTER, 64), (typ, 8)]);
            assert_eq!(
                check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &data),
                Err(MintPolicyError::Disallowed(typ)),
                "{ext:?}"
            );
        }
        // An unknown future type is rejected too.
        let data = mint_2022(&[(999, 0)]);
        assert_eq!(
            check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &data),
            Err(MintPolicyError::Disallowed(999))
        );
    }

    fn base_mint() -> Vec<u8> {
        let mut data = vec![0u8; BASE_MINT_LEN];
        data[IS_INITIALIZED_OFFSET] = 1;
        data
    }

    fn mint_2022(entries: &[(u16, u16)]) -> Vec<u8> {
        let mut data = base_mint();
        data.resize(TLV_START, 0);
        data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_MINT;
        for (typ, len) in entries {
            data.extend_from_slice(&typ.to_le_bytes());
            data.extend_from_slice(&len.to_le_bytes());
            data.extend(std::iter::repeat(7).take(*len as usize));
        }
        data
    }

    #[test]
    fn classic_and_allowlisted_2022_mints_pass() {
        assert_eq!(check_mint_bytes(&NFT_TOKEN_PROGRAM_ID, &base_mint()), Ok(()));
        assert_eq!(check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &base_mint()), Ok(()));
        let all: Vec<(u16, u16)> = ALLOWED_EXTENSIONS.iter().map(|t| (*t, 12)).collect();
        assert_eq!(check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &mint_2022(&all)), Ok(()));
        // TEST-shaped mint: metadata pointer, transfer fee, then trailing zeros.
        let mut test_like = mint_2022(&[(EXT_METADATA_POINTER, 64), (EXT_TRANSFER_FEE_CONFIG, 108)]);
        test_like.extend_from_slice(&[0u8; 6]);
        assert_eq!(check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &test_like), Ok(()));
    }

    #[test]
    fn malformed_or_foreign_accounts_are_rejected() {
        let other = Pubkey::new_from_array([5u8; 32]);
        assert_eq!(
            check_mint_bytes(&other, &base_mint()),
            Err(MintPolicyError::NotATokenProgram)
        );
        let mut uninit = base_mint();
        uninit[IS_INITIALIZED_OFFSET] = 0;
        assert_eq!(
            check_mint_bytes(&NFT_TOKEN_PROGRAM_ID, &uninit),
            Err(MintPolicyError::Malformed)
        );
        // A classic mint never has extension bytes.
        assert_eq!(
            check_mint_bytes(&NFT_TOKEN_PROGRAM_ID, &mint_2022(&[])),
            Err(MintPolicyError::Malformed)
        );
        // A token account (type 2) is not a mint.
        let mut account = mint_2022(&[]);
        account[ACCOUNT_TYPE_OFFSET] = 2;
        assert_eq!(
            check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &account),
            Err(MintPolicyError::Malformed)
        );
        // A non-zero type header with no length after it (codex r2 nit):
        // two or three trailing bytes naming PermanentDelegate.
        for tail in [&[12u8, 0][..], &[12u8, 0, 0][..]] {
            let mut data = mint_2022(&[(EXT_METADATA_POINTER, 64)]);
            data.extend_from_slice(tail);
            assert_eq!(
                check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &data),
                Err(MintPolicyError::Malformed),
                "{tail:?}"
            );
        }
        // One trailing byte is realloc padding, and a zero type ends the entries.
        let mut padded = mint_2022(&[(EXT_METADATA_POINTER, 64)]);
        padded.push(0);
        assert_eq!(check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &padded), Ok(()));
        let mut zero_tail = mint_2022(&[(EXT_METADATA_POINTER, 64)]);
        zero_tail.extend_from_slice(&[0, 0, 0]);
        assert_eq!(check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &zero_tail), Ok(()));
        // A TLV length that runs off the end.
        let mut truncated = mint_2022(&[(EXT_METADATA_POINTER, 64)]);
        truncated.truncate(truncated.len() - 1);
        assert_eq!(
            check_mint_bytes(&TOKEN_2022_PROGRAM_ID, &truncated),
            Err(MintPolicyError::Malformed)
        );
    }
}
