/**
 * The app-level inscription-attempt registry.
 *
 * Resuming an inscription is only safe when the resume knows EVERY earlier
 * transaction of that upload that may still land (keeper/src/core/inscribe.ts,
 * assertAttemptsSettled; docs/X1_INSCRIPTIONS.md, "Resuming an unfinished
 * upload safely"). So the history must not depend on any page or review
 * state, which is cleared on a signer or network change. It lives in App
 * state, like the consumed-review set, and is never cleared: entries are
 * appended from sendPlan's onSubmit (synchronously, right before each
 * broadcast) and updated with outcomes when the send ends.
 *
 * An upload is identified by rpcUrl + genesis hash + payer + inscription
 * number + content hash. Resume builds its priorAttempts only from the entry
 * with exactly that identity. If continuity is lost or unknown (after a page
 * reload, from another tab, or under a different RPC, genesis or payer),
 * Resume is disabled and the page says why.
 *
 * Across page loads only a marker is kept (localStorage): "an upload of #n
 * was sent from this browser and did not finish". It never feeds a resume;
 * it only tells a later page load that its history is missing.
 */
import type { PriorAttempt } from "@core/inscribe.js";
import type { FailedTxState, SubmitHook, TxOutcome } from "@core/owner.js";
import { sha256Hex } from "./sha256";

export interface UploadKey {
  rpcUrl: string;
  genesisHash: string;
  payer: string;
  /** Inscription number, decimal. */
  number: string;
  /** sha256 of the content, hex. */
  contentHash: string;
}

export function uploadKey(input: { rpcUrl: string; genesisHash: string; payer: string; number: bigint; content: Uint8Array }): UploadKey {
  return { rpcUrl: input.rpcUrl, genesisHash: input.genesisHash, payer: input.payer, number: input.number.toString(), contentHash: sha256Hex(input.content) };
}

/** The upload a review writes, or undefined for a review that is not an inscription. */
export function reviewUploadKey(
  review: { rpcUrl: string; payer: { toBase58(): string }; inscribe?: { number: bigint; content: Uint8Array } },
  genesisHash: string,
): UploadKey | undefined {
  if (!review.inscribe) return undefined;
  return uploadKey({ rpcUrl: review.rpcUrl, genesisHash, payer: review.payer.toBase58(), number: review.inscribe.number, content: review.inscribe.content });
}

/**
 * Why a resume review can no longer send: more attempts of its upload were
 * recorded after it was planned, so the snapshot it planned from is stale.
 */
export function staleResumeReason(
  registry: InscriptionRegistry,
  review: { rpcUrl: string; payer: { toBase58(): string }; inscribe?: { number: bigint; content: Uint8Array; historyLen?: number } },
  genesisHash: string | undefined,
): string | undefined {
  const len = review.inscribe?.historyLen;
  if (len === undefined) return undefined;
  const key = genesisHash === undefined ? undefined : reviewUploadKey(review, genesisHash);
  const now = key ? (registry.get(key)?.attempts.length ?? 0) : -1;
  if (now !== len) return "More transactions of this inscription were sent after this resume was planned. Press Resume again to plan from the current state.";
  return undefined;
}

export function uploadId(k: UploadKey): string {
  return JSON.stringify([k.rpcUrl, k.genesisHash, k.payer, k.number, k.contentHash]);
}

export type AttemptState = "submitted" | "confirmed" | "failed" | "unknown" | "refused";

export interface RecordedAttempt {
  signature: string;
  label: string;
  /** The real expiry, from the blockhash the transaction was signed with. */
  lastValidBlockHeight: number;
  state: AttemptState;
  confirmedSlot?: number;
}

export interface UploadHistory {
  id: string;
  key: UploadKey;
  content: Uint8Array;
  uri: string;
  attempts: RecordedAttempt[];
  /** How many sends of this upload have started. */
  sends: number;
  pending: boolean;
  lastResult?: "done" | "failed";
  /** Read back from chain: sealed and exactly this content. */
  finished: boolean;
  /** Read back from chain after a "done" send: not (yet) sealed with this content. */
  incomplete: boolean;
}

/** One "this upload did not finish" note kept across page loads. */
export interface UploadMarker {
  session: string;
  rpcUrl: string;
  genesisHash: string;
  payer: string;
  number: string;
  at: number;
}

export interface MarkerStore {
  load(): UploadMarker[];
  save(markers: UploadMarker[]): void;
}

const MARKER_KEY = "fund-nft:unfinished-inscriptions";

export const localMarkerStore: MarkerStore = {
  load() {
    try {
      const raw = localStorage.getItem(MARKER_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? (parsed.filter((m) => m && typeof m.number === "string" && typeof m.payer === "string") as UploadMarker[]) : [];
    } catch {
      return [];
    }
  },
  save(markers) {
    try {
      localStorage.setItem(MARKER_KEY, JSON.stringify(markers));
    } catch {
      // Storage unavailable: a later page load just will not know about this upload.
    }
  },
};

export const memoryMarkerStore = (initial: UploadMarker[] = []): MarkerStore => {
  let markers = [...initial];
  return {
    load: () => [...markers],
    save: (m) => {
      markers = [...m];
    },
  };
};

const sameMarker = (m: { genesisHash: string; payer: string; number: string }, k: { genesisHash: string; payer: string; number: string }) =>
  m.genesisHash === k.genesisHash && m.payer === k.payer && m.number === k.number;

export class InscriptionRegistry {
  readonly session: string;
  private readonly uploads = new Map<string, UploadHistory>();
  /** Markers left by earlier page loads or other tabs, read once at start. */
  private foreign: UploadMarker[];
  /**
   * Every upload an earlier page load or another tab sent for. Never
   * shrinks: hiding a note does not bring the lost history back.
   */
  private readonly lost: UploadMarker[];
  private listeners = new Set<() => void>();

  constructor(private readonly store: MarkerStore = memoryMarkerStore(), session = `${Date.now()}-${Math.random().toString(36).slice(2)}`) {
    this.session = session;
    this.foreign = store.load().filter((m) => m.session !== session);
    this.lost = [...this.foreign];
  }

  /** True if an earlier page load or another tab sent transactions this page has no record of, for this upload's number. */
  historyLost(k: { genesisHash: string; payer: string; number: string }): boolean {
    return this.lost.some((m) => sameMarker(m, k));
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private changed() {
    for (const fn of this.listeners) fn();
  }

  get(key: UploadKey): UploadHistory | undefined {
    return this.uploads.get(uploadId(key));
  }
  all(): UploadHistory[] {
    return [...this.uploads.values()];
  }
  foreignMarkers(): UploadMarker[] {
    return [...this.foreign];
  }

  private ensure(key: UploadKey, content?: Uint8Array, uri?: string): UploadHistory {
    const id = uploadId(key);
    let h = this.uploads.get(id);
    if (!h) {
      h = { id, key, content: content ?? new Uint8Array(), uri: uri ?? "", attempts: [], sends: 0, pending: false, finished: false, incomplete: false };
      this.uploads.set(id, h);
    }
    return h;
  }

  /** A send of this upload starts. */
  begin(key: UploadKey, content: Uint8Array, uri: string): void {
    const h = this.ensure(key, content, uri);
    h.sends += 1;
    h.pending = true;
    this.changed();
  }

  /** From sendPlan's onSubmit: this transaction is about to be broadcast. Synchronous. */
  submit(key: UploadKey, tx: Parameters<SubmitHook>[0]): void {
    const h = this.ensure(key);
    if (!h.attempts.some((a) => a.signature === tx.signature)) {
      h.attempts.push({ signature: tx.signature, label: tx.label, lastValidBlockHeight: tx.lastValidBlockHeight, state: "submitted" });
    }
    const markers = this.store.load();
    if (!markers.some((m) => m.session === this.session && sameMarker(m, key))) {
      this.store.save([...markers, { session: this.session, rpcUrl: key.rpcUrl, genesisHash: key.genesisHash, payer: key.payer, number: key.number, at: Date.now() }]);
    }
    this.changed();
  }

  /** The send ended. Updates each attempt it knows the outcome of. */
  settle(key: UploadKey, result: { outcomes: TxOutcome[]; failed?: { signature?: string; state: FailedTxState } }): void {
    const h = this.ensure(key);
    for (const o of result.outcomes) {
      const a = h.attempts.find((x) => x.signature === o.signature);
      if (a) {
        a.state = "confirmed";
        if (o.confirmedSlot !== undefined) a.confirmedSlot = o.confirmedSlot;
      }
    }
    const f = result.failed;
    if (f?.signature) {
      const a = h.attempts.find((x) => x.signature === f.signature);
      // A transaction refused by the RPC stays in the history (fail closed): resume then also waits for its expiry.
      if (a) a.state = f.state === "unknown" ? "unknown" : f.state === "failed" ? "failed" : "refused";
    }
    h.pending = false;
    h.lastResult = f ? "failed" : "done";
    h.incomplete = false;
    this.changed();
  }

  /** The chain read after a send: sealed with exactly this content, or not. */
  markReadBack(key: UploadKey, sealed: boolean): void {
    const h = this.get(key);
    if (!h) return;
    if (sealed) {
      h.finished = true;
      h.incomplete = false;
      this.store.save(this.store.load().filter((m) => !sameMarker(m, key)));
      this.foreign = this.foreign.filter((m) => !sameMarker(m, key));
    } else {
      h.incomplete = true;
    }
    this.changed();
  }

  /** Hide a note from an earlier page load (it never enabled anything). */
  forgetForeign(marker: UploadMarker): void {
    this.store.save(this.store.load().filter((m) => !(m.session === marker.session && sameMarker(m, marker))));
    this.foreign = this.foreign.filter((m) => !(m.session === marker.session && sameMarker(m, marker)));
    this.changed();
  }
}

/** Every recorded attempt of the upload, with its real expiry: resume's priorAttempts. */
export function priorAttemptsOf(h: UploadHistory): PriorAttempt[] {
  return h.attempts.map((a) => ({
    signature: a.signature,
    lastValidBlockHeight: a.lastValidBlockHeight,
    ...(a.confirmedSlot !== undefined ? { confirmedSlot: a.confirmedSlot } : {}),
  }));
}

export interface ResumeContext {
  rpcUrl: string;
  genesisHash: string;
  payer: string | null;
}

export interface ReadyResume {
  upload: UploadHistory;
  number: bigint;
  attempts: PriorAttempt[];
}
export interface BlockedResume {
  number: string;
  /** Why the app cannot resume it from here, in plain words. */
  reason: string;
  /** Set for a note from an earlier page load, so the page can offer to hide it. */
  marker?: UploadMarker;
}

/** Wait, then finish it outside the app or start over: shown with every blocked resume. */
export const RESUME_BLOCKED_ADVICE =
  "To be safe, wait until every earlier transaction of this upload has confirmed or expired (about a minute after the last one was sent; " +
  "check them on the explorer). Then either finish it from the command line with the keeper's prepareInscribeResume " +
  '(docs/X1_INSCRIPTIONS.md, "Resuming an unfinished upload safely"), or start a fresh inscription here (it costs the inscription fee again).';

function needsResume(h: UploadHistory): boolean {
  return !h.finished && !h.pending && h.attempts.length > 0 && (h.lastResult === "failed" || h.incomplete);
}

/**
 * Which unfinished uploads this page can resume now, and which it cannot.
 * Ready: the registry holds the upload's full history under exactly this
 * RPC, genesis and payer, and no earlier page load sent for the same number.
 */
export function resumeOptions(registry: InscriptionRegistry, ctx: ResumeContext | null): { ready: ReadyResume[]; blocked: BlockedResume[] } {
  const ready: ReadyResume[] = [];
  const blocked: BlockedResume[] = [];
  const foreign = registry.foreignMarkers();
  for (const h of registry.all()) {
    if (!needsResume(h)) continue;
    const k = h.key;
    let reason: string | undefined;
    if (!ctx) reason = "No network is connected.";
    else if (k.genesisHash !== ctx.genesisHash) reason = "It was sent on a different network than the one connected now. Connect to that network again to resume it.";
    else if (k.rpcUrl !== ctx.rpcUrl) reason = `It was sent through a different RPC (${k.rpcUrl}). Connect to that RPC again to resume it.`;
    else if (ctx.payer === null) reason = `Connect the wallet that paid for it (${k.payer}) to resume it.`;
    else if (k.payer !== ctx.payer) reason = `It was paid for by a different wallet (${k.payer}). Connect that wallet again to resume it.`;
    else if (registry.historyLost(k)) {
      reason = "An earlier page load (or another tab) also sent transactions for this inscription, and this page does not have their history.";
    }
    if (reason) blocked.push({ number: k.number, reason });
    else ready.push({ upload: h, number: BigInt(k.number), attempts: priorAttemptsOf(h) });
  }
  for (const m of foreign) {
    if (ctx && m.genesisHash !== ctx.genesisHash) continue;
    if (registry.all().some((h) => sameMarker(h.key, m) && needsResume(h))) continue; // already listed above
    blocked.push({
      number: m.number,
      reason: `An upload of inscription #${m.number} (paid by ${m.payer}) was sent from this browser before the page was reloaded, or from another tab, and did not finish here. This page does not have the history of its transactions, so it cannot prove none of them can still land.`,
      marker: m,
    });
  }
  return { ready, blocked };
}

/**
 * Run one send of an inscription upload with the registry wired in: begin,
 * record each transaction from onSubmit, then settle with the outcome. The
 * App's startSend uses it; tests drive it with a mock RPC.
 */
export async function trackInscriptionSend(
  registry: InscriptionRegistry,
  upload: { key: UploadKey; content: Uint8Array; uri: string },
  run: (onSubmit: SubmitHook) => Promise<TxOutcome[]>,
): Promise<TxOutcome[]> {
  registry.begin(upload.key, upload.content, upload.uri);
  try {
    const outcomes = await run((tx) => registry.submit(upload.key, tx));
    registry.settle(upload.key, { outcomes });
    return outcomes;
  } catch (err) {
    const e = err as { done?: TxOutcome[]; signature?: string; state?: FailedTxState };
    registry.settle(upload.key, { outcomes: e?.done ?? [], failed: { signature: e?.signature, state: e?.state ?? "not sent" } });
    throw err;
  }
}
