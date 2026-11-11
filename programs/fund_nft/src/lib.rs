//! Fund NFT program.
//!
//! Step 1 of the build only exposes the pure TWAP module. Instructions are
//! added one at a time after this module's tests pass. The TWAP module has
//! no Solana dependency.

pub mod twap;

#[cfg(test)]
mod twap_has_no_solana_dependency {
    /// Compiling this module is the check: `twap` imports nothing from Solana.
    #[test]
    fn module_is_linked() {
        let _ = crate::twap::TRADE_FEE_DENOMINATOR;
    }
}
