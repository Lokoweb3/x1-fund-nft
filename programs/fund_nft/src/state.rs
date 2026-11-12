use anchor_lang::prelude::*;

use crate::errors::FundError;

pub const MAX_TARGETS: usize = 8;
pub const BPS_SUM: u16 = 10_000;
/// Constant crank tip. There is no admin and no instruction that can change it.
pub const TIP_BPS: u64 = 10;
pub const FUND_SEED: &[u8] = b"fund";
/// Largest deviation a fund may allow below the TWAP output (5%).
pub const MAX_DEV_BPS: u16 = 500;
/// TWAP window bounds, in seconds (15 minutes to 24 hours).
pub const MIN_TWAP_WINDOW_SECS: u32 = 900;
pub const MAX_TWAP_WINDOW_SECS: u32 = 86_400;
/// Shortest DCA interval, in seconds.
pub const MIN_INTERVAL_SECS: i64 = 60;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace, Debug)]
pub struct Target {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub bps: u16,
    pub budget: u64,
    pub last_run: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Fund {
    pub nft_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub bump: u8,
    pub per_run_quote: u64,
    pub interval_secs: i64,
    pub twap_window_secs: u32,
    pub max_dev_bps: u16,
    #[max_len(MAX_TARGETS)]
    pub targets: Vec<Target>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct TargetParams {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateFundParams {
    pub per_run_quote: u64,
    pub interval_secs: i64,
    pub twap_window_secs: u32,
    pub max_dev_bps: u16,
    pub targets: Vec<TargetParams>,
}

pub fn validate_create(quote_mint: &Pubkey, params: &CreateFundParams) -> Result<()> {
    require!(params.per_run_quote > 0, FundError::ZeroPerRun);
    require!(
        params.interval_secs >= MIN_INTERVAL_SECS,
        FundError::BadInterval
    );
    require!(
        (MIN_TWAP_WINDOW_SECS..=MAX_TWAP_WINDOW_SECS).contains(&params.twap_window_secs),
        FundError::BadWindow
    );
    require!(params.max_dev_bps <= MAX_DEV_BPS, FundError::BadDeviation);

    let n = params.targets.len();
    require!(n > 0, FundError::EmptyTargets);
    require!(n <= MAX_TARGETS, FundError::TooManyTargets);

    let mut sum: u32 = 0;
    for (i, target) in params.targets.iter().enumerate() {
        require!(target.bps > 0, FundError::ZeroBps);
        sum = sum
            .checked_add(u32::from(target.bps))
            .ok_or(FundError::BpsSum)?;
        if target.mint == *quote_mint {
            require!(
                target.pool == Pubkey::default(),
                FundError::CashPoolNotDefault
            );
        } else {
            require!(target.pool != Pubkey::default(), FundError::PoolRequired);
        }
        for previous in params.targets.iter().take(i) {
            require!(previous.mint != target.mint, FundError::DuplicateMint);
            if target.pool != Pubkey::default() {
                require!(previous.pool != target.pool, FundError::DuplicatePool);
            }
        }
    }
    require!(sum == u32::from(BPS_SUM), FundError::BpsSum);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote() -> Pubkey {
        Pubkey::new_from_array([1u8; 32])
    }

    fn mint(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte; 32])
    }

    fn pool(byte: u8) -> Pubkey {
        Pubkey::new_from_array([byte.wrapping_add(20); 32])
    }

    fn params(targets: Vec<TargetParams>) -> CreateFundParams {
        CreateFundParams {
            per_run_quote: 1_000,
            interval_secs: 60,
            twap_window_secs: 3_600,
            max_dev_bps: 100,
            targets,
        }
    }

    #[test]
    fn accepts_a_cash_slice_and_one_pool() {
        let quote = quote();
        let ok = params(vec![
            TargetParams {
                mint: quote,
                pool: Pubkey::default(),
                bps: 2_000,
            },
            TargetParams {
                mint: mint(2),
                pool: pool(2),
                bps: 8_000,
            },
        ]);
        assert!(validate_create(&quote, &ok).is_ok());
    }

    fn one_target(quote: Pubkey) -> CreateFundParams {
        params(vec![
            TargetParams {
                mint: quote,
                pool: Pubkey::default(),
                bps: 2_000,
            },
            TargetParams {
                mint: mint(2),
                pool: pool(2),
                bps: 8_000,
            },
        ])
    }

    fn code(result: Result<()>) -> u32 {
        match result.unwrap_err() {
            Error::AnchorError(err) => err.error_code_number,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn deviation_is_capped_at_500_bps() {
        let quote = quote();
        let mut p = one_target(quote);
        p.max_dev_bps = 500;
        assert!(validate_create(&quote, &p).is_ok());
        p.max_dev_bps = 0;
        assert!(validate_create(&quote, &p).is_ok());
        p.max_dev_bps = 501;
        assert_eq!(
            code(validate_create(&quote, &p)),
            u32::from(FundError::BadDeviation)
        );
        p.max_dev_bps = 10_000;
        assert!(validate_create(&quote, &p).is_err());
    }

    #[test]
    fn twap_window_must_be_15_minutes_to_24_hours() {
        let quote = quote();
        let mut p = one_target(quote);
        for ok in [900u32, 3_600, 86_400] {
            p.twap_window_secs = ok;
            assert!(validate_create(&quote, &p).is_ok(), "{ok}");
        }
        for bad in [0u32, 1, 899, 86_401, u32::MAX] {
            p.twap_window_secs = bad;
            assert_eq!(
                code(validate_create(&quote, &p)),
                u32::from(FundError::BadWindow),
                "{bad}"
            );
        }
    }

    #[test]
    fn interval_must_be_at_least_60_seconds() {
        let quote = quote();
        let mut p = one_target(quote);
        for ok in [60i64, 3_600, i64::MAX] {
            p.interval_secs = ok;
            assert!(validate_create(&quote, &p).is_ok(), "{ok}");
        }
        for bad in [i64::MIN, -1, 0, 1, 59] {
            p.interval_secs = bad;
            assert_eq!(
                code(validate_create(&quote, &p)),
                u32::from(FundError::BadInterval),
                "{bad}"
            );
        }
    }

    #[test]
    fn rejects_bad_weights_duplicate_mints_and_unpinned_pools() {
        let quote = quote();
        let mut bad_sum = params(vec![TargetParams {
            mint: mint(2),
            pool: pool(2),
            bps: 9_999,
        }]);
        assert!(validate_create(&quote, &bad_sum).is_err());

        bad_sum.targets[0].bps = 10_000;
        bad_sum.targets.push(TargetParams {
            mint: mint(2),
            pool: pool(3),
            bps: 1,
        });
        // Sum is no longer 10000, and the mint is duplicated. Either error is a rejection.
        assert!(validate_create(&quote, &bad_sum).is_err());

        let unpinned = params(vec![TargetParams {
            mint: mint(4),
            pool: Pubkey::default(),
            bps: 10_000,
        }]);
        assert!(validate_create(&quote, &unpinned).is_err());

        let cash_with_pool = params(vec![TargetParams {
            mint: quote,
            pool: pool(9),
            bps: 10_000,
        }]);
        assert!(validate_create(&quote, &cash_with_pool).is_err());
    }
}
