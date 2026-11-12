import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node-pty";
import { WebSocketServer } from "ws";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];
const INPUT_LIMIT = 32 * 1024;
const OUTPUT_LIMIT = 256 * 1024;

/** Do not trust forwarded IPs: a reverse proxy must use a token. Checking
 * Host as well as the actual peer also prevents DNS-rebinding/local-proxy bypasses. */
export function terminalAccess(req, token = "", origins = []) {
  let url;
  let host;
  let origin;
  try {
    url = new URL(req.url, "http://localhost");
    host = new URL(`http://${req.headers.host}`);
    if (req.headers.origin) {
      origin = new URL(req.headers.origin);
      if (!["http:", "https:"].includes(origin.protocol) ||
          (origin.host !== host.host && !origins.includes(origin.origin))) {
        return { status: 403, error: "终端拒绝跨站访问" };
      }
    }
  } catch {
    return { status: 403, error: "无效的终端请求来源" };
  }
  if (token) {
    if ((req.headers["x-devin-token"] || url.searchParams.get("token")) !== token)
      return { status: 401, error: "终端访问需要有效的 DEVIN_WEB_TOKEN" };
  } else if (!LOOPBACK.has(req.socket.remoteAddress) || !LOCAL_HOSTS.has(host.hostname) ||
      (origin && !LOCAL_HOSTS.has(origin.hostname)) || PROXY_HEADERS.some((k) => req.headers[k])) {
    return { status: 403, error: "远程或代理访问终端必须配置 DEVIN_WEB_TOKEN，并通过带 Token 的链接打开页面" };
  }
  return null;
}

function size(value, fallback, max) {
  return Number.isInteger(value) && value >= 2 && value <= max ? value : fallback;
}

function send(ws, message) {
  if (ws.readyState !== 1) return;
  // Slow/dormant browsers may reconnect and replay, but must not grow server RAM.
  if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, "terminal output backpressure");
  try { ws.send(JSON.stringify(message)); } catch { ws.terminate(); }
}

export class TerminalHub {
  constructor({ workspaces, maxTerminals = 8, spawnPty = spawn, shell = process.env.SHELL || os.userInfo().shell || "/bin/bash" }) {
    this.workspaces = workspaces;
    this.maxTerminals = maxTerminals;
    this.spawnPty = spawnPty;
    this.shell = shell;
    this.sessions = new Map();
    this.disposed = false;
  }

  resolve(cwd) {
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("请选择有效的工作区");
    const real = fs.realpathSync(cwd);
    const known = this.workspaces().some((dir) => {
      try { return fs.realpathSync(dir) === real; } catch { return false; }
    });
    if (!known || !fs.statSync(real).isDirectory()) throw new Error("终端只能在已添加的工作区中打开");
    return real;
  }

  status(cwd) {
    const real = this.resolve(cwd);
    const session = this.sessions.get(real);
    return { cwd: real, running: !!session?.pty };
  }

  start(session, cols, rows) {
    if (this.disposed) throw new Error("服务器正在关闭");
    if (session.pty) throw new Error("终端仍在运行，请先结束当前终端");
    if ([...this.sessions.values()].filter((s) => s.pty).length >= this.maxTerminals)
      throw new Error(`后台终端已达上限（${this.maxTerminals}），请先结束不用的终端`);
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" };
    delete env.DEVIN_WEB_TOKEN;
    delete env.DEVIN_WEB_SSH_MASTER_KEY;
    // npm-start injects these; they break nvm-enabled interactive shell startup.
    delete env.npm_config_prefix;
    delete env.NPM_CONFIG_PREFIX;
    const pty = this.spawnPty(this.shell, [], { name: "xterm-256color", cwd: session.cwd, cols, rows, env });
    Object.assign(session, { pty, cols, rows, chunks: [], length: 0, exit: null });
    session.dataSubscription = pty.onData((data) => {
      // Keep a bounded tail for refresh/reconnect. ACP/chat history is untouched.
      const chunk = data.slice(-OUTPUT_LIMIT);
      session.chunks.push(chunk);
      session.length += chunk.length;
      while (session.length > OUTPUT_LIMIT && session.chunks.length > 1)
        session.length -= session.chunks.shift().length;
      for (const ws of session.clients) send(ws, { type: "terminal_output", data });
    });
    session.exitSubscription = pty.onExit(({ exitCode, signal }) => {
      if (session.pty !== pty) return;
      session.pty = null;
      session.exit = { type: "terminal_exit", exitCode, signal };
      session.dataSubscription.dispose();
      session.exitSubscription.dispose();
      for (const ws of session.clients) send(ws, session.exit);
    });
  }

  ready(session, ws) {
    send(ws, {
      type: "terminal_ready", cwd: session.cwd, cols: session.cols, rows: session.rows,
      running: !!session.pty, replay: session.chunks.join(""),
    });
    if (session.exit) send(ws, session.exit);
  }

  attach(ws, { cwd, cols, rows }) {
    let session;
    try {
      if (this.disposed) throw new Error("服务器正在关闭");
      const real = this.resolve(cwd);
      session = this.sessions.get(real);
      if (!session) {
        // Bound exited replay caches too, without evicting live processes or viewers.
        for (const [key, old] of this.sessions) {
          if (this.sessions.size < this.maxTerminals * 2) break;
          if (!old.pty && !old.clients.size) this.sessions.delete(key);
        }
        if (this.sessions.size >= this.maxTerminals * 2) throw new Error("终端会话过多，请关闭不用的终端页面");
        session = { cwd: real, clients: new Set() };
        this.start(session, size(cols, 80, 500), size(rows, 24, 200));
        this.sessions.set(real, session);
      }
      if (session.clients.size >= 16) throw new Error("此终端的连接过多");
      session.clients.add(ws);
      ws.on("close", () => session.clients.delete(ws));
      this.ready(session, ws);
    } catch (e) {
      send(ws, { type: "terminal_error", error: e.message });
      ws.close(1008, "terminal unavailable");
      return;
    }
    ws.on("message", (raw) => {
      if (this.disposed) return;
      try {
        const message = JSON.parse(raw.toString());
        switch (message.type) {
          case "input":
            if (typeof message.data !== "string" || message.data.length > INPUT_LIMIT)
              throw new Error("终端输入过长，请分段粘贴");
            session.pty?.write(message.data);
            break;
          case "resize": {
            const cols = size(message.cols, session.cols, 500);
            const rows = size(message.rows, session.rows, 200);
            if (session.pty && (cols !== session.cols || rows !== session.rows)) {
              session.pty.resize(cols, rows);
              Object.assign(session, { cols, rows });
            }
            break;
          }
          case "terminate":
            session.pty?.kill();
            break;
          case "restart":
            this.start(session, size(message.cols, session.cols, 500), size(message.rows, session.rows, 200));
            for (const client of session.clients) this.ready(session, client);
            break;
        }
      } catch (e) {
        send(ws, { type: "terminal_error", error: e.message });
      }
    });
  }

  dispose() {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      for (const ws of session.clients) ws.close(1001, "server shutdown");
      try { session.pty?.kill(); } catch { /* process already exited */ }
    }
  }
}

export function terminalWebSocketServer({ hub, token, origins = [] }) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
    verifyClient({ req }, done) {
      const denied = terminalAccess(req, token, origins);
      if (denied) return done(false, denied.status, "terminal access denied");
      done(true);
    },
  });
  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("error", () => ws.terminate());
    const params = new URL(req.url, "http://localhost").searchParams;
    hub.attach(ws, { cwd: params.get("cwd"), cols: Number(params.get("cols")), rows: Number(params.get("rows")) });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) ws.terminate();
      else { ws.isAlive = false; ws.ping(); }
    }
  }, 30_000);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}
