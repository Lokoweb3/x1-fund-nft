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
/** A chain the keeper does not recognize. Sends to it are always refused. */
export type DetectedCluster = Cluster | "unknown";

export function isCluster(value: string): value is Cluster {
  return (CLUSTERS as readonly string[]).includes(value);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function isLoopbackUrl(rpcUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(rpcUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * X1 mainnet and testnet are recognized by genesis hash. Any other hash is
 * localnet only when the RPC is on a loopback address; otherwise it is an
 * unknown chain (fail closed), so a mistaken public RPC is never treated as a
 * disposable local validator.
 */
export function clusterFromGenesisHash(genesisHash: string, rpcUrl: string): DetectedCluster {
  if (genesisHash === X1_MAINNET_GENESIS_HASH) return "mainnet";
  if (genesisHash === X1_TESTNET_GENESIS_HASH) return "testnet";
  return isLoopbackUrl(rpcUrl) ? "localnet" : "unknown";
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
  const actual = clusterFromGenesisHash(input.genesisHash, input.rpcUrl);
  if (actual === "unknown") {
    throw new Error(
      `refusing to send: genesis ${input.genesisHash} is not X1 mainnet or testnet, and ${input.rpcUrl} is not a loopback local validator`,
    );
  }
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
