import { gzip } from "node:zlib";
import { filePreviewRoutes } from "./file-preview.js";
import { HISTORY_ENCODING, HISTORY_ENCODING_V2, HISTORY_COMPRESSION } from "./history-wire.js";
import { searchTranscripts } from "./transcript-search.js";
import { devinDbPath } from "./sessions.js";
import { getPiSessionsDir } from "./pi-sdk/pi-acp-agent.js";
import { randomUUID } from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { AcpClient } from "./acp-client.js";
import { PiSdkClient } from "./pi-sdk/pi-sdk-client.js";
import { SessionHub } from "./sessions.js";
import { buildAgents } from "./agents.js";
import { TerminalHub, terminalAccess, terminalWebSocketServer } from "./terminals.js";
import { HostStore, RemoteHosts } from "./remote-hosts.js";
import { remoteRoutes, remoteWebSocketServer } from "./remote-routes.js";
import { scratchRoot, createScratchDir, scratchInfo, removeScratchDir } from "./scratch.js";
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const WEB_DIST = path.join(ROOT, "web", "dist");
const DATA_DIR = process.env.DEVIN_WEB_DATA || path.join(ROOT, "server", "data");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const WORKER = process.env.DEVIN_WEB_WORKER === "1";
if (WORKER && (!process.env.DEVIN_WEB_TOKEN || HOST !== "127.0.0.1")) {
  console.error("remote worker requires a token and loopback binding"); process.exit(1);
}
if (WORKER) process.umask(0o077);

// Capture this coordinator-only secret before creating agents. Tool subprocesses
// must not accidentally inherit it via env/printenv; this is not account isolation.
let remoteStore = null;
try { if (!WORKER) remoteStore = new HostStore(path.join(DATA_DIR, "remote-hosts.json")); }
catch (e) { console.error(`[devin-web] remote configuration: ${e.message}`); process.exit(1); }
delete process.env.DEVIN_WEB_SSH_MASTER_KEY;

// pi extensions now run inside this process — a stray unhandled rejection
// would crash the whole server on Node 22 (default --unhandled-rejections=throw).
process.on("unhandledRejection", (e) => console.error("[devin-web] unhandledRejection", e));
// Same for a synchronous throw inside an extension or event callback: log
// loudly and keep going — the alternative is losing every session on a
// single bad extension.
process.on("uncaughtException", (e) => console.error("[devin-web] uncaughtException", e));

// Event-loop lag for /api/health — in-process pi sessions make stalls
// user-visible, so keep a live histogram.
const loopDelay = monitorEventLoopDelay();
loopDelay.enable();

// One ACP client + SessionHub per enabled agent (DEVIN_WEB_AGENTS). The
// first entry is primary: it owns the shared workspace list in state.json;
// every other agent persists its own metadata in state.<id>.json.
const agents = buildAgents();
const hubs = new Map();
for (const a of agents) {
  const acp =
    a.transport === "sdk"
      ? new PiSdkClient({ label: `${a.id} sdk`, initMeta: a.initMeta })
      : new AcpClient({
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
app.use(express.json({ limit: "10mb" }));
// Do not let Express's default parse-error logger echo password-bearing JSON.
app.use((error, _req, res, next) => {
  if (["entity.parse.failed", "entity.too.large"].includes(error.type))
    return res.status(error.type === "entity.too.large" ? 413 : 400).json({ error: "JSON 请求无效或超过大小限制" });
  next(error);
});

// Optional bearer token — set DEVIN_WEB_TOKEN to require it on /api and /ws
// (share the URL as http://host:port/?token=XXX when exposing beyond local).
const AUTH_TOKEN = process.env.DEVIN_WEB_TOKEN || "";
const TERMINAL_ORIGINS = (process.env.DEVIN_WEB_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
const terminals = new TerminalHub({
  workspaces: () => [os.homedir(), ...[...hubs.values()].flatMap((h) => h.workspaces)],
  maxTerminals: Math.max(1, Math.min(64, Math.floor(Number(process.env.MAX_TERMINALS) || 8))),
});
app.use("/api", (req, res, next) => {
  if (!AUTH_TOKEN || (!WORKER && req.path === "/health")) return next();
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

let remotes = null;
if (!WORKER) {
  try {
    remotes = new RemoteHosts({ root: ROOT, store: remoteStore });
    remoteRoutes(app, remotes, { token: AUTH_TOKEN, origins: TERMINAL_ORIGINS });
  } catch (e) { console.error(`[devin-web] remote configuration: ${e.message}`); process.exit(1); }
}
if (WORKER) app.post("/api/worker/stop", (req, res) => {
  if (req.body.confirm !== true) return res.status(409).json({ error: "confirmation required" });
  res.json({ ok: true });
  setTimeout(() => process.emit("SIGTERM"), 100);
});

const expandHome = (p) => (p === "~" || p?.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p);

app.get("/api/health", (_req, res) => {
  const agents = {};
  for (const [id, h] of hubs) agents[id] = h.status();
  const mem = process.memoryUsage();
  const health = {
    ok: true,
    ...(WORKER ? { workerProtocol: 1, workerVersion: process.env.DEVIN_WEB_WORKER_VERSION, instanceId: serverInstanceId } : {}),
    agents,
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(mem.rss / 1048576),
      heapUsedMb: Math.round(mem.heapUsed / 1048576),
    },
    eventLoopLagMs: {
      mean: +(loopDelay.mean / 1e6).toFixed(1),
      p99: +(loopDelay.percentile(99) / 1e6).toFixed(1),
    },
  };
  loopDelay.reset();
  res.json(health);
});

app.get("/api/agents", (_req, res) => {
  res.json({ agents: agents.map((a) => ({ id: a.id, name: a.name, caps: a.caps })) });
});

app.get("/api/state", (_req, res) => {
  res.json({ workspaces: hub.workspaces, home: os.homedir(), sessions: hub.state.sessions, scratch: true });
});

// ---------- account quota ----------
// Aggregates subscription/quota info for every configured agent's backing
// accounts. Devin quota comes from the windsurf seat-management RPC (same RPC
// the CLI /usage panel reads). Pi providers are queried directly: openai-codex
// via ChatGPT's wham/usage endpoint with pi's OAuth creds, deepseek via its
// balance API. Missing creds simply omit a source; fetch errors surface as a
// per-source `error` so one dead provider can't blank the whole widget.
let _usageCache = { at: 0, data: null };

const windowLabel = (secs) => {
  if (!secs) return { label: "配额", short: "配额" };
  if (secs % 604800 === 0) return { label: "周配额", short: "周" };
  if (secs < 86400) return { label: `${Math.round(secs / 3600)}小时配额`, short: `${Math.round(secs / 3600)}h` };
  return { label: `${Math.round(secs / 86400)}天配额`, short: `${Math.round(secs / 86400)}d` };
};

const rateWindowRow = (win, idPrefix, pos) => {
  const used = Number(win?.used_percent);
  if (!Number.isFinite(used)) return null;
  const { label, short } = windowLabel(Number(win.limit_window_seconds) || 0);
  return {
    id: `${idPrefix}:${pos}`,
    label,
    short,
    remaining: Math.max(0, Math.min(100, 100 - used)),
    resetAt: win.reset_at ? Number(win.reset_at) * 1000 : null,
  };
};

const rateLimitRows = (rl, idPrefix) => {
  if (!rl || typeof rl !== "object") return [];
  return [rateWindowRow(rl.primary_window, idPrefix, "primary"), rateWindowRow(rl.secondary_window, idPrefix, "secondary")].filter(Boolean);
};

async function fetchDevinUsageSource() {
  const credPath = path.join(os.homedir(), ".local/share/devin/credentials.toml");
  if (!fs.existsSync(credPath)) return null;
  const cred = fs.readFileSync(credPath, "utf8");
  const grab = (k) => cred.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`))?.[1];
  const apiKey = grab("windsurf_api_key");
  const server = grab("api_server_url") || "https://server.codeium.com";
  if (!apiKey) return null;
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
  const rows = [];
  if (ps.dailyQuotaRemainingPercent != null && !pi.hideDailyQuota)
    rows.push({ id: "daily", label: "日配额", short: "日", remaining: Number(ps.dailyQuotaRemainingPercent), resetAt: ps.dailyQuotaResetAtUnix ? Number(ps.dailyQuotaResetAtUnix) * 1000 : null });
  if (ps.weeklyQuotaRemainingPercent != null)
    rows.push({ id: "weekly", label: "周配额", short: "周", remaining: Number(ps.weeklyQuotaRemainingPercent), resetAt: ps.weeklyQuotaResetAtUnix ? Number(ps.weeklyQuotaResetAtUnix) * 1000 : null });
  const extras = [];
  if (ps.overageBalanceMicros != null && Number(ps.overageBalanceMicros) !== 0)
    extras.push({ label: "超额余额", value: (Number(ps.overageBalanceMicros) / 1e6).toFixed(2) });
  if (ps.availablePromptCredits != null && Number(ps.availablePromptCredits) >= 0)
    extras.push({ label: "剩余额度", value: String(Number(ps.availablePromptCredits)) });
  return {
    id: "devin",
    name: "Devin",
    plan: pi.planName || j.userStatus?.planInfo?.planName || null,
    email: j.userStatus?.email || null,
    rows,
    extras,
    period: ps.planEnd ? { start: ps.planStart || null, end: ps.planEnd } : null,
  };
}

const PI_AUTH_PATH = path.join(os.homedir(), ".pi/agent/auth.json");
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function readPiAuth() {
  try {
    return JSON.parse(fs.readFileSync(PI_AUTH_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Refresh pi's openai-codex OAuth grant and write it back atomically so the
// rotated refresh token stays usable by pi itself.
async function refreshCodexAuth(auth, cred) {
  const r = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cred.refresh, client_id: CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`codex token refresh ${r.status}`);
  const j = await r.json();
  if (!j.access_token || !j.refresh_token || typeof j.expires_in !== "number") throw new Error("codex token refresh returned incomplete data");
  const next = { ...cred, access: j.access_token, refresh: j.refresh_token, expires: Date.now() + j.expires_in * 1000 };
  const updated = { ...auth, "openai-codex": next };
  const tmp = PI_AUTH_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, PI_AUTH_PATH);
  return next;
}

async function fetchCodexUsageSource() {
  const auth = readPiAuth();
  let cred = auth?.["openai-codex"];
  if (!cred?.access) return null;
  if (cred.refresh && Number(cred.expires) - Date.now() < 60_000) {
    cred = await refreshCodexAuth(auth, cred);
  }
  const get = () =>
    fetch(CODEX_USAGE_URL, {
      headers: { Authorization: `Bearer ${cred.access}`, "chatgpt-account-id": cred.accountId || "", "User-Agent": "agent-web" },
      signal: AbortSignal.timeout(12_000),
    });
  let r = await get();
  if (r.status === 401 && cred.refresh) {
    cred = await refreshCodexAuth(auth, cred);
    r = await get();
  }
  if (!r.ok) throw new Error(`codex usage ${r.status}`);
  const j = await r.json();
  const rows = rateLimitRows(j.rate_limit, "codex");
  for (const extra of j.additional_rate_limits || []) {
    const id = extra?.metered_feature || extra?.limit_name || "extra";
    rows.push(...rateLimitRows(extra?.rate_limit, `codex:${id}`));
  }
  rows.push(...rateLimitRows(j.code_review_rate_limit, "codex:review"));
  const extras = [];
  const credits = j.credits;
  if (credits?.has_credits === true) {
    if (credits.unlimited === true) extras.push({ label: "积分", value: "无限" });
    else if (credits.balance != null) extras.push({ label: "积分余额", value: String(Math.round(Number(credits.balance) || 0)) });
  }
  const resetCredits = Number(j.rate_limit_reset_credits?.available_count);
  if (Number.isFinite(resetCredits) && resetCredits > 0) extras.push({ label: "可用重置次数", value: String(resetCredits) });
  const plan = j.plan_type ? String(j.plan_type) : null;
  return { id: "pi-codex", agent: "pi", name: "Codex", plan: plan ? plan[0].toUpperCase() + plan.slice(1) : null, email: j.email || null, rows, extras };
}

async function fetchDeepseekUsageSource() {
  let key = null;
  try {
    const models = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/models.json"), "utf8"));
    for (const [id, p] of Object.entries(models?.providers || {})) {
      if (id === "deepseek" || p?.baseUrl?.includes("api.deepseek.com")) {
        if (p.apiKey) {
          key = p.apiKey;
          break;
        }
      }
    }
  } catch {
    return null;
  }
  if (!key) return null;
  const r = await fetch("https://api.deepseek.com/user/balance", {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`deepseek balance ${r.status}`);
  const j = await r.json();
  const extras = [];
  let mini = null;
  for (const b of j.balance_infos || []) {
    const total = b.total_balance ?? b.totalBalance;
    if (total == null) continue;
    const cur = b.currency || "";
    const val = `${cur === "CNY" ? "¥" : cur === "USD" ? "$" : cur + " "}${total}`;
    if (!mini) mini = val;
    const detail = [b.topped_up_balance != null ? `充值 ${b.topped_up_balance}` : null, b.granted_balance != null ? `赠金 ${b.granted_balance}` : null].filter(Boolean).join(" · ");
    extras.push({ label: `余额 ${cur}`, value: val, sub: detail || undefined });
  }
  if (extras.length === 0) extras.push({ label: "余额", value: j.is_available ? "可用" : "不可用" });
  return { id: "pi-deepseek", agent: "pi", name: "DeepSeek", plan: "API", rows: [], extras, mini };
}

app.get("/api/account/usage", async (_req, res) => {
  if (Date.now() - _usageCache.at < 60_000 && _usageCache.data) return res.json(_usageCache.data);
  const fetchers = [fetchDevinUsageSource, fetchCodexUsageSource, fetchDeepseekUsageSource];
  const names = ["Devin", "Codex", "DeepSeek"];
  const settled = await Promise.allSettled(fetchers.map((f) => f()));
  const sources = settled
    .map((s, i) => {
      if (s.status === "rejected") return { id: `err-${i}`, name: names[i], error: String(s.reason?.message || s.reason), rows: [], extras: [] };
      return s.value;
    })
    .filter(Boolean);
  const data = { sources };
  _usageCache = { at: Date.now(), data };
  res.json(data);
});

// /api/fs/* exposes the host filesystem. With no token configured, a
// remote browser could browse arbitrary paths — restrict it to loopback
// clients in that case (loopback is all a 127.0.0.1 bind sees anyway).
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
app.use("/api/fs", (req, res, next) => {
  if (AUTH_TOKEN || LOOPBACK_IPS.has(req.ip)) return next();
  res.status(403).json({ error: "filesystem API requires loopback or DEVIN_WEB_TOKEN" });
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

// ---------- interactive terminals ----------
// A read-only preflight gives browsers a useful auth/workspace error before
// opening a WS (whose failed upgrade status browsers deliberately conceal).
app.get("/api/terminal", (req, res) => {
  const denied = terminalAccess(req, AUTH_TOKEN, TERMINAL_ORIGINS);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  try { res.json(terminals.status(req.query.cwd)); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
const activeSearches = new Set();
app.get("/api/sessions/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2 || q.length > 200) return res.status(400).json({ error: "搜索词需 2-200 字符" });
  const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 50));
  if (activeSearches.size >= 2) return res.status(429).json({ error: "搜索繁忙，请稍后再试" });
  const cwd = req.query.cwd ? path.resolve(expandHome(req.query.cwd)) : undefined;
  const settled = await Promise.allSettled([...hubs.values()].map((h) => h.listSessions(cwd)));
  const sessions = [];
  settled.forEach((r) => { if (r.status === "fulfilled") sessions.push(...r.value); });
  sessions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  const controller = new AbortController();
  req.on("close", () => controller.abort());
  const entry = controller;
  activeSearches.add(entry);
  try {
    const result = await searchTranscripts({ q, sessions, devinDbPath: devinDbPath(),
      piSessionsDir: getPiSessionsDir(), limit, signal: controller.signal });
    res.json(result);
  } finally {
    activeSearches.delete(entry);
  }
});
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
    const scratch = req.body.scratch === true;
    const agentId = req.body.agent || primary?.id;
    const h = hubs.get(agentId);
    if (!h) return res.status(400).json({ error: `unknown agent: ${agentId}` });
    let dir = null;
    let cwd = null;
    if (scratch) dir = cwd = createScratchDir(scratchRoot());
    else {
      cwd = path.resolve(expandHome(req.body.cwd || ""));
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        return res.status(400).json({ error: `not a directory: ${cwd}` });
      }
    }
    let created;
    try {
      created = await h.createSession(cwd, { scratch });
    } catch (e) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true }); // just-created, still empty
      throw e;
    }
    // Workspaces are shared and owned by the primary hub — a non-primary
    // hub's own addWorkspace only writes its private state file. Scratch
    // dirs are per-chat temporaries and never join the workspace list.
    if (!scratch && h !== hub) hub.addWorkspace(cwd);
    // pi injects the new row into its list cache (the session file doesn't
    // exist yet); devin's list is cheap to rebuild.
    if (h.devinExt) h.listCacheInvalidate();
    res.json(scratch ? { ...created, cwd: dir, scratch: true } : created);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, code: e.code });
  }
});

app.get("/api/sessions/:id/scratch", (req, res) => {
  const h = hubFor(req.params.id);
  if (!h.isScratch(req.params.id)) return res.status(404).json({ error: "not a scratch session" });
  const cwd = h.sessions.get(req.params.id)?.cwd || h.state.sessions[req.params.id]?.cwd;
  res.json(scratchInfo(cwd));
});

// Finish a quick chat: refuse while anything is in flight, release the
// session, optionally delete its scratch dir, then archive (history stays).
app.post("/api/sessions/:id/scratch/finish", async (req, res) => {
  try {
    const files = req.body?.files;
    if (files !== "keep" && files !== "delete")
      return res.status(400).json({ error: "files must be 'keep' or 'delete'" });
    const id = req.params.id;
    const h = hubFor(id);
    if (!h.isScratch(id)) return res.status(404).json({ error: "not a scratch session" });
    if (h.scratchBusy(id))
      return res.status(409).json({ error: "会话仍在运行或有待处理项，请稍后完成或停止后再结束" });
    const cwd = h.sessions.get(id)?.cwd || h.state.sessions[id]?.cwd;
    await h.closeSession(id); // {closed:false,"not attached"} is fine
    let removed = false;
    if (files === "delete") {
      if (cwd) removeScratchDir(scratchRoot(), cwd);
      removed = !fs.existsSync(cwd || "__missing__");
    }
    await h.setArchived(id, true);
    res.json({ ok: true, archived: true, removed });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, code: e.code });
  }
});

app.post("/api/sessions/:id/close", async (req, res) => {
  try {
    res.json(await hubFor(req.params.id).closeSession(req.params.id));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, code: e.code });
  }
});

app.post("/api/sessions/:id/rename", async (req, res) => {
  try {
    const title = String(req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "empty title" });
    const h = hubFor(req.params.id);
    await h.renameSession(req.params.id, title);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/archive", async (req, res) => {
  try {
    const h = hubFor(req.params.id);
    const r = await h.setArchived(req.params.id, !!req.body?.archived);
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sessions/:id/pin", async (req, res) => {
  try {
    const h = hubFor(req.params.id);
    const r = await h.setPinned(req.params.id, !!req.body?.pinned);
    res.json(r);
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

app.delete("/api/sessions/:id", (req, res) => {
  try {
    const h = hubFor(req.params.id);
    void h.deleteSession(req.params.id).catch(() => {});
    const { status } = h.deletionStatus(req.params.id);
    res.status(status === "deleted" ? 200 : 202).json({ ok: true, status });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/api/sessions/batch-delete", (req, res) => {
  try {
    const ids = [...new Set(Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string" && x).slice(0, 500) : [])];
    if (!ids.length) return res.status(400).json({ error: "ids required" });
    for (const id of ids) void hubFor(id).deleteSession(id).catch(() => {});
    res.status(202).json({ ok: true, status: "deleting" });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Read-only verification. Never infer success merely from a cached/filtered
// session list; receipts become "deleted" only after the actual agent RPC.
app.post("/api/sessions/delete-status", (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === "string" && id).slice(0, 500) : [];
    res.setHeader("Cache-Control", "no-store");
    res.json({ sessions: ids.map((id) => hubFor(id).deletionStatus(id)) });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

// Process reads never load a cold SDK session or spawn a command. Stop is an
// explicit single-session mutation and is never replayed on transport failure.
app.get("/api/sessions/:id/processes", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(hubFor(req.params.id).processes(req.params.id)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
});
app.get("/api/sessions/:id/processes/:processId/output", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(hubFor(req.params.id).processes(req.params.id, req.params.processId)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
});
app.post("/api/sessions/:id/processes/:processId/stop", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!req.params.processId || req.params.processId.length > 128) return res.status(400).json({ error: "后台任务 ID 无效" });
  if (req.aborted || res.destroyed) return;
  try { res.json(await hubFor(req.params.id).stopProcess(req.params.id, req.params.processId)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code, outcomeUnknown: !error.status || error.code === "PROCESS_STOP_UNKNOWN" }); }
});

// Read-only native tree/preview; no session/load, fork, cancellation or file rewrite.
app.get("/api/sessions/:id/tree", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(hubFor(req.params.id).sessionTree(req.params.id)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
});
app.get("/api/sessions/:id/tree/nodes/:nodeId", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try { res.json(hubFor(req.params.id).sessionTree(req.params.id, req.params.nodeId)); }
  catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
});
app.post("/api/sessions/:id/tree/navigate", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { targetId, version, summarize } = req.body || {};
  if (typeof targetId !== "string" || !targetId || targetId.length > 128 ||
      typeof version !== "string" || !/^[a-f0-9]{64}$/.test(version) ||
      (summarize !== undefined && typeof summarize !== "boolean"))
    return res.status(400).json({ error: "targetId/version/summarize 无效" });
  if (req.aborted || res.destroyed) return;
  try { res.json(await hubFor(req.params.id).navigateTree(req.params.id, { targetId, version, summarize })); }
  catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code, outcomeUnknown: !error.status }); }
});

app.get("/api/sessions/:id/history", (req, res) => {
  const hub = hubFor(req.params.id), s = hub.sessions.get(req.params.id);
  res.json({ events: hub.historyEvents(req.params.id), attached: !!s?.attached });
});

// Persisted message images (user uploads + tool results). Events carry a URL
// instead of base64 so multi-MB payloads can't push the transcript buffer
// over its byte budget; images are served lazily from sqlite on <img> load.
app.get("/api/sessions/:id/img/:mid/:idx", (req, res) => {
  const img = hubFor(req.params.id).sessionImage(req.params.id, req.params.mid, Number(req.params.idx) || 0);
  if (!img?.data) return res.status(404).end();
  if (req.query.encoding === "base64") {
    const body = JSON.stringify({ data: img.data, mimeType: img.mimeType });
    res.set("Cache-Control", "private, max-age=3600").set("X-Content-Type-Options", "nosniff").vary("Accept-Encoding");
    if (body.length >= 1024 && req.acceptsEncodings("gzip", "identity") === "gzip") {
      gzip(body, { level: 3 }, (error, compressed) => {
        if (res.destroyed) return;
        if (error) return res.status(500).json({ error: "读取原始图片失败" });
        res.type("application/json").set("Content-Encoding", "gzip").end(compressed);
      });
      return;
    }
    return res.type("application/json").end(body);
  }
  res
    .setHeader("Content-Type", img.mimeType)
    .setHeader("X-Content-Type-Options", "nosniff")
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
  // Raw documents must not become active same-origin application pages.
  // Interactive reports use the dedicated opaque preview instead.
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file, { acceptRanges: false }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

filePreviewRoutes(app, hubFor);

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
  noServer: true,
  perMessageDeflate: HISTORY_COMPRESSION,
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

const remoteWss = remotes ? remoteWebSocketServer({ manager: remotes, token: AUTH_TOKEN, origins: TERMINAL_ORIGINS, currentBuild }) : null;
const terminalWss = terminalWebSocketServer({ hub: terminals, token: AUTH_TOKEN, origins: TERMINAL_ORIGINS });
server.on("upgrade", (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, "http://localhost").pathname; }
  catch { return socket.destroy(); }
  if (remoteWss && pathname.startsWith("/ws/remotes/")) return void remoteWss.upgrade(req, socket, head);
  const target = pathname === "/ws" ? wss : pathname === "/ws/terminal" ? terminalWss : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});
process.once("exit", () => { terminals.dispose(); remotes?.dispose(); });

// Hash of the currently-served bundle — read per connect so a redeployed
// dist advertises itself without a server restart. Clients compare it to
// their own <script> tag and reload when the build moved on.
function currentBuild() {
  try {
    const html = fs.readFileSync(path.join(WEB_DIST, "index.html"), "utf8");
    return html.match(/assets\/index-([^.]+)\.js/)?.[1] || null;
  } catch { return null; }
}

const serverInstanceId = randomUUID();
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.send(JSON.stringify({ type: "hello", build: currentBuild(), instanceId: serverInstanceId, caps: { promptAck: true, dedupMs: 86400000 } }));

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
          const supportedEncodings = [HISTORY_ENCODING_V2, HISTORY_ENCODING];
          ws.historyEncoding = msg.historyEncoding === null ? null :
            supportedEncodings.find((encoding) => Array.isArray(msg.historyEncodings) && msg.historyEncodings.includes(encoding)) ||
            (supportedEncodings.includes(msg.historyEncoding) ? msg.historyEncoding : null);
          const subscribedAt = Date.now();
          const h = hubFor(msg.sessionId);
          const s = h.subscribe(ws, msg.sessionId, msg.cwd);
          // pi aggregate stats ride alongside history — pushed separately so
          // attach-broadcast paths (which skip sendReady) don't starve them.
          h.statsFor(msg.sessionId).then((stats) => {
            if (stats) reply({ type: "session_stats", sessionId: msg.sessionId, stats });
          });
          let sent = false;
          const sendReady = async () => {
            if (sent) return;
            sent = true;
            // Skip re-sending a history this socket just received via the
            // attach/mirror broadcast (it fired AFTER we subscribed, so the
            // socket was in the target set). Only the permission replay below
            // is still needed in that case.
            const bc = s.lastHistoryBC;
            const alreadyBroadcast =
              bc && bc.gen === s.gen && bc.len === s.events.length && bc.revision === s.eventRevision && bc.at >= subscribedAt;
            if (!alreadyBroadcast) {
              const stats = s.stats || (await h.statsFor(msg.sessionId));
              if (ws.readyState === 1) ws.send(h.historyFrame({
                type: "history",
                sessionId: msg.sessionId,
                title: h.state.sessions[msg.sessionId]?.customTitle || s.title || h.state.sessions[msg.sessionId]?.title || null,
                events: h.historyEvents(msg.sessionId),
                revision: s.eventRevision,
                attached: s.attached,
                gen: s.gen,
                state: h.stateOf(msg.sessionId),
                processes: h.acp.getProcessSummary?.(msg.sessionId),
                modes: s.modes,
                configOptions: s.configOptions,
                availableCommands: s.commands || h.commandsByCwd.get(s.cwd),
                usage: s.usage || h.usageById.get(msg.sessionId),
                stats,
                queue: h.queueView?.(msg.sessionId) ?? [],
                pendingPermissionIds: [...s.pendingPermissions.values()].map((p) => p.requestId),
                pendingElicitationIds: [...s.pendingElicitations.values()].map((e) => e.requestId),
              }, { encoding: ws.historyEncoding, knownToken: typeof msg.historyToken === "string" && msg.historyToken.length < 160 ? msg.historyToken : null,
                baseToken: typeof msg.historyBaseToken === "string" && msg.historyBaseToken.length < 160 ? msg.historyBaseToken : null }));
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
            for (const e of s.pendingElicitations.values()) {
              reply({
                type: "elicitation_request",
                sessionId: msg.sessionId,
                requestId: e.requestId,
                agent: h.agent,
                message: e.params?.message,
                schema: e.params?.requestedSchema,
                toolCallId: e.params?.toolCallId || null,
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
          // the attach already resolved. For mirror-less agents (pi) an empty
          // buffer must NOT be pushed — it folds to a blank transcript over
          // real content; the attach-resolve broadcast covers the wait.
          setTimeout(() => {
            if (!s.attached && s.mirrorMaxRow == null && s.events.length) sendReady();
          }, 4000);
          break;
        }
        case "unsubscribe":
          for (const h of hubs.values()) h.unsubscribe(ws, msg.sessionId);
          break;
        case "watch":
          for (const h of hubs.values()) h.allSubscribers.add(ws);
          break;
        case "prompt_status":
          reply({ type: "prompt_delivery", sessionId: msg.sessionId, ...hubFor(msg.sessionId).promptStatus(msg.sessionId, msg.requestId) });
          break;
        case "prompt": {
          const blocks = (msg.blocks || []).length
            ? msg.blocks
            : [{ type: "text", text: msg.text || "" }];
          const h = hubFor(msg.sessionId);
          const work = h.submitPrompt(msg.sessionId, msg.cwd, blocks, msg.requestId);
          if (msg.requestId) reply({ type: "prompt_delivery", sessionId: msg.sessionId, ...h.promptStatus(msg.sessionId, msg.requestId) });
          const result = await work;
          reply({ type: "prompt_result", sessionId: msg.sessionId, ...result,
            ...(msg.requestId ? h.promptStatus(msg.sessionId, msg.requestId) : {}) });
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
        case "elicitation_response":
          for (const h of hubs.values())
            if (h.elicitationResponse(msg.requestId, msg.action, msg.content)) break;
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
      reply({ type: "error", sessionId: msg.sessionId, op: msg.type, requestId: msg.requestId, error: e.message });
    }
  });

  ws.on("close", () => {
    for (const h of hubs.values()) h.dropSocket(ws);
  });
});

// Push the new build to ALREADY-connected clients — a phone WebView holds its
// WS open and would never see a connect-time hello otherwise. index.html is
// written last by vite, so watching it marks a finished build.
let buildWatchTimer = null;
try {
  fs.watch(path.join(WEB_DIST, "index.html"), () => {
    clearTimeout(buildWatchTimer);
    buildWatchTimer = setTimeout(() => {
      const build = currentBuild();
      if (!build) return;
      for (const ws of wss.clients) {
        try { ws.send(JSON.stringify({ type: "hello", build, instanceId: serverInstanceId, caps: { promptAck: true, dedupMs: 86400000 } })); } catch {}
      }
    }, 800);
  });
} catch {}

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

// Listen failures (e.g. port in use) surface as an async 'error' event —
// ws forwards them onto wss too, and an 'error' event with no listener
// becomes an uncaughtException that our trap above would swallow, leaving
// a serving-nothing process behind. Exit explicitly instead.
for (const target of [server, wss, terminalWss, ...(remoteWss ? [remoteWss.wss] : [])]) {
  target.on("error", (e) => {
    console.error(`[devin-web] server error (${HOST}:${PORT}):`, e.message);
    process.exit(1);
  });
}
server.listen(PORT, HOST, () => {
  if (WORKER && process.env.DEVIN_WEB_WORKER_RUNTIME) {
    const file = process.env.DEVIN_WEB_WORKER_RUNTIME;
    fs.writeFileSync(file + ".tmp", JSON.stringify({ pid: process.pid, port: server.address().port,
      version: process.env.DEVIN_WEB_WORKER_VERSION, instanceId: serverInstanceId }), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }
  console.log(`devin-web server listening on http://${HOST}:${server.address().port}`);
  if (!AUTH_TOKEN && !["127.0.0.1", "::1", "localhost"].includes(HOST)) {
    console.warn(
      `[devin-web] WARNING: listening on ${HOST} without DEVIN_WEB_TOKEN — ` +
      `anyone who can reach this port can create/prompt sessions. ` +
      `(/api/fs is loopback-only; set DEVIN_WEB_TOKEN for real auth.)`
    );
  }
  if (hubs.has("pi")) {
    // The in-process SDK and the pi CLI share ~/.pi/agent — warn early if
    // they drift apart (session jsonl/extensions may not round-trip).
    execFile("pi", ["--version"], { timeout: 10_000 }, (e, stdout) => {
      if (e) return; // no CLI on PATH — the SDK works without it
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      const cliV = m?.[1];
      if (cliV && cliV !== PI_SDK_VERSION)
        console.warn(
          `[devin-web] pi CLI v${cliV} ≠ bundled SDK v${PI_SDK_VERSION} — ` +
          `session/config formats may drift; consider aligning versions`
        );
    });
  }
  // pi-ask is installed by pi's own package manager — an upgrade silently
  // wipes our ask_user patch. Re-apply on every boot; the script is
  // idempotent, so this is a cheap marker check when already patched.
  if (hubs.has("pi")) {
    execFile(
      process.execPath,
      [path.join(ROOT, "server", "scripts", "patch-pi-ask.mjs")],
      (e, stdout, stderr) => {
        const out = `${stdout}${stderr}`.trim();
        if (out) console.log(`[patch-pi-ask] ${out}`);
        if (e) console.warn(`[patch-pi-ask] FAILED — pi ask_user unavailable until repatched: ${e.message}`);
      }
    );
  }
  // Warm each agent (spawn + first list) so the first /api/sessions isn't
  // stuck behind pi-acp's cold start. Cache fills in the background.
  for (const h of hubs.values()) h.listSessions(undefined, { fresh: true }).catch(() => {});
});

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[devin-web] ${sig} — shutting down`);
    terminals.dispose(); remotes?.dispose();
    // Tell browsers so they can show a banner instead of a dead socket.
    for (const ws of wss.clients) {
      try {
        ws.send(JSON.stringify({ type: "server_shutdown" }));
      } catch {
      }
    }
    // Give sessions a moment to abort + dispose (pi SDK teardown is async);
    // hard-exit if teardown wedges.
    const deadline = setTimeout(() => process.exit(0), 4_000);
    Promise.allSettled(
      [...hubs.values()].map((h) => Promise.resolve(h.acp.kill()))
    ).then(() => {
      clearTimeout(deadline);
      process.exit(0);
    });
  });
}
