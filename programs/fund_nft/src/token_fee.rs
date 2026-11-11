//! Token-2022 transfer-fee extension, read from the mint account.
//!
//! The TEST mint `C9P839X3i1ijPyCvHEg3HpbEVjBLHJdxGXjez3yVn3Rz` is 531 bytes.
//! Byte 165 is account type 1. The TLV entry of type 1 has length 108.
//! Inside that value, the older fee starts at byte 72 and the newer fee at
//! byte 90: epoch `u64`, maximum fee `u64`, basis points `u16`. Both schedules
//! on TEST are epoch 391, maximum `u64::MAX`, 500 bps. USDC.X has no type-1
//! entry. The epoch rule (newer fee once `epoch >= newer.epoch`) is the
//! Token-2022 rule for this layout; both of TEST's schedules are identical,
//! so mainnet does not show which branch is live.

use crate::twap::TransferFee;

pub const MINT_ACCOUNT_TYPE_OFFSET: usize = 165;
pub const TLV_START: usize = 166;
pub const TRANSFER_FEE_CONFIG_TYPE: u16 = 1;
const OLDER_FEE_OFFSET: usize = 72;
const NEWER_FEE_OFFSET: usize = 90;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScheduledFee {
    pub epoch: u64,
    pub maximum_fee: u64,
    pub basis_points: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferFeeConfig {
    pub older: ScheduledFee,
    pub newer: ScheduledFee,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeeParseError {
    Truncated,
    AccountType,
}

/// `None` means the mint has no transfer fee (classic SPL, or Token-2022
/// without the extension).
pub fn read_transfer_fee_config(data: &[u8]) -> Result<Option<TransferFeeConfig>, FeeParseError> {
    if data.len() < TLV_START {
        return Ok(None);
    }
    if data[MINT_ACCOUNT_TYPE_OFFSET] != 1 {
        return Err(FeeParseError::AccountType);
    }
    let mut offset = TLV_START;
    while offset + 4 <= data.len() {
        let typ = u16::from_le_bytes(data[offset..offset + 2].try_into().unwrap());
        let len = u16::from_le_bytes(data[offset + 2..offset + 4].try_into().unwrap()) as usize;
        let value = offset + 4;
        let next = value.checked_add(len).ok_or(FeeParseError::Truncated)?;
        if next > data.len() {
            return Err(FeeParseError::Truncated);
        }
        if typ == 0 && len == 0 {
            break;
        }
        if typ == TRANSFER_FEE_CONFIG_TYPE {
            if len < NEWER_FEE_OFFSET + 18 {
                return Err(FeeParseError::Truncated);
            }
            return Ok(Some(TransferFeeConfig {
                older: read_fee(&data[value..], OLDER_FEE_OFFSET)?,
                newer: read_fee(&data[value..], NEWER_FEE_OFFSET)?,
            }));
        }
        offset = next;
    }
    Ok(None)
}

pub fn fee_for_epoch(config: Option<TransferFeeConfig>, epoch: u64) -> TransferFee {
    let Some(config) = config else {
        return TransferFee::none();
    };
    let selected = if epoch >= config.newer.epoch {
        config.newer
    } else {
        config.older
    };
    TransferFee {
        basis_points: selected.basis_points,
        maximum_fee: selected.maximum_fee,
    }
}

fn read_fee(value: &[u8], offset: usize) -> Result<ScheduledFee, FeeParseError> {
    let bytes = value
        .get(offset..offset + 18)
        .ok_or(FeeParseError::Truncated)?;
    Ok(ScheduledFee {
        epoch: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        maximum_fee: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        basis_points: u16::from_le_bytes(bytes[16..18].try_into().unwrap()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mint_with_fee(older_bps: u16, newer_epoch: u64, newer_bps: u16) -> Vec<u8> {
        let mut data = vec![0u8; TLV_START];
        data[MINT_ACCOUNT_TYPE_OFFSET] = 1;
        // A metadata-pointer entry first, matching the real mints, then the fee.
        data.extend_from_slice(&18u16.to_le_bytes());
        data.extend_from_slice(&4u16.to_le_bytes());
        data.extend_from_slice(&[9, 9, 9, 9]);
        data.extend_from_slice(&TRANSFER_FEE_CONFIG_TYPE.to_le_bytes());
        data.extend_from_slice(&108u16.to_le_bytes());
        let value_at = data.len();
        data.extend(std::iter::repeat(0).take(108));
        write_fee(
            &mut data,
            value_at + OLDER_FEE_OFFSET,
            391,
            u64::MAX,
            older_bps,
        );
        write_fee(
            &mut data,
            value_at + NEWER_FEE_OFFSET,
            newer_epoch,
            u64::MAX,
            newer_bps,
        );
        data
    }

    fn write_fee(data: &mut [u8], offset: usize, epoch: u64, max_fee: u64, bps: u16) {
        data[offset..offset + 8].copy_from_slice(&epoch.to_le_bytes());
        data[offset + 8..offset + 16].copy_from_slice(&max_fee.to_le_bytes());
        data[offset + 16..offset + 18].copy_from_slice(&bps.to_le_bytes());
    }

    #[test]
    fn parses_the_test_mint_shape_and_picks_the_epoch() {
        let data = mint_with_fee(100, 400, 500);
        let config = read_transfer_fee_config(&data).unwrap().unwrap();
        assert_eq!(config.older.basis_points, 100);
        assert_eq!(config.older.maximum_fee, u64::MAX);
        assert_eq!(config.newer.epoch, 400);
        assert_eq!(fee_for_epoch(Some(config), 399).basis_points, 100);
        assert_eq!(fee_for_epoch(Some(config), 400).basis_points, 500);
        assert!(read_transfer_fee_config(&[0u8; 82]).unwrap().is_none());
    }
}
