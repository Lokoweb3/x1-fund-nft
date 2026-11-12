/**
 * Cluster identity guard. The genesis hash, not the RPC URL, decides which
 * chain a send would land on.
 */

/**
 * Fetched with getGenesisHash from https://rpc.mainnet.x1.xyz and
 * https://rpc.testnet.x1.xyz on 2026-11-12 (UTC).
 */
export const X1_MAINNET_GENESIS_HASH = "4SvBP3omtvcCVWdxq1zBY5cDp4wndjsThb6nEMn6iMdN";
export const X1_TESTNET_GENESIS_HASH = "C7ucgdDEhxLTpXHhWSZxavSVmaNTUJWwT5iTdeaviDho";

export type Cluster = "mainnet" | "testnet" | "localnet";
export const CLUSTERS: readonly Cluster[] = ["mainnet", "testnet", "localnet"];

export function isCluster(value: string): value is Cluster {
  return (CLUSTERS as readonly string[]).includes(value);
}

/** localnet is any genesis hash that is neither X1 mainnet nor X1 testnet. */
export function clusterFromGenesisHash(genesisHash: string): Cluster {
  if (genesisHash === X1_MAINNET_GENESIS_HASH) return "mainnet";
  if (genesisHash === X1_TESTNET_GENESIS_HASH) return "testnet";
  return "localnet";
}

export function isMainnetUrl(rpcUrl: string): boolean {
  return rpcUrl.includes("rpc.mainnet.x1.xyz");
}

export interface SendGuardInput {
  /** Value of --cluster, undefined when the flag was not given. */
  clusterFlag: Cluster | undefined;
  genesisHash: string;
  iUnderstandMainnet: boolean;
  rpcUrl: string;
}

/** Throws unless a send to this RPC is allowed. Returns the detected cluster. */
export function assertSendAllowed(input: SendGuardInput): Cluster {
  const actual = clusterFromGenesisHash(input.genesisHash);
  if (!input.clusterFlag) {
    throw new Error(
      `sending requires --cluster <${CLUSTERS.join("|")}>; the RPC reports ${actual} (genesis ${input.genesisHash})`,
    );
  }
  if (input.clusterFlag !== actual) {
    throw new Error(
      `refusing to send: --cluster ${input.clusterFlag} but the RPC genesis hash ${input.genesisHash} is ${actual}`,
    );
  }
  const mainnetConfirmed = actual === "mainnet" && input.iUnderstandMainnet;
  if (actual === "mainnet" && !mainnetConfirmed) {
    throw new Error("refusing to send to X1 mainnet without --i-understand-mainnet");
  }
  // Second guard: without the explicit mainnet flags, a mainnet-looking URL is refused.
  if (!mainnetConfirmed && isMainnetUrl(input.rpcUrl)) {
    throw new Error(`refusing to send: ${input.rpcUrl} looks like X1 mainnet`);
  }
  return actual;
}
