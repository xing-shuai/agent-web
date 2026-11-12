import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const MiB = 1024 * 1024;
const types = {
  html: ["html", "text/html"], htm: ["html", "text/html"],
  md: ["markdown", "text/markdown"], markdown: ["markdown", "text/markdown"],
  json: ["json", "application/json"], pdf: ["pdf", "application/pdf"],
  png: ["image", "image/png"], jpg: ["image", "image/jpeg"], jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"], webp: ["image", "image/webp"], avif: ["image", "image/avif"],
  svg: ["image", "image/svg+xml"], bmp: ["image", "image/bmp"], ico: ["image", "image/x-icon"],
  css: ["text", "text/css"], js: ["text", "text/javascript"], mjs: ["text", "text/javascript"],
  woff: ["font", "font/woff"], woff2: ["font", "font/woff2"], ttf: ["font", "font/ttf"], otf: ["font", "font/otf"],
};
for (const ext of ["txt", "log", "csv", "tsv", "jsonl", "yaml", "yml", "xml", "py", "sh", "ts", "tsx", "jsx", "c", "cpp", "h", "rs", "go", "sql"])
  types[ext] = ["text", "text/plain"];
const fail = (status, message) => Object.assign(new Error(message), { status });
const inside = (root, file) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
const hidden = (relative) => relative.split(/[\\/]/).some((part) => part.startsWith("."));
function describe(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = types[ext] || (/^(?:readme|license|notice|dockerfile)$/i.test(path.basename(file)) ? ["text", "text/plain"] : null);
  if (!type || type[0] === "font") throw fail(415, "暂不支持此文件类型的预览");
  return { kind: type[0], mimeType: type[1], name: path.basename(file) };
}

/** Read-only, bounded report scopes. Tickets are NOT credentials: every route
 * still requires the normal API authentication. They never enter report HTML. */
export class FilePreviews {
  constructor({ ttl = 15 * 60_000, maxEntries = 64 } = {}) { this.entries = new Map(); this.ttl = ttl; this.maxEntries = maxEntries; this.reading = 0; }
  prune() {
    for (const [id, entry] of this.entries) if (entry.expires < Date.now()) this.entries.delete(id);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
  }
  async open(sessionId, cwd, requested) {
    if (typeof requested !== "string" || !requested || requested.includes("\0") || requested.length > 8192) throw fail(400, "文件路径无效");
    if (!path.isAbsolute(requested) && !cwd) throw fail(409, "会话目录不可用，请等待会话加载完成");
    const file = await fs.realpath(path.resolve(cwd || "/", requested));
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw fail(415, "不支持目录或特殊文件预览");
    const info = describe(file);
    if (path.dirname(file) === path.parse(file).root) throw fail(403, "请将报告放在独立目录内后再预览");
    if (stat.size > (info.kind === "pdf" || info.kind === "image" ? 32 : 2) * MiB) throw fail(413, "文件过大，超出预览大小限制");
    this.prune();
    const ticket = randomBytes(24).toString("base64url");
    this.entries.set(ticket, { sessionId, file, root: path.dirname(file), expires: Date.now() + this.ttl });
    return { ...info, ticket, path: file, size: stat.size };
  }
  async read(sessionId, ticket, requested = "") {
    const entry = this.entries.get(ticket);
    if (!entry || entry.sessionId !== sessionId || entry.expires < Date.now()) throw fail(410, "预览已过期，请刷新重新打开");
    if (typeof requested !== "string" || requested.includes("\0") || requested.length > 8192) throw fail(400, "资源路径无效");
    // Browser report URLs have a dummy origin. Leading /assets/... is relative
    // to this report directory, not to the application or the server account.
    let candidate = entry.file;
    if (requested) {
      candidate = path.isAbsolute(requested) && inside(entry.root, requested) ? requested : path.resolve(entry.root, requested.replace(/^[/\\]+/, ""));
      if (!inside(entry.root, candidate) || hidden(path.relative(entry.root, candidate))) throw fail(403, "预览只能读取当前报告目录内的非隐藏资源");
    }
    const file = await fs.realpath(candidate);
    if (!inside(entry.root, file) || (requested && hidden(path.relative(entry.root, file)))) throw fail(403, "资源超出了报告目录，或指向隐藏文件");
    const ext = path.extname(file).slice(1).toLowerCase(), type = types[ext];
    const info = type?.[0] === "font" ? { kind: "font", mimeType: type[1], name: path.basename(file) } : describe(file);
    const limit = (requested ? 8 : info.kind === "pdf" || info.kind === "image" ? 32 : 2) * MiB;
    if (this.reading >= 8) throw fail(429, "同时读取的预览资源过多，请稍后重试");
    this.reading++;
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      // Pin the opened Linux descriptor too, so replacing a parent directory
      // with a symlink between realpath() and open() cannot widen the scope.
      if (process.platform === "linux" && !inside(entry.root, await fs.realpath(`/proc/self/fd/${handle.fd}`)))
        throw fail(403, "资源超出了报告目录");
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail(415, "不支持目录或特殊文件预览");
      if (stat.size > limit) throw fail(413, "文件过大，超出预览大小限制");
      // Bound the read even if another process grows the file after stat().
      const buffer = Buffer.alloc(stat.size + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size) throw fail(409, "文件正在变化，请稍后刷新预览");
      entry.expires = Date.now() + this.ttl;
      return { ...info, data: buffer.subarray(0, length) };
    } finally { try { await handle?.close(); } finally { this.reading--; } }
  }
}

export function filePreviewRoutes(app, hubFor) {
  const previews = new FilePreviews();
  const error = (res, e) => res.status(e.status || (["ENOENT", "ENOTDIR"].includes(e.code) ? 404 : ["EACCES", "EPERM", "ELOOP"].includes(e.code) ? 403 : 500))
    .set("Cache-Control", "no-store").json({ error: e.status ? e.message : ["ENOENT", "ENOTDIR"].includes(e.code) ? "文件不存在或已被移动" : ["EACCES", "EPERM", "ELOOP"].includes(e.code) ? "没有读取此文件的权限" : "读取预览文件失败" });
  app.get("/api/sessions/:id/preview", async (req, res) => {
    try {
      const h = hubFor(req.params.id), live = h.sessions.get(req.params.id), saved = h.state.sessions[req.params.id];
      if (!live && !saved) throw fail(404, "会话不可用，请重新打开会话");
      const cwd = live?.cwd || saved?.cwd;
      res.set("Cache-Control", "no-store").json(await previews.open(req.params.id, cwd, req.query.path));
    } catch (e) { error(res, e); }
  });
  app.get("/api/sessions/:id/preview/:ticket/file", async (req, res) => {
    try {
      const file = await previews.read(req.params.id, req.params.ticket, req.query.path || "");
      res.set({ "Content-Type": file.mimeType, "X-Preview-Kind": file.kind, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'" }).end(file.data);
    } catch (e) { error(res, e); }
  });
  return previews;
}
