import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acp-client.js";
import { SessionHub } from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const WEB_DIST = path.join(ROOT, "web", "dist");
const DATA_DIR = process.env.DEVIN_WEB_DATA || path.join(ROOT, "server", "data");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const acp = new AcpClient(process.env.DEVIN_BIN || "devin");
const hub = new SessionHub(acp, path.join(DATA_DIR, "state.json"));

const app = express();
app.use(express.json({ limit: "50mb" }));

// Optional bearer token — set DEVIN_WEB_TOKEN to require it on /api and /ws
// (share the URL as http://host:port/?token=XXX when exposing beyond local).
const AUTH_TOKEN = process.env.DEVIN_WEB_TOKEN || "";
app.use("/api", (req, res, next) => {
  if (!AUTH_TOKEN || req.path === "/health") return next();
  const t = req.get("x-devin-token") || req.query.token;
  if (t === AUTH_TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
});

const expandHome = (p) => (p === "~" || p?.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

app.get("/api/health", (_req, res) => res.json({ ok: true, ...hub.status() }));

app.get("/api/state", (_req, res) => {
  res.json({ workspaces: hub.workspaces, home: os.homedir(), sessions: hub.state.sessions });
});

// ---------- account quota (seat_management GetUserStatus) ----------
// The CLI's TUI /usage panel reads plan quota off the same RPC. api.devin.ai
// v3 consumption endpoints are enterprise-only, so quota data comes from the
// windsurf backend using the CLI's own session token.
let _usageCache = { at: 0, data: null };
app.get("/api/account/usage", async (_req, res) => {
  try {
    if (Date.now() - _usageCache.at < 60_000 && _usageCache.data) return res.json(_usageCache.data);
    const credPath = path.join(os.homedir(), ".local/share/devin/credentials.toml");
    const cred = fs.readFileSync(credPath, "utf8");
    const grab = (k) => cred.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`))?.[1];
    const apiKey = grab("windsurf_api_key");
    const server = grab("api_server_url") || "https://server.codeium.com";
    if (!apiKey) return res.status(503).json({ error: "no devin credentials" });
    const r = await fetch(`${server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: JSON.stringify({
        metadata: { apiKey, ideName: "devin", ideVersion: "1.0.0", extensionName: "devin", extensionVersion: "1.0.0", locale: "en" },
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const j = await r.json();
    const ps = j.userStatus?.planStatus || {};
    const pi = ps.planInfo || {};
    const data = {
      plan: pi.planName || j.userStatus?.planInfo?.planName || null,
      tier: j.userStatus?.teamsTier || null,
      email: j.userStatus?.email || null,
      billingStrategy: pi.billingStrategy || null,
      planStart: ps.planStart || null,
      planEnd: ps.planEnd || null,
      hideDaily: !!pi.hideDailyQuota,
      daily: ps.dailyQuotaRemainingPercent != null
        ? { remaining: ps.dailyQuotaRemainingPercent, resetAt: ps.dailyQuotaResetAtUnix ? Number(ps.dailyQuotaResetAtUnix) * 1000 : null }
        : null,
      weekly: ps.weeklyQuotaRemainingPercent != null
        ? { remaining: ps.weeklyQuotaRemainingPercent, resetAt: ps.weeklyQuotaResetAtUnix ? Number(ps.weeklyQuotaResetAtUnix) * 1000 : null }
        : null,
      overageMicros: ps.overageBalanceMicros != null ? Number(ps.overageBalanceMicros) : null,
      promptCredits: ps.availablePromptCredits != null ? Number(ps.availablePromptCredits) : null,
    };
    _usageCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

// ---------- filesystem browsing (workspace picker) ----------
app.get("/api/fs/browse", (req, res) => {
  try {
    let dir = expandHome(req.query.path || "") || os.homedir();
    dir = path.resolve(dir);
    const showHidden = req.query.hidden === "1";
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => showHidden || !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    res.json({ path: dir, parent: path.dirname(dir), home: os.homedir(), entries });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/fs/mkdir", (req, res) => {
  try {
    const dir = path.resolve(expandHome(req.body.path || ""));
    fs.mkdirSync(dir, { recursive: true });
    res.json({ path: dir });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- workspaces ----------
app.post("/api/workspaces", (req, res) => {
  const dir = path.resolve(expandHome(req.body.path || ""));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(400).json({ error: `not a directory: ${dir}` });
  }
  hub.addWorkspace(dir);
  res.json({ workspaces: hub.workspaces });
});

// ---------- sessions ----------
app.get("/api/sessions", async (req, res) => {
  try {
    const sessions = await hub.listSessions(req.query.cwd ? path.resolve(expandHome(req.query.cwd)) : undefined);
    res.json({ sessions });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const cwd = path.resolve(expandHome(req.body.cwd || ""));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${cwd}` });
    }
    const created = await hub.createSession(cwd);
    res.json(created);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/close", async (req, res) => {
  try {
    res.json(await hub.closeSession(req.params.id));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/rename", async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "empty title" });
    await hub.renameSession(req.params.id, title);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await hub.deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/history", (req, res) => {
  const s = hub.sessions.get(req.params.id);
  res.json({ events: s?.events ?? [], attached: !!s?.attached });
});

// Persisted message images (user uploads + tool results). Events carry a URL
// instead of base64 so multi-MB payloads can't push the transcript buffer
// over its byte budget; images are served lazily from sqlite on <img> load.
app.get("/api/sessions/:id/img/:mid/:idx", (req, res) => {
  const img = hub.sessionImage(req.params.id, req.params.mid, Number(req.params.idx) || 0);
  if (!img?.data) return res.status(404).end();
  res
    .setHeader("Content-Type", img.mimeType)
    .setHeader("Cache-Control", "private, max-age=3600")
    .end(Buffer.from(img.data, "base64"));
});

// Workspace files referenced from agent messages — markdown like
// `![x](shots/a.png)` resolves relative to the session cwd, and an
// absolute path is served as-is (same privilege as the agent itself).
app.get("/api/sessions/:id/raw", (req, res) => {
  const p = String(req.query.path || "");
  if (!p || p.includes("\0")) return res.status(400).end();
  const s = hub.sessions.get(req.params.id);
  const cwd = s?.cwd || hub.state.sessions[req.params.id]?.cwd;
  const file = path.isAbsolute(p) ? p : path.resolve(cwd || "/", p);
  res.sendFile(file, { acceptRanges: false }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// ---------- static frontend ----------
if (fs.existsSync(WEB_DIST)) {
  app.use(
    express.static(WEB_DIST, {
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === "index.html" || base === "sw.js" || base === "manifest.webmanifest") {
          res.setHeader("Cache-Control", "no-cache");
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
        if (filePath.endsWith(".webmanifest")) {
          res.setHeader("Content-Type", "application/manifest+json");
        }
      },
    })
  );
  app.get(/^\/(?!api|ws).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(WEB_DIST, "index.html"));
  });
} else {
  app.get("/", (_req, res) =>
    res.status(503).send("frontend not built — run `npm run build` or `npm run dev` (vite)")
  );
}

const server = http.createServer(app);
const isLoopback = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1" || h?.endsWith(".localhost");
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient(info, done) {
    // Browsers always send Origin on WS upgrades — a hostile page on this
    // machine could otherwise drive prompts and permission responses here.
    // Allow: same-origin (served app), loopback↔loopback (dev/proxy), or
    // origins listed in DEVIN_WEB_ORIGINS. Non-browser clients send no
    // Origin and still pass the token check below.
    const origin = info.req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const o = new URL(origin);
        const host = new URL(`http://${info.req.headers.host}`);
        const extra = (process.env.DEVIN_WEB_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
        ok = o.host === host.host || extra.includes(origin) || (isLoopback(o.hostname) && isLoopback(host.hostname));
      } catch { /* malformed origin */ }
      if (!ok) return done(false, 403, "forbidden origin");
    }
    if (AUTH_TOKEN) {
      const url = new URL(info.req.url, "http://x");
      if (url.searchParams.get("token") !== AUTH_TOKEN) return done(false, 401, "unauthorized");
    }
    done(true);
  },
});

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const reply = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));
    try {
      switch (msg.type) {
        case "subscribe": {
          const subscribedAt = Date.now();
          const s = hub.subscribe(ws, msg.sessionId, msg.cwd);
          let sent = false;
          const sendReady = () => {
            if (sent) return;
            sent = true;
            // Skip re-sending a history this socket just received via the
            // attach/mirror broadcast (it fired AFTER we subscribed, so the
            // socket was in the target set). Only the permission replay below
            // is still needed in that case.
            const bc = s.lastHistoryBC;
            const alreadyBroadcast =
              bc && bc.gen === s.gen && bc.len === s.events.length && bc.at >= subscribedAt;
            if (!alreadyBroadcast) {
              reply({
                type: "history",
                sessionId: msg.sessionId,
                events: s.events,
                attached: s.attached,
                gen: s.gen,
                state: hub.stateOf(msg.sessionId),
                modes: s.modes,
                configOptions: s.configOptions,
                availableCommands: s.commands || hub.commandsByCwd.get(s.cwd),
                usage: s.usage || hub.usageById.get(msg.sessionId),
              });
            }
            // Re-send unanswered permission cards — they're live JSON-RPC
            // requests, not buffered events, so history replay misses them.
            for (const p of s.pendingPermissions.values()) {
              reply({
                type: "permission_request",
                sessionId: msg.sessionId,
                requestId: p.requestId,
                toolCall: p.params?.toolCall,
                options: p.params?.options || [],
              });
            }
          };
          // Wait for the attach attempt to settle, then send ONE history:
          // success → the freshly replayed transcript; failure (locked) →
          // none — the sqlite mirror's rebuilt history covers it.
          // (ensureAttached returns the bare entry when already attached.)
          Promise.resolve(hub.ensureAttached(msg.sessionId, msg.cwd))
            .then(sendReady)
            .catch((e) => {
              reply({
                type: "attach_error",
                sessionId: msg.sessionId,
                error: e.message,
                code: e.code,
                kind: e.data?.["cognition.ai/errorKind"],
                lockHolderPid: e.data?.["cognition.ai/lockHolderPid"],
              });
              // Attach failed but the buffer may already hold the mirrored
              // transcript — deliver it so a re-subscribed client isn't left
              // blank. (Fresh mirrors send their own rebuilt history.)
              if (s.events.length) sendReady();
            });
          // Backstop: if the attach attempt pends, don't leave the client on a
          // loading screen — send whatever the buffer holds so far. Skipped
          // when the mirror already rebuilt (it broadcast its own history) or
          // the attach already resolved.
          setTimeout(() => {
            if (!s.attached && s.mirrorMaxRow == null) sendReady();
          }, 4000);
          break;
        }
        case "unsubscribe":
          hub.unsubscribe(ws, msg.sessionId);
          break;
        case "watch":
          hub.allSubscribers.add(ws);
          break;
        case "prompt": {
          const blocks = (msg.blocks || []).length
            ? msg.blocks
            : [{ type: "text", text: msg.text || "" }];
          const result = await hub.prompt(msg.sessionId, msg.cwd, blocks);
          reply({ type: "prompt_result", sessionId: msg.sessionId, ...result });
          break;
        }
        case "cancel":
          await hub.cancel(msg.sessionId);
          break;
        case "permission_response":
          hub.permissionResponse(msg.requestId, msg.optionId, !!msg.cancelled);
          break;
        case "set_config_option": {
          const r = await hub.setConfigOption(msg.sessionId, msg.configId, msg.value);
          reply({ type: "config_options", sessionId: msg.sessionId, ...r });
          break;
        }
        case "ping":
          reply({ type: "pong" });
          break;
      }
    } catch (e) {
      reply({ type: "error", sessionId: msg.sessionId, op: msg.type, error: e.message });
    }
  });

  ws.on("close", () => hub.dropSocket(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      hub.dropSocket(ws);
      ws.terminate();
    } else {
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  console.log(`devin-web server listening on http://${HOST}:${PORT}`);
});

process.on("SIGINT", () => {
  acp.kill();
  process.exit(0);
});
process.on("SIGTERM", () => {
  acp.kill();
  process.exit(0);
});
