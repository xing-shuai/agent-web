// Vendored from pi-acp 0.0.34 (https://github.com/svkozak/pi-acp, MIT,
// (c) 2025 Sergii Kozak — full license text in ./PI_ACP_LICENSE).
//
// Local modifications for devin-web's in-process pi SDK transport:
//  - stdio/NDJSON bootstrap removed; PiAcpAgent is exported and driven
//    directly by PiSdkClient (./pi-sdk-client.js).
//  - PiRpcProcess / PiRpcSpawnError / pi-command resolution and the
//    child_process/readline/cross-spawn plumbing deleted — sessions run
//    on PiSdkProcess (./pi-sdk-process.js) instead of `pi --mode rpc`
//    subprocesses.
//  - closeAllExcept() and both call sites removed: multiple pi sessions
//    run concurrently inside this process now.
//  - The session registry is renamed SessionManager -> PiSessionRegistry
//    (the pi SDK has its own SessionManager).
//  - The session-dir walks (listPiSessions / findPiSession + helpers)
//    are async — the sync walk froze the whole server in-process.
//  - closeSession() added for session/close (idle detach).
//  - __devin_elicitation_patch carried over: extension input/editor
//    requests route through unstable_createElicitation.
//  - Remaining sync fs/spawn work made async too: loadSlashCommands /
//    /export / deleteSession file ops, and /changelog resolves the SDK's
//    own package dir (no `which pi` / `npm root -g` spawnSync — those
//    froze the whole server for ~1s each).
import { PiSdkProcess } from "./pi-sdk-process.js";
import { readFile as readFileAsync, readdir as readdirAsync, unlink as unlinkAsync } from "node:fs/promises";
import { promisify as promisify2 } from "node:util";

// src/acp/agent.ts
import {
  RequestError as RequestError3
} from "@agentclientprotocol/sdk";

// src/acp/auth.ts
var PI_SETUP_METHOD_ID = "pi_terminal_login";
function getAuthMethods(opts) {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;
  const method = {
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    description: "Start pi in an interactive terminal to configure API keys or login",
    // Registry-required fields
    type: "terminal",
    args: ["--terminal-login"],
    env: {}
  };
  if (supportsTerminalAuthMeta) {
    const launch = terminalAuthLaunchSpec();
    method._meta = {
      ...method._meta ?? {},
      "terminal-auth": {
        ...launch,
        label: "Launch pi"
      }
    };
  }
  return [method];
}
function terminalAuthLaunchSpec() {
  const argv0 = process.argv[0] || "node";
  const argv1 = process.argv[1];
  if (argv1 && argv0) {
    const isNode = argv0.includes("node");
    const isJs = argv1.endsWith(".js");
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, "--terminal-login"] };
    }
  }
  return { command: "pi-acp", args: ["--terminal-login"] };
}

var SESSION_STATS_TIMEOUT_MS = 1e3;

// src/acp/session.ts
import { RequestError as RequestError2 } from "@agentclientprotocol/sdk";
import { readFileSync as readFileSync3 } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";

// src/acp/auth-required.ts
import { RequestError } from "@agentclientprotocol/sdk";
function maybeAuthRequiredError(err) {
  const msg = String(err?.message ?? err ?? "");
  const s = msg.toLowerCase();
  const patterns = [
    "api key",
    "apikey",
    "missing key",
    "no key",
    "not configured",
    "unauthorized",
    "authentication",
    "permission denied",
    "forbidden",
    "401",
    "403"
  ];
  const hit = patterns.some((p) => s.includes(p));
  if (!hit) return null;
  return RequestError.authRequired(
    {
      authMethods: getAuthMethods()
    },
    "Configure an API key or log in with an OAuth provider."
  );
}

// src/acp/session-store.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// src/acp/paths.ts
import { homedir } from "os";
import { join } from "path";
function getPiAcpDir() {
  return join(homedir(), ".pi", "pi-acp");
}
function getPiAcpSessionMapPath() {
  return join(getPiAcpDir(), "session-map.json");
}

// src/acp/session-store.ts
function ensureParentDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}
function loadFile(path) {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.sessions !== "object" || !parsed.sessions) {
      return { version: 1, sessions: {} };
    }
    return parsed;
  } catch {
    return { version: 1, sessions: {} };
  }
}
function saveFile(path, data) {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
var SessionStore = class {
  path;
  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path;
  }
  get(sessionId) {
    const db = loadFile(this.path);
    return db.sessions[sessionId] ?? null;
  }
  upsert(entry) {
    const db = loadFile(this.path);
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    saveFile(this.path, db);
  }
  delete(sessionId) {
    const db = loadFile(this.path);
    if (!db.sessions[sessionId]) return;
    delete db.sessions[sessionId];
    saveFile(this.path, db);
  }
};

// src/acp/slash-commands.ts
import { existsSync, readdirSync, readFileSync as readFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2, resolve } from "path";
function parseFrontmatter(content) {
  const frontmatter = {};
  if (!content.startsWith("---")) return { frontmatter, content };
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter, content };
  const frontmatterBlock = content.slice(4, endIndex);
  const remaining = content.slice(endIndex + 4).trim();
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2].trim();
  }
  return { frontmatter, content: remaining };
}
async function loadCommandsFromDir(dir, source, subdir = "") {
  const commands = [];
  try {
    const entries = await readdirAsync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join2(dir, entry.name);
      if (entry.isDirectory()) {
        const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
        commands.push(...await loadCommandsFromDir(fullPath, source, newSubdir));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const rawContent = await readFileAsync(fullPath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(rawContent);
        const name = entry.name.slice(0, -3);
        const sourceStr = source === "user" ? subdir ? `(user:${subdir})` : "(user)" : subdir ? `(project:${subdir})` : "(project)";
        let description = frontmatter.description || "";
        if (!description) {
          const firstLine = content.split("\n").find((l) => l.trim());
          if (firstLine) {
            description = firstLine.slice(0, 60);
            if (firstLine.length > 60) description += "...";
          }
        }
        description = description ? `${description} ${sourceStr}` : sourceStr;
        commands.push({
          name,
          description,
          content,
          source: sourceStr
        });
      } catch {
      }
    }
  } catch {
  }
  return commands;
}
async function loadSlashCommands(cwd) {
  const commands = [];
  const userDir = join2(homedir2(), ".pi", "agent", "prompts");
  const projectDir = resolve(cwd, ".pi", "prompts");
  commands.push(...await loadCommandsFromDir(userDir, "user"));
  commands.push(...await loadCommandsFromDir(projectDir, "project"));
  return commands;
}
function toAvailableCommands(fileCommands) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const c of fileCommands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: c.description
      // input: omitted for now (pi commands don't specify this)
    });
  }
  return out;
}
function parseCommandArgs(argsString) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "	") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
function substituteArgs(content, args) {
  let result = content;
  result = result.replace(/\$@/g, args.join(" "));
  result = result.replace(/\$(\d+)/g, (_m, num) => {
    const idx = Number.parseInt(String(num), 10) - 1;
    return args[idx] ?? "";
  });
  return result;
}
function expandSlashCommand(text, fileCommands) {
  if (!text.startsWith("/")) return text;
  const spaceIndex = text.indexOf(" ");
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
  const cmd = fileCommands.find((c) => c.name === commandName);
  if (!cmd) return text;
  const args = parseCommandArgs(argsString);
  return substituteArgs(cmd.content, args);
}

// src/acp/translate/bash.ts
function isBashTool(toolName) {
  return toolName.toLowerCase() === "bash";
}
function bashCommand(value) {
  const record = value;
  const command = record?.command ?? record?.cmd ?? record?.args?.command ?? record?.args?.cmd ?? record?.input?.command ?? record?.input?.cmd ?? record?.rawInput?.command ?? record?.rawInput?.cmd ?? record?.toolInput?.command ?? record?.toolInput?.cmd ?? record?.details?.command ?? record?.details?.cmd;
  return typeof command === "string" && command.trim() ? command : void 0;
}
function bashResultText(result) {
  const record = result;
  const content = record?.content;
  if (Array.isArray(content)) {
    const texts = content.map((c) => {
      const block = c;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    }).filter(Boolean);
    if (texts.length) return texts.join("");
  }
  const details = record?.details;
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof record?.stdout === "string" ? record.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof record?.output === "string" ? record.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof record?.stderr === "string" ? record.stderr : void 0);
  return [stdout, stderr].filter((part) => typeof part === "string" && part.length > 0).join("\n");
}
function bashExitCode(result, isError) {
  const record = result;
  const details = record?.details;
  const exitCode = details?.exitCode ?? record?.exitCode ?? details?.code ?? record?.code;
  return typeof exitCode === "number" ? exitCode : isError ? 1 : 0;
}
function bashOutputDelta(previous, next) {
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}
function bashTerminalContent(toolCallId) {
  return [{ type: "terminal", terminalId: toolCallId }];
}
function bashTerminalInfoMeta(toolCallId, cwd) {
  return { terminal_info: { terminal_id: toolCallId, cwd } };
}
function bashTerminalOutputMeta(toolCallId, data) {
  return { terminal_output: { terminal_id: toolCallId, data } };
}
function bashTerminalExitMeta(toolCallId, exitCode) {
  return { terminal_exit: { terminal_id: toolCallId, exit_code: exitCode, signal: null } };
}

// src/acp/translate/pi-tools.ts
function toolResultToText(result) {
  if (!result) return "";
  const details = result?.details;
  const diff = details?.diff;
  if (typeof diff === "string" && diff.trim()) {
    return diff;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    const texts = content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean);
    if (texts.length) return texts.join("");
  }
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof result?.stdout === "string" ? result.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof result?.output === "string" ? result.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof result?.stderr === "string" ? result.stderr : void 0);
  const exitCode = (typeof details?.exitCode === "number" ? details.exitCode : void 0) ?? (typeof result?.exitCode === "number" ? result.exitCode : void 0) ?? (typeof details?.code === "number" ? details.code : void 0) ?? (typeof result?.code === "number" ? result.code : void 0);
  if (typeof stdout === "string" && stdout.trim() || typeof stderr === "string" && stderr.trim()) {
    const parts = [];
    if (typeof stdout === "string" && stdout.trim()) parts.push(stdout);
    if (typeof stderr === "string" && stderr.trim()) parts.push(`stderr:
${stderr}`);
    if (typeof exitCode === "number") parts.push(`exit code: ${exitCode}`);
    return parts.join("\n\n").trimEnd();
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// src/acp/session.ts
var CONFIRM_PERMISSION_OPTIONS = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" }
];
var EXTENSION_UI_RAW_INPUT_KEYS = ["title", "message", "options", "placeholder", "prefill"];
var CHOICE_OPTION_PREFIX = "choice-";
function toUsageUpdate(stats) {
  const used = stats?.contextUsage?.tokens;
  const size = stats?.contextUsage?.contextWindow;
  if (typeof used !== "number" || !Number.isSafeInteger(used) || used < 0) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return null;
  return { sessionUpdate: "usage_update", used, size };
}
function findUniqueLineNumber(text, needle) {
  if (!needle) return void 0;
  const first = text.indexOf(needle);
  if (first < 0) return void 0;
  const second = text.indexOf(needle, first + needle.length);
  if (second >= 0) return void 0;
  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
function getToolPath(args) {
  const record = args;
  if (typeof record?.path === "string") return record.path;
  if (typeof record?.file_path === "string") return record.file_path;
  return void 0;
}
function getParsedEdits(args) {
  const record = args;
  const parsed = [];
  if (typeof record?.oldText === "string" && typeof record?.newText === "string") {
    parsed.push({ oldText: record.oldText, newText: record.newText });
  }
  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = void 0;
    }
  }
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit;
      if (typeof item?.oldText === "string" && typeof item?.newText === "string") {
        parsed.push({ oldText: item.oldText, newText: item.newText });
      }
    }
  }
  return parsed;
}
function getEditOldTexts(args) {
  const record = args;
  const oldTexts = getParsedEdits(args).map((edit) => edit.oldText);
  if (typeof record?.oldText === "string" && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText);
  let edits = record?.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      edits = void 0;
    }
  }
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = edit?.oldText;
      if (typeof oldText === "string" && !oldTexts.includes(oldText)) oldTexts.push(oldText);
    }
  }
  return oldTexts;
}
function toToolCallLocations(args, cwd, line) {
  const path = getToolPath(args);
  if (!path) return void 0;
  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  return [{ path: resolvedPath, ...typeof line === "number" ? { line } : {} }];
}
var PiSessionRegistry = class {
  sessions = /* @__PURE__ */ new Map();
  store = new SessionStore();
  /**
   * Dispose all sessions — aborts in-flight turns and awaits each proc's
   * async teardown. Used on server shutdown.
   */
  async disposeAll() {
    for (const id of [...this.sessions.keys()]) {
      const s = this.sessions.get(id);
      if (!s) continue;
      try {
        await s.proc.abort?.();
      } catch {
      }
      try {
        await s.proc.dispose?.();
      } catch {
      }
      this.sessions.delete(id);
    }
  }
  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId) {
    return this.sessions.get(sessionId);
  }
  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      // proc.dispose() is async — fire and forget here; disposeAll()
      // awaits teardown when ordering matters (shutdown).
      void s.proc.dispose?.();
    } catch {
    }
    this.sessions.delete(sessionId);
  }
  async create(params) {
    const proc = await PiSdkProcess.create({ cwd: params.cwd });
    let state = null;
    try {
      state = await proc.getState();
    } catch {
      state = null;
    }
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : crypto.randomUUID();
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile });
    }
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    });
    this.sessions.set(sessionId, session);
    return session;
  }
  get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw RequestError2.invalidParams(`Unknown sessionId: ${sessionId}`);
    return s;
  }
  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId, params) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    });
    this.sessions.set(sessionId, session);
    return session;
  }
};
var PiAcpSession = class {
  sessionId;
  cwd;
  mcpServers;
  startupInfo = null;
  startupInfoSent = false;
  proc;
  conn;
  fileCommands;
  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  cancelRequested = false;
  // Current in-flight turn (if any). Additional prompts are queued.
  pendingTurn = null;
  turnQueue = [];
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  currentToolCalls = /* @__PURE__ */ new Map();
  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  inAgentLoop = false;
  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  fileSnapshots = /* @__PURE__ */ new Map();
  fileMutationToolCallIds = /* @__PURE__ */ new Set();
  bashToolCallIds = /* @__PURE__ */ new Set();
  bashOutputSnapshots = /* @__PURE__ */ new Map();
  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  lastEmit = Promise.resolve();
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.fileCommands = opts.fileCommands ?? [];
    // devin-web: in-process — a throwing handler would otherwise propagate
    // into the SDK's event dispatch and hit uncaughtException, taking down
    // the whole server.
    this.proc.onEvent((ev) => {
      try {
        this.handlePiEvent(ev);
      } catch (e) {
        console.error(`[pi-sdk] handlePiEvent threw for ${this.sessionId}:`, e);
      }
    });
  }
  setStartupInfo(text) {
    this.startupInfo = text;
    this.startupInfoSent = false;
  }
  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending() {
    if (this.startupInfoSent || !this.startupInfo) return;
    this.startupInfoSent = true;
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo }
    });
  }
  async prompt(message, images = []) {
    const expandedMessage = expandSlashCommand(message, this.fileCommands);
    const turnPromise = new Promise((resolve4, reject) => {
      const queued = { message: expandedMessage, images, resolve: resolve4, reject };
      if (this.pendingTurn) {
        this.turnQueue.push(queued);
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        });
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        });
        return;
      }
      this.startTurn(queued);
    });
    return turnPromise;
  }
  async cancel() {
    this.cancelRequested = true;
    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const t of queued) t.resolve("cancelled");
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." }
      });
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      });
    }
    await this.proc.abort();
  }
  wasCancelRequested() {
    return this.cancelRequested;
  }
  emit(update) {
    this.lastEmit = this.lastEmit.then(
      () => this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update
      })
    ).catch(() => {
    });
  }
  async flushEmits() {
    await this.lastEmit;
  }
  /**
   * Best-effort: publish the real pi context-window occupancy as ACP `usage_update`.
   * Queued updates are flushed even when the stats query fails or times out, so callers
   * can await this before resolving `session/prompt`.
   */
  async publishContextUsage() {
    try {
      if (typeof this.proc.getSessionStats === "function") {
        const update = toUsageUpdate(await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS));
        if (update) this.emit(update);
      }
    } catch {
    }
    await this.flushEmits();
  }
  async settleTurn() {
    await this.publishContextUsage();
    const reason = this.cancelRequested ? "cancelled" : "end_turn";
    this.pendingTurn?.resolve(reason);
    this.pendingTurn = null;
    this.inAgentLoop = false;
    const next = this.turnQueue.shift();
    if (next) {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Starting queued message. (${this.turnQueue.length} remaining)` }
      });
      this.startTurn(next);
    } else {
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: false } }
      });
    }
  }
  emitBashToolCall(params) {
    this.bashToolCallIds.add(params.toolCallId);
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: "execute",
      status: params.status,
      locations: params.locations,
      ...params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {},
      ...params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {}
    });
  }
  emitBashOutputUpdate(params) {
    const text = bashResultText(params.result);
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? "";
    const delta = bashOutputDelta(previous, text);
    this.bashOutputSnapshots.set(params.toolCallId, text);
    this.emit({
      sessionUpdate: "tool_call_update",
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {},
        ...params.status === "completed" || params.status === "failed" ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError))) : {}
      }
    });
  }
  cleanupToolCall(toolCallId) {
    this.currentToolCalls.delete(toolCallId);
    this.fileSnapshots.delete(toolCallId);
    this.fileMutationToolCallIds.delete(toolCallId);
    this.bashToolCallIds.delete(toolCallId);
    this.bashOutputSnapshots.delete(toolCallId);
  }
  startTurn(t) {
    this.cancelRequested = false;
    this.inAgentLoop = false;
    this.pendingTurn = { resolve: t.resolve, reject: t.reject };
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    });
    this.proc.prompt(t.message, t.images).catch((err) => {
      void this.flushEmits().finally(() => {
        const authErr = maybeAuthRequiredError(err);
        if (authErr) {
          this.pendingTurn?.reject(authErr);
        } else {
          const reason = this.cancelRequested ? "cancelled" : "error";
          this.pendingTurn?.resolve(reason);
        }
        this.pendingTurn = null;
        this.inAgentLoop = false;
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        });
      });
      void err;
    });
  }
  handlePiEvent(ev) {
    const type = String(ev.type ?? "");
    switch (type) {
      case "message_update": {
        const ame = ev.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "toolcall_start" || ame?.type === "toolcall_delta" || ame?.type === "toolcall_end") {
          const toolCall = (
            // pi sometimes includes the tool call directly on the event
            ame?.toolCall ?? // ...and always includes it in the partial assistant message at contentIndex
            ame?.partial?.content?.[ame?.contentIndex ?? 0]
          );
          const toolCallId = String(toolCall?.id ?? "");
          const toolName = String(toolCall?.name ?? "tool");
          if (toolCallId) {
            const rawInput = toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : (() => {
              const s = String(toolCall?.partialArgs ?? "");
              if (!s) return void 0;
              try {
                return JSON.parse(s);
              } catch {
                return { partialArgs: s };
              }
            })();
            const locations = toToolCallLocations(rawInput, this.cwd);
            const existingStatus = this.currentToolCalls.get(toolCallId);
            const status = existingStatus ?? "pending";
            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, "pending");
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              });
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, "pending");
              this.emit({
                sessionUpdate: "tool_call",
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              });
            } else {
              this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status,
                locations,
                rawInput
              });
            }
          }
          break;
        }
        break;
      }
      case "tool_execution_start": {
        const toolCallId = String(ev.toolCallId ?? crypto.randomUUID());
        const toolName = String(ev.toolName ?? "tool");
        const args = ev.args;
        let line;
        if (isBashTool(toolName)) {
          const locations2 = toToolCallLocations(args, this.cwd);
          const existingStatus = this.currentToolCalls.get(toolCallId);
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? "tool_call_update" : "tool_call",
            toolCallId,
            toolName,
            args,
            status: "in_progress",
            locations: locations2,
            includeTerminal: !existingStatus
          });
          break;
        }
        const isFileMutation = toolName === "edit" || toolName === "write";
        let snapshotOldText;
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId);
          const p = getToolPath(args);
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
              snapshotOldText = readFileSync3(abs, "utf8");
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText });
              if (toolName === "edit") {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle);
                  if (typeof line === "number") break;
                }
              }
            } catch {
              snapshotOldText = null;
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null });
            }
          }
        }
        const locations = toToolCallLocations(args, this.cwd, line);
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: args
          });
        } else {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            locations,
            rawInput: args
          });
        }
        break;
      }
      case "tool_execution_update": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        const partial = ev.partialResult;
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: "in_progress", result: partial });
          break;
        }
        const text = this.fileMutationToolCallIds.has(toolCallId) ? "" : toolResultToText(partial);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content: text ? [{ type: "content", content: { type: "text", text } }] : void 0,
          ...this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial }
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        const result = ev.result;
        const isError = Boolean(ev.isError);
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? "failed" : "completed",
            result,
            isError
          });
          this.cleanupToolCall(toolCallId);
          break;
        }
        const text = toolResultToText(result);
        const snapshot = this.fileSnapshots.get(toolCallId);
        let content;
        let hasStructuredDiff = false;
        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path);
            const newText = readFileSync3(abs, "utf8");
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true;
              content = [
                {
                  type: "diff",
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ];
            }
          } catch {
          }
        }
        if (!content && !hasStructuredDiff && text) {
          content = [{ type: "content", content: { type: "text", text } }];
        }
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content,
          ...hasStructuredDiff ? {} : { rawOutput: result }
        });
        this.cleanupToolCall(toolCallId);
        break;
      }
      case "extension_ui_request": {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, "id");
          if (!id) {
            return;
          }
          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {
          });
        });
        break;
      }
      case "auto_retry_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatAutoRetryMessage(ev) }
        });
        break;
      }
      case "auto_retry_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retry finished, resuming." }
        });
        break;
      }
      case "auto_compaction_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Context nearing limit, running automatic compaction..."
          }
        });
        break;
      }
      case "auto_compaction_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Automatic compaction finished; context was summarized to continue the session."
          }
        });
        break;
      }
      case "agent_start": {
        this.inAgentLoop = true;
        break;
      }
      case "turn_end": {
        break;
      }
      case "agent_end": {
        this.inAgentLoop = false;
        break;
      }
      case "agent_settled": {
        void this.settleTurn();
        break;
      }
      default:
        break;
    }
  }
  async handleExtensionUiRequest(ev) {
    const id = stringProp(ev, "id");
    const method = stringProp(ev, "method");
    if (!id) {
      return;
    }
    if (method === "select") {
      await this.handleExtensionSelect(ev, id);
      return;
    }
    if (method === "confirm") {
      await this.handleExtensionConfirm(ev, id);
      return;
    }
    if (method === "input" || method === "editor") {
      // __devin_elicitation_patch: route free-form input through elicitation/create so ACP
      // clients can render an answer card instead of auto-cancelling.
      try {
        const elicTitle = stringProp(ev, "title") ?? stringProp(ev, "message") ?? `Pi ${method}`;
        const elicRes = await this.conn.unstable_createElicitation({
          sessionId: this.sessionId,
          message: stringProp(ev, "message") ?? elicTitle,
          mode: "form",
          requestedSchema: {
            type: "object",
            title: elicTitle,
            properties: {
              value: {
                type: "string",
                title: elicTitle,
                description: stringProp(ev, "placeholder") ?? undefined,
                default: stringProp(ev, "prefill") ?? undefined
              }
            },
            required: ["value"]
          }
        });
        const elicVal = elicRes?.action === "accept" ? elicRes?.content?.value : null;
        await this.proc.sendExtensionUiResponse(elicVal == null ? { id, cancelled: true } : { id, value: String(elicVal) });
      } catch {
        await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      }
      return;
    }
    if (method === "notify") {
      // devin-web: extension ui.notify is a transient notice — route it to
      // the client as a toast (agent_notification), not a permanent
      // transcript bubble. e.g. remote-pi's relay/mesh status chatter
      // fired on every session load and polluted history.
      if (typeof this.conn.notify === "function") {
        this.conn.notify({
          sessionId: this.sessionId,
          level: stringProp(ev, "notifyType") ?? "info",
          text: stringProp(ev, "message") ?? "Pi notification"
        });
      } else {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: stringProp(ev, "message") ?? "Pi notification" },
          _meta: { piAcp: { notify: { level: stringProp(ev, "notifyType") ?? "info" } } }
        });
      }
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    await this.proc.sendExtensionUiResponse({ id, cancelled: true });
  }
  async handleExtensionSelect(ev, id) {
    const rawOptions = ev.options;
    const options = Array.isArray(rawOptions) ? rawOptions.map((option) => String(option)) : [];
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    const permissionOptions = options.map((name, index2) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index2}`,
      name,
      kind: "allow_once"
    }));
    const selected = await this.requestExtensionPermission(id, ev, permissionOptions);
    if (selected === null) {
      return;
    }
    const selectedOptionId = selected.outcome.outcome === "selected" ? selected.outcome.optionId : null;
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId);
    const value = index === null ? null : options.at(index) ?? null;
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value });
  }
  async handleExtensionConfirm(ev, id) {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS);
    if (selected === null) {
      return;
    }
    if (selected.outcome.outcome === "cancelled") {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === "yes" });
  }
  async requestExtensionPermission(id, ev, options) {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      });
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return null;
    }
  }
};
function extensionUiToolCall(id, ev) {
  const method = stringProp(ev, "method") ?? "ui";
  const title = stringProp(ev, "title") ?? `Pi ${method}`;
  const rawInput = { method };
  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key];
  }
  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: "other",
    status: "pending",
    rawInput
  };
}
function stringProp(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : null;
}
function optionIndex(optionId) {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null;
  }
  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length);
  if (!rawIndex) {
    return null;
  }
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null;
}
function formatAutoRetryMessage(ev) {
  const attempt = Number(ev.attempt);
  const maxAttempts = Number(ev.maxAttempts);
  const delayMs = Number(ev.delayMs);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return "Retrying...";
  }
  let delaySeconds = Math.round(delayMs / 1e3);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;
  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}
function toToolKind(toolName) {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "execute";
    default:
      return "other";
  }
}

// src/acp/pi-sessions.ts
import { readFileSync as readFileSync4, existsSync as existsSync2 } from "fs";
import { open as fsOpen, readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from "fs/promises";
import { homedir as homedir3 } from "os";
import { join as join3, resolve as resolve2, isAbsolute as isAbsolute2 } from "path";
var DEFAULT_TAIL_BYTES = 256 * 1024;
var DEFAULT_HEAD_BYTES = 64 * 1024;
function getPiAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve2(process.env.PI_CODING_AGENT_DIR) : join3(homedir3(), ".pi", "agent");
}
function readSessionDirFromSettings(agentDir) {
  const settingsPath = join3(agentDir, "settings.json");
  try {
    if (!existsSync2(settingsPath)) return null;
    const raw = readFileSync4(settingsPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const sessionDir = data.sessionDir;
    if (typeof sessionDir !== "string" || !sessionDir.trim()) return null;
    return isAbsolute2(sessionDir) ? sessionDir : resolve2(agentDir, sessionDir);
  } catch {
    return null;
  }
}
function getPiSessionsDir() {
  const agentDir = getPiAgentDir();
  return readSessionDirFromSettings(agentDir) ?? join3(agentDir, "sessions");
}
async function walkJsonlFiles(dir, out) {
  let entries;
  try {
    entries = await fsReaddir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = typeof e.name === "string" ? e.name : String(e.name);
    const p = join3(dir, name);
    if (e.isDirectory()) await walkJsonlFiles(p, out);
    else if (e.isFile() && name.endsWith(".jsonl")) out.push(p);
  }
}
async function readFirstLine(path) {
  let fh;
  try {
    fh = await fsOpen(path, "r");
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead <= 0) return null;
    const s = buf.subarray(0, bytesRead).toString("utf-8");
    const idx = s.indexOf("\n");
    return idx === -1 ? s.trim() : s.slice(0, idx).trim();
  } catch {
    return null;
  } finally {
    try {
      await fh?.close();
    } catch {
    }
  }
}
async function readTail(path, tailBytes = DEFAULT_TAIL_BYTES) {
  const st = await fsStat(path);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;
  const fh = await fsOpen(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } finally {
    try {
      await fh.close();
    } catch {
    }
  }
}
function parseSessionHeader(firstLine) {
  try {
    const obj = JSON.parse(firstLine);
    if (obj?.type !== "session") return null;
    const sessionId = typeof obj?.id === "string" ? obj.id : null;
    const cwd = typeof obj?.cwd === "string" ? obj.cwd : null;
    if (!sessionId || !cwd) return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}
function pickTitleFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
        return obj.name.trim();
      }
    } catch {
    }
  }
  return null;
}
async function scanSessionInfoNameFromFile(path) {
  let fh;
  try {
    fh = await fsOpen(path, "r");
    const buf = Buffer.alloc(256 * 1024);
    let leftover = "";
    let offset = 0;
    let lastName = null;
    while (true) {
      const { bytesRead: n } = await fh.read(buf, 0, buf.length, offset);
      if (n <= 0) break;
      offset += n;
      const chunk = leftover + buf.subarray(0, n).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line0 of lines) {
        const line = line0.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
            lastName = obj.name.trim();
          }
        } catch {
        }
      }
    }
    const tailLine = leftover.trim();
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine);
        if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
          lastName = obj.name.trim();
        }
      } catch {
      }
    }
    return lastName;
  } catch {
    return null;
  } finally {
    try {
      await fh?.close();
    } catch {
    }
  }
}
function pickUpdatedAtFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type !== "message") continue;
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  return null;
}
async function pickFallbackTitleFromHead(path) {
  try {
    const raw = await fsReadFile(path, { encoding: "utf8" });
    const lines = raw.split(/\r?\n/);
    for (const line0 of lines) {
      const line = line0.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "message" && obj?.message?.role === "user") {
          const content = obj?.message?.content;
          if (typeof content === "string") return content.slice(0, 80);
          if (Array.isArray(content)) {
            const t = content.find((c) => c?.type === "text" && typeof c?.text === "string");
            if (t?.text) return String(t.text).slice(0, 80);
          }
        }
      } catch {
      }
      if (lines.length > 2e3) break;
    }
  } catch {
  }
  return null;
}
async function listPiSessions() {
  const sessionsDir = getPiSessionsDir();
  const files = [];
  await walkJsonlFiles(sessionsDir, files);
  const probed = await Promise.all(files.map(async (file) => {
    const first = await readFirstLine(file);
    if (!first) return null;
    const header = parseSessionHeader(first);
    if (!header) return null;
    let updatedAt = null;
    let title = null;
    try {
      const tail = await readTail(file);
      title = pickTitleFromTail(tail);
      updatedAt = pickUpdatedAtFromTail(tail);
    } catch {
    }
    if (!title) {
      title = await scanSessionInfoNameFromFile(file);
    }
    if (!updatedAt) {
      try {
        updatedAt = (await fsStat(file)).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }
    if (!title) {
      title = await pickFallbackTitleFromHead(file);
    }
    return {
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    };
  }));
  const items = probed.filter(Boolean);
  items.sort((a, b) => {
    const aa = a.updatedAt ?? "";
    const bb = b.updatedAt ?? "";
    return bb.localeCompare(aa);
  });
  return items;
}
async function findPiSession(sessionId) {
  const all = await listPiSessions();
  return all.find((s) => s.sessionId === sessionId) ?? null;
}

// src/acp/translate/pi-messages.ts
function normalizePiMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}
function normalizePiAssistantText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}

// src/acp/translate/prompt.ts
function promptToPiMessage(blocks) {
  let message = "";
  const images = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        message += b.text;
        break;
      case "resource_link":
        message += `
[Context] ${b.uri}`;
        break;
      case "image": {
        images.push({
          type: "image",
          mimeType: b.mimeType,
          data: b.data
        });
        break;
      }
      case "resource": {
        const r = b.resource;
        const uri = typeof r?.uri === "string" ? r.uri : "(unknown)";
        if (typeof r?.text === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "text/plain";
          message += `
[Embedded Context] ${uri} (${mime})
${r.text}`;
        } else if (typeof r?.blob === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "application/octet-stream";
          const bytes = Buffer.byteLength(r.blob, "base64");
          message += `
[Embedded Context] ${uri} (${mime}, ${bytes} bytes)`;
        } else {
          message += `
[Embedded Context] ${uri}`;
        }
        break;
      }
      case "audio": {
        const bytes = Buffer.byteLength(b.data, "base64");
        message += `
[Audio] (${b.mimeType}, ${bytes} bytes) not supported by pi-acp`;
        break;
      }
      default:
        break;
    }
  }
  return { message, images };
}

// src/acp/pi-settings.ts
import { existsSync as existsSync3, readFileSync as readFileSync5 } from "fs";
import { homedir as homedir4 } from "os";
import { join as join4, resolve as resolve3 } from "path";
function isObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}
function readJsonFile(path) {
  try {
    if (!existsSync3(path)) return {};
    const raw = readFileSync5(path, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}
function getMergedSettings(cwd) {
  const globalSettingsPath = join4(getAgentDir(), "settings.json");
  const projectSettingsPath = resolve3(cwd, ".pi", "settings.json");
  const global = readJsonFile(globalSettingsPath);
  const project = readJsonFile(projectSettingsPath);
  return deepMerge(global, project);
}
function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve3(process.env.PI_CODING_AGENT_DIR) : join4(homedir4(), ".pi", "agent");
}
function getEnableSkillCommands(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.enableSkillCommands;
  if (typeof direct === "boolean") return direct;
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : void 0;
  if (typeof nested === "boolean") return nested;
  return true;
}
function getQuietStartup(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.quietStartup;
  if (typeof direct === "boolean") return direct;
  const legacy = merged.quietStart;
  if (typeof legacy === "boolean") return legacy;
  return false;
}

// src/acp/pi-commands.ts
function describeFallback(c) {
  const source = typeof c.source === "string" ? c.source : "";
  const location = typeof c.location === "string" ? c.location : "";
  const parts = [];
  if (source) parts.push(source);
  if (location) parts.push(location);
  return parts.length ? `(${parts.join(":")})` : "(command)";
}
function toAvailableCommandsFromPiGetCommands(data, opts) {
  const enableSkillCommands = opts?.enableSkillCommands ?? true;
  const includeExtensionCommands = opts?.includeExtensionCommands ?? false;
  const root = data;
  const commandsRaw = Array.isArray(root?.commands) ? root.commands : Array.isArray(root?.data?.commands) ? root.data.commands : [];
  const out = [];
  for (const c of commandsRaw) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const source = typeof c?.source === "string" ? c.source : "";
    if (!includeExtensionCommands && source === "extension") continue;
    if (!enableSkillCommands && name.startsWith("skill:")) continue;
    const desc = typeof c?.description === "string" ? c.description.trim() : "";
    out.push({
      name,
      description: desc || describeFallback(c)
    });
  }
  return { commands: out, raw: commandsRaw };
}

// src/acp/agent.ts
import { isAbsolute as isAbsolute3 } from "path";
import { existsSync as existsSync4, readFileSync as readFileSync6, realpathSync, readdirSync as readdirSync3, statSync as statSync2, unlinkSync } from "fs";
import { join as join5, dirname as dirname2, basename } from "path";
import { execFile } from "child_process";
var execFileAsync = promisify2(execFile);
import { VERSION as PI_SDK_VERSION } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "url";
var MODEL_CONFIG_ID = "model";
var THOUGHT_LEVEL_CONFIG_ID = "thought_level";
function builtinAvailableCommands() {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" }
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" }
    },
    {
      name: "export",
      description: "Export session to an HTML file in the session cwd"
    },
    {
      name: "session",
      description: "Show session stats (messages, tokens, cost, session file)"
    },
    {
      name: "name",
      description: "Set session display name",
      input: { hint: "<name>" }
    },
    {
      name: "steering",
      description: "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "follow-up",
      description: "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "changelog",
      description: "Show pi changelog"
    }
  ];
}
function mergeCommands(a, b) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}
var pkg = readNearestPackageJson(import.meta.url);
var PiAcpAgent = class {
  conn;
  sessions = new PiSessionRegistry();
  store = new SessionStore();
  restoringSessions = /* @__PURE__ */ new Map();
  async dispose() {
    await this.sessions.disposeAll();
  }
  // Remember recent session cwd and use it as the default filter.
  lastSessionCwd = null;
  constructor(conn, _config) {
    this.conn = conn;
    void _config;
  }
  cleanupFailedNewSession(sessionId, state) {
    this.sessions.close(sessionId);
    const sessionFile = typeof state?.sessionFile === "string" && state.sessionFile.trim() ? state.sessionFile : this.store.get(sessionId)?.sessionFile;
    if (typeof sessionFile === "string" && sessionFile.trim()) {
      try {
        if (existsSync4(sessionFile)) unlinkSync(sessionFile);
      } catch {
      }
    }
    this.store.delete(sessionId);
  }
  async findStoredSession(sessionId) {
    const stored = this.store.get(sessionId);
    if (stored?.cwd && stored?.sessionFile) {
      return { cwd: stored.cwd, sessionFile: stored.sessionFile };
    }
    const piSession = await findPiSession(sessionId);
    if (!piSession) return null;
    this.store.upsert({
      sessionId,
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    });
    return {
      cwd: piSession.cwd,
      sessionFile: piSession.sessionFile
    };
  }
  async restoreSession(sessionId, opts) {
    const existing = this.sessions.maybeGet(sessionId);
    if (existing) return existing;
    const inFlight = this.restoringSessions.get(sessionId);
    if (inFlight) return inFlight;
    const restorePromise = (async () => {
      const stored = await this.findStoredSession(sessionId);
      if (!stored) {
        throw RequestError3.invalidParams(`Unknown sessionId: ${sessionId}`);
      }
      const cwd = opts?.cwd ?? stored.cwd;
      const proc = await PiSdkProcess.create({
        cwd,
        sessionPath: stored.sessionFile
      });
      const fileCommands = await loadSlashCommands(cwd);
      const session = this.sessions.getOrCreate(sessionId, {
        cwd,
        mcpServers: opts?.mcpServers ?? [],
        conn: this.conn,
        proc,
        fileCommands
      });
      this.lastSessionCwd = cwd;
      this.store.upsert({ sessionId, cwd, sessionFile: stored.sessionFile });
      return session;
    })();
    this.restoringSessions.set(sessionId, restorePromise);
    try {
      return await restorePromise;
    } finally {
      this.restoringSessions.delete(sessionId);
    }
  }
  async initialize(params) {
    const supportedVersion = 1;
    const requested = params.protocolVersion;
    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0"
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: params?.clientCapabilities?._meta?.["terminal-auth"] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true"
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {},
          delete: {}
        }
      }
    };
  }
  async newSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError3.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    this.lastSessionCwd = params.cwd;
    const fileCommands = await loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND
    });
    let state = null;
    let availableModels = null;
    let stateErr = null;
    let availableModelsErr = null;
    await Promise.all([
      session.proc.getState().then((s) => {
        state = s;
      }).catch((err) => {
        stateErr = err;
        state = null;
      }),
      session.proc.getAvailableModels().then((m) => {
        availableModels = m;
      }).catch((err) => {
        availableModelsErr = err;
        availableModels = null;
      })
    ]);
    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);
    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw availableModelsAuthErr;
    }
    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError3.internalError({}, String(availableModelsErr?.message ?? availableModelsErr));
    }
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0;
    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError3.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError3.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    let configuration;
    try {
      if (stateErr) throw stateErr;
      configuration = await getSessionConfiguration(session.proc, { state, availableModels });
    } catch (err) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw maybeAuthRequiredError(err) ?? RequestError3.internalError({}, String(err?.message ?? err));
    }
    const { configOptions, models, modes } = configuration;
    const quietStartup = getQuietStartup(params.cwd);
    const updateNotice = buildUpdateNotice();
    const preludeText = quietStartup ? updateNotice ? updateNotice + "\n" : "" : buildStartupInfo({
      cwd: params.cwd,
      fileCommands,
      updateNotice
    });
    if (preludeText)
      session.setStartupInfo(preludeText);
    const response = {
      sessionId: session.sessionId,
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    };
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0);
    setTimeout(() => {
      void (async () => {
        await session.publishContextUsage();
        try {
          const pi = await session.proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  async authenticate(_params) {
    return;
  }
  async prompt(params) {
    const session = await this.restoreSession(params.sessionId);
    const { message, images } = promptToPiMessage(params.prompt);
    if (images.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);
      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || void 0;
        const res = await session.proc.compact(customInstructions);
        const r = res && typeof res === "object" ? res : null;
        const tokensBefore = typeof r?.tokensBefore === "number" ? r.tokensBefore : null;
        const summary = typeof r?.summary === "string" ? r.summary : null;
        const headerLines = [
          `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean);
        const text = headerLines.join("\n") + (summary ? `

${summary}` : "");
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "session") {
        const stats = await session.proc.getSessionStats();
        const lines = [];
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`);
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
        if (typeof stats?.totalMessages === "number") lines.push(`Messages: ${stats.totalMessages}`);
        if (typeof stats?.cost === "number") lines.push(`Cost: ${stats.cost}`);
        const t = stats?.tokens;
        if (t && typeof t === "object") {
          const parts = [];
          if (typeof t.input === "number") parts.push(`in ${t.input}`);
          if (typeof t.output === "number") parts.push(`out ${t.output}`);
          if (typeof t.cacheRead === "number") parts.push(`cache read ${t.cacheRead}`);
          if (typeof t.cacheWrite === "number") parts.push(`cache write ${t.cacheWrite}`);
          if (typeof t.total === "number") parts.push(`total ${t.total}`);
          if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
        }
        const text = lines.length ? lines.join("\n") : `Session stats:
${JSON.stringify(stats, null, 2)}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "name") {
        const name = args.join(" ").trim();
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Usage: /name <name>" }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          await session.proc.setSessionName(name);
        } catch (e) {
          const msg = String(e?.message ?? e);
          const hint = /set_session_name/i.test(msg) ? " This requires a newer pi version that supports `set_session_name` in RPC mode." : "";
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to set session name: ${msg}${hint}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: name,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          }
        });
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Session name set: ${name}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "steering") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.steeringMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Steering mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /steering all | /steering one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setSteeringMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Steering mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "follow-up") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.followUpMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Follow-up mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /follow-up all | /follow-up one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setFollowUpMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "changelog") {
        // devin-web: no spawnSync here — in-process, it froze the server.
        // The SDK ships CHANGELOG.md in its package; resolve its install
        // dir via import.meta.resolve, falling back to `which pi`.
        const findChangelog = async () => {
          try {
            const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
            const p = join5(dirname2(dirname2(entry)), "CHANGELOG.md");
            if (existsSync4(p)) return p;
          } catch {
          }
          try {
            const { stdout } = await execFileAsync(
              process.platform === "win32" ? "where" : "which",
              ["pi"]
            );
            const piPath = String(stdout ?? "").split(/\r?\n/)[0]?.trim();
            if (piPath) {
              const p = join5(dirname2(dirname2(realpathSync(piPath))), "CHANGELOG.md");
              if (existsSync4(p)) return p;
            }
          } catch {
          }
          return null;
        };
        const changelogPath = await findChangelog();
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Changelog not found (couldn't locate pi installation)." }
            }
          });
          return { stopReason: "end_turn" };
        }
        let text = "";
        try {
          text = await readFileAsync(changelogPath, "utf-8");
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        const maxChars = 2e4;
        if (text.length > maxChars) text = text.slice(0, maxChars) + "\n\n...(truncated)...";
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "export") {
        const state = await session.proc.getState();
        const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
        const messageCount = typeof state?.messageCount === "number" ? state.messageCount : 0;
        if (!sessionFile || messageCount === 0 || !existsSync4(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Nothing to export yet (no session messages). Send a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          const raw = await readFileAsync(sessionFile, "utf-8");
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Nothing to export yet (empty session file). Send a prompt first."
                }
              }
            });
            return { stopReason: "end_turn" };
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = join5(session.cwd, `pi-session-${safeSessionId}.html`);
        let resultPath = "";
        try {
          const result2 = await session.proc.exportHtml(outputPath);
          resultPath = result2.path;
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Export failed: no output path returned by pi."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const uri = `file://${resultPath}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Session exported: "
            }
          }
        });
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource_link",
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: "text/html",
              title: "Session exported"
            }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "autocompact") {
        const mode = (args[0] ?? "toggle").toLowerCase();
        let enabled = null;
        if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") enabled = true;
        else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") enabled = false;
        if (enabled === null) {
          const state = await session.proc.getState();
          const current = Boolean(state?.autoCompactionEnabled);
          enabled = !current;
        }
        await session.proc.setAutoCompaction(enabled);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`
            }
          }
        });
        return { stopReason: "end_turn" };
      }
    }
    const result = await session.prompt(message, images);
    const stopReason = result === "error" ? session.wasCancelRequested() ? "cancelled" : "end_turn" : result;
    return { stopReason };
  }
  async cancel(params) {
    const session = this.sessions.maybeGet(params.sessionId);
    if (!session) return;
    await session.cancel();
  }
  async listSessions(params) {
    const all = await listPiSessions();
    const effectiveCwd = params.cwd ?? this.lastSessionCwd;
    const filtered = effectiveCwd ? all.filter((s) => s.cwd === effectiveCwd) : all;
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);
    const sessions = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }));
    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;
    return { sessions, nextCursor, _meta: {} };
  }
  async loadSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError3.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    this.sessions.close(params.sessionId);
    this.lastSessionCwd = params.cwd;
    const stored = await this.findStoredSession(params.sessionId);
    if (!stored) {
      throw RequestError3.invalidParams(`Unknown sessionId: ${params.sessionId}`);
    }
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const session = await this.restoreSession(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers
    });
    const proc = session.proc;
    let configuration;
    try {
      configuration = await getSessionConfiguration(proc);
    } catch (err) {
      this.sessions.close(session.sessionId);
      throw err;
    }
    const { configOptions, models, modes } = configuration;
    const fileCommands = await loadSlashCommands(params.cwd);
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile
    });
    const data = await proc.getMessages();
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    for (const m of messages) {
      const role = String(m?.role ?? "");
      if (role === "user") {
        const text = normalizePiMessageText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text }
            }
          });
        }
      }
      if (role === "assistant") {
        const text = normalizePiAssistantText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text }
            }
          });
        }
      }
      if (role === "toolResult") {
        const toolName = String(m?.toolName ?? "tool");
        const toolCallId = String(m?.toolCallId ?? crypto.randomUUID());
        const isError = Boolean(m?.isError);
        const isBash = isBashTool(toolName);
        if (isBash) {
          const text2 = bashResultText(m);
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId,
              title: bashCommand(m) ?? toolName,
              kind: "execute",
              status: "completed",
              content: bashTerminalContent(toolCallId),
              _meta: bashTerminalInfoMeta(toolCallId, params.cwd)
            }
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: isError ? "failed" : "completed",
              _meta: {
                ...text2 ? bashTerminalOutputMeta(toolCallId, text2) : {},
                ...bashTerminalExitMeta(toolCallId, bashExitCode(m, isError))
              }
            }
          });
          continue;
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toolName === "read" ? "read" : toolName === "write" || toolName === "edit" ? "edit" : "other",
            status: "completed",
            rawInput: null,
            rawOutput: m
          }
        });
        const text = toolResultToText(m);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            content: text ? [{ type: "content", content: { type: "text", text } }] : null,
            rawOutput: m
          }
        });
      }
    }
    const response = {
      configOptions,
      models,
      modes,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    };
    setTimeout(() => {
      void (async () => {
        await session.publishContextUsage();
        try {
          const pi = await proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  async closeSession(params) {
    this.sessions.close(params.sessionId);
    return {};
  }
  async deleteSession(params) {
    const stored = this.store.get(params.sessionId);
    const piSession = await findPiSession(params.sessionId);
    if (!stored && !piSession) {
      return {};
    }
    const sessionFile = stored?.sessionFile ?? piSession?.sessionFile;
    if (sessionFile) {
      try {
        if (existsSync4(sessionFile)) await unlinkAsync(sessionFile);
      } catch {
      }
    }
    this.store.delete(params.sessionId);
    return {};
  }
  async unstable_setSessionModel(params) {
    const session = await this.restoreSession(params.sessionId);
    await setSessionModel(session.proc, params.modelId);
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    await session.publishContextUsage();
  }
  async setSessionMode(params) {
    const session = await this.restoreSession(params.sessionId);
    const mode = params.modeId;
    if (typeof mode !== "string" || mode.length === 0) {
      throw RequestError3.invalidParams("Expected nonempty string modeId");
    }
    await session.proc.setThinkingLevel(mode);
    await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    return {};
  }
  async setSessionConfigOption(params) {
    const session = await this.restoreSession(params.sessionId);
    const configId = String(params.configId);
    let modelChanged = false;
    if (typeof params.value !== "string") {
      throw RequestError3.invalidParams(`Expected string value for config option: ${configId}`);
    }
    if (configId === MODEL_CONFIG_ID) {
      await setSessionModel(session.proc, params.value);
      modelChanged = true;
    } else if (configId === THOUGHT_LEVEL_CONFIG_ID) {
      if (params.value.length === 0) {
        throw RequestError3.invalidParams("Expected nonempty thinking level");
      }
      await session.proc.setThinkingLevel(params.value);
    } else {
      throw RequestError3.invalidParams(`Unknown config option: ${configId}`);
    }
    const configOptions = await emitConfigOptionsUpdate(this.conn, session.sessionId, session.proc);
    if (modelChanged) await session.publishContextUsage();
    return { configOptions };
  }
};
async function getThinkingState(proc, pre) {
  const state = pre?.state ?? await proc.getState();
  const available = await proc.getAvailableThinkingLevels();
  const current = state && typeof state === "object" && "thinkingLevel" in state ? state.thinkingLevel : void 0;
  if (typeof current !== "string" || current.length === 0 || !available.includes(current)) {
    throw new Error("pi returned a thinking level absent from available levels");
  }
  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  };
}
async function getSessionConfiguration(proc, pre) {
  const state = pre?.state ?? await proc.getState();
  const [models, modes] = await Promise.all([getModelState(proc, { ...pre, state }), getThinkingState(proc, { state })]);
  return {
    configOptions: buildConfigOptions({ models, modes }),
    models,
    modes
  };
}
function buildConfigOptions(state) {
  const configOptions = [
    {
      type: "select",
      id: THOUGHT_LEVEL_CONFIG_ID,
      category: "thought_level",
      name: "Thinking",
      description: "Set the reasoning effort for this session",
      currentValue: state.modes.currentModeId,
      options: state.modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description ?? null
      }))
    }
  ];
  if (state.models?.availableModels.length) {
    configOptions.unshift({
      type: "select",
      id: MODEL_CONFIG_ID,
      category: "model",
      name: "Model",
      description: "Select the model for this session",
      currentValue: state.models.currentModelId,
      options: state.models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      }))
    });
  }
  return configOptions;
}
async function getModelState(proc, pre) {
  let availableModels = [];
  const data = pre?.availableModels ?? await (async () => {
    try {
      return await proc.getAvailableModels();
    } catch {
      return null;
    }
  })();
  const models = Array.isArray(data?.models) ? data.models : [];
  availableModels = models.map((m) => {
    const provider = String(m?.provider ?? "").trim();
    const id = String(m?.id ?? "").trim();
    if (!provider || !id) return null;
    const name = String(m?.name ?? id);
    return {
      modelId: `${provider}/${id}`,
      name: `${provider}/${name}`,
      description: null
    };
  }).filter(Boolean);
  let currentModelId = null;
  const state = pre?.state ?? await (async () => {
    try {
      return await proc.getState();
    } catch {
      return null;
    }
  })();
  const model = state?.model;
  if (model && typeof model === "object") {
    const provider = String(model.provider ?? "").trim();
    const id = String(model.id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }
  if (!availableModels.length && !currentModelId) return null;
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";
  return {
    availableModels,
    currentModelId: currentModelId ?? availableModels[0]?.modelId ?? "default"
  };
}
async function emitConfigOptionsUpdate(conn, sessionId, proc) {
  const { configOptions, modes } = await getSessionConfiguration(proc);
  await conn.sessionUpdate({
    sessionId,
    update: { sessionUpdate: "current_mode_update", currentModeId: modes.currentModeId }
  });
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "config_option_update",
      configOptions
    }
  });
  return configOptions;
}
async function setSessionModel(proc, requestedModelId) {
  let provider = null;
  let modelId = null;
  if (requestedModelId.includes("/")) {
    const [candidateProvider, ...rest] = requestedModelId.split("/");
    provider = candidateProvider;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }
  if (!provider) {
    const data = await proc.getAvailableModels();
    const models = Array.isArray(data?.models) ? data.models : [];
    const found = models.find((m) => String(m?.id) === modelId);
    if (found) {
      provider = String(found.provider);
      modelId = String(found.id);
    }
  }
  if (!provider || !modelId) {
    throw RequestError3.invalidParams(`Unknown modelId: ${requestedModelId}`);
  }
  await proc.setModel(provider, modelId);
}
function isSemver(v) {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}
function compareSemver(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
// devin-web: in-process, spawnSync would freeze the whole server — the
// installed version is the SDK's VERSION, and the latest-version probe runs
// async in the background (cached hourly; first session/new sees no notice).
let latestPiVersion = { at: 0, value: null };
function refreshLatestPiVersion() {
  if (Date.now() - latestPiVersion.at < 3600_000) return;
  latestPiVersion.at = Date.now();
  execFile("npm", ["view", "@earendil-works/pi-coding-agent", "version"], { encoding: "utf-8", timeout: 10_000 }, (err, stdout) => {
    if (!err) latestPiVersion.value = String(stdout ?? "").trim().replace(/^v/i, "") || null;
  });
}
function buildUpdateNotice() {
  try {
    refreshLatestPiVersion();
    const installed = String(PI_SDK_VERSION ?? "").replace(/^v/i, "");
    if (!installed || !isSemver(installed)) return null;
    const latest = latestPiVersion.value;
    if (!latest || !isSemver(latest)) return null;
    if (compareSemver(latest, installed) <= 0) return null;
    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
}
function buildStartupInfo(opts) {
  void opts.fileCommands;
  const md = [];
  try {
    const installed = String(PI_SDK_VERSION ?? "").replace(/^v/i, "");
    if (installed) {
      md.push(`pi v${installed}`);
      md.push("---");
      md.push("");
    }
  } catch {
  }
  const addSection = (title, items) => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean);
    if (!cleaned.length) return;
    md.push(`## ${title}`);
    for (const item of cleaned) md.push(`- ${item}`);
    md.push("");
  };
  const contextItems = [];
  const contextPath = join5(opts.cwd, "AGENTS.md");
  if (existsSync4(contextPath)) contextItems.push(contextPath);
  addSection("Context", contextItems);
  const skillsItems = [];
  const pushSkillFromRoot = (root) => {
    try {
      for (const e of readdirSync3(root)) {
        const p = join5(root, e);
        try {
          const st = statSync2(p);
          if (st.isFile() && e.toLowerCase().endsWith(".md")) {
            skillsItems.push(p);
          }
        } catch {
        }
      }
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = readdirSync3(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (name === "node_modules" || name === ".git") continue;
          const p = join5(dir, name);
          let st;
          try {
            st = statSync2(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(p);
          } else if (st.isFile() && name === "SKILL.md") {
            skillsItems.push(p);
          }
        }
      }
    } catch {
    }
  };
  const globalSkillsDir = join5(getAgentDir(), "skills");
  pushSkillFromRoot(globalSkillsDir);
  const legacyAgentsSkillsDir = join5(process.env.HOME ?? "", ".agents", "skills");
  pushSkillFromRoot(legacyAgentsSkillsDir);
  const projectSkillsDir = join5(opts.cwd, ".pi", "skills");
  pushSkillFromRoot(projectSkillsDir);
  addSection("Skills", skillsItems);
  const promptsItems = [];
  const promptsDir = join5(process.env.HOME ?? "", ".pi", "agent", "prompts");
  try {
    const prompts = readdirSync3(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {
  }
  addSection("Prompts", promptsItems);
  const extItems = [];
  const extDir = join5(process.env.HOME ?? "", ".pi", "agent", "extensions");
  try {
    const exts = readdirSync3(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const f of exts) extItems.push(join5(extDir, f));
  } catch {
  }
  const settingsPaths = [join5(getAgentDir(), "settings.json"), join5(opts.cwd, ".pi", "settings.json")];
  for (const settingsPath of settingsPaths) {
    try {
      const settings = JSON.parse(readFileSync6(settingsPath, "utf-8"));
      const pkgs = Array.isArray(settings?.packages) ? settings.packages : [];
      for (const pkg2 of pkgs) {
        const s = String(pkg2);
        if (s.startsWith("npm:")) {
          extItems.push(`${s}
  - index.ts`);
        } else {
          extItems.push(s);
        }
      }
    } catch {
    }
  }
  addSection("Extensions", extItems);
  if (opts.updateNotice) {
    md.push("---");
    md.push(opts.updateNotice);
    md.push("");
  }
  return md.join("\n").trim() + "\n";
}
function readNearestPackageJson(metaUrl) {
  try {
    let dir = dirname2(fileURLToPath(metaUrl));
    for (let i = 0; i < 6; i++) {
      const p = join5(dir, "package.json");
      if (existsSync4(p)) {
        const json = JSON.parse(readFileSync6(p, "utf-8"));
        return { name: json?.name, version: json?.version };
      }
      dir = dirname2(dir);
    }
  } catch {
  }
  return { name: "pi-acp", version: "0.0.0" };
}

export { PiAcpAgent };
