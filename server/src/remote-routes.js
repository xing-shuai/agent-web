import { HISTORY_COMPRESSION } from "./history-wire.js";
import { isIPv4 } from "node:net";
import { pipeline } from "node:stream";
import { WebSocketServer } from "ws";
import { terminalAccess } from "./terminals.js";
import { remoteError } from "./remote-hosts.js";

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const proxyHeaders = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];

function privateHttpOrigin(authority) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::([1-9]\d{0,4}))?$/.exec(authority || "");
  if (!match || !isIPv4(match[1]) || Number(match[2] || 80) > 65535) return null;
  const [a, b] = match[1].split(".").map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return null;
  return new URL(`http://${authority}`).origin;
}

// Explicit risk acceptance for a LAN entry forwarded directly over SSH. The
// backend sees the tunnel's loopback peer, not the phone's IP. This is an exact
// Host/Origin allowlist, NOT proof that the browser itself is inside the LAN.
function insecureLanEntry(req, entries) {
  if (!entries || !loopback.has(req.socket.remoteAddress) || proxyHeaders.some((name) => req.headers[name] !== undefined)) return false;
  const origin = privateHttpOrigin(req.headers.host);
  const allowed = entries.split(",").map((entry) => privateHttpOrigin(entry.trim()));
  if (!origin || !allowed.includes(origin)) return false;
  return !req.headers.origin || req.headers.origin === origin;
}

export function remoteAccess(req, token, origins = [], trustedProxy = process.env.DEVIN_WEB_TRUST_PROXY || "", insecureHttpHosts = process.env.DEVIN_WEB_INSECURE_REMOTE_HTTP_HOSTS || "") {
  if (!token) return { status: 503, error: "SSH 远程开发必须配置 DEVIN_WEB_TOKEN" };
  const denied = terminalAccess(req, token, origins);
  if (denied) return denied;
  const directLocal = !terminalAccess(req, "", origins);
  const trusted = trustedProxy.split(",").map((x) => x.trim()).filter(Boolean);
  const proxy = trusted.includes(req.socket.remoteAddress) || (trusted.includes("loopback") && loopback.has(req.socket.remoteAddress));
  if (!directLocal && !req.socket.encrypted && !(proxy && req.headers["x-forwarded-proto"] === "https") && !insecureLanEntry(req, insecureHttpHosts))
    return { status: 403, error: "远程主机与 SSH 凭据访问需要 HTTPS；反向代理须显式配置 DEVIN_WEB_TRUST_PROXY" };
  return null;
}

const allowedPath = (pathname) => /^\/api\/(?:health|agents|state|account\/usage|terminal|workspaces|fs\/(?:browse|search|mkdir)|sessions(?:\/[^?#]*)?)(?:\?|$)/.test(pathname);
export const sanitizePath = (value) => {
  const url = new URL(value, "http://localhost");
  url.searchParams.delete("token");
  if (!allowedPath(url.pathname + url.search)) throw remoteError("不支持的远程 API", 404);
  return url.pathname + url.search;
};

export function remoteRoutes(app, manager, { token, origins = [], proxyTimeoutMs = 30000 }) {
  app.use("/api/remotes", (req, res, next) => {
    const denied = remoteAccess(req, token, origins);
    if (denied) return res.status(denied.status).json({ error: denied.error });
    next();
  });
  const action = (handler) => async (req, res) => {
    try { res.json(await handler(req)); }
    catch (error) { if (!res.headersSent) res.status(error.status || 502).json({ error: error.message, code: error.code, fingerprint: error.fingerprint }); }
  };
  app.get("/api/remotes", action(() => ({ hosts: manager.list(), keyConfigured: !!manager.store.key })));
  app.post("/api/remotes", action((req) => { manager.store.add(req.body); return { hosts: manager.list() }; }));
  app.post("/api/remotes/:id", action((req) => {
    manager.store.update(req.params.id, req.body);
    if (req.body.password) manager.record(req.params.id).blocked = null;
    return { hosts: manager.list() };
  }));
  app.delete("/api/remotes/:id", action((req) => {
    if (manager.record(req.params.id).operation) throw remoteError("请等待当前操作完成后删除配置", 409);
    manager.disconnect(req.params.id); manager.store.remove(req.params.id); manager.connections.delete(req.params.id);
    return { ok: true };
  }));
  app.post("/api/remotes/:id/probe", action((req) => manager.probe(req.params.id)));
  app.post("/api/remotes/:id/trust", action((req) => manager.trust(req.params.id, req.body.fingerprint)));
  app.post("/api/remotes/:id/install", action((req) => {
    if (req.body.confirm !== true) throw remoteError("安装需要明确确认", 409);
    return manager.install(req.params.id, req.body.planId);
  }));
  app.post("/api/remotes/:id/connect", action((req) => manager.connect(req.params.id)));
  app.post("/api/remotes/:id/disconnect", action((req) => {
    if (manager.record(req.params.id).operation) throw remoteError("请等待当前操作完成后断开", 409);
    manager.disconnect(req.params.id); return { ok: true };
  }));
  app.post("/api/remotes/:id/stop", action((req) => {
    if (req.body.confirm !== true) throw remoteError("停止远端组件需要明确确认", 409);
    return manager.stop(req.params.id).then(() => ({ ok: true }));
  }));
  app.use("/api/remotes/:id/proxy", async (req, res) => {
    let upstream, settled = false, attempted = false;
    const mutation = !["GET", "HEAD"].includes(req.method) && req.path !== "/api/sessions/delete-status";
    const fail = (error) => {
      if (settled || res.destroyed || res.writableEnded) return;
      settled = true;
      if (!res.headersSent) res.status(error.status || 502).json({
        error: mutation && attempted ? "远端操作结果尚未确认，需只读核对；不要重复提交" : error.message,
        code: mutation && attempted ? "REMOTE_OUTCOME_UNKNOWN" : error.code,
        outcomeUnknown: mutation && attempted,
      });
      else res.destroy();
      upstream?.destroy();
    };
    // req.setTimeout only starts after a socket exists. Bound ensure(), SSH
    // channel creation and HTTP headers too, otherwise a delete can hang forever.
    const deadline = setTimeout(() => fail(remoteError("远端请求超时", 504)), proxyTimeoutMs);
    res.on("close", () => { settled = true; clearTimeout(deadline); upstream?.destroy(); });
    res.on("finish", () => { settled = true; clearTimeout(deadline); });
    try {
      const pathname = sanitizePath(req.url);
      await manager.ensure(req.params.id);
      if (settled || res.destroyed) return;
      const body = ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body || {});
      upstream = manager.request(req.params.id, pathname, { method: req.method, body,
        headers: { ...(req.headers.accept ? { accept: req.headers.accept } : {}),
          ...(req.headers["accept-encoding"] ? { "accept-encoding": req.headers["accept-encoding"] } : {}) } });
      upstream.setTimeout(proxyTimeoutMs, () => fail(remoteError("远端请求超时", 504)));
      upstream.on("error", () => fail(remoteError("远端连接中断", 502)));
      upstream.on("response", (response) => {
        if (settled) { response.destroy(); return; }
        // Reads may stream large images/files for longer than the connection
        // budget while making progress. Their socket idle deadline still applies.
        if (!mutation) clearTimeout(deadline);
        res.status(response.statusCode);
        for (const key of ["content-type", "content-length", "cache-control", "etag", "last-modified", "content-security-policy", "x-content-type-options", "x-preview-kind", "content-encoding", "vary"])
          if (response.headers[key]) res.setHeader(key, response.headers[key]);
        pipeline(response, res, () => {});
      });
      attempted = true; upstream.end(body);
    } catch (error) { clearTimeout(deadline); fail(error); }
  });
}

/** Remote WS traffic is never queued across SSH reconnects. The browser queries
 * its request receipts instead of replaying potentially accepted prompts. */
export function remoteWebSocketServer({ manager, token, origins = [], currentBuild = () => null }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024, perMessageDeflate: HISTORY_COMPRESSION });
  const reject = (socket, status = 502) => { socket.end(`HTTP/1.1 ${status} Remote unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
  const upgrade = async (req, socket, head) => {
    let upstream;
    try {
      const denied = remoteAccess(req, token, origins);
      if (denied) return reject(socket, denied.status);
      const url = new URL(req.url, "http://localhost"), match = url.pathname.match(/^\/ws\/remotes\/([a-zA-Z0-9-]+)(\/terminal)?$/);
      if (!match) return reject(socket, 404);
      const pathname = match[2] ? "/ws/terminal" : "/ws";
      if (match[2]) delete req.headers["sec-websocket-extensions"]; // PTY transport remains uncompressed.
      const params = new URLSearchParams(url.searchParams); params.delete("token");
      upstream = await manager.websocket(match[1], `${pathname}?${params}`);
      const pending = []; let browser, bytes = 0, sending = false;
      // One potentially large history frame in flight; at most 2 MiB of
      // additional output. Pause the upstream instead of dropping a slow
      // browser's valid snapshot when a small state/permission frame follows.
      // This queue is output-only and dies with this SSH channel: never replay
      // prompts, permission answers or other mutations across reconnects.
      const flush = () => {
        if (!browser || browser.readyState !== 1 || sending || !pending.length) return;
        const [payload, binary] = pending.shift(); bytes -= Buffer.byteLength(payload);
        sending = true; upstream.pause();
        browser.send(payload, { binary }, (error) => {
          sending = false;
          if (error) { pending.length = 0; bytes = 0; upstream.close(); return; }
          if (pending.length) flush(); else upstream.resume();
        });
      };
      const forward = (data, binary) => {
        let payload = data;
        if (!binary && !match[2]) {
          try {
            const message = JSON.parse(data.toString());
            if (message.type === "hello") payload = JSON.stringify({ ...message, build: currentBuild() });
          } catch { upstream.close(1003, "invalid remote frame"); return; }
        }
        if (!browser) {
          bytes += payload.length;
          if (bytes > 2 * 1024 * 1024) return upstream.close(1013, "upgrade backpressure");
          pending.push([payload, binary]); return;
        }
        if (browser.readyState !== 1) return;
        if (match[2]) {
          if (browser.bufferedAmount > 2 * 1024 * 1024) return browser.close(1013, "remote output backpressure");
          browser.send(payload, { binary }); return;
        }
        const size = Buffer.byteLength(payload);
        if (sending && bytes + size > 2 * 1024 * 1024) return browser.close(1013, "remote output backpressure");
        bytes += size; pending.push([payload, binary]); flush();
      };
      upstream.on("message", forward);
      upstream.on("error", () => { if (browser) browser.close(1011, "remote disconnected"); });
      await new Promise((resolve, fail) => { upstream.once("open", resolve); upstream.once("error", fail); upstream.once("close", () => fail(new Error("closed"))); });
      if (socket.destroyed) return upstream.close();
      wss.handleUpgrade(req, socket, head, (ws) => {
        browser = ws;
        if (match[2]) { for (const [data, binary] of pending) ws.send(data, { binary }); pending.length = 0; bytes = 0; }
        else flush();
        ws.on("message", (data, binary) => {
          if (upstream.readyState !== 1) return ws.close(1012, "remote disconnected");
          if (upstream.bufferedAmount > 2 * 1024 * 1024) return ws.close(1013, "remote input backpressure");
          upstream.send(data, { binary });
        });
        ws.on("error", () => upstream.close()); ws.on("close", () => { pending.length = 0; bytes = 0; upstream.close(); });
        upstream.on("close", () => ws.close(1012, "remote disconnected"));
        ws.isAlive = true; ws.on("pong", () => { ws.isAlive = true; });
      });
    } catch { upstream?.close(); if (!socket.destroyed) reject(socket); }
  };
  const heartbeat = setInterval(() => { for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate(); else { ws.isAlive = false; ws.ping(); }
  } }, 30000);
  heartbeat.unref(); wss.on("close", () => clearInterval(heartbeat));
  return { wss, upgrade };
}
