/**
 * Art for the fund NFT and the Metaplex metadata JSON that points at it.
 *
 * Two art sources:
 * - an X1 inscription (https://www.x1inscriptions.io/i/<n> or just <n>): the
 *   inscription header and its Metaplex Core asset are read from chain
 *   (inscribe.ts PDAs), then, only when the caller asks, the site's NFT JSON
 *   and a HEAD of the gateway are compared with the chain;
 * - plain image / video URLs.
 *
 * `buildFundNftJson` writes the Metaplex-standard JSON. Its compact form fits
 * one inscription transaction (FIRST_CHUNK_MAX = 600 bytes).
 *
 * Nothing here fetches on its own: the RPC reads take an account reader and
 * the HTTP checks take an injected fetch, so the app decides when a host is
 * contacted. docs/X1_INSCRIPTIONS.md has the trust notes.
 *
 * Browser-safe: no node: imports.
 */
import { PublicKey } from "@solana/web3.js";
import {
  CORE_PROGRAM_ID,
  decodeInscription,
  ENCODING_BIG_FLAG,
  FIRST_CHUNK_MAX,
  INSCRIPTION_PROGRAM_ID,
  inscriptionAssetPda,
  inscriptionPda,
  inscriptionUri,
} from "./inscribe.js";

export const SITE_ORIGIN = "https://www.x1inscriptions.io";
/** Largest inscription number accepted from user input (u64 in the program; this keeps input sane). */
const MAX_REF = 10n ** 15n;

/**
 * Parse "https://www.x1inscriptions.io/i/<n>", "x1inscriptions.io/i/<n>",
 * "#<n>" or "<n>". Anything else is refused.
 */
export function parseInscriptionRef(input: string): bigint {
  const v = input.trim();
  let digits: string | undefined;
  const plain = /^#?(\d{1,16})$/.exec(v);
  if (plain) digits = plain[1];
  else {
    let url: URL | undefined;
    try {
      url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
    } catch {
      url = undefined;
    }
    if (url && (url.hostname === "www.x1inscriptions.io" || url.hostname === "x1inscriptions.io")) {
      const m = /^\/i\/(\d{1,16})\/?$/.exec(url.pathname);
      if (m && !url.search && !url.hash) digits = m[1];
    }
  }
  if (digits === undefined) {
    throw new Error("enter an inscription number, or a link like https://www.x1inscriptions.io/i/63");
  }
  const n = BigInt(digits);
  if (n > MAX_REF) throw new Error(`inscription number ${digits} is too large`);
  return n;
}

export interface InscriptionArtUrls {
  /** The inscription's page on the site. */
  page: string;
  /** The site's Metaplex JSON for the inscription's own Core NFT. */
  nftJson: string;
  /** The raw content on the gateway (inscribe.ts inscriptionUri). */
  content: string;
  /** The site's rendered card image (always an image, even for video inscriptions). */
  card: string;
}

export function inscriptionArtUrls(n: bigint): InscriptionArtUrls {
  return {
    page: `${SITE_ORIGIN}/i/${n}`,
    nftJson: `${SITE_ORIGIN}/api/nft/ins/${n}.json`,
    content: inscriptionUri(n),
    card: `${SITE_ORIGIN}/api/ins/${n}?card=1&v=1`,
  };
}

/** Metaplex Core `Key::AssetV1`. */
export const CORE_KEY_ASSET_V1 = 1;
/**
 * Owner of a Metaplex Core asset: bytes 1..33, right after the 1-byte key.
 * Verified on 2026-11-12 against mainnet asset Aej1SC2B... (#63): offset 1
 * holds 6P5dGdd3..., the same key as the inscription account's owner field.
 */
export const CORE_ASSET_OWNER_OFFSET = 1;

export function readCoreAssetOwner(data: Uint8Array): PublicKey {
  if (data.length < 33 || data[0] !== CORE_KEY_ASSET_V1) throw new Error("not a Metaplex Core AssetV1 account");
  return new PublicKey(data.subarray(CORE_ASSET_OWNER_OFFSET, CORE_ASSET_OWNER_OFFSET + 32));
}

export interface InscriptionArt {
  number: bigint;
  inscription: PublicKey;
  asset: PublicKey;
  contentType: string;
  totalSize: number;
  written: number;
  sealed: boolean;
  encoding: number;
  /** Owner field of the inscription account. */
  inscriptionOwner: PublicKey;
  /** Owner of the Core asset (the inscription's NFT); undefined when the asset is missing. */
  assetOwner: PublicKey | undefined;
  urls: InscriptionArtUrls;
}

export interface ArtAccountReader {
  getMultipleAccountsInfo(
    keys: PublicKey[],
    commitment?: "confirmed",
  ): Promise<Array<{ owner: PublicKey; data: Uint8Array } | null>>;
}

/** Read inscription #n and its Core asset from the RPC. Throws with a plain reason. */
export async function readInscriptionArt(
  connection: ArtAccountReader,
  n: bigint,
  programId: PublicKey = INSCRIPTION_PROGRAM_ID,
): Promise<InscriptionArt> {
  const inscription = inscriptionPda(n, programId);
  const asset = inscriptionAssetPda(n, programId);
  const [ins, core] = await connection.getMultipleAccountsInfo([inscription, asset], "confirmed");
  if (!ins) throw new Error(`inscription #${n} does not exist on this network (no account at ${inscription.toBase58()})`);
  if (!ins.owner.equals(programId)) throw new Error(`account ${inscription.toBase58()} is owned by ${ins.owner.toBase58()}, not X1 Inscriptions`);
  const decoded = decodeInscription(ins.data);
  if (decoded.number !== n) throw new Error(`account ${inscription.toBase58()} says #${decoded.number}, expected #${n}`);
  let assetOwner: PublicKey | undefined;
  if (core) {
    if (!core.owner.equals(CORE_PROGRAM_ID)) throw new Error(`asset ${asset.toBase58()} is owned by ${core.owner.toBase58()}, not Metaplex Core`);
    assetOwner = readCoreAssetOwner(core.data);
  }
  return {
    number: n,
    inscription,
    asset,
    contentType: decoded.contentType,
    totalSize: decoded.totalSize,
    written: decoded.written,
    sealed: decoded.sealed,
    encoding: decoded.encoding,
    inscriptionOwner: decoded.owner,
    assetOwner,
    urls: inscriptionArtUrls(n),
  };
}

export interface ArtFile {
  uri: string;
  type: string;
}

export interface GatewayCheck {
  /** animation_url from the site's NFT JSON, kept only if it points at this inscription's own hosts. */
  animationUrl?: string;
  files: ArtFile[];
  headContentType?: string;
  headLength?: number;
  warnings: string[];
}

export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

/** Only https URLs on the site or on this inscription's own gateway subdomain are taken from the site's JSON. */
export function isInscriptionHostUrl(value: unknown, n: bigint): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && (u.hostname === "www.x1inscriptions.io" || u.hostname === `${n}.x1ins.xyz`);
  } catch {
    return false;
  }
}

const baseType = (t: string) => t.split(";")[0]!.trim().toLowerCase();

/**
 * The explicit "Check" step: GET the site's NFT JSON for animation_url and
 * files, and HEAD the gateway content, then compare with the chain. Network
 * failures become warnings; they never throw.
 */
export async function checkInscriptionGateway(fetchFn: FetchLike, art: InscriptionArt): Promise<GatewayCheck> {
  const n = art.number;
  const out: GatewayCheck = { files: [], warnings: [] };
  try {
    const res = await fetchFn(art.urls.nftJson);
    if (!res.ok) out.warnings.push(`the site's NFT JSON answered HTTP ${res.status}`);
    else {
      const body = (await res.json()) as { animation_url?: unknown; properties?: { files?: unknown } };
      if (isInscriptionHostUrl(body?.animation_url, n)) out.animationUrl = body.animation_url;
      else if (body?.animation_url !== undefined) out.warnings.push("ignored the site's animation_url: it is not on www.x1inscriptions.io or this inscription's gateway");
      const files = Array.isArray(body?.properties?.files) ? (body.properties!.files as unknown[]) : [];
      for (const f of files) {
        const file = f as { uri?: unknown; type?: unknown };
        if (isInscriptionHostUrl(file?.uri, n) && typeof file.type === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(file.type)) {
          out.files.push({ uri: file.uri, type: file.type });
        }
      }
    }
  } catch (err) {
    out.warnings.push(`could not read the site's NFT JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const head = await fetchFn(art.urls.content, { method: "HEAD" });
    if (!head.ok) out.warnings.push(`the gateway answered HTTP ${head.status} for ${art.urls.content}`);
    else {
      const type = head.headers.get("content-type") ?? undefined;
      const length = head.headers.get("content-length");
      out.headContentType = type;
      if (length !== null && /^\d+$/.test(length)) out.headLength = Number(length);
      if (!type) out.warnings.push("the gateway did not say what type the content is");
      else if (baseType(type) !== baseType(art.contentType)) {
        out.warnings.push(`the gateway serves this as ${type}, but the chain says ${art.contentType}`);
      }
      const gzip = (art.encoding & ~ENCODING_BIG_FLAG) === 1;
      if (out.headLength === undefined) out.warnings.push("the gateway did not report a content length, so the size could not be compared");
      else if (!gzip && out.headLength !== art.totalSize) {
        out.warnings.push(`the gateway reports ${out.headLength} bytes, but the chain says ${art.totalSize}`);
      }
    }
  } catch (err) {
    out.warnings.push(`could not reach the gateway: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!art.sealed) out.warnings.push(`inscription #${n} is not finished uploading (${art.written} of ${art.totalSize} bytes written)`);
  return out;
}

export type Category = "image" | "video" | "audio" | "html" | "vr";

export function categoryFor(contentType: string): Category {
  const t = baseType(contentType);
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  if (t === "text/html") return "html";
  if (t.startsWith("model/")) return "vr";
  return "image";
}

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  glb: "model/gltf-binary",
  html: "text/html",
};

/** Content type guessed from a URL's file extension, or undefined. */
export function guessContentType(url: string): string | undefined {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const ext = /\.([a-z0-9]+)$/.exec(path)?.[1];
    return ext ? EXT_TYPES[ext] : undefined;
  } catch {
    return undefined;
  }
}

/** A plain https (or http) URL for art. */
export function checkArtUrl(value: string, what: string): string {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new Error(`${what} must be a full https:// link`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${what} must start with https://`);
  return u.toString();
}

export interface FundNftJsonInput {
  name: string;
  symbol: string;
  description: string;
  image: ArtFile;
  animation?: ArtFile;
  /** Present when the art is an inscription. */
  inscription?: {
    number: bigint;
    inscription: PublicKey;
    asset: PublicKey;
    contentType: string;
    totalSize: number;
  };
  fund: PublicKey;
  quote: { mint: PublicKey; label: string };
  /** Non-cash targets and, when there is one, the cash slice (mint = quote). */
  targets: Array<{ mint: PublicKey; label: string; bps: number; cash: boolean }>;
  /**
   * Fit one inscription transaction: minified; the inscription's account, NFT,
   * content type and size (all readable from chain by its number) and the
   * mint addresses are left out; properties.files lists only the main file;
   * the description is shortened if needed.
   */
  compact: boolean;
  /** Byte budget for the compact form. Default FIRST_CHUNK_MAX (600). */
  maxBytes?: number;
}

export interface FundNftJson {
  json: string;
  bytes: Uint8Array;
  /** Set when compact mode shortened the description to fit. */
  descriptionTrimmedTo?: string;
}

const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
const utf8 = new TextEncoder();

function trimUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8.encode(s).length <= maxBytes) return s;
  const chars = [...s];
  while (chars.length && utf8.encode(chars.join("") + "…").length > maxBytes) chars.pop();
  return chars.length ? chars.join("") + "…" : "";
}

/**
 * The fund NFT's Metaplex JSON: name, symbol, description, image,
 * animation_url, properties.files (with types) and category, and attributes
 * for the art and the fund. Throws if the compact form cannot fit even with
 * an empty description.
 */
export function buildFundNftJson(input: FundNftJsonInput): FundNftJson {
  const maxBytes = input.maxBytes ?? FIRST_CHUNK_MAX;
  const compact = input.compact;
  const attributes: Array<{ trait_type: string; value: string | number }> = [];
  const ins = input.inscription;
  if (ins) {
    attributes.push({ trait_type: "Inscription", value: Number(ins.number) });
    if (!compact) {
      attributes.push({ trait_type: "Inscription account", value: ins.inscription.toBase58() });
      attributes.push({ trait_type: "Inscription NFT", value: ins.asset.toBase58() });
    }
    if (!compact) {
      attributes.push({ trait_type: "Content type", value: ins.contentType });
      attributes.push({ trait_type: "Size", value: ins.totalSize });
    }
  }
  attributes.push({ trait_type: "Fund", value: input.fund.toBase58() });
  const label = (t: { mint: PublicKey; label: string }) => (compact ? t.label : `${t.label} ${t.mint.toBase58()}`);
  attributes.push({ trait_type: "Pay with", value: label(input.quote) });
  input.targets.forEach((t, i) => {
    if (t.cash) attributes.push({ trait_type: "Cash", value: pct(t.bps) });
    else attributes.push({ trait_type: `Buy ${i + 1}`, value: `${label(t)} ${pct(t.bps)}` });
  });
  // Compact lists only the main file (the animation when there is one); the image is in `image` anyway.
  const files: ArtFile[] = compact && input.animation ? [input.animation] : [input.image];
  if (!compact && input.animation && input.animation.uri !== input.image.uri) files.push(input.animation);
  const category = categoryFor(input.animation?.type ?? input.image.type);
  const doc = (description: string) => ({
    name: input.name,
    symbol: input.symbol,
    description,
    image: input.image.uri,
    ...(input.animation ? { animation_url: input.animation.uri } : {}),
    ...(!compact && ins ? { external_url: inscriptionArtUrls(ins.number).page } : {}),
    attributes,
    properties: { category, files },
  });
  const render = (description: string) => (compact ? JSON.stringify(doc(description)) : JSON.stringify(doc(description), null, 2));
  let json = render(input.description);
  let descriptionTrimmedTo: string | undefined;
  if (compact && utf8.encode(json).length > maxBytes) {
    const without = utf8.encode(render("")).length;
    if (without > maxBytes) {
      throw new Error(
        `the compact JSON is ${without} bytes even without a description; the limit for one transaction is ${maxBytes}. ` +
          "Use a shorter name, fewer tokens, or turn Compact off.",
      );
    }
    // JSON escaping can make a character cost more than its UTF-8 bytes; shrink until it fits.
    let budget = maxBytes - without;
    for (;;) {
      descriptionTrimmedTo = trimUtf8(input.description, budget);
      json = render(descriptionTrimmedTo);
      if (utf8.encode(json).length <= maxBytes || budget <= 0) break;
      budget -= utf8.encode(json).length - maxBytes;
    }
  }
  return { json, bytes: utf8.encode(json), descriptionTrimmedTo };
}
