/**
 * The NFT image step: name, symbol, description, the art (an X1 inscription
 * or plain URLs), the Metaplex JSON, and how the NFT's metadata uri is
 * provided: (a) inscribe the JSON on X1 (its own reviewed plan), (b) download
 * it and host it yourself, or (c) paste an existing uri.
 *
 * Network rule: nothing here contacts a host other than the selected RPC,
 * except the explicit "Check" button, which reads www.x1inscriptions.io and
 * <n>.x1ins.xyz (the site's NFT JSON, a HEAD of the content, then the card
 * and video previews). Plain art URLs are never loaded; they are shown as
 * links the owner can open.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  fetchInscription,
  fetchInscriptionConfig,
  planInscribe,
  type InscriptionConfig,
} from "@core/inscribe.js";
import { compileTx, parseUi } from "@core/owner.js";
import { MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN, utf8Length, validateMetadataUpdate, type MetadataFields } from "@core/metadata.js";
import {
  buildFundNftJson,
  categoryFor,
  checkArtUrl,
  checkInscriptionGateway,
  guessContentType,
  parseInscriptionRef,
  readInscriptionArt,
  type ArtFile,
  type FetchLike,
  type GatewayCheck,
  type InscriptionArt,
} from "@core/nft_art.js";
import type { AppState } from "../App";
import { ATTACH_NOTE, inscriptionRent, reviewInscribe, reviewInscribeResume, xnt, type Review } from "../lib/actions";
import { RESUME_BLOCKED_ADVICE, resumeOptions, type ReadyResume } from "../lib/inscriptions";
import { signerId } from "../lib/session";
import { ReviewPanel } from "./ReviewPanel";
import { CopyButton, errMsg, FriendlyError, Short } from "./ui";

export type ArtResult = { state: "none" } | { state: "pending"; reason: string } | { state: "ready"; metadata: MetadataFields };

export interface ArtContext {
  fund: PublicKey | null;
  quote: { mint: PublicKey; label: string } | null;
  targets: Array<{ mint: PublicKey; label: string; bps: number; cash: boolean }>;
}

type LinkMode = "inscribe" | "host" | "paste" | "none";

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function ArtStep({
  s,
  ctx,
  initial,
  allowNone,
  onChange,
}: {
  s: AppState;
  ctx: ArtContext;
  initial?: { name?: string; symbol?: string };
  allowNone: boolean;
  onChange: (r: ArtResult) => void;
}) {
  const net = s.net;
  const [name, setName] = useState(initial?.name ?? "");
  const [symbol, setSymbol] = useState(initial?.symbol ?? "");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<"inscription" | "url">("url");
  const [insRef, setInsRef] = useState("");
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<{ art: InscriptionArt; gateway: GatewayCheck; generation: number } | null>(null);
  const [checkError, setCheckError] = useState<unknown>(null);
  const [ownOnly, setOwnOnly] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageType, setImageType] = useState("");
  const [animUrl, setAnimUrl] = useState("");
  const [animType, setAnimType] = useState("");
  const [compact, setCompact] = useState(true);
  const [mode, setMode] = useState<LinkMode>(allowNone ? "none" : "paste");
  const [hosted, setHosted] = useState("");
  const [pasted, setPasted] = useState("");

  // ---- the art files ----
  const art = useMemo((): { image?: ArtFile; animation?: ArtFile; error?: string } => {
    try {
      if (source === "inscription") {
        if (!check || check.generation !== net?.generation) return { error: 'enter an inscription and press "Check"' };
        const a = check.art;
        if (ownOnly && (!s.signer || !a.assetOwner || !a.assetOwner.equals(s.signer.publicKey))) {
          return { error: `inscription #${a.number}'s NFT is owned by ${a.assetOwner?.toBase58() ?? "nobody"}, not your wallet ("Only allow inscriptions I own" is on)` };
        }
        const image = { uri: a.urls.card, type: "image/jpeg" };
        const animUri = check.gateway.animationUrl ?? (categoryFor(a.contentType) === "image" ? undefined : a.urls.content);
        const animFile = animUri ? check.gateway.files.find((f) => f.uri === animUri) : undefined;
        return { image, animation: animUri ? { uri: animUri, type: animFile?.type ?? a.contentType } : undefined };
      }
      if (!imageUrl.trim()) return { error: "enter an image link" };
      const img = checkArtUrl(imageUrl, "the image link");
      const image = { uri: img, type: imageType.trim() || guessContentType(img) || "image/png" };
      if (!animUrl.trim()) return { image };
      const anim = checkArtUrl(animUrl, "the video link");
      return { image, animation: { uri: anim, type: animType.trim() || guessContentType(anim) || "video/mp4" } };
    } catch (err) {
      return { error: errMsg(err) };
    }
  }, [source, check, net?.generation, ownOnly, s.signer, imageUrl, imageType, animUrl, animType]);

  // ---- the JSON ----
  const fieldError = useMemo(() => {
    try {
      if (!name.trim()) return "give the NFT a name";
      if (!symbol.trim()) return "give the NFT a short symbol";
      validateMetadataUpdate({ name, symbol });
      return undefined;
    } catch (err) {
      return errMsg(err).replace("--name", "The name").replace("--symbol", "The symbol");
    }
  }, [name, symbol]);

  const json = useMemo((): { bytes?: Uint8Array; text?: string; trimmed?: string; error?: string } => {
    if (fieldError) return { error: fieldError };
    if (art.error || !art.image) return { error: art.error ?? "choose the art" };
    if (!ctx.fund || !ctx.quote) return { error: "finish the steps above first (pay-with and buy tokens)" };
    try {
      const a = source === "inscription" ? check?.art : undefined;
      const r = buildFundNftJson({
        name,
        symbol,
        description,
        image: art.image,
        animation: art.animation,
        inscription: a ? { number: a.number, inscription: a.inscription, asset: a.asset, contentType: a.contentType, totalSize: a.totalSize } : undefined,
        fund: ctx.fund,
        quote: ctx.quote,
        targets: ctx.targets,
        compact,
      });
      return { bytes: r.bytes, text: r.json, trimmed: r.descriptionTrimmedTo };
    } catch (err) {
      return { error: errMsg(err) };
    }
  }, [fieldError, art, ctx, source, check, name, symbol, description, compact]);

  // ---- (b) download ----
  const downloadUrl = useMemo(() => (json.text ? URL.createObjectURL(new Blob([json.text], { type: "application/json" })) : undefined), [json.text]);
  useEffect(() => () => {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  }, [downloadUrl]);

  // ---- (a) inscribe ----
  const [config, setConfig] = useState<{ generation: number; config: InscriptionConfig } | null>(null);
  const [configError, setConfigError] = useState<unknown>(null);
  const [maxFee, setMaxFee] = useState("");
  const [estimate, setEstimate] = useState<{ key: string; number: bigint; txs: number; total: bigint; uri: string } | null>(null);
  const [insReview, setInsReview] = useState<Review | null>(null);
  const [insBusy, setInsBusy] = useState(false);
  const [insError, setInsError] = useState<unknown>(null);
  const [verified, setVerified] = useState<{ generation: number; number: bigint; uri: string; bytes: Uint8Array } | null>(null);
  const [verifyError, setVerifyError] = useState("");
  const payer = s.signer?.publicKey ?? null;
  const signerKey = signerId(s.signer);

  // Network or signer change: drop the inscription review and config.
  useEffect(() => {
    setInsReview(null);
    setConfig(null);
    setEstimate(null);
  }, [net, signerKey]);

  const readConfig = async () => {
    if (!net) return;
    setConfigError(null);
    try {
      const c = await fetchInscriptionConfig(net.connection);
      setConfig({ generation: net.generation, config: c });
      setMaxFee(xntInput(c.fees.inscribe));
    } catch (err) {
      setConfig(null);
      setConfigError(new Error(`X1 Inscriptions is not available on this network: ${errMsg(err)}`));
    }
  };
  useEffect(() => {
    if (mode === "inscribe" && net && (!config || config.generation !== net.generation)) void readConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, net]);

  const maxFeeLamports = useMemo(() => {
    try {
      return parseUi(maxFee, 9, "max fee");
    } catch {
      return undefined;
    }
  }, [maxFee]);

  // Predicted number, transaction count and total cost, offline from the config plus RPC rent and fee quotes.
  const estKey = `${config?.generation}|${json.text ?? ""}|${payer?.toBase58() ?? ""}`;
  useEffect(() => {
    if (!net || !config || config.generation !== net.generation || !json.bytes) return;
    let cancelled = false;
    (async () => {
      try {
        const p = planInscribe({ payer: payer ?? PublicKey.default, content: json.bytes!, contentType: "application/json", maxFee: config.config.fees.inscribe, config: config.config });
        const rent = await inscriptionRent(net, json.bytes!.length);
        const { blockhash } = await net.connection.getLatestBlockhash("confirmed");
        let fees = 0n;
        for (const tx of p.txs) fees += BigInt((await net.connection.getFeeForMessage(compileTx(payer ?? PublicKey.default, tx, blockhash).message, "confirmed")).value ?? 0);
        if (!cancelled) setEstimate({ key: estKey, number: p.number, txs: p.txs.length, total: p.fee + rent + fees, uri: p.uri });
      } catch {
        if (!cancelled) setEstimate(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estKey]);

  const buildInscribe = async () => {
    if (!net || !payer || !json.bytes || maxFeeLamports === undefined || s.sendPending) return;
    const epoch = s.live().signerEpoch;
    const gen = net.generation;
    setInsBusy(true);
    setInsError(null);
    setInsReview(null);
    try {
      const r = await reviewInscribe(net, payer, json.bytes, maxFeeLamports);
      if (s.live().generation === gen && s.live().signerEpoch === epoch) setInsReview({ ...r, signerEpoch: epoch });
    } catch (err) {
      setInsError(err);
    } finally {
      setInsBusy(false);
    }
  };
  // Unfinished uploads, from the app-level registry only (never from this
  // page's review state, which a signer or network change clears).
  const ctxPayer = payer?.toBase58() ?? null;
  const resume = useMemo(
    () => resumeOptions(s.inscriptions, net ? { rpcUrl: net.rpcUrl, genesisHash: net.genesisHash, payer: ctxPayer } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.inscriptions, s.inscriptionsTick, net, ctxPayer],
  );

  const buildResume = async (option: ReadyResume) => {
    if (!net || !payer || s.sendPending) return;
    const epoch = s.live().signerEpoch;
    setInsBusy(true);
    setInsError(null);
    setInsReview(null);
    try {
      // Every attempt the registry holds for exactly this upload, each with its
      // real expiry. The shared planner refuses until each is confirmed or expired.
      const r = await reviewInscribeResume(net, payer, option.number, option.upload.content, option.attempts);
      if (s.live().generation === net.generation && s.live().signerEpoch === epoch) setInsReview({ ...r, signerEpoch: epoch });
    } catch (err) {
      setInsError(err);
    } finally {
      setInsBusy(false);
    }
  };

  // After an inscription send finishes ("done"): read the bytes back from chain
  // and compare before using the uri. Driven by the registry, so it runs even
  // if this page's review was cleared while the send was in flight.
  const readBack = useRef(new Set<string>());
  useEffect(() => {
    if (!net) return;
    for (const h of s.inscriptions.all()) {
      if (h.pending || h.finished || h.lastResult !== "done" || h.key.rpcUrl !== net.rpcUrl || h.key.genesisHash !== net.genesisHash) continue;
      const tag = `${h.id}#${h.sends}`;
      if (readBack.current.has(tag)) continue;
      readBack.current.add(tag);
      const number = BigInt(h.key.number);
      const { content, uri, key } = h;
      (async () => {
        setVerifyError("");
        try {
          const ins = await fetchInscription(net.connection, number);
          if (!ins) throw new Error(`inscription #${number} is not on chain`);
          if (!ins.sealed || !bytesEqual(ins.content, content)) {
            s.inscriptions.markReadBack(key, false);
            throw new Error(`inscription #${number} on chain does not hold exactly your JSON yet (${ins.written} of ${ins.totalSize} bytes); press Resume`);
          }
          s.inscriptions.markReadBack(key, true);
          setVerified({ generation: net.generation, number, uri, bytes: content });
        } catch (err) {
          setVerifyError(errMsg(err));
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.inscriptionsTick, net]);

  const verifiedOk = !!verified && verified.generation === net?.generation && !!json.bytes && bytesEqual(verified.bytes, json.bytes);

  // ---- the result for the parent ----
  const uriError = (u: string) => {
    try {
      checkArtUrl(u, "the metadata link");
      if (utf8Length(u.trim()) > MAX_URI_LEN) return `the link is ${utf8Length(u.trim())} bytes; the limit is ${MAX_URI_LEN}`;
      return undefined;
    } catch (err) {
      return errMsg(err);
    }
  };
  const result: ArtResult = useMemo(() => {
    if (mode === "none") return { state: "none" };
    if (fieldError) return { state: "pending", reason: fieldError };
    let uri: string | undefined;
    if (mode === "paste") {
      if (!pasted.trim()) return { state: "pending", reason: "paste the metadata link" };
      const e = uriError(pasted);
      if (e) return { state: "pending", reason: e };
      uri = pasted.trim();
    } else if (mode === "host") {
      if (json.error) return { state: "pending", reason: json.error };
      if (!hosted.trim()) return { state: "pending", reason: "download the JSON, host it, and paste its link" };
      const e = uriError(hosted);
      if (e) return { state: "pending", reason: e };
      uri = hosted.trim();
    } else {
      if (json.error) return { state: "pending", reason: json.error };
      if (!verifiedOk) return { state: "pending", reason: verified ? "the JSON changed after it was inscribed; inscribe it again or undo the change" : "inscribe the JSON first" };
      uri = verified!.uri;
    }
    return { state: "ready", metadata: { name, symbol, uri } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, fieldError, pasted, hosted, json, verifiedOk, verified, name, symbol]);
  const resultKey = JSON.stringify(result);
  useEffect(() => onChange(result), [resultKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const doCheck = async () => {
    if (!net) return;
    setChecking(true);
    setCheckError(null);
    setCheck(null);
    try {
      const n = parseInscriptionRef(insRef);
      const a = await readInscriptionArt(net.connection, n);
      // Only now, on this explicit click, contact the inscription site and gateway.
      const gateway = await checkInscriptionGateway(((url, init) => fetch(url, { method: init?.method ?? "GET", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" })) as FetchLike, a);
      setCheck({ art: a, gateway, generation: net.generation });
    } catch (err) {
      setCheckError(err);
    } finally {
      setChecking(false);
    }
  };

  const shownCheck = check && check.generation === net?.generation ? check : null;

  return (
    <div className="art-step" data-testid="art-step">
      <div className="grid2">
        <label className="field">
          NFT name ({utf8Length(name)}/{MAX_NAME_LEN} bytes)
          <input aria-label="NFT name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My X1 fund" />
        </label>
        <label className="field">
          Symbol ({utf8Length(symbol)}/{MAX_SYMBOL_LEN} bytes)
          <input aria-label="NFT symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder="XFUND" />
        </label>
      </div>
      <label className="field">
        Description
        <textarea aria-label="NFT description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this fund buys, in a sentence." />
      </label>

      <fieldset className="choice">
        <legend>Picture</legend>
        <label>
          <input type="radio" name="art-source" checked={source === "url"} onChange={() => setSource("url")} aria-label="Art from a link" /> A link to an image or video
        </label>
        <label>
          <input type="radio" name="art-source" checked={source === "inscription"} onChange={() => setSource("inscription")} aria-label="Art from an X1 inscription" /> An X1
          inscription (on-chain art)
        </label>
      </fieldset>

      {source === "url" && (
        <>
          <label className="field">
            Image link
            <input aria-label="Image URL" className="mono" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." />
          </label>
          <label className="field">
            Video or animation link (optional)
            <input aria-label="Animation URL" className="mono" value={animUrl} onChange={(e) => setAnimUrl(e.target.value)} placeholder="https://... .mp4" />
          </label>
          <details>
            <summary className="small">File types</summary>
            <div className="grid2">
              <label className="field">
                Image type
                <input aria-label="Image type" value={imageType} onChange={(e) => setImageType(e.target.value)} placeholder={guessContentType(imageUrl) ?? "image/png"} />
              </label>
              <label className="field">
                Video type
                <input aria-label="Animation type" value={animType} onChange={(e) => setAnimType(e.target.value)} placeholder={guessContentType(animUrl) ?? "video/mp4"} />
              </label>
            </div>
          </details>
          {art.image && (
            <p className="small muted">
              The app does not load these links (it only talks to your RPC). Check them yourself:{" "}
              <a href={art.image.uri} target="_blank" rel="noreferrer noopener">
                open the image
              </a>
              {art.animation && (
                <>
                  {" · "}
                  <a href={art.animation.uri} target="_blank" rel="noreferrer noopener">
                    open the video
                  </a>
                </>
              )}
            </p>
          )}
        </>
      )}

      {source === "inscription" && (
        <>
          <div className="row wrap">
            <label className="field grow">
              Inscription link or number
              <input aria-label="Inscription" className="mono" value={insRef} onChange={(e) => setInsRef(e.target.value)} placeholder="https://www.x1inscriptions.io/i/63" />
            </label>
            <button onClick={() => void doCheck()} disabled={!insRef.trim() || checking || !net} data-testid="check-inscription">
              {checking ? "Checking..." : "Check"}
            </button>
          </div>
          <p className="small muted">
            Check reads the inscription from your RPC, then contacts www.x1inscriptions.io and the inscription's x1ins.xyz gateway to compare them and show a
            preview. Nothing else here leaves your RPC.
          </p>
          <label className="ack small">
            <input type="checkbox" checked={ownOnly} onChange={(e) => setOwnOnly(e.target.checked)} aria-label="Only allow inscriptions I own" /> Only allow inscriptions I own
            (checks the owner of the inscription's NFT)
          </label>
          {checkError !== null && <FriendlyError err={checkError} cluster={net?.cluster} testId="inscription-error" />}
          {shownCheck && (
            <div className="ins-check" data-testid="inscription-check">
              <p className="small">
                Inscription <strong>#{shownCheck.art.number.toString()}</strong>: {shownCheck.art.contentType}, {shownCheck.art.totalSize} bytes on chain
                {shownCheck.art.sealed ? "" : " (unfinished)"}. Account <Short value={shownCheck.art.inscription.toBase58()} />, NFT{" "}
                <Short value={shownCheck.art.asset.toBase58()} />, owned by{" "}
                {shownCheck.art.assetOwner ? <Short value={shownCheck.art.assetOwner.toBase58()} /> : "nobody (no NFT account)"}
                {shownCheck.art.assetOwner && s.signer && shownCheck.art.assetOwner.equals(s.signer.publicKey) && <span className="tag">you</span>}
              </p>
              {shownCheck.gateway.warnings.map((w) => (
                <p key={w} className="warn small" data-testid="gateway-warning">
                  {w}
                </p>
              ))}
              <div className="preview">
                <img src={shownCheck.art.urls.card} alt={`Inscription #${shownCheck.art.number} card`} data-testid="card-preview" />
                {art.animation && categoryFor(art.animation.type) === "video" && (
                  <video src={art.animation.uri} controls muted playsInline preload="metadata" data-testid="video-preview" />
                )}
              </div>
            </div>
          )}
        </>
      )}
      {art.error && source === "inscription" && shownCheck && <p className="error small">{art.error}</p>}

      <label className="ack small">
        <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} aria-label="Compact JSON" /> Compact (fits one inscription transaction)
      </label>
      {json.text ? (
        <details>
          <summary className="small" data-testid="json-bytes">
            Metadata JSON: {json.bytes!.length} bytes{compact ? ` (limit 600)` : ""}
          </summary>
          <pre className="logs" data-testid="json-preview">
            {json.text}
          </pre>
        </details>
      ) : (
        <p className="small muted" data-testid="json-pending">
          Metadata JSON: {json.error}
        </p>
      )}
      {json.trimmed !== undefined && <p className="warn small">The description was shortened to fit 600 bytes.</p>}

      <fieldset className="choice">
        <legend>Where the NFT's metadata lives</legend>
        <label>
          <input type="radio" name="link-mode" checked={mode === "inscribe"} onChange={() => setMode("inscribe")} aria-label="Inscribe on X1" /> (a) Inscribe it on X1
          (about 0.52 XNT, on chain)
        </label>
        <label>
          <input type="radio" name="link-mode" checked={mode === "host"} onChange={() => setMode("host")} aria-label="Host it myself" /> (b) Download the JSON, host it
          yourself, paste its link
        </label>
        <label>
          <input type="radio" name="link-mode" checked={mode === "paste"} onChange={() => setMode("paste")} aria-label="Paste a metadata link" /> (c) Paste a metadata
          link I already have
        </label>
        {allowNone && (
          <label>
            <input type="radio" name="link-mode" checked={mode === "none"} onChange={() => setMode("none")} aria-label="No metadata now" /> No name or picture now (add
            it later from the fund page)
          </label>
        )}
      </fieldset>
      {mode !== "none" && <p className="small muted">{ATTACH_NOTE}</p>}

      {mode === "paste" && (
        <label className="field">
          Metadata link
          <input aria-label="Metadata URI" className="mono" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://.../fund.json" />
        </label>
      )}

      {mode === "host" && (
        <>
          {downloadUrl ? (
            <a className="button" href={downloadUrl} download="fund-nft.json" data-testid="download-json">
              Download fund-nft.json
            </a>
          ) : (
            <p className="small muted">{json.error}</p>
          )}
          <label className="field">
            Link to your hosted copy
            <input aria-label="Hosted JSON URL" className="mono" value={hosted} onChange={(e) => setHosted(e.target.value)} placeholder="https://.../fund-nft.json" />
          </label>
        </>
      )}

      {mode === "inscribe" && (
        <div className="inscribe" data-testid="inscribe-option">
          <p className="warn" data-testid="inscribe-wallet-warning">
            <strong>Use a separate wallet.</strong> Signing gives the X1 Inscriptions program (third-party, upgradeable) access to this wallet's whole XNT
            balance, not just the fee. Inscribe from a separate wallet holding only about 0.53 XNT. Any wallet can pay for the inscription; your fund NFT can
            point at it: inscribe here from that wallet, copy the link, then switch to the NFT holder's wallet and paste it (option c).
          </p>
          {configError !== null && <FriendlyError err={configError} cluster={net?.cluster} testId="inscribe-config-error" />}
          {config && (
            <>
              <p className="small" data-testid="inscribe-fee">
                Live inscription fee: <strong>{xnt(config.config.fees.inscribe)} XNT</strong> ({config.config.fees.inscribe.toString()} lamports, read from the
                program's config now){config.config.paused ? ". The program is PAUSED and refuses every inscription." : "."}
              </p>
              <label className="field narrow">
                Max fee you accept (XNT)
                <input aria-label="Max inscription fee" inputMode="decimal" value={maxFee} onChange={(e) => setMaxFee(e.target.value)} />
              </label>
              {maxFeeLamports !== undefined && maxFeeLamports < config.config.fees.inscribe && (
                <p className="warn small">The current fee is above your maximum, so the review will refuse.</p>
              )}
              {estimate && estimate.key === estKey && (
                <p className="small" data-testid="inscribe-estimate">
                  Predicted inscription <strong>#{estimate.number.toString()}</strong> · {estimate.txs} transaction{estimate.txs === 1 ? "" : "s"} · about{" "}
                  <strong>{xnt(estimate.total)} XNT</strong> in total (fee, rent and network fees) · link <span className="mono">{estimate.uri}</span>
                </p>
              )}
              <p className="small muted">
                Trust: X1 Inscriptions is a third-party program that its admin can upgrade, pause, or re-price. The JSON stays on chain, but wallets follow the
                https link, which is an off-chain gateway run by the same third party. The number is a prediction: if someone inscribes first, transaction 1 fails
                and nothing is charged. See docs/X1_INSCRIPTIONS.md.
              </p>
              {verifiedOk ? (
                <p className="ok" data-testid="inscribe-verified">
                  Inscribed and read back from chain: #{verified!.number.toString()} holds exactly this JSON. Metadata link:{" "}
                  <span className="mono" data-testid="inscribed-uri">{verified!.uri}</span> <CopyButton text={verified!.uri} label="copy link" />
                </p>
              ) : (
                <div className="row wrap">
                  <button disabled={!payer || !json.bytes || maxFeeLamports === undefined || insBusy || s.sendPending} onClick={() => void buildInscribe()} data-testid="inscribe-review">
                    {insBusy ? "Planning and simulating..." : "Review inscription"}
                  </button>
                  {!payer && <span className="small muted">Connect a wallet to inscribe.</span>}
                </div>
              )}
              {verified && !verifiedOk && <p className="warn small">You changed the JSON after inscribing #{verified.number.toString()}; inscribe again or undo the change.</p>}
              {verifyError && <p className="error small">{verifyError}</p>}
            </>
          )}
          {insError !== null && <FriendlyError err={insError} cluster={net?.cluster} testId="inscribe-error" />}
          {insReview && <ReviewPanel s={s} review={insReview} onClose={() => setInsReview(null)} />}
        </div>
      )}

      {(resume.ready.length > 0 || resume.blocked.length > 0) && (
        <div className="resume" data-testid="inscribe-resume-section">
          <p className="small">Unfinished inscription upload{resume.ready.length + resume.blocked.length === 1 ? "" : "s"}:</p>
          {resume.ready.map((r) => (
            <div key={r.upload.id} className="row wrap">
              <button disabled={!payer || insBusy || s.sendPending} onClick={() => void buildResume(r)} data-testid="inscribe-resume">
                Resume #{r.number.toString()}
              </button>
              <span className="small muted">
                Sends only what is missing, after every one of its {r.attempts.length} earlier transaction{r.attempts.length === 1 ? "" : "s"} has confirmed or
                expired.
              </span>
            </div>
          ))}
          {resume.blocked.map((b, i) => (
            <div key={`${b.number}-${i}`} className="resume-blocked" data-testid="resume-blocked">
              <button disabled data-testid="inscribe-resume-disabled">
                Resume #{b.number}
              </button>
              <p className="warn small">
                Resume is off for #{b.number}. {b.reason} Resuming without the full history could write a chunk twice and seal the wrong JSON. {RESUME_BLOCKED_ADVICE}
              </p>
              {b.marker && (
                <button className="link small" onClick={() => s.inscriptions.forgetForeign(b.marker!)} data-testid="forget-resume-note">
                  hide this note
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {mode !== "inscribe" && insError !== null && <FriendlyError err={insError} cluster={net?.cluster} testId="inscribe-error" />}
      {mode !== "inscribe" && insReview && <ReviewPanel s={s} review={insReview} onClose={() => setInsReview(null)} />}

      {result.state === "pending" && (
        <p className="small warn-text" data-testid="art-pending">
          NFT metadata: {result.reason}
        </p>
      )}
      {result.state === "ready" && (
        <p className="small ok" data-testid="art-ready">
          NFT metadata ready: "{result.metadata.name}" ({result.metadata.symbol}), link {result.metadata.uri}
        </p>
      )}
    </div>
  );
}

/** Lamports as an exact XNT input string. */
function xntInput(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
