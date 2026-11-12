use anchor_lang::prelude::*;

#[error_code]
pub enum FundError {
    #[msg("A fund has at most 8 targets")]
    TooManyTargets,
    #[msg("A fund needs at least one target")]
    EmptyTargets,
    #[msg("Target weights must sum to 10000 bps")]
    BpsSum,
    #[msg("Target mints must be unique")]
    DuplicateMint,
    #[msg("The cash slice must use the default pool address")]
    CashPoolNotDefault,
    #[msg("A swapped target must pin a pool")]
    PoolRequired,
    #[msg("Two targets cannot pin the same pool")]
    DuplicatePool,
    #[msg("A target weight must be greater than zero")]
    ZeroBps,
    #[msg("The TWAP window must be greater than zero")]
    BadWindow,
    #[msg("The DCA interval must be greater than zero")]
    BadInterval,
    #[msg("max_dev_bps cannot exceed 10000")]
    BadDeviation,
    #[msg("per_run_quote must be greater than zero")]
    ZeroPerRun,
    #[msg("The fund NFT must use the classic SPL token program")]
    NftTokenProgram,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("This target is not due yet")]
    NotDue,
    #[msg("The cash slice is never swapped")]
    CashSlice,
    #[msg("This target has no budget left")]
    EmptyBudget,
    #[msg("The quote slice rounded to zero")]
    ZeroSlice,
    #[msg("The pool account is not the pinned XDEX pool")]
    BadPool,
    #[msg("The pool mints are not the quote mint and the target mint")]
    PoolMintMismatch,
    #[msg("The observation account does not belong to this pool")]
    BadObservation,
    #[msg("The TWAP guard rejected the quote")]
    TwapRejected,
    #[msg("The vault received less than the TWAP minimum")]
    Slippage,
    #[msg("The signer does not hold the fund NFT")]
    BadNft,
    #[msg("The vault is not the fund's associated token account")]
    BadVault,
    #[msg("The tip account is not the caller's quote token account")]
    BadTipDestination,
    #[msg("Arithmetic overflow")]
    Math,
    #[msg("The token program does not match the mint")]
    BadTokenProgram,
    #[msg("The pool authority is not the owner of the pool vault")]
    BadAuthority,
    #[msg("The quote mint does not match the fund")]
    QuoteMintMismatch,
    #[msg("Target index is out of range")]
    TargetIndex,
    #[msg("The destination token account must belong to the NFT holder")]
    BadDestination,
    #[msg("The pool program is not the allowlisted XDEX program")]
    BadPoolProgram,
    #[msg("The quote vault did not drop by exactly the tip plus the swap input")]
    QuoteVaultDelta,
    #[msg("A fund vault is no longer owned by the fund")]
    VaultOwner,
    #[msg("A fund vault has a delegate")]
    VaultDelegate,
    #[msg("A fund vault has a close authority")]
    VaultCloseAuthority,
}
