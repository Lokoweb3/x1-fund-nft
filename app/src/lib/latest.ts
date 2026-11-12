/**
 * Guards against stale data: replies that belong to an older network
 * generation, RPC, fund or wallet are dropped instead of shown.
 */

/**
 * Latest-only results for async loads. Each `run` supersedes every earlier
 * one; `invalidate` (network, fund or wallet change) supersedes all in
 * flight. A superseded result comes back `{ stale: true }` and must be
 * dropped, so an old reply can never overwrite a newer view.
 */
export type Latest<T> = { stale: false; value: T } | { stale: true };

export function createLatest() {
  let token = 0;
  return {
    /** A rejection from a superseded call is also reported as stale, not thrown. */
    async run<T>(work: Promise<T>): Promise<Latest<T>> {
      const mine = ++token;
      try {
        const value = await work;
        return mine === token ? { stale: false, value } : { stale: true };
      } catch (err) {
        if (mine !== token) return { stale: true };
        throw err;
      }
    },
    invalidate(): void {
      token++;
    },
  };
}

/** Identity of loaded fund data: actions are enabled only while it matches the current one. */
export interface ViewIdentity {
  generation: number;
  rpcUrl: string;
  fund: string;
}

export function sameView(a: ViewIdentity | undefined, b: ViewIdentity | undefined): boolean {
  return !!a && !!b && a.generation === b.generation && a.rpcUrl === b.rpcUrl && a.fund === b.fund;
}
