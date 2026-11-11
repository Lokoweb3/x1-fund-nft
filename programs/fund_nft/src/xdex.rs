//! Byte offsets for the XDEX cp-swap accounts, checked against mainnet.
//!
//! Pool `7drPqaqcXcyYmdo62xucGqZzALuPCbGBCXCT41nWMmQD` is 637 bytes and its
//! discriminator is `account:PoolState`. The pubkeys at the offsets below are
//! the amm config, USDC.X and TEST mints, both Token-2022 programs, and the
//! observation account named in the spec. Amm config
//! `2eFPWosizV6nSAGeSvi5tRgXLoqhjnSesra23ALA248c` is 236 bytes with
//! `trade_fee_rate` 2800 at offset 12. Observation
//! `6EV7aqfYx15yVPdBANkaEBdLpKUkyQrC6thUAy5CCi4y` is 4075 bytes: the header
//! below, then 100 entries of 40 bytes, then 32 zero bytes of trailing padding.

use anchor_lang::prelude::*;

use crate::errors::FundError;

pub const POOL_LEN: usize = 637;
pub const AMM_CONFIG_LEN: usize = 236;
pub const OBSERVATION_LEN: usize = 4075;
pub const OBSERVATION_HEADER: usize = 43;
pub const OBSERVATION_RING_LEN: usize = 4_000;

pub const POOL_DISCRIMINATOR: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
pub const AMM_CONFIG_DISCRIMINATOR: [u8; 8] = [0xda, 0xf4, 0x21, 0x68, 0xcb, 0xcb, 0x2b, 0x6f];
pub const OBSERVATION_DISCRIMINATOR: [u8; 8] = [0x7a, 0xae, 0xc5, 0x35, 0x81, 0x09, 0xa5, 0x84];
/// `sha256("global:swap_base_input")[..8]`, also the data prefix of the
/// reference transaction's inner SwapBaseInput instruction.
pub const SWAP_BASE_INPUT_DISCRIMINATOR: [u8; 8] = [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

const OFF_AMM_CONFIG: usize = 8;
const OFF_TOKEN_0_VAULT: usize = 72;
const OFF_TOKEN_1_VAULT: usize = 104;
const OFF_TOKEN_0_MINT: usize = 168;
const OFF_TOKEN_1_MINT: usize = 200;
const OFF_TOKEN_0_PROGRAM: usize = 232;
const OFF_TOKEN_1_PROGRAM: usize = 264;
const OFF_OBSERVATION: usize = 296;
const OFF_TRADE_FEE_RATE: usize = 12;
const OFF_INITIALIZED: usize = 8;
const OFF_INDEX: usize = 9;
const OFF_POOL_ID: usize = 11;

#[derive(Clone, Copy, Debug)]
pub struct PoolAccounts {
    pub amm_config: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub token_0_mint: Pubkey,
    pub token_1_mint: Pubkey,
    pub token_0_program: Pubkey,
    pub token_1_program: Pubkey,
    pub observation: Pubkey,
}

pub fn read_pool(data: &[u8]) -> Result<PoolAccounts> {
    require!(
        data.len() == POOL_LEN && data.get(..8) == Some(&POOL_DISCRIMINATOR),
        FundError::BadPool
    );
    Ok(PoolAccounts {
        amm_config: pubkey_at(data, OFF_AMM_CONFIG)?,
        token_0_vault: pubkey_at(data, OFF_TOKEN_0_VAULT)?,
        token_1_vault: pubkey_at(data, OFF_TOKEN_1_VAULT)?,
        token_0_mint: pubkey_at(data, OFF_TOKEN_0_MINT)?,
        token_1_mint: pubkey_at(data, OFF_TOKEN_1_MINT)?,
        token_0_program: pubkey_at(data, OFF_TOKEN_0_PROGRAM)?,
        token_1_program: pubkey_at(data, OFF_TOKEN_1_PROGRAM)?,
        observation: pubkey_at(data, OFF_OBSERVATION)?,
    })
}

pub fn read_trade_fee_rate(data: &[u8]) -> Result<u64> {
    require!(
        data.len() == AMM_CONFIG_LEN && data.get(..8) == Some(&AMM_CONFIG_DISCRIMINATOR),
        FundError::BadPool
    );
    let bytes = data
        .get(OFF_TRADE_FEE_RATE..OFF_TRADE_FEE_RATE + 8)
        .ok_or(FundError::BadPool)?;
    Ok(u64::from_le_bytes(bytes.try_into().unwrap()))
}

pub struct ObservationView<'a> {
    pub index: u16,
    pub pool_id: Pubkey,
    pub ring: &'a [u8],
}

pub fn read_observation(data: &[u8]) -> Result<ObservationView<'_>> {
    require!(
        data.len() == OBSERVATION_LEN && data.get(..8) == Some(&OBSERVATION_DISCRIMINATOR),
        FundError::BadObservation
    );
    require!(data[OFF_INITIALIZED] == 1, FundError::BadObservation);
    let index = u16::from_le_bytes(
        data.get(OFF_INDEX..OFF_INDEX + 2)
            .ok_or(FundError::BadObservation)?
            .try_into()
            .unwrap(),
    );
    require!(usize::from(index) < 100, FundError::BadObservation);
    let pool_id = pubkey_at(data, OFF_POOL_ID)?;
    let ring = data
        .get(OBSERVATION_HEADER..OBSERVATION_HEADER + OBSERVATION_RING_LEN)
        .ok_or(FundError::BadObservation)?;
    Ok(ObservationView {
        index,
        pool_id,
        ring,
    })
}

fn pubkey_at(data: &[u8], offset: usize) -> Result<Pubkey> {
    let bytes = data.get(offset..offset + 32).ok_or(FundError::BadPool)?;
    Ok(Pubkey::new_from_array(bytes.try_into().unwrap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_offsets_round_trip() {
        let mut data = vec![0u8; POOL_LEN];
        data[..8].copy_from_slice(&POOL_DISCRIMINATOR);
        let keys = [
            (OFF_AMM_CONFIG, 3u8),
            (OFF_TOKEN_0_VAULT, 4),
            (OFF_TOKEN_1_VAULT, 5),
            (OFF_TOKEN_0_MINT, 6),
            (OFF_TOKEN_1_MINT, 7),
            (OFF_TOKEN_0_PROGRAM, 8),
            (OFF_TOKEN_1_PROGRAM, 9),
            (OFF_OBSERVATION, 10),
        ];
        for (offset, byte) in keys {
            data[offset..offset + 32].fill(byte);
        }
        let pool = read_pool(&data).unwrap();
        assert_eq!(pool.amm_config, Pubkey::new_from_array([3u8; 32]));
        assert_eq!(pool.token_0_mint, Pubkey::new_from_array([6u8; 32]));
        assert_eq!(pool.token_1_program, Pubkey::new_from_array([9u8; 32]));
        assert_eq!(pool.observation, Pubkey::new_from_array([10u8; 32]));
        assert!(read_pool(&[0u8; POOL_LEN]).is_err());
    }

    #[test]
    fn raydium_authority_seed_against_the_known_mainnet_address() {
        // The XDEX IDL does not document the authority PDA seeds. This checks
        // the seed string used by Raydium cp-swap against the authority that
        // signed the reference swap. It is not used by the program.
        let program: Pubkey = "sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN"
            .parse()
            .unwrap();
        let known: Pubkey = "9Dpjw2pB5kXJr6ZTHiqzEMfJPic3om9jgNacnwpLCoaU"
            .parse()
            .unwrap();
        let (pda, bump) = Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &program);
        assert_eq!(pda, known);
        // PoolState.auth_bump on the USDC.X/TEST pool is 255.
        assert_eq!(bump, 255);

        // Same seed under the program id that owns X1 testnet pools.
        let testnet: Pubkey = "7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf"
            .parse()
            .unwrap();
        let testnet_vault_owner: Pubkey = "2HbqjtA9gB9c95c8KkUUWxhtNjCfYcPbvfdhcdobbq1C"
            .parse()
            .unwrap();
        let (testnet_pda, testnet_bump) =
            Pubkey::find_program_address(&[b"vault_and_lp_mint_auth_seed"], &testnet);
        assert_eq!(testnet_pda, testnet_vault_owner);
        // auth_bump byte on testnet pool 5vfq8dsnMqnP4w9WmZYCv4VjcwXK1sfTQy6rprvHK6ah.
        assert_eq!(testnet_bump, 251);
    }

    #[test]
    fn amm_config_fee_and_observation_ring() {
        let mut config = vec![0u8; AMM_CONFIG_LEN];
        config[..8].copy_from_slice(&AMM_CONFIG_DISCRIMINATOR);
        config[OFF_TRADE_FEE_RATE..OFF_TRADE_FEE_RATE + 8].copy_from_slice(&2800u64.to_le_bytes());
        assert_eq!(read_trade_fee_rate(&config).unwrap(), 2800);

        let mut obs = vec![0u8; OBSERVATION_LEN];
        obs[..8].copy_from_slice(&OBSERVATION_DISCRIMINATOR);
        obs[OFF_INITIALIZED] = 1;
        obs[OFF_INDEX..OFF_INDEX + 2].copy_from_slice(&79u16.to_le_bytes());
        obs[OFF_POOL_ID..OFF_POOL_ID + 32].fill(11);
        let view = read_observation(&obs).unwrap();
        assert_eq!(view.index, 79);
        assert_eq!(view.pool_id, Pubkey::new_from_array([11u8; 32]));
        assert_eq!(view.ring.len(), OBSERVATION_RING_LEN);
        assert_eq!(
            OBSERVATION_HEADER + OBSERVATION_RING_LEN + 32,
            OBSERVATION_LEN
        );
    }
}
