/**
 * RPC choice, cluster detection, and explorer links. The cluster comes from
 * the RPC's genesis hash via the keeper's shared guard, never from the URL.
 */
import { Connection } from "@solana/web3.js";
import { clusterFromGenesisHash, isLoopbackUrl, type Cluster, type DetectedCluster } from "@core/cluster.js";

export type RpcChoice = "mainnet" | "testnet" | "local" | "custom";

export const MAINNET_RPC = "https://rpc.mainnet.x1.xyz";
export const TESTNET_RPC = "https://rpc.testnet.x1.xyz";
export const DEFAULT_LOCAL_PORT = 8899;

export interface RpcSettings {
  choice: RpcChoice;
  localPort: string;
  customUrl: string;
}

export const DEFAULT_RPC_SETTINGS: RpcSettings = { choice: "mainnet", localPort: String(DEFAULT_LOCAL_PORT), customUrl: "" };

/** The RPC URL for a choice. Throws on a bad port or a non-http(s) custom URL. */
export function rpcUrlFor(s: RpcSettings): string {
  switch (s.choice) {
    case "mainnet":
      return MAINNET_RPC;
    case "testnet":
      return TESTNET_RPC;
    case "local": {
      if (!/^\d{1,5}$/.test(s.localPort) || Number(s.localPort) < 1 || Number(s.localPort) > 65535) {
        throw new Error(`local port must be 1-65535, got ${JSON.stringify(s.localPort)}`);
      }
      return `http://127.0.0.1:${Number(s.localPort)}`;
    }
    case "custom": {
      let url: URL;
      try {
        url = new URL(s.customUrl.trim());
      } catch {
        throw new Error("custom RPC must be a full http(s) URL");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("custom RPC must be http or https");
      return url.toString();
    }
  }
}

export interface NetworkInfo {
  rpcUrl: string;
  connection: Connection;
  genesisHash: string;
  cluster: DetectedCluster;
  loopback: boolean;
}

/** getGenesisHash, then classify with the keeper's guard (loopback-only localnet; anything else unknown). */
export async function detectNetwork(rpcUrl: string): Promise<NetworkInfo> {
  const connection = new Connection(rpcUrl, { commitment: "confirmed" });
  const genesisHash = await connection.getGenesisHash();
  return {
    rpcUrl,
    connection,
    genesisHash,
    cluster: clusterFromGenesisHash(genesisHash, rpcUrl),
    loopback: isLoopbackUrl(rpcUrl),
  };
}

/**
 * Default explorer transaction URL per cluster. Checked on 2026-11-12:
 * https://explorer.x1.xyz/tx/<sig> redirects (307) to
 * https://explorer.mainnet.x1.xyz/tx/<sig>, and /transaction/<sig> redirects
 * to /tx/<sig>; the testnet explorer serves /tx/<sig> too. A local validator
 * has no public explorer, so there is no default link.
 */
export const DEFAULT_EXPLORER: Record<Cluster, string> = {
  mainnet: "https://explorer.x1.xyz/tx/{sig}",
  testnet: "https://explorer.testnet.x1.xyz/tx/{sig}",
  localnet: "",
};

/** A link for `sig`, or undefined when the template is empty or not an http(s) URL with {sig}. */
export function explorerLink(template: string, sig: string): string | undefined {
  const t = template.trim();
  if (!t || !t.includes("{sig}")) return undefined;
  const href = t.replace("{sig}", encodeURIComponent(sig));
  try {
    const u = new URL(href);
    return u.protocol === "https:" || u.protocol === "http:" ? href : undefined;
  } catch {
    return undefined;
  }
}

/** Per-viewer convenience only. Wrapped so a blocked storage never breaks the app. */
export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`fund-nft:${key}`);
    return raw === null ? fallback : { ...fallback, ...(JSON.parse(raw) as T) };
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(`fund-nft:${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}
