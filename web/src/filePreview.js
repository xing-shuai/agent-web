const extensions = /\.(?:html?|md|markdown|pdf|png|jpe?g|gif|webp|avif|svg|bmp|ico|jsonl?|txt|log|csv|tsv|ya?ml|xml|[cm]?js|[jt]sx?|py|sh|sql|rs|go|c|cpp|h)(?:[?#]|$)/i;

/** Only filesystem links, not arbitrary websites or application routes. */
export function fileLink(href) {
  if (typeof href !== "string" || !href || href.startsWith("#") || /[\0\r\n]/.test(href)) return null;
  try {
    if (/^file:/i.test(href)) {
      const url = new URL(href);
      if (url.host && url.host !== "localhost") return null;
      return { path: decodeURIComponent(url.pathname) };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return null;
    if (href.startsWith("/api/")) {
      const url = new URL(href, "https://report-preview.invalid");
      const match = url.pathname.match(/^\/api\/(?:remotes\/([^/]+)\/proxy\/api\/)?sessions\/([^/]+)\/raw$/);
      return match && url.searchParams.get("path") ? { path: url.searchParams.get("path"), sessionId: decodeURIComponent(match[2]), ...(match[1] ? { host: decodeURIComponent(match[1]) } : {}) } : null;
    }
    const raw = href.split(/[?#]/, 1)[0];
    if (/^\/[^/]+\.apk$/i.test(raw)) return null; // App installer downloads are not report previews.
    if ((href.startsWith("/") && raw !== "/") || extensions.test(href) || /^(?:\.\/)?(?:README|LICENSE|NOTICE|Dockerfile)$/i.test(raw)) return { path: decodeURIComponent(raw) };
  } catch { /* malformed URLs remain ordinary non-preview links */ }
  return null;
}

export function fileName(path) {
  return String(path || "").split(/[?#]/, 1)[0].split("/").pop() || "";
}

// Mirrors the extensions server/src/file-preview.js describe() accepts; other
// file links are offered as downloads instead of a guaranteed 415 preview.
const previewableExtensions = new Set(["html", "htm", "md", "markdown", "json", "pdf", "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "bmp", "ico", "css", "js", "mjs", "txt", "log", "csv", "tsv", "jsonl", "yaml", "yml", "xml", "py", "sh", "ts", "tsx", "jsx", "c", "cpp", "h", "rs", "go", "sql"]);
export function previewable(path) {
  const base = fileName(path);
  const dot = base.lastIndexOf(".");
  return (dot > 0 && previewableExtensions.has(base.slice(dot + 1).toLowerCase())) || /^(?:readme|license|notice|dockerfile)$/i.test(base);
}

export const PREVIEW_ORIGIN = "https://report-preview.invalid";
export function previewResourcePath(href, base = "/report.html") {
  const url = new URL(href, PREVIEW_ORIGIN + base);
  if (url.origin !== PREVIEW_ORIGIN || url.username || url.password) throw new Error("External resources are disabled");
  return decodeURIComponent(url.pathname);
}

// Format whitespace only: JSON.parse/stringify would round large integers and
// collapse duplicate keys, changing the contents of a model-generated report.
export function formatJson(text) {
  JSON.parse(text);
  const parts = []; let depth = 0, quoted = false, escaped = false, previous = "", size = 0;
  const push = (value) => { size += value.length; if (size > 4 * 1024 * 1024) throw new Error("Formatted JSON is too large"); parts.push(value); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { push(c); if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') { quoted = false; previous = c; } continue; }
    if (c === '"') { quoted = true; push(c); }
    else if (/\s/.test(c)) continue;
    else if (c === "{" || c === "[") {
      if (++depth > 100) throw new Error("JSON nesting is too deep");
      push(c); let j = i + 1; while (/\s/.test(text[j] || "x")) j++;
      if (text[j] !== (c === "{" ? "}" : "]")) push("\n" + "  ".repeat(depth));
    } else if (c === "}" || c === "]") { depth--; if (previous !== "{" && previous !== "[") push("\n" + "  ".repeat(depth)); push(c); }
    else if (c === ",") push(",\n" + "  ".repeat(depth));
    else push(c === ":" ? ": " : c);
    previous = c;
  }
  return parts.join("");
}
