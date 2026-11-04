import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acp-client.js";
import { SessionHub } from "./sessions.js";
import { buildAgents } from "./agents.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const WEB_DIST = path.join(ROOT, "web", "dist");
const DATA_DIR = process.env.DEVIN_WEB_DATA || path.join(ROOT, "server", "data");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

// One ACP client + SessionHub per enabled agent (DEVIN_WEB_AGENTS). The
// first entry is primary: it owns the shared workspace list in state.json;
// every other agent persists its own metadata in state.<id>.json.
const agents = buildAgents();
const hubs = new Map();
for (const a of agents) {
  const acp = new AcpClient({
    bin: a.bin,
    args: a.args,
    label: `${a.id} acp`,
    initMeta: a.initMeta,
  });
  const statePath = path.join(
    DATA_DIR,
    a.devinExt ? "state.json" : `state.${a.id}.json`
  );
  hubs.set(a.id, new SessionHub(acp, statePath, { agent: a.id, devinExt: a.devinExt }));
}
const primary = agents[0];
const hub = hubs.get(primary?.id);

// Route a session id to its hub: whichever hub already knows it; otherwise
// UUID-shaped ids go to the pi hub (devin ids are short, pi's are UUIDs);
// anything else falls back to primary.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function hubFor(sessionId) {
  for (const h of hubs.values()) {
    if (h.sessions.has(sessionId) || h.state.sessions[sessionId]) return h;
  }
  if (UUID_RE.test(sessionId || "") && hubs.has("pi")) return hubs.get("pi");
  return hub;
}

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

// CSRF guard for mutating requests — without it, any page the user browses
// could POST create/delete/prompt while no token is configured. Browsers
// always send sec-fetch-site (or Origin) on writes; requests without either
// come from non-browser clients (curl), which can't be CSRF'd anyway.
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const site = req.get("sec-fetch-site");
  if (site === "same-origin") return next();
  if (site && site !== "none") return res.status(403).json({ error: "forbidden" });
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host === req.get("host")) return next();
    } catch { /* malformed origin */ }
    return res.status(403).json({ error: "forbidden origin" });
  }
  next();
});

const expandHome = (p) => (p === "~" || p?.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

app.get("/api/health", (_req, res) => {
  const agents = {};
  for (const [id, h] of hubs) agents[id] = h.status();
  res.json({ ok: true, agents });
});

app.get("/api/agents", (_req, res) => {
  res.json({ agents: agents.map((a) => ({ id: a.id, name: a.name, caps: a.caps })) });
});

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

// Fuzzy file search inside a workspace for @-mentions — shallow recursive
// walk with the usual noise dirs skipped.
app.get("/api/fs/search", (req, res) => {
  try {
    const root = path.resolve(expandHome(req.query.root || ""));
    const q = String(req.query.q || "").toLowerCase();
    const SKIP = new Set([
      "node_modules", ".git", "dist", "build", ".next", "__pycache__",
      ".venv", "venv", "target", ".cache", "coverage",
    ]);
    const out = [];
    const walk = (dir, depth) => {
      if (out.length >= 300 || depth > 6) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= 300) return;
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1);
        } else {
          const rel = path.relative(root, p);
          if (!q || rel.toLowerCase().includes(q)) out.push({ path: p, rel, name: e.name });
        }
      }
    };
    walk(root, 0);
    // Prefer shorter paths and substring-leftmost matches.
    out.sort((a, b) =>
      q
        ? a.rel.toLowerCase().indexOf(q) - b.rel.toLowerCase().indexOf(q) ||
          a.rel.length - b.rel.length
        : a.rel.length - b.rel.length
    );
    res.json({ root, files: out.slice(0, 50) });
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
  const cwd = req.query.cwd ? path.resolve(expandHome(req.query.cwd)) : undefined;
  const settled = await Promise.allSettled([...hubs.values()].map((h) => h.listSessions(cwd)));
  const sessions = [];
  let err = null;
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") sessions.push(...r.value);
    else {
      err = r.reason;
      console.error(`[devin-web] listSessions failed for agent ${[...hubs.keys()][i]}:`, r.reason?.message || r.reason);
    }
  });
  // A failing hub degrades gracefully — only an all-fail surfaces an error.
  if (settled.every((r) => r.status === "rejected"))
    return res.status(502).json({ error: err?.message || "all agents failed" });
  res.json({ sessions });
});

app.post("/api/sessions", async (req, res) => {
  try {
    const cwd = path.resolve(expandHome(req.body.cwd || ""));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return res.status(400).json({ error: `not a directory: ${cwd}` });
    }
    const agentId = req.body.agent || primary?.id;
    const h = hubs.get(agentId);
    if (!h) return res.status(400).json({ error: `unknown agent: ${agentId}` });
    const created = await h.createSession(cwd);
    // Workspaces are shared and owned by the primary hub — a non-primary
    // hub's own addWorkspace only writes its private state file.
    if (h !== hub) hub.addWorkspace(cwd);
    res.json(created);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/close", async (req, res) => {
  try {
    res.json(await hubFor(req.params.id).closeSession(req.params.id));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/rename", async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "empty title" });
    await hubFor(req.params.id).renameSession(req.params.id, title);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/archive", async (req, res) => {
  try {
    res.json(await hubFor(req.params.id).setArchived(req.params.id, !!req.body?.archived));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/pin", async (req, res) => {
  try {
    res.json(await hubFor(req.params.id).setPinned(req.params.id, !!req.body?.pinned));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Fork the session at a user prompt → returns the new session id.
// stepIndex = the Nth user message (kind:"prompt" steps, in order).
app.post("/api/sessions/:id/fork", async (req, res) => {
  try {
    const idx = Number(req.body?.stepIndex ?? -1);
    if (!Number.isInteger(idx) || idx < 0)
      return res.status(400).json({ error: "stepIndex required" });
    const r = await hubFor(req.params.id).forkAtStep(req.params.id, req.body?.cwd, idx);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/sessions/:id", async (req, res) => {
  try {
    await hubFor(req.params.id).deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/sessions/:id/history", (req, res) => {
  const s = hubFor(req.params.id).sessions.get(req.params.id);
  res.json({ events: s?.events ?? [], attached: !!s?.attached });
});

// Persisted message images (user uploads + tool results). Events carry a URL
// instead of base64 so multi-MB payloads can't push the transcript buffer
// over its byte budget; images are served lazily from sqlite on <img> load.
app.get("/api/sessions/:id/img/:mid/:idx", (req, res) => {
  const img = hubFor(req.params.id).sessionImage(req.params.id, req.params.mid, Number(req.params.idx) || 0);
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
  const h = hubFor(req.params.id);
  const s = h.sessions.get(req.params.id);
  const cwd = s?.cwd || h.state.sessions[req.params.id]?.cwd;
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
const wss = new WebSocketServer({
  server,
  path: "/ws",
  verifyClient(info, done) {
    // Browsers always send Origin on WS upgrades — a hostile page on this
    // machine could otherwise drive prompts and permission responses here.
    // Allow: same-origin (served app) or origins listed in DEVIN_WEB_ORIGINS
    // (a different local port IS hostile — no loopback↔loopback blanket pass).
    // Non-browser clients send no Origin and still pass the token check below.
    const origin = info.req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        const o = new URL(origin);
        const host = new URL(`http://${info.req.headers.host}`);
        const extra = (process.env.DEVIN_WEB_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
        ok = o.host === host.host || extra.includes(origin);
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
          const h = hubFor(msg.sessionId);
          const s = h.subscribe(ws, msg.sessionId, msg.cwd);
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
                state: h.stateOf(msg.sessionId),
                modes: s.modes,
                configOptions: s.configOptions,
                availableCommands: s.commands || h.commandsByCwd.get(s.cwd),
                usage: s.usage || h.usageById.get(msg.sessionId),
                queue: h.queueView?.(msg.sessionId) ?? [],
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
          Promise.resolve(h.ensureAttached(msg.sessionId, msg.cwd))
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
          for (const h of hubs.values()) h.unsubscribe(ws, msg.sessionId);
          break;
        case "watch":
          for (const h of hubs.values()) h.allSubscribers.add(ws);
          break;
        case "prompt": {
          const blocks = (msg.blocks || []).length
            ? msg.blocks
            : [{ type: "text", text: msg.text || "" }];
          const result = await hubFor(msg.sessionId).prompt(msg.sessionId, msg.cwd, blocks);
          reply({ type: "prompt_result", sessionId: msg.sessionId, ...result });
          break;
        }
        case "cancel":
          await hubFor(msg.sessionId).cancel(msg.sessionId);
          break;
        case "queue_remove":
          reply({
            type: "queue_result",
            sessionId: msg.sessionId,
            removed: !!hubFor(msg.sessionId).removeQueued(msg.sessionId, msg.queueId),
          });
          break;
        case "queue_edit": {
          const h = hubFor(msg.sessionId);
          const q = h.removeQueued(msg.sessionId, msg.queueId);
          if (q) {
            const r = await h.prompt(msg.sessionId, msg.cwd, msg.blocks || q.blocks);
            reply({ type: "prompt_result", sessionId: msg.sessionId, ...r });
          } else {
            reply({ type: "queue_result", sessionId: msg.sessionId, removed: false });
          }
          break;
        }
        case "permission_response":
          // Request ids are agent-namespaced; try each hub until one owns it.
          for (const h of hubs.values())
            if (h.permissionResponse(msg.requestId, msg.optionId, !!msg.cancelled)) break;
          break;
        case "set_config_option": {
          const r = await hubFor(msg.sessionId).setConfigOption(msg.sessionId, msg.configId, msg.value);
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

  ws.on("close", () => {
    for (const h of hubs.values()) h.dropSocket(ws);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      for (const h of hubs.values()) h.dropSocket(ws);
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

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const h of hubs.values()) h.acp.kill();
    process.exit(0);
  });
}
