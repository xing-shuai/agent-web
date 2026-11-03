// REST + WebSocket client for the devin-web backend.

// Optional auth token: passed once as ?token=XXX in the page URL, then kept
// in sessionStorage and sent as `x-devin-token` (REST) / `?token=` (WS).
const _tok = new URLSearchParams(location.search).get("token");
if (_tok) sessionStorage.setItem("devin-web-token", _tok);
const TOKEN = _tok || sessionStorage.getItem("devin-web-token") || "";
const authHeaders = TOKEN ? { "x-devin-token": TOKEN } : {};

const api = {
  async get(path) {
    const r = await fetch(path, { headers: authHeaders });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  },
  async del(path) {
    const r = await fetch(path, { method: "DELETE", headers: authHeaders });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `${r.status}`);
    return j;
  },
};

export default api;

/** Append the auth token to an /api URL so <img> tags (which can't send
 *  headers) still pass the optional token check. No-op when no token set. */
export function withToken(url) {
  if (!TOKEN || !url || !url.startsWith("/api/")) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(TOKEN);
}

/**
 * Singleton WebSocket with auto-reconnect. One connection carries all
 * session-scoped traffic; messages are routed by `type`.
 */
class WsClient {
  constructor() {
    this.ws = null;
    this.handlers = new Map(); // type -> Set<fn>
    this.queue = [];
    this.open = false;
    this.onOpen = null; // invoked on every (re)connect for re-subscribing
    this.onStatus = null;
    this.#connect();

    // Phones kill the socket when the screen sleeps — reconnect the moment
    // the page becomes visible / the network comes back, instead of waiting
    // out the retry timer.
    const wake = () => {
      if (!this.ws || this.ws.readyState > 1) {
        clearTimeout(this._t);
        this.#connect();
      }
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wake();
    });
    window.addEventListener("online", wake);
  }

  #connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""}`;
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
      this.onStatus?.(true);
      for (const m of this.queue) ws.send(m);
      this.queue = [];
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
      const set = this.handlers.get(msg.type);
      if (set) for (const fn of set) fn(msg);
      const all = this.handlers.get("*");
      if (all) for (const fn of all) fn(msg);
    };
    ws.onclose = () => {
      // A stale socket's close must not mark the live connection dead or
      // spawn a second retry loop — only react to our own socket dying.
      if (ws !== this.ws) return;
      this.open = false;
      this.onStatus?.(false);
      this.#retry();
    };
    ws.onerror = () => {
      if (ws !== this.ws) return;
      ws.close();
    };
  }

  #retry() {
    clearTimeout(this._t);
    this._t = setTimeout(() => this.#connect(), 2000);
  }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.handlers.get(type)?.delete(fn);
  }

  send(msg) {
    const data = JSON.stringify(msg);
    if (this.open && this.ws.readyState === 1) this.ws.send(data);
    else this.queue.push(data);
  }
}

export const wsClient = new WsClient();
