//! Budget arithmetic. No Solana types.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountingError {
    Shape,
    Overflow,
    ZeroSlice,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlicePlan {
    pub slice: u64,
    pub tip: u64,
    pub amount_in: u64,
}

/// `slice = min(budget, per_run * bps / 10_000, vault)`.
/// `tip = slice * tip_bps / 10_000`. The swap input is `slice - tip`.
pub fn plan_slice(
    budget: u64,
    per_run_quote: u64,
    bps: u16,
    vault_balance: u64,
    tip_bps: u64,
) -> Result<SlicePlan, AccountingError> {
    if budget == 0 || bps == 0 {
        return Err(AccountingError::ZeroSlice);
    }
    let cap = (per_run_quote as u128) * u128::from(bps) / 10_000;
    let cap = u64::try_from(cap).unwrap_or(u64::MAX);
    let slice = budget.min(cap).min(vault_balance);
    if slice == 0 {
        return Err(AccountingError::ZeroSlice);
    }
    let tip = (slice as u128)
        .checked_mul(tip_bps as u128)
        .ok_or(AccountingError::Overflow)?
        / 10_000;
    let tip = u64::try_from(tip).map_err(|_| AccountingError::Overflow)?;
    let amount_in = slice.checked_sub(tip).ok_or(AccountingError::Overflow)?;
    if amount_in == 0 {
        return Err(AccountingError::ZeroSlice);
    }
    Ok(SlicePlan {
        slice,
        tip,
        amount_in,
    })
}

/// Add `received` quote units to budgets in proportion to `weights` (bps).
/// The flooring remainder goes to the first target.
pub fn credit_budgets(
    budgets: &mut [u64],
    weights: &[u16],
    received: u64,
) -> Result<(), AccountingError> {
    if budgets.is_empty() || budgets.len() != weights.len() {
        return Err(AccountingError::Shape);
    }
    let mut shares = vec![0u64; budgets.len()];
    let mut allocated = 0u128;
    for (index, weight) in weights.iter().enumerate() {
        let share = (received as u128) * u128::from(*weight) / 10_000;
        shares[index] = u64::try_from(share).map_err(|_| AccountingError::Overflow)?;
        allocated += share;
    }
    let remainder = (received as u128)
        .checked_sub(allocated)
        .ok_or(AccountingError::Overflow)?;
    let remainder = u64::try_from(remainder).map_err(|_| AccountingError::Overflow)?;
    shares[0] = shares[0]
        .checked_add(remainder)
        .ok_or(AccountingError::Overflow)?;
    for (budget, share) in budgets.iter_mut().zip(shares) {
        *budget = budget.checked_add(share).ok_or(AccountingError::Overflow)?;
    }
    Ok(())
}

/// Reduce budgets by `amount` in proportion to the budgets themselves.
///
/// A withdrawal of at least the total zeros every budget. Otherwise each
/// budget pays `floor(amount * budget / total)`, and any flooring remainder
/// is taken from the earliest budgets that still have room. The original
/// weights are not used: after a DCA run some budgets are already spent, and
/// charging those empty budgets again would either fail or leave a phantom
/// balance.
pub fn debit_budgets(budgets: &mut [u64], amount: u64) -> Result<(), AccountingError> {
    if budgets.is_empty() {
        return Err(AccountingError::Shape);
    }
    let total: u128 = budgets.iter().map(|budget| *budget as u128).sum();
    if amount as u128 >= total {
        for budget in budgets.iter_mut() {
            *budget = 0;
        }
        return Ok(());
    }
    let mut shares = vec![0u64; budgets.len()];
    let mut allocated = 0u64;
    for (index, budget) in budgets.iter().enumerate() {
        let share = (*budget as u128) * (amount as u128) / total;
        let share = u64::try_from(share).map_err(|_| AccountingError::Overflow)?;
        shares[index] = share;
        allocated = allocated
            .checked_add(share)
            .ok_or(AccountingError::Overflow)?;
    }
    let mut remainder = amount
        .checked_sub(allocated)
        .ok_or(AccountingError::Overflow)?;
    for (budget, share) in budgets.iter_mut().zip(shares.iter_mut()) {
        let room = budget
            .checked_sub(*share)
            .ok_or(AccountingError::Overflow)?;
        let extra = remainder.min(room);
        *share = share.checked_add(extra).ok_or(AccountingError::Overflow)?;
        remainder -= extra;
        if remainder == 0 {
            break;
        }
    }
    if remainder != 0 {
        return Err(AccountingError::Overflow);
    }
    for (budget, share) in budgets.iter_mut().zip(shares) {
        *budget = budget.checked_sub(share).ok_or(AccountingError::Overflow)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slice_keeps_a_ten_bps_tip_out_of_the_swap() {
        let plan = plan_slice(800_000, 500_000, 8_000, 1_000_000, 10).unwrap();
        assert_eq!(
            plan,
            SlicePlan {
                slice: 400_000,
                tip: 400,
                amount_in: 399_600,
            }
        );
        assert!(plan_slice(0, 500_000, 8_000, 1_000_000, 10).is_err());
    }

    #[test]
    fn deposit_remainder_goes_to_the_first_target() {
        let mut budgets = [0u64, 0];
        credit_budgets(&mut budgets, &[5_000, 5_000], 3).unwrap();
        assert_eq!(budgets, [2, 1]);

        let mut even = [0u64, 0];
        credit_budgets(&mut even, &[2_000, 8_000], 1_000_000).unwrap();
        assert_eq!(even, [200_000, 800_000]);
    }

    #[test]
    fn quote_withdrawal_follows_remaining_budgets() {
        let mut budgets = [200_000u64, 400_000];
        debit_budgets(&mut budgets, 100_000).unwrap();
        assert_eq!(budgets.iter().sum::<u64>(), 500_000);
        // 200k/600k and 400k/600k of 100k, with the 1-unit remainder on the first.
        assert_eq!(budgets, [166_666, 333_334]);

        debit_budgets(&mut budgets, u64::MAX).unwrap();
        assert_eq!(budgets, [0, 0]);
    }
}
