/**
 * Find a fund NFT's picture for display: on-chain metadata uri -> JSON ->
 * `image` (or `properties.files[0].uri`). DISPLAY ONLY.
 *
 * Privacy: the app contacts nothing but the RPC on its own. The one
 * exception is the X1 Inscriptions hosts (www.x1inscriptions.io and
 * <n>.x1ins.xyz over https), where the app's own inscriptions live; any
 * other host is contacted only after the user clicks "Load picture" for it.
 * Both the JSON and the image bytes are fetched here with no credentials,
 * no referrer, redirects refused, an 8 s timeout and a size cap (64 KB
 * JSON, 2 MB image); the JSON is parsed defensively and the image must be
 * a raster image/* type. The page shows the image from a local blob: URL,
 * so the browser itself never requests a remote picture. `animation_url`
 * is offered as a link, never embedded.
 */

export const NFT_JSON_MAX_BYTES = 64 * 1024;
export const NFT_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
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

/** Stop reading a response we are rejecting, so the connection is released. */
function discard(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // already locked or consumed
  }
}

/** Read a response body, stopping (and cancelling it) past `max` bytes. */
export async function readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(len) && len > max) {
    discard(res);
    throw new Error(`${what} is too large`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => {});
      throw new Error(`${what} is too large`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return all;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * GET with no credentials, no referrer, CORS mode, redirects refused (a
 * redirect could lead to a host nobody approved) and a timeout covering
 * the whole body read inside `use`.
 */
async function hardenedGet<T>(url: string, signal: AbortSignal, fetchFn: FetchLike, use: (res: Response) => Promise<T>): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), NFT_FETCH_TIMEOUT_MS);
  const onAbort = () => timeout.abort();
  if (signal.aborted) timeout.abort();
  signal.addEventListener("abort", onAbort);
  try {
    const res = await fetchFn(url, {
      method: "GET",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      mode: "cors",
      cache: "no-cache",
      redirect: "error",
      signal: timeout.signal,
    });
    if (res.type === "opaqueredirect" || res.redirected) {
      discard(res);
      throw new Error("redirects are not followed");
    }
    if (!res.ok) {
      discard(res);
      throw new Error(`request failed (${res.status})`);
    }
    return await use(res);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** Fetch and parse the metadata JSON (hardened GET, 64 KB cap). */
export async function fetchNftJson(uri: string, signal: AbortSignal, fetchFn: FetchLike = fetch): Promise<NftJson> {
  return hardenedGet(uri, signal, fetchFn, async (res) =>
    parseNftJson(new TextDecoder().decode(await readCapped(res, NFT_JSON_MAX_BYTES, "metadata JSON"))),
  );
}

/**
 * Raster image types only. SVG is refused: even though <img> does not run
 * its scripts, there is no need to accept a document format here.
 */
export function checkImageType(contentType: string | null): string {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!/^image\/[a-z0-9.+-]+$/.test(t) || t === "image/svg+xml") throw new Error(`not a raster image (${t || "no content type"})`);
  return t;
}

/** Fetch the picture's bytes (hardened GET, image/* except SVG, 2 MB cap) as a Blob. */
export async function fetchImageBlob(url: string, signal: AbortSignal, fetchFn: FetchLike = fetch): Promise<Blob> {
  return hardenedGet(url, signal, fetchFn, async (res) => {
    let type: string;
    try {
      type = checkImageType(res.headers.get("content-type"));
    } catch (err) {
      discard(res);
      throw err;
    }
    const bytes = await readCapped(res, NFT_IMAGE_MAX_BYTES, "picture");
    return new Blob([bytes], { type });
  });
}

/** What the card renders. `src` is a blob: URL the owner of the state revokes. */
export type PictureState =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ask"; host: string }
  | { status: "ok"; src: string; source: string; animationUrl: string | undefined }
  | { status: "error" };

export type ResolvedPicture = Exclude<PictureState, { status: "ok" } | { status: "loading" }> | { status: "ok"; blob: Blob; source: string; animationUrl: string | undefined };

/**
 * Resolve the picture for a metadata uri. Stops with "ask" naming the host
 * that needs a click, for the metadata JSON or for the image itself. The
 * image bytes are fetched here, under the same rules, so the browser never
 * requests a remote image (or follows its redirects) on its own.
 */
export async function resolvePicture(
  uri: string | undefined,
  allowed: ReadonlySet<string>,
  signal: AbortSignal,
  fetchFn?: FetchLike,
): Promise<ResolvedPicture> {
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
  try {
    const blob = await fetchImageBlob(json.image, signal, fetchFn);
    return { status: "ok", blob, source: json.image, animationUrl: json.animationUrl };
  } catch {
    return { status: "error" };
  }
}
