/**
 * The context a review and a send were authorized under, and the checks that
 * stop work when that context is gone.
 *
 * A "session" is one detected network (its generation number increases on
 * every Connect, so reconnecting to the same URL is a new session), the
 * active signer, and, on mainnet, the acknowledgement tick.
 */
import type { DetectedCluster } from "@core/cluster.js";
import type { SendGuard } from "@core/owner.js";
import type { AppSigner } from "./signer";

export interface SessionKey {
  generation: number;
  rpcUrl: string;
  cluster: DetectedCluster;
  signerId: string | null;
  /** The AppSigner object itself, compared with ===. */
  signer: AppSigner | null;
  /**
   * Bumped synchronously by the wallet adapter's own connect, disconnect and
   * readyStateChange events, by an adapter change, and by the test wallet.
   * Any bump invalidates, even when the same key comes back.
   */
  signerEpoch: number;
  mainnetAck: boolean;
}

export function signerId(signer: AppSigner | null): string | null {
  return signer ? `${signer.kind}:${signer.publicKey.toBase58()}` : null;
}

/** Why `live` no longer matches the session `expected` was authorized under, or undefined if it still does. */
export function sessionMismatch(expected: SessionKey, live: SessionKey): string | undefined {
  if (live.generation !== expected.generation || live.rpcUrl !== expected.rpcUrl || live.cluster !== expected.cluster) {
    return `the network changed (was ${expected.cluster} ${expected.rpcUrl}, now ${live.cluster} ${live.rpcUrl || "none"})`;
  }
  if (live.signerId !== expected.signerId) return "the signer changed or disconnected";
  // A public key alone is not an identity: another wallet, or a disconnect
  // and reconnect, can present the same key.
  if (live.signerEpoch !== expected.signerEpoch) {
    return "the wallet connection changed (connect, disconnect, account or adapter change), even if the same key is back";
  }
  if (live.signer !== expected.signer) return "a different signer object is active";
  if (expected.cluster === "mainnet" && !live.mainnetAck) return "the mainnet acknowledgement was cleared";
  return undefined;
}

export class SessionChanged extends Error {
  constructor(reason: string) {
    super(`session changed: ${reason}`);
    this.name = "SessionChanged";
  }
}

/** Throws SessionChanged if the live session differs from `expected`. */
export function assertSession(expected: SessionKey, live: SessionKey): void {
  const why = sessionMismatch(expected, live);
  if (why) throw new SessionChanged(why);
}

/** A sendPlan guard: checked before each signature and each broadcast. */
export function sessionGuard(expected: SessionKey, getLive: () => SessionKey): SendGuard {
  return () => assertSession(expected, getLive());
}
