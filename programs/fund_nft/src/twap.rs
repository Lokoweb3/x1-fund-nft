//! On-chain TWAP min-out, with no Solana types.
//!
//! The pool records two cumulative prices. `cumulative_token_0_price_x32` is
//! raw token-1 units per raw token-0 unit, scaled by 2^32, and the token-1
//! cumulative is the reciprocal side. The quote always uses the cumulative
//! that prices the swap direction (output per input). Inverting the opposite
//! side would give `1 / E[P]` instead of `E[output per input]`, which a short
//! price spike can push far from the time average. When the directional x32
//! average is below `MIN_DIRECT_PRICE_X32` the quote is rejected rather than
//! inverted, so the relative truncation error stays at most 2^-16.
//!
//! The newest observation must be no older than the window and not in the
//! future. The older sample is the latest at or before `now - window`, else
//! the oldest, and the span between the two must be within
//! `[window / 2, 2 * window]`.
//!
//! Cumulative values are allowed to wrap. Deltas use `wrapping_sub`.

/// Raw price scale used by the observation cumulatives.
pub const PRICE_SCALE: u128 = 1 << 32;
/// Uniswap-style basis-point denominator used for deviation and transfer fees.
pub const BPS_DENOMINATOR: u128 = 10_000;
/// Raydium cp-swap fee denominator. Confirmed against the USDC.X/TEST
/// reference swap: fee rate 2800 charges exactly 560 on a 200_000 input, and
/// only denominator 1_000_000 reproduces the executed output.
pub const TRADE_FEE_DENOMINATOR: u128 = 1_000_000;
pub const OBSERVATION_COUNT: usize = 100;
pub const OBSERVATION_BYTES: usize = 40;
pub const RING_BYTES: usize = OBSERVATION_COUNT * OBSERVATION_BYTES;
/// Smallest directional x32 average the quote accepts. Below this, flooring
/// the average loses more than 2^-16 of the price.
pub const MIN_DIRECT_PRICE_X32: u128 = 1 << 16;

/// Which pool mint is the swap input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SwapDirection {
    /// Input is token 0, output is token 1. The direct price is token-0's.
    Token0ToToken1,
    /// Input is token 1, output is token 0. The direct price is token-1's.
    Token1ToToken0,
}

/// Token-2022 transfer fee for one epoch. `maximum_fee` caps the raw fee.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferFee {
    pub basis_points: u16,
    pub maximum_fee: u64,
}

impl TransferFee {
    pub const fn none() -> Self {
        Self {
            basis_points: 0,
            maximum_fee: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub block_timestamp: u64,
    pub cumulative_token_0_price_x32: u128,
    pub cumulative_token_1_price_x32: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    /// Minimum output the swap must deliver, after the output transfer fee
    /// and the configured deviation.
    pub min_out: u64,
    /// TWAP output after the trade fee and the output transfer fee, before
    /// the deviation haircut.
    pub expected_out: u64,
    pub newest_timestamp: u64,
    pub older_timestamp: u64,
    /// Seconds between the two observations actually used.
    pub dt_secs: u64,
    /// Directional x32 average used for the quote (output per input).
    pub price_x32: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TwapError {
    /// The ring buffer is not exactly 100 packed observations.
    BadRing,
    /// `observation_index` is outside 0..100.
    IndexOutOfRange,
    /// The newest slot is empty, or the ring has no second observation.
    EmptyObservation,
    /// The two samples are closer together than `twap_window_secs / 2`.
    WindowTooShort,
    /// The two samples are more than `2 * twap_window_secs` apart.
    WindowTooLong,
    /// The newest observation is older than `twap_window_secs` before `now`.
    Stale,
    /// The newest observation is later than `now`.
    FutureObservation,
    /// A zero window cannot define an average.
    ZeroWindow,
    /// The directional average is below `MIN_DIRECT_PRICE_X32`.
    PriceTooSmall,
    /// A denominator was zero.
    ZeroDenominator,
    /// The quote does not fit in a token amount.
    Overflow,
    /// A fee rate is above its denominator.
    FeeTooLarge,
    /// Nothing remains to swap after the input transfer fee.
    AmountZero,
}

#[derive(Clone, Copy, Debug)]
pub struct QuoteInput<'a> {
    /// 100 observations, 40 bytes each, packed the way the pool stores them:
    /// `block_timestamp: u64`, `cumulative_token_0_price_x32: u128`,
    /// `cumulative_token_1_price_x32: u128`, all little-endian.
    pub ring: &'a [u8],
    pub observation_index: u16,
    /// `Clock::unix_timestamp` at execution.
    pub now: i64,
    pub twap_window_secs: u32,
    /// Swap input after the input mint's transfer fee.
    pub amount_in_after_input_fee: u64,
    pub trade_fee_rate: u64,
    pub direction: SwapDirection,
    pub output_transfer_fee: TransferFee,
    pub max_dev_bps: u16,
}

/// Ceiling of `amount * bps / 10_000`, then capped at `maximum_fee`.
///
/// A zero maximum fee charges nothing, matching Token-2022. Basis points
/// above 10_000 are rejected. The ceiling matches the fee on the USDC.X/TEST
/// reference swap (`output_transfer_fee` 513_634_030_221).
pub fn transfer_fee_charged(amount: u64, fee: TransferFee) -> Result<u64, TwapError> {
    if fee.basis_points == 0 || amount == 0 || fee.maximum_fee == 0 {
        return Ok(0);
    }
    if fee.basis_points as u128 > BPS_DENOMINATOR {
        return Err(TwapError::FeeTooLarge);
    }
    let raw = ceil_div(amount as u128, fee.basis_points as u128, BPS_DENOMINATOR)?;
    Ok(raw.min(fee.maximum_fee as u128) as u64)
}

pub fn amount_after_transfer_fee(amount: u64, fee: TransferFee) -> Result<u64, TwapError> {
    let charged = transfer_fee_charged(amount, fee)?;
    amount.checked_sub(charged).ok_or(TwapError::Overflow)
}

/// `floor(amount * (FEE_DENOMINATOR - trade_fee_rate) / FEE_DENOMINATOR)`.
///
/// That floor is the same as `amount - ceil(amount * rate / FEE_DENOMINATOR)`,
/// which is how the reference pool reduced 200_000 by 560.
pub fn net_after_trade_fee(amount: u64, trade_fee_rate: u64) -> Result<u128, TwapError> {
    if trade_fee_rate as u128 > TRADE_FEE_DENOMINATOR {
        return Err(TwapError::FeeTooLarge);
    }
    mul_div_floor(
        amount as u128,
        TRADE_FEE_DENOMINATOR - trade_fee_rate as u128,
        TRADE_FEE_DENOMINATOR,
    )
}

pub fn quote_min_out(input: QuoteInput<'_>) -> Result<Quote, TwapError> {
    if input.amount_in_after_input_fee == 0 {
        return Err(TwapError::AmountZero);
    }
    if input.max_dev_bps as u128 > BPS_DENOMINATOR {
        return Err(TwapError::FeeTooLarge);
    }
    if input.twap_window_secs == 0 {
        return Err(TwapError::ZeroWindow);
    }

    let (newest, older, dt) = select_samples(
        input.ring,
        input.observation_index,
        input.twap_window_secs,
        input.now,
    )?;
    // Token 0 -> token 1 needs token-1 per token-0, which is the token-0
    // cumulative. The reverse direction uses the token-1 cumulative.
    let price = match input.direction {
        SwapDirection::Token0ToToken1 => newest
            .cumulative_token_0_price_x32
            .wrapping_sub(older.cumulative_token_0_price_x32),
        SwapDirection::Token1ToToken0 => newest
            .cumulative_token_1_price_x32
            .wrapping_sub(older.cumulative_token_1_price_x32),
    } / dt as u128;
    if price < MIN_DIRECT_PRICE_X32 {
        return Err(TwapError::PriceTooSmall);
    }

    let net = net_after_trade_fee(input.amount_in_after_input_fee, input.trade_fee_rate)?;
    let before_output_fee = mul_div_floor(net, price, PRICE_SCALE)?;
    let before_output_fee = u64::try_from(before_output_fee).map_err(|_| TwapError::Overflow)?;
    let expected_out = amount_after_transfer_fee(before_output_fee, input.output_transfer_fee)?;
    let min_out = mul_div_floor(
        expected_out as u128,
        BPS_DENOMINATOR - input.max_dev_bps as u128,
        BPS_DENOMINATOR,
    )?;
    let min_out = u64::try_from(min_out).map_err(|_| TwapError::Overflow)?;

    Ok(Quote {
        min_out,
        expected_out,
        newest_timestamp: newest.block_timestamp,
        older_timestamp: older.block_timestamp,
        dt_secs: dt,
        price_x32: price,
    })
}

fn select_samples(
    ring: &[u8],
    observation_index: u16,
    window_secs: u32,
    now: i64,
) -> Result<(Observation, Observation, u64), TwapError> {
    if ring.len() != RING_BYTES {
        return Err(TwapError::BadRing);
    }
    let newest_i = observation_index as usize;
    if newest_i >= OBSERVATION_COUNT {
        return Err(TwapError::IndexOutOfRange);
    }
    let newest = read_observation(ring, newest_i)?;
    if newest.block_timestamp == 0 {
        return Err(TwapError::EmptyObservation);
    }
    // A negative `now` is earlier than any non-zero timestamp.
    let now = u64::try_from(now).map_err(|_| TwapError::FutureObservation)?;
    if newest.block_timestamp > now {
        return Err(TwapError::FutureObservation);
    }
    if now - newest.block_timestamp > window_secs as u64 {
        return Err(TwapError::Stale);
    }
    let cutoff = now.saturating_sub(window_secs as u64);

    let mut older_i: Option<usize> = None;
    let mut oldest_i: Option<usize> = None;
    for i in 0..OBSERVATION_COUNT {
        if i == newest_i {
            continue;
        }
        let ts = read_timestamp(ring, i)?;
        if ts == 0 {
            continue;
        }
        oldest_i = Some(match oldest_i {
            Some(prev) if read_timestamp(ring, prev)? <= ts => prev,
            _ => i,
        });
        if ts <= cutoff {
            older_i = Some(match older_i {
                Some(prev) if read_timestamp(ring, prev)? >= ts => prev,
                _ => i,
            });
        }
    }
    let older_i = older_i.or(oldest_i).ok_or(TwapError::EmptyObservation)?;
    let older = read_observation(ring, older_i)?;
    let dt = newest
        .block_timestamp
        .checked_sub(older.block_timestamp)
        .ok_or(TwapError::WindowTooShort)?;
    // `dt == 0` would divide the cumulative delta by zero. A window of 1 has
    // `window / 2 == 0`, so the zero-dt case needs its own rejection.
    let min_span = (window_secs / 2) as u64;
    if dt == 0 || dt < min_span {
        return Err(TwapError::WindowTooShort);
    }
    if dt > 2 * window_secs as u64 {
        return Err(TwapError::WindowTooLong);
    }
    Ok((newest, older, dt))
}

fn read_timestamp(ring: &[u8], index: usize) -> Result<u64, TwapError> {
    let start = index * OBSERVATION_BYTES;
    let bytes = ring
        .get(start..start + 8)
        .ok_or(TwapError::IndexOutOfRange)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

fn read_observation(ring: &[u8], index: usize) -> Result<Observation, TwapError> {
    let start = index * OBSERVATION_BYTES;
    let bytes = ring
        .get(start..start + OBSERVATION_BYTES)
        .ok_or(TwapError::IndexOutOfRange)?;
    Ok(Observation {
        block_timestamp: u64::from_le_bytes(bytes[0..8].try_into().unwrap()),
        cumulative_token_0_price_x32: u128::from_le_bytes(bytes[8..24].try_into().unwrap()),
        cumulative_token_1_price_x32: u128::from_le_bytes(bytes[24..40].try_into().unwrap()),
    })
}

fn ceil_div(value: u128, numerator: u128, denominator: u128) -> Result<u128, TwapError> {
    if denominator == 0 {
        return Err(TwapError::ZeroDenominator);
    }
    if numerator == 0 || value == 0 {
        return Ok(0);
    }
    let (hi, lo) = widening_mul(value, numerator);
    let (hi, lo) = add_256(hi, lo, denominator - 1);
    div_wide(hi, lo, denominator)
}

pub(crate) fn mul_div_floor(a: u128, b: u128, denominator: u128) -> Result<u128, TwapError> {
    if denominator == 0 {
        return Err(TwapError::ZeroDenominator);
    }
    let (hi, lo) = widening_mul(a, b);
    div_wide(hi, lo, denominator)
}

fn widening_mul(a: u128, b: u128) -> (u128, u128) {
    fn mul64(x: u64, y: u64) -> (u64, u64) {
        let product = (x as u128) * (y as u128);
        (product as u64, (product >> 64) as u64)
    }
    fn add3(x: u64, y: u64, z: u64) -> (u64, u64) {
        let sum = (x as u128) + (y as u128) + (z as u128);
        (sum as u64, (sum >> 64) as u64)
    }

    let a0 = a as u64;
    let a1 = (a >> 64) as u64;
    let b0 = b as u64;
    let b1 = (b >> 64) as u64;
    let (p00_lo, p00_hi) = mul64(a0, b0);
    let (p01_lo, p01_hi) = mul64(a0, b1);
    let (p10_lo, p10_hi) = mul64(a1, b0);
    let (p11_lo, p11_hi) = mul64(a1, b1);

    let r0 = p00_lo;
    let (r1, c1) = add3(p00_hi, p01_lo, p10_lo);
    let (sum2, c2a) = add3(p01_hi, p10_hi, p11_lo);
    let (r2, c2b) = add3(sum2, c1, 0);
    let (r3, c3) = add3(p11_hi, c2a, c2b);
    debug_assert_eq!(c3, 0);

    let lo = (r0 as u128) | ((r1 as u128) << 64);
    let hi = (r2 as u128) | ((r3 as u128) << 64);
    (hi, lo)
}

fn add_256(hi: u128, lo: u128, add: u128) -> (u128, u128) {
    let (lo, carry) = lo.overflowing_add(add);
    let hi = hi + u128::from(carry);
    (hi, lo)
}

/// Floor division of a 256-bit value by a u128. `None`-style overflow is an error.
fn div_wide(hi: u128, lo: u128, denominator: u128) -> Result<u128, TwapError> {
    if denominator == 0 {
        return Err(TwapError::ZeroDenominator);
    }
    if hi >= denominator {
        return Err(TwapError::Overflow);
    }
    if hi == 0 {
        return Ok(lo / denominator);
    }

    let mut low = 0u128;
    let mut high = u128::MAX;
    let mut answer = 0u128;
    while low <= high {
        let mid = low + (high - low) / 2;
        let (phi, plo) = widening_mul(mid, denominator);
        if phi < hi || (phi == hi && plo <= lo) {
            answer = mid;
            if mid == u128::MAX {
                break;
            }
            low = mid + 1;
        } else if mid == 0 {
            break;
        } else {
            high = mid - 1;
        }
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(ring: &mut [u8], index: usize, ts: u64, c0: u128, c1: u128) {
        let start = index * OBSERVATION_BYTES;
        ring[start..start + 8].copy_from_slice(&ts.to_le_bytes());
        ring[start + 8..start + 24].copy_from_slice(&c0.to_le_bytes());
        ring[start + 24..start + 40].copy_from_slice(&c1.to_le_bytes());
    }

    fn empty_ring() -> Vec<u8> {
        vec![0u8; RING_BYTES]
    }

    fn no_fees(direction: SwapDirection, ring: &[u8], index: u16, amount: u64) -> QuoteInput<'_> {
        // `now` defaults to the newest timestamp, the freshest legal clock.
        let now = read_timestamp(ring, index as usize).unwrap() as i64;
        QuoteInput {
            ring,
            observation_index: index,
            now,
            twap_window_secs: 1_000,
            amount_in_after_input_fee: amount,
            trade_fee_rate: 0,
            direction,
            output_transfer_fee: TransferFee::none(),
            max_dev_bps: 0,
        }
    }

    #[test]
    fn trade_fee_matches_reference_swap_net_input() {
        // 200_000 USDC.X raw, rate 2800 / 1_000_000 = 560, net 199_440.
        assert_eq!(net_after_trade_fee(200_000, 2_800).unwrap(), 199_440);
        assert_eq!(
            transfer_fee_charged(
                10_272_680_604_408,
                TransferFee {
                    basis_points: 500,
                    maximum_fee: u64::MAX,
                }
            )
            .unwrap(),
            513_634_030_221
        );
    }

    #[test]
    fn cumulative_wrap_matches_unwrapped_delta() {
        let dt = 10u64;
        let price = 1_000u128 * PRICE_SCALE;
        let delta = price * dt as u128;
        let old = u128::MAX - 20;
        let new = old.wrapping_add(delta);
        assert!(new < old, "this fixture must actually wrap");

        let mut wrapped = empty_ring();
        put(&mut wrapped, 0, 5_000, old, 0);
        put(&mut wrapped, 1, 5_000 + dt, new, 0);
        let mut plain = empty_ring();
        put(&mut plain, 0, 5_000, 0, 0);
        put(&mut plain, 1, 5_000 + dt, delta, 0);

        let amount = 25_000u64;
        let mut wrapped_input = no_fees(SwapDirection::Token0ToToken1, &wrapped, 1, amount);
        let mut plain_input = no_fees(SwapDirection::Token0ToToken1, &plain, 1, amount);
        // dt is 10s, so the window has to be at most 20s to pass the half-span check.
        wrapped_input.twap_window_secs = 20;
        plain_input.twap_window_secs = 20;
        let wrapped_quote = quote_min_out(wrapped_input).unwrap();
        let plain_quote = quote_min_out(plain_input).unwrap();
        assert_eq!(wrapped_quote.min_out, plain_quote.min_out);
        assert_eq!(wrapped_quote.min_out, amount as u64 * 1_000);
    }

    #[test]
    fn ring_index_wraps_to_the_tail() {
        let mut ring = empty_ring();
        // Newest is index 1. Older samples sit at the end of the ring.
        put(&mut ring, 98, 5_000, 0, 0);
        put(&mut ring, 99, 8_000, 0, 0);
        put(&mut ring, 0, 9_000, 0, 0);
        put(&mut ring, 1, 10_000, 3_000 * PRICE_SCALE, 0);
        let mut input = no_fees(SwapDirection::Token0ToToken1, &ring, 1, 10);
        input.twap_window_secs = 1_500;
        let quote = quote_min_out(input).unwrap();
        // Cutoff is 8_500, so the latest eligible sample is ts 8_000, not 9_000.
        assert_eq!(quote.older_timestamp, 8_000);
        assert_eq!(quote.newest_timestamp, 10_000);
        assert_eq!(quote.dt_secs, 2_000);
        assert!(quote.dt_secs >= 1_500 / 2);
    }

    #[test]
    fn sparse_history_is_rejected_when_the_span_exceeds_twice_the_window() {
        // A 24h gap used to be accepted for a 1h window. It is now too long.
        let mut ring = empty_ring();
        put(&mut ring, 0, 1_000_000, 0, 0);
        put(&mut ring, 1, 1_086_400, 86_400 * PRICE_SCALE, 0);
        let mut input = no_fees(SwapDirection::Token0ToToken1, &ring, 1, 4);
        input.twap_window_secs = 3_600;
        assert_eq!(quote_min_out(input).unwrap_err(), TwapError::WindowTooLong);

        // Exactly 2 * window is still accepted.
        let mut edge = empty_ring();
        put(&mut edge, 0, 1_000_000, 0, 0);
        put(&mut edge, 1, 1_007_200, 7_200 * PRICE_SCALE, 0);
        let mut edge_input = no_fees(SwapDirection::Token0ToToken1, &edge, 1, 4);
        edge_input.twap_window_secs = 3_600;
        let quote = quote_min_out(edge_input).unwrap();
        assert_eq!(quote.dt_secs, 7_200);
        assert_eq!(quote.min_out, 4);

        // Only ten seconds of history cannot satisfy a one-hour window / 2.
        let mut short = empty_ring();
        put(&mut short, 0, 50_000, 0, 0);
        put(&mut short, 1, 50_010, 10 * PRICE_SCALE, 0);
        let mut short_input = no_fees(SwapDirection::Token0ToToken1, &short, 1, 4);
        short_input.twap_window_secs = 3_600;
        assert_eq!(
            quote_min_out(short_input).unwrap_err(),
            TwapError::WindowTooShort
        );
    }

    #[test]
    fn newest_observation_must_be_fresh_and_not_in_the_future() {
        let mut ring = empty_ring();
        put(&mut ring, 0, 10_000, 0, 0);
        put(&mut ring, 1, 11_000, 1_000 * PRICE_SCALE, 0);
        let mut input = no_fees(SwapDirection::Token0ToToken1, &ring, 1, 10);
        input.twap_window_secs = 1_000;

        input.now = 12_000; // exactly one window old: accepted
        let quote = quote_min_out(input).unwrap();
        // The cutoff is now - window = 11_000, so the older sample must be at
        // or before that. Only ts 10_000 qualifies besides the newest.
        assert_eq!(quote.older_timestamp, 10_000);

        input.now = 12_001;
        assert_eq!(quote_min_out(input).unwrap_err(), TwapError::Stale);

        input.now = 10_999;
        assert_eq!(
            quote_min_out(input).unwrap_err(),
            TwapError::FutureObservation
        );
        input.now = -1;
        assert_eq!(
            quote_min_out(input).unwrap_err(),
            TwapError::FutureObservation
        );
    }

    #[test]
    fn cutoff_is_measured_from_now_not_from_the_newest_sample() {
        let mut ring = empty_ring();
        put(&mut ring, 0, 8_000, 0, 0);
        put(&mut ring, 1, 9_000, 1_000 * PRICE_SCALE, 0);
        put(&mut ring, 2, 10_000, 2_000 * PRICE_SCALE, 0);
        let mut input = no_fees(SwapDirection::Token0ToToken1, &ring, 2, 10);
        input.twap_window_secs = 1_500;
        // newest - window = 8_500 would pick 8_000. now - window = 9_000.
        input.now = 10_500;
        let quote = quote_min_out(input).unwrap();
        assert_eq!(quote.older_timestamp, 9_000);
        assert_eq!(quote.dt_secs, 1_000);
    }

    #[test]
    fn reverse_direction_quotes_mean_of_inverse_price_not_inverse_of_mean() {
        // Token-0 price P (token-1 per token-0) is 1 for 9_900 s, then 10_000
        // for 100 s. Token-1's cumulative accrues 1/P over the same time.
        let scale = PRICE_SCALE;
        let inv_spike = scale / 10_000; // floor(2^32 / 10_000), as the pool would
        let mut ring = empty_ring();
        put(&mut ring, 0, 100_000, 0, 0);
        put(&mut ring, 1, 109_900, 9_900 * scale, 9_900 * scale);
        put(
            &mut ring,
            2,
            110_000,
            9_900 * scale + 100 * 10_000 * scale,
            9_900 * scale + 100 * inv_spike,
        );
        let amount = 1_000_000u64;
        let mut input = no_fees(SwapDirection::Token1ToToken0, &ring, 2, amount);
        input.twap_window_secs = 10_000;
        let quote = quote_min_out(input).unwrap();
        assert_eq!(quote.dt_secs, 10_000);

        // E[1/P] = (9_900 + 100 / 10_000) / 10_000 = 0.990001.
        // 1 / E[P] = 10_000 / (9_900 + 1_000_000) = 0.0099020...
        let e_inv_p = amount as f64 * 0.990001;
        let inv_e_p = amount as f64 * 10_000.0 / 1_009_900.0;
        let got = quote.min_out as f64;
        assert!(
            (got - e_inv_p).abs() <= 2.0,
            "quote {got} should be E[1/P] * amount = {e_inv_p}"
        );
        assert!(got > 50.0 * inv_e_p, "quote must not be 1/E[P] = {inv_e_p}");

        // The forward direction still prices with E[P] = 100.99. The x32
        // average is floored, so 1_000 * 100.99 = 100_990 comes out one lower.
        let mut forward = no_fees(SwapDirection::Token0ToToken1, &ring, 2, 1_000);
        forward.twap_window_secs = 10_000;
        assert_eq!(quote_min_out(forward).unwrap().min_out, 100_989);
    }

    #[test]
    fn single_observation_is_rejected() {
        let mut ring = empty_ring();
        put(&mut ring, 4, 9_000, PRICE_SCALE, 1);
        let err = quote_min_out(no_fees(SwapDirection::Token0ToToken1, &ring, 4, 10)).unwrap_err();
        assert_eq!(err, TwapError::EmptyObservation);
    }

    #[test]
    fn precision_trap_rejects_a_tiny_directional_average_instead_of_inverting() {
        // Token-0 price is 50_000_000 raw output per raw input, scaled by 2^32.
        // Token-1 price is 83. That is the same shape as USDC.X/TEST, where the
        // measured token-1 x32 average was ~83 and the token-0 side was ~2.2e17.
        let dt = 100u64;
        let price0 = 50_000_000u128 * PRICE_SCALE;
        let price1 = 83u128;
        let mut ring = empty_ring();
        put(&mut ring, 0, 1_000, 10, 10);
        put(
            &mut ring,
            1,
            1_000 + dt,
            10 + price0 * dt as u128,
            10 + price1 * dt as u128,
        );

        let mut forward_input = no_fees(SwapDirection::Token0ToToken1, &ring, 1, 1_000_000);
        forward_input.twap_window_secs = 200;
        let forward = quote_min_out(forward_input).unwrap();
        assert_eq!(forward.price_x32, price0);
        assert_eq!(forward.min_out, 1_000_000 * 50_000_000);

        // The reverse direction would need the 83-scaled side. It is below
        // MIN_DIRECT_PRICE_X32, so the quote is rejected, not inverted.
        let mut backward_input = no_fees(SwapDirection::Token1ToToken0, &ring, 1, 50_000_000);
        backward_input.twap_window_secs = 200;
        assert_eq!(
            quote_min_out(backward_input).unwrap_err(),
            TwapError::PriceTooSmall
        );

        // At exactly the floor the quote is accepted.
        let mut floor_ring = empty_ring();
        put(&mut floor_ring, 0, 1_000, 0, 0);
        put(&mut floor_ring, 1, 1_100, 0, MIN_DIRECT_PRICE_X32 * 100);
        let mut floor_input = no_fees(SwapDirection::Token1ToToken0, &floor_ring, 1, 1 << 20);
        floor_input.twap_window_secs = 200;
        assert_eq!(quote_min_out(floor_input).unwrap().min_out, 16);
    }

    #[test]
    fn output_transfer_fee_and_deviation_are_applied_after_the_trade_fee() {
        let mut ring = empty_ring();
        // Price x32 == 2^32, so the raw conversion is 1:1 before fees.
        put(&mut ring, 0, 100, 0, 0);
        put(&mut ring, 1, 1_100, 1_000 * PRICE_SCALE, 0);
        let quote = quote_min_out(QuoteInput {
            ring: &ring,
            observation_index: 1,
            now: 1_100,
            twap_window_secs: 1_000,
            amount_in_after_input_fee: 1_000_000,
            trade_fee_rate: 2_800,
            direction: SwapDirection::Token0ToToken1,
            output_transfer_fee: TransferFee {
                basis_points: 500,
                maximum_fee: u64::MAX,
            },
            max_dev_bps: 100,
        })
        .unwrap();
        let net = 997_200u64;
        let output_fee = (net as u128 * 500 + 9_999) / 10_000;
        assert_eq!(output_fee, 49_860);
        let expected = net - output_fee as u64;
        assert_eq!(expected, 947_340);
        assert_eq!(quote.expected_out, expected);
        assert_eq!(quote.min_out, expected * 9_900 / 10_000);
    }

    #[test]
    fn transfer_fee_cap_binds() {
        let fee = TransferFee {
            basis_points: 500,
            maximum_fee: 10,
        };
        assert_eq!(transfer_fee_charged(1_000_000, fee).unwrap(), 10);
        assert_eq!(amount_after_transfer_fee(1_000_000, fee).unwrap(), 999_990);
    }

    #[test]
    fn mul_div_floor_handles_wide_products() {
        assert_eq!(mul_div_floor(200_000, 997_200, 1_000_000).unwrap(), 199_440);
        assert_eq!(
            mul_div_floor(1u128 << 100, 1u128 << 40, 1u128 << 20).unwrap(),
            1u128 << 120
        );
        assert_eq!(widening_mul(1u128 << 64, 1u128 << 64), (1, 0));

        let mut state = 0x1234_5678_9abc_def0u128;
        for _ in 0..300 {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let a = state;
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let b = state | 1;
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            let denominator = (state >> 96).max(1);
            let (hi, lo) = widening_mul(a, b);
            let quotient = match div_wide(hi, lo, denominator) {
                Ok(q) => q,
                Err(TwapError::Overflow) => continue,
                Err(other) => panic!("unexpected {other:?}"),
            };
            let (phi, plo) = widening_mul(quotient, denominator);
            assert!(phi < hi || (phi == hi && plo <= lo), "quotient too large");
            if quotient < u128::MAX {
                let (nhi, nlo) = widening_mul(quotient + 1, denominator);
                assert!(nhi > hi || (nhi == hi && nlo > lo), "quotient too small");
            }
        }
    }
}
