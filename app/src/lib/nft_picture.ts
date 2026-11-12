/**
 * Find a fund NFT's picture for display: on-chain metadata uri -> JSON ->
 * `image` (or `properties.files[0].uri`). DISPLAY ONLY.
 *
 * Privacy: the app contacts nothing but the RPC on its own. The one
 * exception is the X1 Inscriptions hosts (www.x1inscriptions.io and
 * <n>.x1ins.xyz over https), where the app's own inscriptions live; any
 * other host is contacted only after the user clicks "Load picture" for it.
 * Requests carry no credentials and no referrer, time out, and the JSON is
 * size-capped and parsed defensively. The image is only ever used as an
 * <img src>; `animation_url` is offered as a link, never embedded.
 */

export const NFT_JSON_MAX_BYTES = 64 * 1024;
export const NFT_FETCH_TIMEOUT_MS = 8_000;

/** The URL if it parses as http(s), else undefined. */
export function httpUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

/** True for https URLs on www.x1inscriptions.io or <digits>.x1ins.xyz (fetched without asking). */
export function isAutoFetchUrl(value: unknown): boolean {
  const u = httpUrl(value);
  if (!u || u.protocol !== "https:" || u.username || u.password || u.port) return false;
  return u.hostname === "www.x1inscriptions.io" || /^[0-9]{1,12}\.x1ins\.xyz$/.test(u.hostname);
}

/** Whether `url` may be contacted now: an auto host, or a host the user allowed by clicking. */
export function mayFetch(url: string, allowed: ReadonlySet<string>): boolean {
  if (isAutoFetchUrl(url)) return true;
  const u = httpUrl(url);
  return !!u && allowed.has(u.host);
}

export interface NftJson {
  image: string;
  animationUrl: string | undefined;
}

/** Parse metadata JSON text. Throws when oversized, not an object, or without an http(s) image. */
export function parseNftJson(text: string): NftJson {
  if (new TextEncoder().encode(text).length > NFT_JSON_MAX_BYTES) throw new Error("metadata JSON is too large");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("metadata is not JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("metadata is not a JSON object");
  const o = body as Record<string, unknown>;
  const props = o.properties && typeof o.properties === "object" ? (o.properties as Record<string, unknown>) : undefined;
  const files = Array.isArray(props?.files) ? (props!.files as unknown[]) : [];
  const first = files[0] && typeof files[0] === "object" ? (files[0] as Record<string, unknown>).uri : undefined;
  const image = httpUrl(o.image) ?? httpUrl(first);
  if (!image) throw new Error("metadata has no http(s) image");
  return { image: image.href, animationUrl: httpUrl(o.animation_url)?.href };
}

/** Read a response body as text, stopping past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) throw new Error("metadata JSON is too large");
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel();
      throw new Error("metadata JSON is too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Fetch and parse the metadata JSON with no credentials, no referrer, a timeout and a size cap. */
export async function fetchNftJson(uri: string, signal: AbortSignal, fetchFn: FetchLike = fetch): Promise<NftJson> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), NFT_FETCH_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  signal.addEventListener("abort", onAbort);
  try {
    const res = await fetchFn(uri, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "cors",
      cache: "no-cache",
      redirect: "error",
      signal: timeout.signal,
    });
    if (!res.ok) throw new Error(`metadata request failed (${res.status})`);
    return parseNftJson(await readCapped(res, NFT_JSON_MAX_BYTES));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export type PictureState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ask"; host: string }
  | { status: "ok"; image: string; animationUrl: string | undefined }
  | { status: "error" };

/**
 * Resolve the picture for a metadata uri. Stops with "ask" naming the host
 * that needs a click, for the metadata JSON or for the image itself.
 */
export async function resolvePicture(
  uri: string | undefined,
  allowed: ReadonlySet<string>,
  signal: AbortSignal,
  fetchFn?: FetchLike,
): Promise<PictureState> {
  const u = httpUrl(uri);
  if (!u) return { status: "none" };
  if (!mayFetch(u.href, allowed)) return { status: "ask", host: u.host };
  let json: NftJson;
  try {
    json = await fetchNftJson(u.href, signal, fetchFn);
  } catch {
    return { status: "error" };
  }
  if (!mayFetch(json.image, allowed)) return { status: "ask", host: new URL(json.image).host };
  return { status: "ok", image: json.image, animationUrl: json.animationUrl };
}
