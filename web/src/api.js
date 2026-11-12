import { HISTORY_ENCODING, HISTORY_ENCODING_V2, unpackHistory } from "../../server/src/history-wire.js";
import { t } from "./i18n.js";
// REST + WebSocket client for the devin-web backend.

// Optional auth token: passed once as ?token=XXX in the page URL, then kept
// in sessionStorage and sent as `x-devin-token` (REST) / `?token=` (WS).
const _tok = new URLSearchParams(location.search).get("token");
if (_tok) sessionStorage.setItem("devin-web-token", _tok);
const TOKEN = _tok || sessionStorage.getItem("devin-web-token") || "";
const authHeaders = TOKEN ? { "x-devin-token": TOKEN } : {};

// Every pane targets one execution environment; `?remote=` seeds the focused
// pane's host. A pane bound to an unknown/disconnected host fails closed —
// its scope never falls back to local execution.
export const initialHost = new URLSearchParams(location.search).get("remote") || "";

export function environmentUrl(hostId) {
  const url = new URL(location.href);
  if (hostId) url.searchParams.set("remote", hostId); else url.searchParams.delete("remote");
  url.hash = ""; return url.href;
}
const apiError = (r, j) => Object.assign(new Error(j.error || `${r.status}`), { status: r.status, code: j.code, fingerprint: j.fingerprint, outcomeUnknown: !!j.outcomeUnknown });

const environments = new Map();
export function environment(host = "") {
  host = host || "";
  let env = environments.get(host);
  if (!env) { env = makeEnvironment(host); environments.set(host, env); }
  return env;
}

function makeEnvironment(host) {
  const storageKey = (key) => host ? `${key}@${host}` : key;
  const scopedPath = (path) => host && path.startsWith("/api/") && !path.startsWith("/api/remotes")
    ? `/api/remotes/${encodeURIComponent(host)}/proxy${path}` : path;
  const request = async (path, options = {}) => {
    const r = await fetch(scopedPath(path), { ...options, headers: { ...authHeaders, ...options.headers } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw apiError(r, j);
    return j;
  };
  const api = {
    get: (path, opts) => request(path, opts),
    file: async (path, { maxBytes = 32 * 1024 * 1024, ...opts } = {}) => {
      const response = await fetch(scopedPath(path), { ...opts, headers: { ...authHeaders, ...opts.headers } });
      if (!response.ok) throw apiError(response, await response.json().catch(() => ({})));
      const tooLarge = () => Object.assign(new Error(t("文件过大，超出预览大小限制")), { status: 413 });
      if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw tooLarge(); }
      let bytes;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = []; let length = 0;
        try {
          for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength;
            if (length > maxBytes) { await reader.cancel(); throw tooLarge(); } chunks.push(value); }
        } finally { reader.releaseLock(); }
        const joined = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
        bytes = joined.buffer;
      } else { bytes = await response.arrayBuffer(); if (bytes.byteLength > maxBytes) throw tooLarge(); }
      return { bytes, mimeType: response.headers.get("content-type") || "application/octet-stream", kind: response.headers.get("x-preview-kind") };
    },
    post: (path, body, opts = {}) => request(path, { ...opts, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    del: (path) => request(path, { method: "DELETE" }),
  };

  /** Bounded destructive request/verification; abort is NOT proof of rollback. */
  async function boundedRequest(path, options, timeoutMs) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(scopedPath(path), { ...options, signal: controller.signal,
            headers: { ...authHeaders, ...options.headers } });
          const data = await response.json();
          if (!response.ok) throw apiError(response, data);
          return data;
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { reject(new Error(t("请求超时，结果尚未确认"))); controller.abort(); }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  /** Never retry DELETE after an uncertain response. Poll worker receipts only. */
  async function deleteSessionsVerified(ids, { requestTimeoutMs = 15000, checkTimeoutMs = 5000,
    verificationTimeoutMs = 20000, pollIntervalMs = 500, onProgress = () => {} } = {}) {
    ids = [...new Set(ids)];
    if (!ids.length) return;
    if (ids.length > 500) throw new Error(t("一次最多删除 500 个会话，请缩小选择范围"));
    const deleted = new Set(); let unsupported = false;
    try {
      const result = await boundedRequest(ids.length === 1 ? `/api/sessions/${encodeURIComponent(ids[0])}` : "/api/sessions/batch-delete", {
        method: ids.length === 1 ? "DELETE" : "POST", headers: { "Content-Type": "application/json" },
        ...(ids.length === 1 ? {} : { body: JSON.stringify({ ids }) }),
      }, requestTimeoutMs);
      // An empty/legacy 200 is not proof of deletion: old workers acknowledged
      // before unlinking and swallowed failures. Require a verified final receipt.
      if (result.status === "deleted") return;
    } catch (error) {
      if (error.status && error.status < 500 && !error.outcomeUnknown) throw error;
    }
    onProgress();
    const until = Date.now() + verificationTimeoutMs;
    while (Date.now() < until) {
      try {
        const result = await boundedRequest("/api/sessions/delete-status", { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }),
        }, Math.min(checkTimeoutMs, Math.max(1, until - Date.now())));
        const results = result.sessions || [];
        for (const row of results) if (ids.includes(row.sessionId) && row.status === "deleted") deleted.add(row.sessionId);
        if (deleted.size === ids.length) return;
        const failed = results.find((row) => ids.includes(row.sessionId) && row.status === "failed");
        if (failed) throw Object.assign(new Error(failed.error || t("远端删除失败")), { code: "DELETE_FAILED", deletedIds: [...deleted] });
      } catch (error) {
        if (error.code === "DELETE_FAILED") throw error;
        if (error.status === 404) { unsupported = true; break; } // old worker cannot safely verify
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, until - Date.now()))));
    }
    throw Object.assign(new Error((unsupported ? t("当前环境后端不支持删除结果核对，需要更新对应组件。") : "") + t("删除结果暂时无法确认，已停止等待且不会重复删除。请稍后刷新核对；关闭弹窗不会撤销已发送的请求。")),
      { code: "DELETE_RESULT_UNKNOWN", outcomeUnknown: true, deletedIds: [...deleted] });
  }

  /** Append the auth token to an /api URL so <img> tags (which can't send
   *  headers) still pass the optional token check. No-op when no token set. */
  function withToken(url) {
    if (!url || !url.startsWith("/api/")) return url;
    url = scopedPath(url);
    if (!TOKEN) return url;
    return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
  }

  function websocketUrl(path, params = {}) {
    if (host && ["/ws", "/ws/terminal"].includes(path)) path = `/ws/remotes/${encodeURIComponent(host)}${path === "/ws/terminal" ? "/terminal" : ""}`;
    const url = new URL(path, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    if (TOKEN) url.searchParams.set("token", TOKEN);
    return url.href;
  }

  let ws = null;
  return {
    host, storageKey, scopedPath, api, withToken, websocketUrl, deleteSessionsVerified,
    // Lazily created on first access; `release` drops it so a later `ws`
    // builds a fresh client for the same host.
    get ws() { return ws ||= new WsClient(websocketUrl); },
    release() { ws?.close(); ws = null; },
  };
}

// Host administration (/api/remotes) always stays on the local control plane.
export const controlApi = environment("").api;

/**
 * Auto-reconnecting WebSocket, one per in-use host. One connection carries
 * all session-scoped traffic; messages are routed by `type`.
 */
class WsClient {
  constructor(urlFor) {
    this.urlFor = urlFor;
    this.ws = null;
    this.handlers = new Map(); // type -> Set<fn>
    this.subscriptions = new Map();
    this.historyTokens = new Map();
    this.historyResync = new Set();
    this.open = false;
    this.closed = false;
    this.onOpen = null; // invoked on every (re)connect for re-subscribing
    this.onStatus = null;
    this.#connect();

    // Phones kill the socket when the screen sleeps — reconnect the moment
    // the page becomes visible / the network comes back, instead of waiting
    // out the retry timer.
    this._wake = () => {
      if (this.closed) return;
      if (!this.ws || this.ws.readyState > 1) {
        clearTimeout(this._t);
        this.#connect();
      }
    };
    this._onVisible = () => {
      if (document.visibilityState === "visible") this._wake();
    };
    document.addEventListener("visibilitychange", this._onVisible);
    window.addEventListener("online", this._wake);
  }

  #connect() {
    if (this.closed) return;
    const url = this.urlFor("/ws");
    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.#retry();
    }
    this.ws = ws;

    ws.onopen = () => {
      if (ws !== this.ws) return ws.close();
      this.open = true;
      this.connectionId = `${Date.now()}-${Math.random()}`; // Tree history fences are connection-local.
      this.onStatus?.(true);
      this.onOpen?.();
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "session_update") this.historyTokens.delete(msg.sessionId);
      if (msg.type === "history") {
        if (msg.historyEncoding === HISTORY_ENCODING_V2 && (!Number.isSafeInteger(msg.gen) || msg.gen < 0 ||
            typeof msg.historyToken !== "string" || !msg.historyToken || !Number.isSafeInteger(msg.historyLength) || msg.historyLength < 0 ||
            (msg.delta && msg.unchanged) || (!msg.delta && !msg.unchanged && msg.historyLength !== msg.events?.length))) {
          this.requestHistory(msg.sessionId, true); return;
        }
        if (msg.unchanged && (typeof msg.historyToken !== "string" || !msg.historyToken || this.historyTokens.get(msg.sessionId) !== msg.historyToken)) { this.requestHistory(msg.sessionId); return; }
        if (msg.delta && (msg.historyEncoding !== HISTORY_ENCODING_V2 || !msg.historyBaseToken ||
            this.subscriptions.get(msg.sessionId)?.historyBaseToken !== msg.historyBaseToken || !msg.historyToken ||
            !Number.isSafeInteger(msg.historyBaseLength) || msg.historyBaseLength < 0 || !Array.isArray(msg.events) ||
            msg.historyLength !== msg.historyBaseLength + msg.events.length)) { this.requestHistory(msg.sessionId); return; }
        if (!msg.unchanged && !Array.isArray(msg.events)) { this.requestHistory(msg.sessionId, true); return; }
        try { unpackHistory(msg); }
        catch { this.requestHistory(msg.sessionId, true); return; }
        this.historyResync.delete(msg.sessionId);
        if (!msg.historyToken) this.historyTokens.delete(msg.sessionId);
      }
      if (msg.type === "session_deleted") this.historyTokens.delete(msg.sessionId);
      if (msg.type === "hello") this.hello = msg;
      const set = this.handlers.get(msg.type);
      if (set) for (const fn of set) fn(msg);
      const all = this.handlers.get("*");
      if (all) for (const fn of all) fn(msg);
      if (msg.type === "history" && msg.historyToken && this.subscriptions.has(msg.sessionId) && !this.historyResync.has(msg.sessionId)) {
        this.historyTokens.delete(msg.sessionId); this.historyTokens.set(msg.sessionId, msg.historyToken);
        if (msg.historyFormat === HISTORY_ENCODING_V2 || msg.historyEncoding === HISTORY_ENCODING_V2)
          this.subscriptions.get(msg.sessionId).historyBaseToken = msg.historyToken;
        while (this.historyTokens.size > 512) this.historyTokens.delete(this.historyTokens.keys().next().value);
      }
    };
    ws.onclose = () => {
      // A stale socket's close must not mark the live connection dead or
      // spawn a second retry loop — only react to our own socket dying.
      if (ws !== this.ws) return;
      this.open = false;
      this.historyResync.clear();
      this.onStatus?.(false);
      this.#retry();
    };
    ws.onerror = () => {
      if (ws !== this.ws) return;
      ws.close();
    };
  }

  #retry() {
    if (this.closed) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => this.#connect(), 2000);
  }

  close() {
    this.closed = true;
    this.subscriptions.clear(); this.historyTokens.clear(); this.historyResync.clear();
    clearTimeout(this._t);
    document.removeEventListener("visibilitychange", this._onVisible);
    window.removeEventListener("online", this._wake);
    this.open = false;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  requestHistory(sessionId, legacy = false) {
    const subscription = this.subscriptions.get(sessionId);
    if (!subscription || this.historyResync.has(sessionId)) return false;
    this.historyResync.add(sessionId); this.historyTokens.delete(sessionId);
    return this.send({ ...subscription, historyToken: null, historyBaseToken: null, ...(legacy ? { historyEncoding: null } : {}) });
  }

  send(msg) {
    if (msg.type === "subscribe") {
      const historyBaseToken = msg.historyBaseToken === undefined ? this.subscriptions.get(msg.sessionId)?.historyBaseToken || null : msg.historyBaseToken;
      this.subscriptions.set(msg.sessionId, { type: "subscribe", sessionId: msg.sessionId, cwd: msg.cwd, historyBaseToken });
      if (typeof msg.historyToken === "string") this.historyTokens.set(msg.sessionId, msg.historyToken);
      // Old workers read only historyEncoding; keep v1 as their fallback.
      // New workers pick v2 from the preference list without another roundtrip.
      msg = { ...msg, historyEncoding: msg.historyEncoding === null ? null : HISTORY_ENCODING,
        historyEncodings: msg.historyEncoding === null ? [] : [HISTORY_ENCODING_V2, HISTORY_ENCODING],
        historyBaseToken, historyToken: msg.historyToken === undefined ? this.historyTokens.get(msg.sessionId) || null : msg.historyToken };
    } else if (msg.type === "unsubscribe") {
      this.subscriptions.delete(msg.sessionId); this.historyResync.delete(msg.sessionId);
    }
    const data = JSON.stringify(msg);
    if (this.open && this.ws.readyState === 1) {
      try { this.ws.send(data); return true; } catch { return false; }
    }
    return false;
  }
}
