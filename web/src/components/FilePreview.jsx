import DialogResize, { DialogMaximize } from "./DialogResize.jsx";
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, Check, Code2, Copy, Download, Loader2, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import CodePre from "./CodePre.jsx";
import { useLayer } from "../layers.js";
import useCopyText from "../hooks/useCopyText.js";
import { previewResourcePath, formatJson, fileName } from "../filePreview.js";
import { downloadFile, rawFileUrl } from "../download.js";
import { sandboxHTML } from "../previewSandbox.js";
import { t } from "../i18n.js";

const markdownPlugins = [remarkGfm];
const unsupported = () => new Error(t("当前环境后端不支持文件预览，请重启本机后端或更新远端组件。"));
const textual = (kind) => ["html", "markdown", "json", "text"].includes(kind);
const MAX_CACHE = 16 * 1024 * 1024;
const timeoutRead = async (fn, parentSignal) => {
  const controller = new AbortController(), abort = () => controller.abort();
  parentSignal.addEventListener("abort", abort, { once: true });
  if (parentSignal.aborted) controller.abort();
  const timer = setTimeout(abort, 20000);
  try { return await fn(controller.signal); }
  finally { clearTimeout(timer); parentSignal.removeEventListener("abort", abort); }
};
function textOf(file) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); }
  catch { throw new Error(t("文件不是有效的 UTF-8 文本")); }
}

function PdfPreview({ bytes, nav }) {
  const container = useRef(null), canvas = useRef(null), [pdf, setPdf] = useState(null);
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [width, setWidth] = useState(600);
  const [error, setError] = useState(""), [busy, setBusy] = useState(true);
  useEffect(() => {
    let disposed = false, task;
    (async () => {
      const engine = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (disposed) return;
      engine.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const assets = new URL(`/pdfjs/${engine.version}/`, location.href).href;
      task = engine.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false, cMapUrl: assets + "cmaps/", cMapPacked: true,
        standardFontDataUrl: assets + "standard_fonts/", wasmUrl: assets + "wasm/", canvasMaxAreaInBytes: 32 * 1024 * 1024 });
      const result = await task.promise;
      if (!disposed) setPdf(result);
    })().catch((e) => { if (!disposed) { setError(e.message); setBusy(false); } });
    return () => { disposed = true; task?.destroy(); };
  }, [bytes]);
  useEffect(() => {
    const observer = new ResizeObserver(() => setWidth(container.current?.clientWidth || 600));
    observer.observe(container.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf) return;
    let disposed = false, render;
    setBusy(true); setError("");
    (async () => {
      const sheet = await pdf.getPage(page); if (disposed) return;
      const natural = sheet.getViewport({ scale: 1 }), scale = Math.min((width - 24) / natural.width, 2) * zoom;
      const viewport = sheet.getViewport({ scale: Math.max(.1, scale) });
      const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const element = canvas.current;
      element.width = Math.ceil(viewport.width * ratio); element.height = Math.ceil(viewport.height * ratio);
      element.style.width = viewport.width + "px"; element.style.height = viewport.height + "px";
      render = sheet.render({ canvasContext: element.getContext("2d"), viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (!disposed) setBusy(false);
    })().catch((e) => { if (!disposed && e.name !== "RenderingCancelledException") { setError(e.message); setBusy(false); } });
    return () => { disposed = true; render?.cancel(); };
  }, [pdf, page, zoom, width]);
  useEffect(() => {
    nav.current = {
      prev: () => setPage((n) => Math.max(1, n - 1)),
      next: () => setPage((n) => Math.min(pdf?.numPages || n, n + 1)),
      first: () => setPage(1),
      last: () => setPage(pdf?.numPages || 1),
    };
    return () => { nav.current = null; };
  }, [pdf, nav]);
  return <div className="preview-pdf" ref={container}>
    <nav className="preview-pdf-controls" aria-label={t("PDF 页面控制")}>
      <button disabled={!pdf || page <= 1} onClick={() => setPage((n) => n - 1)}>{t("上一页")}</button>
      <span>{page} / {pdf?.numPages || "—"}</span>
      <button disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((n) => n + 1)}>{t("下一页")}</button>
      <button className="icon-ghost" title={t("缩小")} aria-label={t("缩小")} disabled={zoom <= .5} onClick={() => setZoom((n) => n - .25)}><ZoomOut size={16} /></button>
      <button className="icon-ghost" title={t("放大")} aria-label={t("放大")} disabled={zoom >= 2} onClick={() => setZoom((n) => n + .25)}><ZoomIn size={16} /></button>
    </nav>
    {busy && <p role="status">{t("正在渲染 PDF…")}</p>}
    {error && <p className="preview-error" role="alert">{error}</p>}
    <div className="preview-pdf-sheet"><canvas ref={canvas} aria-label={t("PDF 第 {page} 页", { page })} /></div>
  </div>;
}

function ResourceImage({ src, alt, read }) {
  const [url, setUrl] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    let disposed = false, created;
    setUrl(""); setError("");
    if (/^data:image\//i.test(src || "")) { setUrl(src); return; }
    read(src).then((file) => {
      if (disposed) return;
      if (file.kind !== "image") throw new Error(t("此资源不是图片"));
      created = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType })); setUrl(created);
    }).catch((e) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; if (created) URL.revokeObjectURL(created); };
  }, [src, read]);
  return error ? <span className="preview-error">{alt}: {error}</span> : <img src={url || undefined} alt={alt || ""} decoding="async" />;
}

export default function FilePreview({ source, onClose }) {
  const ref = useRef(null), frame = useRef(null), titleId = useId();
  const [loaded, setLoaded] = useState(null), [busy, setBusy] = useState(true), [error, setError] = useState(""), [errorStatus, setErrorStatus] = useState(null);
  const [reload, setReload] = useState(0), [path, setPath] = useState(""), [back, setBack] = useState([]), [raw, setRaw] = useState(false), [notes, setNotes] = useState([]);
  const [manifest, setManifest] = useState(null), [refreshing, setRefreshing] = useState(false), [imgZoom, setImgZoom] = useState(false);
  const resources = useRef(null), scope = useRef(null), { copied, copy } = useCopyText();
  const keepRef = useRef(false), loadedRef = useRef(null), retried410 = useRef(null), pdfNav = useRef(null);
  useEffect(() => { loadedRef.current = loaded; }, [loaded]);
  const api = source.environment.api, sessionId = source.sessionId, prefix = `/api/sessions/${encodeURIComponent(sessionId)}/preview`;
  useLayer({ ref, modal: true, outside: false, onClose, initialFocus: ".preview-close" });
  const nativeSafe = !window.DevinNative || window.__DEVIN_NATIVE_PREVIEW_SAFE__ === true;
  useEffect(() => {
    const controller = new AbortController(); let disposed = false;
    // Manual refreshes (and ticket renewals with content on screen) keep the
    // current view; navigation and new sources still show the loading state.
    const keep = keepRef.current && loadedRef.current != null;
    keepRef.current = false;
    setRefreshing(keep);
    if (!keep) { setBusy(true); setError(""); setErrorStatus(null); setLoaded(null); setRaw(false); setNotes([]); setImgZoom(false); }
    const cache = new Map(); let cacheBytes = 0, count = 0, running = 0;
    const waiting = [];
    const state = { controller, read: null };
    resources.current = state;
    (async () => {
      if (source.error) throw new Error(source.error);
      let meta = scope.current?.source === source && scope.current.reload === reload ? scope.current.meta : null;
      if (!meta) {
        try { meta = await timeoutRead((signal) => api.get(`${prefix}?path=${encodeURIComponent(source.path)}`, { signal }), controller.signal); }
        catch (e) { if (e.status === 404 && e.message === "404") throw unsupported(); throw e; }
        if (!meta?.ticket || !meta.kind || typeof meta.path !== "string") throw unsupported();
        if (disposed) return;
        scope.current = { source, reload, meta }; setManifest(meta);
      }
      const read = async (url = "") => {
        const requested = url ? previewResourcePath(url, path || "/report.html") : path;
        if (cache.has(requested)) return cache.get(requested);
        if (++count > 256) throw new Error(t("预览资源过多，请刷新后重试"));
        if (running >= 4) await new Promise((resolve) => waiting.push(resolve));
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        running++;
        try {
          const result = await timeoutRead((signal) => api.file(`${prefix}/${encodeURIComponent(meta.ticket)}/file${requested ? `?path=${encodeURIComponent(requested)}` : ""}`, { signal }), controller.signal);
          if (result.bytes.byteLength <= MAX_CACHE) {
            cache.set(requested, result); cacheBytes += result.bytes.byteLength;
            while (cacheBytes > MAX_CACHE || cache.size > 32) { const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes.byteLength; cache.delete(first); }
          }
          return result;
        } finally { running--; waiting.shift()?.(); }
      };
      state.read = read;
      const file = await read();
      if (!file.kind) throw unsupported();
      const text = textual(file.kind) ? textOf(file) : null;
      if (!disposed) { retried410.current = null; setLoaded({ ...file, text, name: path ? path.split("/").at(-1) : meta.name }); }
    })().catch((e) => {
      // Expired tickets transparently re-open once; only a second failure is shown.
      if (!disposed && e.status === 410 && retried410.current?.key !== path + "|" + source.path) {
        retried410.current = { key: path + "|" + source.path };
        keepRef.current = keep;
        setReload((n) => n + 1);
        return;
      }
      if (!disposed) {
        const message = e.name === "AbortError" ? t("预览读取超时，请刷新重试") : e.message;
        if (keep) setNotes((items) => [...new Set([...items, message])].slice(-4));
        else { setError(message); setErrorStatus(e.status || null); }
      }
    })
      .finally(() => { if (!disposed) { setBusy(false); setRefreshing(false); } });
    return () => { disposed = true; controller.abort(); waiting.splice(0).forEach((resolve) => resolve()); cache.clear(); };
  // manifest is held across within-directory navigation; refreshing replaces it.
  }, [source, path, reload]);
  const read = useCallback((url) => resources.current.read(url), [loaded]);
  const navigate = useCallback((href) => {
    try {
      if (href.startsWith("#")) { const id = decodeURIComponent(href.slice(1)); ref.current?.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView(); return; }
      const next = previewResourcePath(href, path || "/report.html");
      setBack((items) => [...items.slice(-9), path]); setPath(next);
    } catch { setNotes((items) => [...new Set([...items, t("隔离预览不打开外部链接或网络资源")])]); }
  }, [path]);
  const channel = useMemo(() => {
    const bytes = new Uint8Array(18); crypto.getRandomValues(bytes); return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, [loaded, raw]);
  const frameUrl = useMemo(() => loaded?.kind === "html" && !raw ? URL.createObjectURL(new Blob([sandboxHTML(loaded.text, channel, nativeSafe, path || "/report.html")], { type: "text/html" })) : null, [loaded, raw, channel, nativeSafe, path]);
  const imageUrl = useMemo(() => loaded?.kind === "image" ? URL.createObjectURL(new Blob([loaded.bytes], { type: loaded.mimeType })) : null, [loaded]);
  useEffect(() => () => { if (frameUrl) URL.revokeObjectURL(frameUrl); if (imageUrl) URL.revokeObjectURL(imageUrl); }, [frameUrl, imageUrl]);
  useEffect(() => {
    if (!frameUrl) return;
    let disposed = false, messages = 0;
    const readyDeadline = setTimeout(() => setNotes((items) => [...new Set([...items, t("HTML 预览尚未完成，可能缺少资源或被浏览器阻止")])].slice(-4)), 20000);
    const handler = async (event) => {
      const m = event.data;
      if (event.source !== frame.current?.contentWindow || m?.channel !== channel) return;
      if (m.action === "ready") { clearTimeout(readyDeadline); return; }
      if (m.action === "close") onClose();
      else if (m.action === "warning") setNotes((items) => [...new Set([...items, String(m.error).slice(0, 240)])].slice(-4));
      else if (m.action === "link" && typeof m.url === "string") navigate(m.url);
      else if (m.action === "resource" && typeof m.url === "string" && Number.isSafeInteger(m.id)) {
        const target = event.source;
        try {
          if (++messages > 256) throw new Error(t("预览资源过多，请刷新后重试"));
          const result = await read(m.url); if (disposed) return;
          const bytes = result.bytes.slice(0);
          target.postMessage({ channel, action: "resource-result", id: m.id, bytes, mimeType: result.mimeType }, "*", [bytes]);
        } catch (e) { if (!disposed) target.postMessage({ channel, action: "resource-result", id: m.id, error: e.message }, "*"); }
      }
    };
    window.addEventListener("message", handler);
    return () => { disposed = true; clearTimeout(readyDeadline); window.removeEventListener("message", handler); };
  }, [channel, read, navigate, onClose, frameUrl]);
  const markdownComponents = useMemo(() => ({ pre: CodePre,
    img: ({ src, alt }) => <ResourceImage src={src} alt={alt} read={read} />,
    table: ({ node, ...props }) => <div className="tbl-wrap"><table {...props} /></div>,
    a: ({ href, children }) => /^(?:https?:|mailto:)/i.test(href || "") ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> :
      <a href={href} onClick={(event) => { event.preventDefault(); navigate(href); }}>{children}</a>,
  }), [read, navigate]);
  const formatted = useMemo(() => {
    if (loaded?.kind !== "json" || raw) return loaded?.text;
    try { return formatJson(loaded.text); } catch { return loaded.text; }
  }, [loaded, raw]);
  const codeLang = useMemo(() => {
    if (!loaded) return "plaintext";
    const ext = (loaded.name || "").split(".").pop().toLowerCase();
    return { py: "python", sh: "bash", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", xml: "xml", svg: "xml", html: "xml", htm: "xml", sql: "sql", rs: "rust", go: "go", c: "c", h: "c", cpp: "cpp", css: "css", md: "markdown", markdown: "markdown" }[ext] || "plaintext";
  }, [loaded]);
  // Report-directory absolute path: root file for path "", else root dir + the
  // report-relative navigation path (which always carries a leading "/").
  const absPath = manifest ? (path === "" ? manifest.path : manifest.path.replace(/\/[^/]*$/, "") + path) : (path === "" ? source.path : "");
  const downloadOriginal = () => {
    if (!absPath) return;
    downloadFile({ url: rawFileUrl(source.environment, sessionId, absPath), name: fileName(absPath) })
      .catch((e) => setNotes((items) => [...new Set([...items, e.message])].slice(-4)));
  };
  return createPortal(<div className="modal-back file-preview-back">
    <section className="file-preview" ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={(event) => {
      const nav = pdfNav.current;
      if (!nav || (event.target !== event.currentTarget && event.target.closest?.("input,textarea,select,iframe,[contenteditable]"))) return;
      const action = { ArrowLeft: "prev", ArrowRight: "next", PageUp: "prev", PageDown: "next", Home: "first", End: "last" }[event.key];
      if (action) { event.preventDefault(); nav[action](); }
    }}>
      <header className="file-preview-head">
        {back.length > 0 && <button className="icon-ghost" title={t("返回")} aria-label={t("返回")} onClick={() => { setPath(back.at(-1)); setBack((items) => items.slice(0, -1)); }}><ArrowLeft size={18} /></button>}
        <div className="file-preview-title"><strong id={titleId}>{loaded?.name || t("文件预览")}</strong><button type="button" className="file-preview-path" title={t("点击复制路径")} onClick={() => absPath && copy(absPath)}>{source.environment.host ? t("远端") : t("本机")} · {copied === absPath && absPath ? t("已复制") : path || manifest?.path || source.path}</button></div>
        {loaded?.text != null && <><button className="icon-ghost" aria-label={t("复制原文")} title={t("复制原文")} onClick={() => copy(loaded.text)}>{copied === loaded.text ? <Check size={17} /> : <Copy size={17} />}</button>
          <button className={"icon-ghost" + (raw ? " active" : "")} aria-pressed={raw} title={raw ? t("显示预览") : t("显示源码")} aria-label={raw ? t("显示预览") : t("显示源码")} onClick={() => setRaw((value) => !value)}><Code2 size={17} /></button></>}
        <button className="icon-ghost" title={t("下载原文件")} aria-label={t("下载原文件")} disabled={busy} onClick={downloadOriginal}><Download size={17} /></button>
        <button className="icon-ghost" title={t("刷新预览")} aria-label={t("刷新预览")} disabled={busy || refreshing} onClick={() => { keepRef.current = true; setReload((n) => n + 1); }}><RotateCw size={17} className={refreshing ? "spin" : ""} /></button>
        <DialogMaximize target={ref} storageKey="dw.dialogMax.preview" />
        <button className="icon-ghost preview-close" title={t("关闭预览")} aria-label={t("关闭预览")} onClick={onClose}><X size={19} /></button>
      </header>
      {loaded?.kind === "html" && <p className="file-preview-help">{nativeSafe ? t("隔离预览：仅可读取当前报告目录内的资源，外部网络资源不自动加载。") : t("旧版 APK 使用静态预览，请更新 APK 后启用安全的 HTML 交互。")}</p>}
      {!!notes.length && <div className="file-preview-notes" role="status">{notes.map((note) => <div key={note}>{note}</div>)}</div>}
      <div className={"file-preview-body" + (frameUrl ? " html" : "")}>
        {busy ? <div className="file-preview-loading" role="status"><Loader2 size={20} className="spin" />{t("正在读取文件…")}</div> : error ? <div className="preview-error" role="alert">{error}{(errorStatus === 413 || errorStatus === 415) && absPath && <button className="primary preview-download" onClick={downloadOriginal}>{t("下载文件")}</button>}</div> : loaded?.kind === "html" && !raw ?
          <iframe ref={frame} src={frameUrl} sandbox="allow-scripts" referrerPolicy="no-referrer" title={t("隔离报告预览")} allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" /> :
          loaded?.kind === "image" ? <div className={"file-preview-image" + (imgZoom ? " natural" : "")}><img src={imageUrl} alt={loaded.name} onClick={() => setImgZoom((zoomed) => !zoomed)} /></div> :
          loaded?.kind === "pdf" ? <PdfPreview bytes={loaded.bytes} nav={pdfNav} /> :
          loaded?.kind === "markdown" && !raw ? <div className="agent-body file-preview-markdown"><ReactMarkdown remarkPlugins={markdownPlugins} components={markdownComponents}>{loaded.text}</ReactMarkdown></div> :
          loaded && <div className="file-preview-code"><CodePre><code className={"language-" + codeLang}>{formatted}</code></CodePre></div>}
      </div>
      <DialogResize target={ref} />
    </section>
  </div>, document.body);
}
