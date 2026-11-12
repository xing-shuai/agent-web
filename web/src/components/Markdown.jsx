import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download } from "lucide-react";
import CodePre from "./CodePre.jsx";
import { fileLink, previewable, fileName } from "../filePreview.js";
import { downloadFile, rawFileUrl } from "../download.js";
import { useEnvironment } from "../environmentContext.js";
import { splitStreamingMarkdown, StreamingTailContext } from "../markdownBlocks.js";
import { t } from "../i18n.js";

const FilePreviewContext = React.createContext(null);
const previewUrlTransform = (url, key) => key === "href" && fileLink(url) ? url : defaultUrlTransform(url);

// Files the preview backend cannot render (archives, binaries, …) download
// through the session raw route instead of opening a guaranteed 415 preview.
function DownloadLink({ link, title, sessionId, children }) {
  const env = useEnvironment();
  const mounted = useRef(true), timers = useRef([]);
  const [status, setStatus] = useState(null);
  useEffect(() => () => { mounted.current = false; timers.current.forEach(clearTimeout); }, []);
  const name = fileName(link.path);
  const url = rawFileUrl(env, link.sessionId || sessionId, link.path);
  const download = async (event) => {
    event.preventDefault();
    const busy = setTimeout(() => { if (mounted.current) setStatus("busy"); }, 300);
    let failed = false;
    try { await downloadFile({ url, name }); }
    catch (e) {
      failed = true;
      setStatus(e.message);
      timers.current.push(setTimeout(() => { if (mounted.current) setStatus((s) => s === "busy" ? s : null); }, 6000));
    } finally {
      clearTimeout(busy);
      setStatus((s) => failed ? s : null);
    }
  };
  return <>
    <a href={url} download={name} title={title} onClick={download}><Download size={12} />{children}</a>
    {status && <span className="md-download-status" role={status === "busy" ? "status" : "alert"}>{status === "busy" ? t("正在下载…") : status}</span>}
  </>;
}

function MdLink({ href, children, title }) {
  const open = useContext(FilePreviewContext), link = fileLink(href);
  const env = useEnvironment(), sessionId = useContext(ImgSessionCtx);
  if (link && !link.path.endsWith("/") && !previewable(link.path)) {
    if (link.host !== undefined && link.host !== env.host)
      return <a href={href} title={title || t("文件链接不属于当前主机环境")} target="_blank" rel="noopener noreferrer">{children}</a>;
    if (link.sessionId || sessionId) return <DownloadLink link={link} title={title} sessionId={sessionId}>{children}</DownloadLink>;
  }
  return <a href={href} title={title} {...(link && open ? { "data-file-preview": true, onClick: (event) => { event.preventDefault(); open(link); } } : href?.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{children}</a>;
}
const md = [remarkGfm];
const hl = []; // Block coloring is lazy and off-thread in CodePre.

// Session id for markdown image resolution — relative images like shots/a.png
// goes through /api/sessions/<id>/raw against the session cwd.
const ImgSessionCtx = React.createContext(null);

function MdImg({ node, src, alt, ...props }) {
  const { withToken } = useEnvironment();
  const sid = React.useContext(ImgSessionCtx);
  const [fallback, setFallback] = useState(false);
  if (!src) return null;
  let u = src;
  if (/^(data:|blob:|https?:)/i.test(u)) {
    // external/embedded — keep as-is
  } else if (u.startsWith("/api/")) {
    u = withToken(u);
  } else if (fallback || !u.startsWith("/")) {
    // Relative path (or web-path fallback): serve the workspace file via the
    // session raw endpoint — the file lives on disk, not in the web bundle.
    u = withToken(`/api/sessions/${sid}/raw?path=${encodeURIComponent(src)}`);
  }
  // A leading "/" src tries the web root first; onError retries as an
  // absolute filesystem path via the raw endpoint.
  return (
    <img
      src={u}
      alt={alt || ""}
      {...props}
      onError={fallback ? undefined : () => setFallback(true)}
    />
  );
}

const mdComponents = {
  pre: CodePre,
  a: MdLink,
  img: MdImg,
  table: ({ node, ...props }) => (
    <div className="tbl-wrap">
      <table {...props} />
    </div>
  ),
};

export { FilePreviewContext, ImgSessionCtx };

export function MarkdownBody({ text }) {
  return <ReactMarkdown remarkPlugins={md} rehypePlugins={hl} components={mdComponents} urlTransform={previewUrlTransform}>{text}</ReactMarkdown>;
}

const CACHE_ENTRIES = 256, CACHE_CHARS = 1_000_000, CACHE_ITEM = 200_000;
const markdownCache = new Map();
let markdownCacheChars = 0;

export function clearMarkdownCache() {
  markdownCache.clear();
  markdownCacheChars = 0;
}

/** Synchronous ReactMarkdown call — same options as MarkdownBody, but the
 * element tree is returned for embedding and bounded reuse by source text. */
export function renderMarkdown(text, { cache = true } = {}) {
  if (cache && text.length <= CACHE_ITEM) {
    const hit = markdownCache.get(text);
    if (hit) {
      markdownCache.delete(text);
      markdownCache.set(text, hit);
      return hit;
    }
  }
  const element = ReactMarkdown({ children: text, remarkPlugins: md, rehypePlugins: hl, components: mdComponents, urlTransform: previewUrlTransform });
  if (!cache || text.length > CACHE_ITEM) return element;
  markdownCache.set(text, element);
  markdownCacheChars += text.length;
  while (markdownCache.size > CACHE_ENTRIES || markdownCacheChars > CACHE_CHARS) {
    const oldest = markdownCache.keys().next();
    if (oldest.done) break;
    markdownCache.delete(oldest.value);
    markdownCacheChars -= oldest.value.length;
  }
  return element;
}

const MarkdownBlock = React.memo(function MarkdownBlock({ text, tail }) {
  return <StreamingTailContext.Provider value={tail}>{renderMarkdown(text, { cache: !tail })}</StreamingTailContext.Provider>;
});

/** Streaming text re-parses only the growing tail block; committed prefix
 * blocks stay memoized and are never remounted when the stream finishes. */
export function AgentMarkdown({ text, streaming = false }) {
  const blockMode = useRef(false);
  if (streaming) blockMode.current = true;
  const blocks = useMemo(() => blockMode.current ? splitStreamingMarkdown(text) : null, [text, blockMode.current]);
  if (!blocks) return renderMarkdown(text);
  // remark-rehype separates top-level nodes with a "\n" text node; joining
  // the blocks the same way keeps the concatenation identical to one parse.
  let offset = 0;
  const out = [];
  blocks.forEach((block, index) => {
    const start = offset;
    offset += block.length;
    if (index) out.push("\n");
    out.push(<MarkdownBlock key={start} text={block} tail={streaming && index === blocks.length - 1} />);
  });
  return out;
}
