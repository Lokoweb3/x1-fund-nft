/**
 * Build-time replacement for @solana-mobile/wallet-adapter-mobile (see
 * vite.config.ts). The real package injects Google Fonts and a remote
 * connection UI on Android; this local app loads nothing from third-party
 * hosts, so Mobile Wallet Adapter is not bundled. Browser-extension and
 * in-app wallets (Wallet Standard, e.g. Backpack) are unaffected.
 *
 * The exports are the ones @solana/wallet-adapter-react 0.15.39 imports.
 */
import {
  BaseWalletAdapter,
  WalletNotReadyError,
  WalletReadyState,
  type WalletName,
} from "@solana/wallet-adapter-base";
import type { PublicKey } from "@solana/web3.js";

export const SolanaMobileWalletAdapterWalletName = "Mobile Wallet Adapter" as WalletName<"Mobile Wallet Adapter">;

export class SolanaMobileWalletAdapter extends BaseWalletAdapter {
  name = SolanaMobileWalletAdapterWalletName;
  url = "https://github.com/solana-mobile/mobile-wallet-adapter";
  icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=";
  readyState = WalletReadyState.Unsupported;
  publicKey: PublicKey | null = null;
  connecting = false;
  supportedTransactionVersions = null;

  constructor(_config?: unknown) {
    super();
  }

  async connect(): Promise<void> {
    throw new WalletNotReadyError("Mobile Wallet Adapter is not bundled in this local app");
  }

  async disconnect(): Promise<void> {}

  async sendTransaction(): Promise<never> {
    throw new WalletNotReadyError("Mobile Wallet Adapter is not bundled in this local app");
  }
}

export function createDefaultAddressSelector(): unknown {
  return { select: async (addresses: string[]) => addresses[0] };
}

export function createDefaultAuthorizationResultCache(): unknown {
  return { clear: async () => {}, get: async () => undefined, set: async () => {} };
}

export function createDefaultWalletNotFoundHandler(): () => Promise<void> {
  return async () => {};
}
