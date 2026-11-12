import { createHash, randomUUID } from "node:crypto";
import { HISTORY_ENCODING, HISTORY_ENCODING_V2, packHistoryEvents } from "./history-wire.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { piUsageStats } from "./pi-stats.js";
import { treeError } from "./pi-sdk/session-tree.js";
import { processError } from "./pi-sdk/processes.js";
import { scratchRoot, isScratchDir, isScratchDirLexical } from "./scratch.js";

const MAX_BUFFERED_EVENTS = 8000;
// Event payloads can each carry multi-hundred-KB outputs — cap the replay
// buffer by bytes too, not just count (drop oldest, keep ≥100 tail events).
// This is a bounded delivery cache, NOT authoritative Pi transcript storage.
// Coalesce streamed deltas/snapshots; if evicted, rebuild browser history from
// the raw active branch plus the unfinished live tail, without session/load.
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
// Fallback freshness windows for activity detection: streaming commits tick
// every few seconds, so 25s still means "generating"; without probe data a
// wider 120s window is used.
const GEN_WINDOW_MS = 25_000;
const ACTIVE_WINDOW_MS = 120_000;
const STATE_POLL_MS = 8_000;
const LIST_CACHE_MS = 10_000;
// Locked sessions: mirror transcript progress out of devin's sqlite store so
// the web view updates live while the terminal CLI holds the lock. Polls are
// cheap (a COUNT/MAX signature) and only open one shared read-only handle.
const MIRROR_POLL_MS = 2_500;
const ATTACH_TIMEOUT_MS = 20_000;
// Sessions we hold but nobody interacts with get released after this idle
// window — a held session only costs acp memory; the transcript is in sqlite.
const IDLE_DETACH_MS = Number(process.env.IDLE_DETACH_MS || 30 * 60 * 1000);
// pi's session/load disposes the session's live AgentSession and creates a
// fresh one — it is a restart, not an attach. A turn producing zero events
// for this long is presumed orphaned (session replaced externally or died),
// so we stop treating it as in-flight and allow reattach again.
const TURN_STALL_MS = Number(process.env.TURN_STALL_MS || 10 * 60 * 1000);
// Cap on attached sessions per hub: each attachment holds an agent-side
// session (in-process pi AgentSessions consume this server's heap), so
// past the cap the coldest idle attachment is evicted.
const MAX_ATTACHED_SESSIONS = Number(process.env.MAX_ATTACHED_SESSIONS || 10);
// Memory/state hygiene: cold session entries (unsubscribed, unattached) are
// swept after this idle window — all their fields rebuild from sqlite/state.
const ENTRY_EVICT_MS = 30 * 60 * 1000;
const MAX_META_SESSIONS = 2000;   // persisted title/cwd records
const MAX_USAGE_CACHE = 500;      // usageById entries
const MAX_COMMANDS_CACHE = 100;   // commandsByCwd entries (one per workspace)
const MAX_IMG_CACHE = 50;         // sessions with decoded image indexes

// The CLI's own plumbing (summarization, thread-continuation context) is
// injected into the transcript as user-role prompts, and acp echoes/replays
// it as user_message_chunk — showing up as giant raw-markup bubbles. Real
// user prompts always carry a clientMessageId; plumbing never does.
const INTERNAL_USER_CHUNK =
  /^(?:Conversation to summarize:|Now summarize the conversation above|You are continuing work from a previous conversation thread)/;
function isInternalUserChunk(u) {
  return (
    u?.sessionUpdate === "user_message_chunk" &&
    u.content?.type === "text" &&
    !u._meta?.["cognition.ai/clientMessageId"] &&
    INTERNAL_USER_CHUNK.test((u.content.text || "").trimStart())
  );
}
// Keepalive/cache-warming prompts are also stored as role:"user" rows — the
// node metadata marks them (telemetry.source / is_user_input flags), so both
// the mirror and the sqlite backfill can skip them without touching real
// prompts sent from a terminal (is_user_input true / absent on old rows).
function isInternalMessageNode(m, text) {
  const md = m?.metadata || {};
  return (
    // explicitly marked non-user rows (keepalives carry is_user_input:null;
    // key-absent rows stay visible — unknown ≠ internal)
    ("is_user_input" in md && !md.is_user_input) ||
    md.telemetry?.source === "cache_keepalive" ||
    INTERNAL_USER_CHUNK.test((text || "").trimStart())
  );
}

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* optional — locked-session activity detection degrades to lock-only */
}

/**
 * SessionHub multiplexes web sessions over a single `devin acp` process.
 * Each ACP session is lazily "attached" via session/load the first time a
 * client subscribes or prompts; all session/update notifications are
 * buffered so late-joining browsers can replay the transcript.
 */
/** Move a workspace to the front of the MRU list, capping the list.
 *  Returns the new list, or null when the order already matches. */
export const devinDbPath = () => process.env.DEVIN_SESSIONS_DB || path.join(os.homedir(), ".local/share/devin/cli/sessions.db");

export function pushWorkspace(workspaces, dir, max = 50) {
  const index = workspaces.indexOf(dir);
  if (index === 0) return null;
  const next = [dir, ...(index < 0 ? workspaces : workspaces.filter((w) => w !== dir))];
  return next.slice(0, max);
}

// Unknown raster headers retain the original inline representation. Known
// dimensions reserve the exact thumbnail geometry before lazy HTTP loading.
function imageDimensions(mime, data) {
  const b = Buffer.from(data.slice(0, mime === "image/jpeg" ? 256 * 1024 : 64), "base64");
  let width, height;
  if (mime === "image/png" && b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = b.readUInt32BE(16); height = b.readUInt32BE(20);
  } else if (mime === "image/gif" && b.length >= 10 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) {
    width = b.readUInt16LE(6); height = b.readUInt16LE(8);
  } else if (mime === "image/webp" && b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const kind = b.toString("ascii", 12, 16);
    if (kind === "VP8X" && (b[20] & 8)) return null; // EXIF orientation: keep native inline sizing.
    if (kind === "VP8X") { width = 1 + b.readUIntLE(24, 3); height = 1 + b.readUIntLE(27, 3); }
    else if (kind === "VP8L" && b[20] === 0x2f) { width = 1 + (b[21] | ((b[22] & 63) << 8)); height = 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 15) << 10)); }
    else if (kind === "VP8 " && b.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) { width = b.readUInt16LE(26) & 16383; height = b.readUInt16LE(28) & 16383; }
  } else if (mime === "image/jpeg" && b.length >= 4 && b.readUInt16BE(0) === 0xffd8) {
    for (let pos = 2; pos + 3 < b.length;) {
      if (b[pos++] !== 0xff) break;
      while (b[pos] === 0xff) pos++;
      const marker = b[pos++];
      if (marker === 0xd9 || marker === 0xda || pos + 2 > b.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const len = b.readUInt16BE(pos);
      if (len < 2 || pos + len > b.length) break;
      if (marker === 0xe1 && len >= 8 && b.toString("ascii", pos + 2, pos + 8) === "Exif\0\0") return null;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && len >= 8) { height = b.readUInt16BE(pos + 3); width = b.readUInt16BE(pos + 5); }
      pos += len;
    }
  }
  return width > 0 && height > 0 && width <= 32768 && height <= 32768 ? { width, height } : null;
}

export class SessionHub extends EventEmitter {
  constructor(acp, statePath, { agent = "devin", devinExt = true } = {}) {
    super();
    this.acp = acp;
    this.statePath = statePath;
    this.agent = agent;
    this.devinExt = devinExt;
    /** @type {Map<string, {id:string, cwd:string, attached:boolean, attaching:Promise|null, events:Array, subscribers:Set, pendingPermissions:Map, prompting:number, title?:string}>} */
    this.sessions = new Map();
    this.imgCache = new Map();
    this.historyImageCache = new Map(); this.historyImageBytes = 0;
    this.historyEpoch = randomUUID();
    this.historyCheckpoints = new Map(); this.historyCheckpointBytes = 0;
    this.promptReceipts = new Map();
    this._slotReservations = new Set();
    this._capacityGate = Promise.resolve();
    this.state = this.#loadState();
    // available_commands_update is an ACP session-level event — the sqlite
    // mirror can't produce it, and replay doesn't always carry it either.
    // Cache the last advertised set per workspace (skills vary by cwd) so
    // every history can ship a complete command list.
    this.commandsByCwd = new Map(Object.entries(this.state.commandsByCwd || {}));
    // usage_update is also session-level-only — cache the latest sample per
    // session so mirrors/locked sessions can still show the context meter.
    this.usageById = new Map(Object.entries(this.state.usageById || {}));

    acp.on("sessionUpdate", (sessionId, update) => {
      const s = this.sessions.get(sessionId);
      if (!s) {
        // Untracked session — still let a title land in our meta cache, but
        // never broadcast a stray gen:0 update to watchers.
        if (update?.sessionUpdate === "session_info_update" && update.title)
          this.#setMeta(sessionId, { title: update.title });
        return;
      }
      // acp replays the CLI's summarization/continuation plumbing as user
      // chunks — keep that raw context blob out of the transcript.
      if (isInternalUserChunk(update)) return;
      const evt = { t: Date.now(), update };
      {
        if (s.attaching) {
          // Replay from an in-flight session/load — collected separately,
          // swapped into s.events wholesale on success, dropped on failure
          // so a failed attach never clobbers the mirrored buffer.
          this.#pushEvent(s, evt, s.replayEvents, "replayBytes");
        } else if (s.attached) {
          this.#pushEvent(s, evt, s.events);
        }
        // else: stragglers from a failed load — drop; the mirror owns this
        // buffer and its own broadcast path.
        if (update?.sessionUpdate === "session_info_update" && update.title) {
          s.title = update.title;
          this.#setMeta(sessionId, { title: update.title });
        }
        if (update?.sessionUpdate === "available_commands_update") {
          s.commands = update.availableCommands || [];
          if (s.cwd && s.commands.length) {
            this.#cappedSet(this.commandsByCwd, s.cwd, s.commands, MAX_COMMANDS_CACHE);
            this.state.commandsByCwd = Object.fromEntries(this.commandsByCwd);
            this.#saveState();
          }
        }
        if (update?.sessionUpdate === "usage_update" && update.size) {
          s.usage = update;
          this.#cappedSet(this.usageById, sessionId, update, MAX_USAGE_CACHE);
          this.state.usageById = Object.fromEntries(this.usageById);
          this.#saveState();
          // Live context samples arrive per response/tool batch. Refresh the
          // lifetime JSONL billing totals only at load/compaction/settle.
          if (!update._meta?.piAcp?.contextUsage?.intermediate) this.#refreshPiStats(s);
        }
        s.lastActiveAt = Date.now();
        const running = update?._meta?.piAcp?.running;
        if (typeof running === "boolean") {
          s.sdkRunning = running;
          if (s.attached && !s.attaching) this.#broadcast(s.id, { type: "session_state", sessionId: s.id, state: this.stateOf(s.id) }, { global: true });
          if (!running && !this.#isRunning(s) && s.queue.length) queueMicrotask(() => { if (!this.#isRunning(s)) this.#drainQueue(s); });
        }
      }
      // Only stream live updates for sessions we actually hold — replay is
      // delivered as one consolidated `history` once attach resolves, and
      // post-failure stragglers must not broadcast (their gen would
      // ping-pong the client's transcript reset).
      if (s && (s.attaching || !s.attached)) return;
      if (update?._meta?.piAcp?.historyBoundary) return;
      this.#broadcast(
        sessionId,
        { type: "session_update", sessionId, update, gen: s?.gen ?? 0 },
        { global: update?.sessionUpdate === "session_info_update" }
      );
    });

    acp.on("request", (msg, respond, respondError) => {
      if (msg.method === "session/request_permission") {
        const sessionId = msg.params?.sessionId;
        const s = sessionId && this.sessions.get(sessionId);
        const key = `perm-${this.agent}-${msg.id}`;
        const entry = { requestId: key, respond, params: msg.params };
        if (s) {
          s.pendingPermissions.set(key, entry);
        } else {
          // Nobody can answer this card — refusing is the only way to keep
          // the agent's turn from blocking forever.
          respondError(-32601, "session not tracked by devin-web");
        }
        this.#broadcast(
          sessionId,
          {
            type: "permission_request",
            sessionId,
            requestId: key,
            toolCall: msg.params?.toolCall,
            options: msg.params?.options,
          },
          { global: true }
        );
      } else if (msg.method === "elicitation/create") {
        // Agent asks the user a structured question (devin ask_user_question,
        // pi input/editor via our pi-acp patch). Form mode renders a card;
        // url mode is declined (no embedded browser here).
        const params = msg.params || {};
        const sessionId = params.sessionId;
        const s = sessionId && this.sessions.get(sessionId);
        if (!s || params.mode === "url") {
          respond({ action: "cancel" });
        } else {
          const key = `elic-${this.agent}-${msg.id}`;
          (s.pendingElicitations ||= new Map()).set(key, { requestId: key, respond, params });
          this.#broadcast(
            sessionId,
            {
              type: "elicitation_request",
              sessionId,
              requestId: key,
              agent: this.agent,
              message: params.message,
              schema: params.requestedSchema,
              toolCallId: params.toolCallId || null,
            },
            { global: true }
          );
        }
      } else {
        // We don't advertise fs/terminal capabilities; refuse politely so the
        // agent never hangs waiting on us.
        respondError(-32601, `method not supported by devin-web: ${msg.method}`);
      }
    });

    acp.on("notification", (method, params) => {
      const sessionId = params?.sessionId || params?.session_id;
      // Safety net: a turn ended (stopped/cancelled/stats emitted) without our
      // session/prompt request resolving — clear the running flag.
      if (sessionId && typeof method === "string" && (method.endsWith("agent_stopped") || method.endsWith("turn_stats"))) {
        const s = this.sessions.get(sessionId);
        if (s?.prompting) {
          s.prompting = 0;
          this.#broadcast(sessionId, { type: "session_state", sessionId, state: "held" }, { global: true });
        }
      }
      this.#broadcast(sessionId, { type: "agent_notification", sessionId, method, params }, { global: true });
    });

    acp.on("exit", () => {
      for (const s of this.sessions.values()) {
        const wasAttached = s.attached;
        s.attached = false;
        s.attaching = null;
        s.prompting = 0;
        // The process will respawn on the next request — mark re-attach
        // intent so watched sessions come back instead of staying dead.
        if (wasAttached) s.attachWanted = true;
        // Pending permission requests die with the acp process — tell clients
        // so their cards don't stay stuck awaiting an answer that can't come.
        for (const p of s.pendingPermissions.values())
          this.#broadcast(
            s.id,
            {
              type: "permission_resolved",
              sessionId: s.id,
              requestId: p.requestId,
              cancelled: true,
            },
            { global: true }
          );
        s.pendingPermissions.clear();
        for (const e of s.pendingElicitations.values()) {
          this.#broadcast(s.id, { type: "elicitation_resolved", sessionId: s.id, requestId: e.requestId, cancelled: true }, { global: true });
        }
        s.pendingElicitations.clear();
        if (wasAttached)
          this.#broadcast(s.id, { type: "session_state", sessionId: s.id, state: "free" }, { global: true });
      }
      this.#broadcast(null, { type: "agent_detached" });
    });

    // Recompute session states periodically and broadcast flips — keeps
    // locked-active ↔ locked badges fresh without waiting for client polls.
    this._lastStates = new Map();
    // Re-entry guards: a request wedged mid-poll must not stack overlapping
    // passes (pending growth + out-of-order state writes).
    this._statePolling = false;
    this._mirrorPolling = false;
    this._stateTimer = setInterval(() => {
      if (this._statePolling) return;
      this._statePolling = true;
      this.#pollStates().catch(() => {}).finally(() => (this._statePolling = false));
    }, STATE_POLL_MS);
    this._stateTimer.unref();
    // Coalesced list refresh: batch deletes resolve one by one but each
    // fresh list costs a full dir walk on the agent — queue them into a
    // single re-list instead of one per delete.
    this._refreshing = false;
    this._refreshQ = false;
    this._refreshT = null;
    this._mirrorTimer = setInterval(() => {
      if (this._mirrorPolling) return;
      this._mirrorPolling = true;
      this.#mirrorPoll().catch(() => {}).finally(() => (this._mirrorPolling = false));
    }, MIRROR_POLL_MS);
    this._mirrorTimer.unref();
    // Faster path: watch the session store — every CLI write triggers a
    // mirror pass ~150ms later instead of waiting for the next poll tick.
    // Devin-only: other agents have no sqlite session store.
    if (this.devinExt) try {
      const dbPath =
        process.env.DEVIN_SESSIONS_DB ||
        path.join(os.homedir(), ".local/share/devin/cli/sessions.db");
      const dir = path.dirname(dbPath);
      const base = path.basename(dbPath);
      this._dbWatcher = fs.watch(dir, { persistent: false }, (_e, file) => {
        if (!file || !String(file).startsWith(base)) return;
        clearTimeout(this._dbWatchT);
        this._dbWatchT = setTimeout(() => this.#kickMirror(), 150);
      });
    } catch {
      /* watch is a latency optimization — the interval still covers us */
    }
  }

  /** Trigger a mirror pass respecting the re-entry guard (manual callers). */
  #kickMirror() {
    if (this._mirrorPolling) return;
    this._mirrorPolling = true;
    this.#mirrorPoll()
      .catch(() => {})
      .finally(() => (this._mirrorPolling = false));
  }

  async #pollStates() {
    if (!this.acp.ready) return;
    // Idle-detach first: a session we hold but nobody prompted or watched
    // recently is released so it stops occupying the acp process.
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (
        s.attached &&
        !this.#isRunning(s) &&
        !this.#hasBackground(s) &&
        !s.treeNavigating &&
        !s.attaching &&
        s.pendingPermissions.size === 0 &&
        s.pendingElicitations.size === 0 &&
        now - (s.lastActiveAt || 0) > IDLE_DETACH_MS
      ) {
        console.log(`[devin-web] auto-detaching idle session ${s.id}`);
        this.closeSession(s.id).catch(() => {});
      }
      // Dead-proc watchdog: a prompt that produced no events for
      // TURN_STALL_MS is orphaned — the agent session was replaced or
      // died externally (pi restarts a session's AgentSession on every
      // session/load). Free the flag so the UI stops spinning and reattach
      // is allowed.
      if (
        s.prompting > 0 &&
        !this.acp.sessionActivity?.(s.id)?.running &&
        s.pendingPermissions.size === 0 &&
        s.pendingElicitations.size === 0 &&
        now - (s.lastActiveAt || 0) > TURN_STALL_MS
      ) {
        console.log(`[devin-web] turn stalled ${Math.round(TURN_STALL_MS / 60000)}min with no events — clearing running flag for ${s.id}`);
        s.prompting = 0;
        this.#broadcast(s.id, { type: "session_state", sessionId: s.id, state: "held" }, { global: true });
        this.#broadcast(s.id, { type: "agent_notification", sessionId: s.id, method: "devin-web/turn_stalled", params: { idleMs: TURN_STALL_MS } }, { global: true });
        if (s.attached && s.queue.length) this.#drainQueue(s);
      }
      // Cold-entry sweep: unattached, unsubscribed, idle entries hold their
      // whole transcript buffer + image index for no benefit — drop them;
      // everything rebuilds from sqlite/state on the next subscribe.
      if (
        !s.attached &&
        !s.attaching &&
        !s.attachWanted &&
        s.subscribers.size === 0 &&
        s.prompting === 0 &&
        now - (s.lastActiveAt || 0) > ENTRY_EVICT_MS
      ) {
        this.sessions.delete(s.id);
        this.imgCache.delete(s.id);
      }
    }
    // Attach cap: beyond it, evict the coldest idle attachments so an
    // abandoned attach can't grow agent-side memory forever. Unsubscribed
    // sessions go first — detaching one nobody watches is invisible; the
    // next subscribe just re-attaches it.
    const attachable = [...this.sessions.values()].filter((s) => this.#evictable(s));
    const excess = [...this.sessions.values()].filter((s) => s.attached).length - MAX_ATTACHED_SESSIONS;
    if (excess > 0) {
      attachable.sort(
        (a, b) =>
          Number(a.subscribers.size > 0) - Number(b.subscribers.size > 0) ||
          (a.lastActiveAt || 0) - (b.lastActiveAt || 0)
      );
      for (const s of attachable.slice(0, excess)) {
        console.log(`[devin-web] evicting attached session ${s.id} (cap ${MAX_ATTACHED_SESSIONS})`);
        this.closeSession(s.id).catch(() => {});
      }
    }
    // pi's list is a filesystem walk over ~/.pi/agent sessions — don't
    // grind it every 8s when nothing changed.
    const cacheStale = !this._listCache || Date.now() - this._listCache.at > 30_000;
    const list =
      this.devinExt || cacheStale
        ? await this.listSessions(undefined, { fresh: true })
        : this._listCache.data;
    const next = new Map();
    for (const it of list) {
      next.set(it.sessionId, it.state);
      if (this._lastStates.has(it.sessionId) && this._lastStates.get(it.sessionId) !== it.state)
        this.#broadcast(it.sessionId, { type: "session_state", sessionId: it.sessionId, state: it.state }, { global: true });
      // Takeover: a session we tried to open while another process held it —
      // grab it the moment the lock frees, swapping mirror → live stream.
      const s = this.sessions.get(it.sessionId);
      if (
        it.state === "free" &&
        s?.attachWanted &&
        !s.attached &&
        !s.attaching &&
        s.prompting === 0 &&
        s.subscribers.size > 0
      ) {
        console.log(`[devin-web] lock freed — taking over ${it.sessionId}`);
        this.ensureAttached(it.sessionId, s.cwd).catch(() => {});
      }
    }
    this._lastStates = next;
  }

  #loadState() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch { /* missing/corrupt — start fresh */ }
    // Normalize: a truncated or hand-edited state.json must not poison the
    // maps built from it (fromEntries crashes on non-objects).
    const st = typeof raw === "object" && raw ? raw : {};
    return {
      workspaces: Array.isArray(st.workspaces) ? st.workspaces.filter((w) => typeof w === "string") : [],
      sessions: st.sessions && typeof st.sessions === "object" && !Array.isArray(st.sessions) ? st.sessions : {},
      commandsByCwd: st.commandsByCwd && typeof st.commandsByCwd === "object" && !Array.isArray(st.commandsByCwd) ? st.commandsByCwd : {},
      usageById: st.usageById && typeof st.usageById === "object" && !Array.isArray(st.usageById) ? st.usageById : {},
    };
  }

  #saveState() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        // Atomic write: tmp + rename — a crash mid-write leaves the old
        // state.json intact instead of a truncated file that loses every
        // workspace/title record.
        const tmp = this.statePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
        fs.renameSync(tmp, this.statePath);
      } catch { /* best-effort */ }
    }, 300);
  }

  get workspaces() {
    return this.state.workspaces;
  }

  addWorkspace(dir) {
    const next = pushWorkspace(this.state.workspaces, dir);
    if (next) {
      this.state.workspaces = next;
      this.#saveState();
    }
  }

  /** LRU-ish cap for insertion-ordered Maps: refresh position on set,
   *  evict oldest entries past `max`. */
  #cappedSet(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  #setMeta(sessionId, patch) {
    const next = { ...(this.state.sessions[sessionId] || {}), ...patch };
    delete this.state.sessions[sessionId];
    this.state.sessions[sessionId] = next;
    const keys = Object.keys(this.state.sessions);
    if (keys.length > MAX_META_SESSIONS)
      for (const k of keys.slice(0, keys.length - MAX_META_SESSIONS))
        delete this.state.sessions[k];
    this.#saveState();
  }

  #entry(sessionId, cwd) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        cwd,
        attached: false,
        attaching: null,
        events: [],
        subscribers: new Set(),
        pendingPermissions: new Map(),
        pendingElicitations: new Map(),
        prompting: 0,
        queue: [], // FIFO of prompts sent while a turn is running
        lastActiveAt: Date.now(),
        gen: 0,
        title: this.state.sessions[sessionId]?.title,
      };
      this.sessions.set(sessionId, s);
    }
    if (cwd && !s.cwd) s.cwd = cwd;
    return s;
  }

  bufferToolIndexes = new WeakMap();

  /** Delivery-cache eviction must never be confused with persisted history. */
  #evictHead(s, arr, bytesField = "eventBytes") {
    while ((s[bytesField] > MAX_BUFFERED_BYTES || arr.length > MAX_BUFFERED_EVENTS) && arr.length > 100) {
      // Never evict the last persistence seam: its unfinished tail is not
      // recoverable from disk yet. Coalescing keeps normal live tails small.
      if (!this.devinExt && arr[0].update?._meta?.piAcp?.historyBoundary &&
          !arr.some((event, index) => index > 0 && event.update?._meta?.piAcp?.historyBoundary)) break;
      const dropped = arr.shift();
      s[bytesField] -= dropped._sz || 0;
      const tools = this.bufferToolIndexes.get(arr);
      if (tools?.get(dropped.update?.toolCallId) === dropped) tools.delete(dropped.update.toolCallId);
      s[bytesField === "replayBytes" ? "replayTruncated" : "historyTruncated"] = true;
    }
  }

  #pushEvent(s, evt, arr, bytesField = "eventBytes") {
    s.eventRevision = (s.eventRevision || 0) + 1;
    let previous, textSize;
    if (!this.devinExt) {
      let tools = this.bufferToolIndexes.get(arr);
      if (!tools) { tools = new Map(); this.bufferToolIndexes.set(arr, tools); }
      const u = evt.update, last = arr.at(-1);
      if (["agent_message_chunk", "agent_thought_chunk"].includes(u.sessionUpdate) &&
          last?.update.sessionUpdate === u.sessionUpdate && u.content?.type === "text" &&
          last.update.content?.type === "text" && !u._meta && !last.update._meta) {
        previous = last;
        if (Object.keys(u).length === 2 && Object.keys(last.update).length === 2) {
          textSize = previous._sz + JSON.stringify(u.content.text).length - 2;
          // JSON escapes lone UTF-16 surrogates; adjacent chunks can join
          // them into one code point (12 escaped chars become 2 code units).
          if (/[\uD800-\uDBFF]$/.test(last.update.content.text) && /^[\uDC00-\uDFFF]/.test(u.content.text)) textSize -= 10;
        }
        evt.update = { ...u, content: { type: "text", text: last.update.content.text + u.content.text } };
      } else if (["tool_call", "tool_call_update"].includes(u.sessionUpdate)) {
        previous = tools.get(u.toolCallId);
        if (previous) {
          const old = previous.update, fields = Object.fromEntries(Object.entries(u).filter(([, value]) => value != null));
          const meta = { ...old._meta, ...u._meta };
          if (typeof u._meta?.terminal_output?.data === "string") meta.terminal_output = {
            ...u._meta.terminal_output, data: (old._meta?.terminal_output?.data || "") + u._meta.terminal_output.data,
          };
          evt.update = { ...old, ...fields, sessionUpdate: old.sessionUpdate, _meta: meta };
        } else tools.set(u.toolCallId, evt);
      }
      // A message fence is a snapshot seam. Keep subsequent tool progress in
      // the live tail rather than mutating an event on the persisted side.
      if (u._meta?.piAcp?.historyBoundary) tools.clear();
    }
    evt._sz = textSize ?? JSON.stringify(evt.update).length;
    if (previous) {
      s[bytesField] = (s[bytesField] || 0) + evt._sz - previous._sz;
      previous.update = evt.update; previous._sz = evt._sz;
    } else {
      arr.push(evt); s[bytesField] = (s[bytesField] || 0) + evt._sz;
    }
    this.#evictHead(s, arr, bytesField);
  }

  /** Restore evicted history, preserving current progress and model context.
   * The fence is emitted before persistence but delivered on Pi's ordered
   * promise queue after persistence. A synchronous snapshot cannot straddle it. */
  historyEvents(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s?.historyTruncated || this.devinExt) return s?.events || [];
    const snapshot = this.acp.recordedHistorySnapshot?.(sessionId);
    if (!snapshot) return s.events;
    for (let i = s.events.length - 1; i >= 0; i--) {
      const boundary = s.events[i].update?._meta?.piAcp?.historyBoundary;
      const entryIndex = snapshot.messageIndexes.get(boundary);
      if (!boundary) continue;
      // A fence absent from the active branch means a tree switch, not an
      // evicted prefix. Never graft an abandoned branch back into the UI.
      if (entryIndex === undefined) return snapshot.events.map(({ t, update }) => ({ t, update }));
      const prefix = snapshot.events.filter((event) => event.entryIndex <= entryIndex).map(({ t, update }) => ({ t, update }));
      // Reattach request IDs to replayed user messages so inline receipts do
      // not turn into orphan recovery rows after reconnecting a running turn.
      let cursor = prefix.length - 1;
      for (let j = i; j >= 0; j--) {
        const u = s.events[j].update;
        if (u.sessionUpdate !== "user_message_chunk" || !u._meta?.["devin-web/requestId"]) continue;
        for (; cursor >= 0; cursor--) {
          const candidate = prefix[cursor].update;
          if (candidate.sessionUpdate === u.sessionUpdate && candidate.content?.type === u.content?.type &&
              (candidate.content?.text ?? candidate.content?.data) === (u.content?.text ?? u.content?.data)) {
            prefix[cursor].update = { ...candidate, _meta: { ...candidate._meta, ...u._meta } }; cursor--; break;
          }
        }
      }
      const pending = new Set();
      for (const { update } of prefix) {
        if (update.sessionUpdate === "tool_call") pending.add(update.toolCallId);
        if (["completed", "failed"].includes(update.status)) pending.delete(update.toolCallId);
      }
      const inFlight = s.events.slice(0, i + 1).filter((event) => pending.has(event.update.toolCallId));
      return [...prefix, ...inFlight, ...s.events.slice(i + 1)];
    }
    return s.events;
  }

  // Historical image bytes stay in the authoritative transcript. The wire only
  // references immutable, session-scoped assets; eviction can recover them read-only.
  #historyImage(sessionId, image) {
    const mimeType = image.mimeType || "image/png", data = image.data;
    if (!/^image\/(?:png|jpeg|gif|webp|avif)$/.test(mimeType) || typeof data !== "string" || !data || data.length > 32 * 1024 * 1024) return null;
    const mid = "pi-" + createHash("sha256").update(mimeType).update("\0").update(data).digest("hex");
    const key = `${sessionId}:${mid}`, old = this.historyImageCache.get(key);
    const dimensions = old?.dimensions || imageDimensions(mimeType, data);
    if (!dimensions) return null;
    if (old) this.historyImageCache.delete(key);
    else this.historyImageBytes += data.length;
    this.historyImageCache.set(key, old || { data, mimeType, dimensions });
    while (this.historyImageBytes > 32 * 1024 * 1024 || this.historyImageCache.size > 256) {
      const first = this.historyImageCache.keys().next().value;
      this.historyImageBytes -= this.historyImageCache.get(first).data.length; this.historyImageCache.delete(first);
    }
    return { mid, url: `/api/sessions/${encodeURIComponent(sessionId)}/img/${mid}/0`, ...dimensions };
  }

  /** Pure transport projection: never rewrite the SDK branch or delivery buffer. */
  wireHistoryEvents(sessionId, events) {
    return events.map((event) => {
      const update = event.update;
      if (update?.sessionUpdate !== "user_message_chunk" || update.content?.type !== "image" || !update.content.data) return event;
      const asset = this.#historyImage(sessionId, update.content);
      if (!asset) return event;
      const { data, ...content } = update.content;
      return { ...event, update: { ...update, content: { ...content, url: asset.url, ...(asset.width ? { width: asset.width, height: asset.height } : {}) } } };
    });
  }

  // V2 removes only recognized binary image fields. Explicit paths, never a
  // tool-owned marker, let the browser defer bytes without altering other raw data.
  projectHistoryV2(sessionId, events) {
    return this.wireHistoryEvents(sessionId, events).map((event) => {
      const assets = [];
      const walk = (value, path) => {
        if (!value || typeof value !== "object" || path.length >= 245) return value;
        if (value.type === "image" && typeof value.data === "string" && value.data.length >= 1024) {
          const asset = this.#historyImage(sessionId, value);
          if (asset) { assets.push({ ...asset, mimeType: value.mimeType || "image/png", path: [...path, "data"] }); return { ...value, data: null }; }
        }
        let copy;
        for (const [key, child] of Object.entries(value)) {
          const next = walk(child, [...path, Array.isArray(value) ? Number(key) : key]);
          if (next !== child) {
            copy ||= Array.isArray(value) ? value.slice() : { ...value };
            Object.defineProperty(copy, key, { value: next, enumerable: true, writable: true, configurable: true });
          }
        }
        return copy || value;
      };
      return { event: ["tool_call", "tool_call_update"].includes(event.update?.sessionUpdate) ? walk(event, []) : event, assets };
    });
  }

  historyFrameV2(message, { knownToken, baseToken } = {}) {
    const { events, ...envelope } = message, rows = this.projectHistoryV2(message.sessionId, events || []);
    const hashes = Buffer.concat(rows.map((row) => createHash("sha256").update(JSON.stringify(row)).digest()));
    const historyToken = `${this.historyEpoch}:${message.gen}:v2:${createHash("sha256").update(message.sessionId).update("\0").update(hashes).digest("hex")}`;
    const meta = { ...envelope, historyToken, historyEncoding: HISTORY_ENCODING_V2, historyLength: rows.length };
    const previous = this.historyCheckpoints.get(baseToken);
    let from = 0, delta = false;
    if (previous && previous.sessionId === message.sessionId && previous.gen === message.gen && previous.at > Date.now() - 10 * 60_000 &&
        previous.hashes.length <= hashes.length && previous.hashes.equals(hashes.subarray(0, previous.hashes.length))) {
      from = previous.hashes.length / 32; delta = true;
    }
    // Fingerprints only, never another full transcript cache. Eviction is safe:
    // an unavailable baseline simply receives a complete authoritative snapshot.
    const existing = this.historyCheckpoints.get(historyToken);
    if (existing) { this.historyCheckpointBytes -= existing.hashes.length; this.historyCheckpoints.delete(historyToken); }
    if (hashes.length <= 8 * 1024 * 1024 && Number.isSafeInteger(message.gen)) {
      this.historyCheckpoints.set(historyToken, { sessionId: message.sessionId, gen: message.gen, hashes, at: Date.now() });
      this.historyCheckpointBytes += hashes.length;
    }
    while (this.historyCheckpoints.size > 32 || this.historyCheckpointBytes > 8 * 1024 * 1024) {
      const first = this.historyCheckpoints.keys().next().value;
      this.historyCheckpointBytes -= this.historyCheckpoints.get(first).hashes.length; this.historyCheckpoints.delete(first);
    }
    if (knownToken === historyToken) return JSON.stringify({ ...meta, unchanged: true });
    const selected = rows.slice(from), historyAssets = selected.flatMap((row, i) => row.assets.map((asset) => ({ ...asset, path: ["events", i, ...asset.path] })));
    return JSON.stringify({ ...meta, ...(delta ? { delta: true, historyBaseToken: baseToken, historyBaseLength: from } : {}),
      ...packHistoryEvents(selected.map((row) => row.event)), historyAssets });
  }

  /** Old clients retain the exact legacy envelope. New clients opt in per socket. */
  historyFrame(message, { encoding, knownToken, baseToken } = {}) {
    if (encoding === HISTORY_ENCODING_V2) return this.historyFrameV2(message, { knownToken, baseToken });
    if (encoding !== HISTORY_ENCODING) return JSON.stringify(message);
    const { events, ...envelope } = message;
    const body = JSON.stringify(packHistoryEvents(this.wireHistoryEvents(message.sessionId, events || [])));
    const historyToken = `${this.historyEpoch}:${message.gen}:${createHash("sha256").update(body).digest("hex")}`;
    const meta = { ...envelope, historyToken, historyEncoding: HISTORY_ENCODING };
    if (knownToken === historyToken) return JSON.stringify({ ...meta, unchanged: true });
    // Serialize the large body only once, rather than stringify it again in an envelope.
    return JSON.stringify(meta).slice(0, -1) + "," + body.slice(1);
  }

  // By default a session-scoped message goes only to that session's
  // subscribers — `history`/`session_update` payloads are heavy (up to the
  // 32MB buffer) and watchers' clients fold every transcript they receive.
  // Lightweight metadata (state badges, deletions, agent notices) passes
  // {global:true} so watchers' sidebars stay live.
  #broadcast(sessionId, msg, { global = false } = {}) {
    if (msg.type === "history") msg = { ...msg,
      pendingPermissionIds: [...(this.sessions.get(sessionId)?.pendingPermissions.values() || [])].map((p) => p.requestId),
      pendingElicitationIds: [...(this.sessions.get(sessionId)?.pendingElicitations.values() || [])].map((e) => e.requestId),
      title: this.state.sessions[sessionId]?.customTitle || this.sessions.get(sessionId)?.title || this.state.sessions[sessionId]?.title || null,
      ...(this.acp.getProcessSummary ? { processes: this.acp.getProcessSummary(sessionId) } : {}),
    };
    let data, encoded, encodedV2;
    const targets = new Set();
    const s = sessionId && this.sessions.get(sessionId);
    if (s) for (const ws of s.subscribers) targets.add(ws);
    if (global || sessionId == null) for (const ws of this.allSubscribers) targets.add(ws);
    for (const ws of targets) {
      // A socket that both `watch`es and subscribes must get each message once.
      if (ws.readyState === 1) {
        if (msg.type === "history" && ws.historyEncoding === HISTORY_ENCODING_V2) {
          encodedV2 ??= this.historyFrame(msg, { encoding: HISTORY_ENCODING_V2 });
          this.#send(ws, encodedV2);
        } else if (msg.type === "history" && ws.historyEncoding === HISTORY_ENCODING) {
          encoded ??= this.historyFrame(msg, { encoding: HISTORY_ENCODING });
          this.#send(ws, encoded);
        } else { data ??= JSON.stringify(msg); this.#send(ws, data); }
      }
    }
  }

  #send(ws, data) {
    if (ws.readyState === 1) ws.send(data);
  }

  allSubscribers = new Set();

  subscribe(ws, sessionId, cwd) {
    const s = this.#entry(sessionId, cwd);
    s.subscribers.add(ws);
    return s;
  }

  unsubscribe(ws, sessionId) {
    this.sessions.get(sessionId)?.subscribers.delete(ws);
  }

  dropSocket(ws) {
    for (const s of this.sessions.values()) s.subscribers.delete(ws);
    this.allSubscribers.delete(ws);
  }

  /** Ensure the ACP session is loaded in the agent process. */
  async ensureAttached(sessionId, cwd) {
    const s = this.#entry(sessionId, cwd);
    if (s.deleting || this.deletions.get(sessionId)?.status === "deleting") throw new Error("会话正在删除，请稍后核对结果");
    if (s.attached) return s;
    if (s.attaching) return s.attaching;
    // pi's session/load disposes the session's live AgentSession before
    // creating a fresh one — a restart, not an attach. Refuse it while a
    // prompt of ours may still be running on that session (silent longer
    // than TURN_STALL_MS means the turn is already dead).
    if (
      !this.devinExt &&
      s.prompting > 0 &&
      Date.now() - (s.lastActiveAt || 0) < TURN_STALL_MS
    ) {
      s.attachWanted = true;
      throw new Error("session busy — a prompt is still in flight");
    }
    // An archived scratch chat whose files were deleted still needs its cwd
    // for session/load — recreate the exact validated dir, empty.
    if (s.cwd && !fs.existsSync(s.cwd) &&
        (this.state.sessions[sessionId]?.scratch || isScratchDirLexical(scratchRoot(), s.cwd)) &&
        isScratchDir(scratchRoot(), s.cwd)) {
      try { fs.mkdirSync(s.cwd, { recursive: true, mode: 0o700 }); } catch {}
    }
    // Replay lands in a side buffer (see the sessionUpdate handler) — the
    // mirrored events stay intact until the load actually succeeds, so a
    // failed attempt changes nothing for subscribers.
    s.replayEvents = []; s.replayBytes = 0; s.replayTruncated = false;
    const onLoaded = (res) => {
        s.attached = true;
        // A fresh agent-side session cannot carry our previous in-flight
        // prompt — clear any ghost so the queue can drain and the UI stops
        // spinning.
        s.prompting = 0;
        s.attachWanted = false;
        s.lastActiveAt = Date.now();
        s.attaching = null;
        // Transcript is being replaced (mirror → live replay): bump gen so
        // clients reset, swap in the buffered replay, drop mirror state.
        s.gen++;
        // Post-timeout adopts arrive with replayEvents already nulled — keep
        // the previous transcript rather than blanking it.
        if (s.replayEvents) s.historyTruncated = s.replayTruncated;
        s.events = s.replayEvents || s.events || [];
        // Replay drops user prompts sent via ACP (they're not in
        // prompt_history) — graft them back from message_nodes.
        this.#injectUserMessages(s);
        // Devin's own replay drops tool-result images (they live only on
        // message_nodes `images` fields) — patch them back in from sqlite.
        this.#injectToolImages(s);
        s.eventBytes = s.events.reduce((a, e) => a + (e._sz || 0), 0);
        this.#evictHead(s, s.events);
        s.replayEvents = null;
        s.mirrorMsgs = s.mirrorEmittedTc = s.mirrorTcSeen = null;
        s.mirrorCount = s.mirrorMaxRow = null;
        s.userInjected = null; // fresh replay → re-graft user chunks
        s.lockState = null;
        if (res?.modes) s.modes = res.modes;
        if (res?.configOptions) s.configOptions = res.configOptions;
        // Seed the usage cache from replay so the meter doesn't wait for a
        // fresh turn (and mirror sessions get it via usageById).
        if (!s.usage) {
          for (let i = s.events.length - 1; i >= 0; i--) {
            const u = s.events[i].update;
            if (u?.sessionUpdate === "usage_update" && u.size) {
              s.usage = u;
              this.#cappedSet(this.usageById, sessionId, u, MAX_USAGE_CACHE);
              this.state.usageById = Object.fromEntries(this.usageById);
              this.#saveState();
              break;
            }
          }
        }
        s.lastHistoryBC = { gen: s.gen, len: s.events.length, revision: s.eventRevision, at: Date.now() };
        this.#broadcast(sessionId, {
          type: "history",
          sessionId,
          events: this.historyEvents(sessionId),
          revision: s.eventRevision,
          attached: true,
          gen: s.gen,
          state: "held",
          modes: s.modes,
          configOptions: s.configOptions,
          availableCommands: s.commands || this.commandsByCwd.get(s.cwd),
          usage: s.usage || this.usageById.get(sessionId),
          stats: s.stats || null,
          queue: this.#queueView(s),
        });
        this.#broadcast(sessionId, { type: "session_attached", sessionId }, { global: true });
        this.#broadcast(sessionId, { type: "session_state", sessionId, state: "held" }, { global: true });
        // Resume parked prompts — the ghost turn that held them is gone now
        // that a fresh agent-side session is attached.
        if (!s.prompting && s.queue.length) this.#drainQueue(s);
        return s;
      };
    const loadReq = this.#withAttachmentSlot(sessionId, () => this.acp.request("session/load", { sessionId, cwd: s.cwd, mcpServers: [] }).then(onLoaded));
    s.attaching = Promise.race([
      loadReq,
      // A hung session/load (busy/wedged agent) must not hold s.attaching
      // forever — it starves the sqlite mirror via the attaching guard.
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("session/load timed out")), ATTACH_TIMEOUT_MS)
      ),
    ])
      .catch((err) => {
        s.attaching = null;
        s.replayEvents = null;
        // Retry only for transient causes — lock contention (freed later) and
        // timeouts (agent was busy). Permanent errors must not loop forever.
        const kind = err?.data?.["cognition.ai/errorKind"];
        const msg = String(err?.message || "");
        s.attachWanted = kind === "session_locked" || /already open|locked|timed out/i.test(msg);
        s.lockState = /already open|locked/i.test(msg) || kind === "session_locked" ? "locked" : "free";
        // Mirror buffer is untouched by the failed attach — just kick a
        // catch-up pass rather than waiting for the next poll tick.
        this.#kickMirror();
        throw err;
      });
    // If the real load settles after the race already lost (timeout), adopt
    // it — the agent DID load the session, so re-attach rather than leave a
    // held-by-us session in a permanently "failed" split-brain state.
    loadReq.then(
      (res) => {
        if (!s.attached && !s.attaching) onLoaded(res);
      },
      () => {}
    );
    return s.attaching;
  }

  async createSession(cwd, { scratch = false } = {}) {
    const slot = Symbol("new session");
    return this.#withAttachmentSlot(slot, async () => {
      const res = await this.acp.request("session/new", { cwd, mcpServers: [] });
      const s = this.#entry(res.sessionId, cwd);
      s.attached = true;
      this._slotReservations.delete(slot);
      s.modes = res.modes;
      s.configOptions = res.configOptions;
      this.#setMeta(res.sessionId, { cwd, createdAt: new Date().toISOString(), ...(scratch ? { scratch: true } : {}) });
      // Scratch dirs are per-chat temporaries — they never join the MRU list.
      if (!scratch) this.addWorkspace(cwd);
      // pi doesn't write the session file until the first prompt — a re-list
      // would lose the just-created session, so inject it into the cache.
      if (!this.devinExt) {
        this.listCacheAdd({
          sessionId: res.sessionId,
          cwd,
          title: null,
          updatedAt: new Date().toISOString(),
          agent: this.agent,
          pinned: false,
          archived: false,
          scratch,
          state: "held",
        });
      }
      return { sessionId: res.sessionId, modes: res.modes, configOptions: res.configOptions };
    });
  }

  #isRunning(s) {
    return !!(s.prompting || (this.acp.sessionActivity ? this.acp.sessionActivity(s.id).running : s.sdkRunning));
  }

  #hasBackground(s) { return !!this.acp.sessionActivity?.(s.id)?.background; }

  #evictable(s) {
    return s.attached && !s.attaching && !s.closing && !s.deleting && !s.configuring && !s.treeNavigating &&
      !this.#isRunning(s) && !this.#hasBackground(s) && !s.queue.length && !s.pendingPermissions.size && !s.pendingElicitations.size;
  }

  /** Admission reservations cap Pi's heap even when every attachment is busy.
   * Only admission is serialized; unrelated loads and prompts still run in parallel. */
  async #withAttachmentSlot(key, work) {
    if (this.agent !== "pi") return work();
    const reserve = this._capacityGate.then(async () => {
      const count = () => new Set([...this._slotReservations, ...[...this.sessions.values()].filter((s) => s.attached).map((s) => s.id)]).size;
      while (count() >= MAX_ATTACHED_SESSIONS) {
        const candidate = [...this.sessions.values()].filter((s) => s.id !== key && this.#evictable(s))
          .sort((a, b) => Number(a.subscribers.size > 0) - Number(b.subscribers.size > 0) || (a.lastActiveAt || 0) - (b.lastActiveAt || 0))[0];
        if (!candidate) throw processError(409, "SESSION_CAPACITY", "已达到会话保留上限，请先停止后台任务或关闭空闲会话后重试");
        await this.closeSession(candidate.id);
      }
      this._slotReservations.add(key);
    });
    this._capacityGate = reserve.catch(() => {});
    await reserve;
    try { return await work(); } finally { this._slotReservations.delete(key); }
  }

  /**
   * Whether a session is mid-turn, inferred from devin's own sqlite store
   * (strictly read-only): a turn is active when the newest message node is a
   * user prompt (agent owes a reply), a tool result (agent continues), or an
   * assistant message with unanswered tool_calls; or when tool_call_state has
   * unfinished rows; or when last_activity ticked very recently. Falls back
   * to the updatedAt freshness window when the db is unavailable.
   */
  #sessDb() {
    // Devin-only store — a null here disables the mirror, the user-message
    // graft, the activity probe and sqlite image lookups all at once.
    if (!this.devinExt) return null;
    // Retry a failed/absent open periodically — the db may not exist yet on
    // first boot and a cached null would silently kill all mirroring.
    if (!this._sessDb && Date.now() - (this._sessDbT || 0) > 30_000) {
      this._sessDbT = Date.now();
      try {
        const dbPath =
          process.env.DEVIN_SESSIONS_DB ||
          path.join(os.homedir(), ".local/share/devin/cli/sessions.db");
        this._sessDb = DatabaseSync ? new DatabaseSync(dbPath, { readOnly: true }) : null;
        this._sessDb?.exec("PRAGMA query_only = ON");
      } catch {
        this._sessDb = null;
      }
    }
    return this._sessDb;
  }

  /** Drop the sqlite handle after a query failure — a stale/locked handle
   *  would otherwise spam the same error every poll tick. The 30s reopen
   *  throttle in #sessDb() prevents a reopen storm. */
  #invalidateDb() {
    try {
      this._sessDb?.close();
    } catch { /* already broken */ }
    this._sessDb = null;
    // Reset the throttle so the next open waits a full 30s — a persistent
    // failure (corrupt/migrated db) must not retry every poll tick.
    this._sessDbT = Date.now();
  }

  /**
   * Live mirror for sessions held by ANOTHER devin process. ACP won't let a
   * second process subscribe, but every turn is persisted to sessions.db —
   * so we rebuild the same session/update events from message_nodes +
   * tool_call_state (whose *_json columns literally store the ACP payloads)
   * and feed clients through the normal history/session_update channel.
   */
  async #mirrorPoll() {
    const db = this.#sessDb();
    if (!db) return;
    for (const s of this.sessions.values()) {
      // Only mirror what someone is watching and nobody loaded. `attaching`
      // must have settled — the failed session/load replay would otherwise
      // race the mirror's buffer reset.
      if (s.attached || s.attaching || s.subscribers.size === 0) continue;
      try {
        this.#mirrorSession(s);
      } catch (e) {
        console.error(`[devin-web] mirror failed for ${s.id}:`, e);
        this.#invalidateDb();
      }
    }
  }

  #mirrorSession(s) {
    const db = this.#sessDb();
    const sig = db
      .prepare("SELECT COUNT(*) c, COALESCE(MAX(row_id),0) m FROM message_nodes WHERE session_id = ?")
      .get(s.id);
    if (sig.c === s.mirrorCount && sig.m === s.mirrorMaxRow) {
      // No new message rows — tool progress can still move in
      // tool_call_state, which doesn't always add a node.
      this.#mirrorToolUpdates(s);
      return;
    }
    const shrunk = s.mirrorCount != null && sig.c < s.mirrorCount;
    if (s.mirrorMaxRow == null || shrunk) {
      // First mirror pass (or rewind) → rebuild the full transcript and
      // replace the buffer; clients reset on the bumped gen.
      const rows = db
        .prepare("SELECT row_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id")
        .all(s.id);
      // Fresh rebuild — clear dedupe state so every event regenerates.
      s.mirrorMsgs = new Map();
      s.mirrorEmittedTc = new Set();
      s.mirrorTcSeen = new Map();
      const tcMap = this.#mirrorTcMap(s.id);
      const evts = this.#mirrorWalk(s, rows, tcMap);
      s.events = evts.map((update) => ({
        t: Date.now(),
        update,
        _sz: JSON.stringify(update).length,
      }));
      s.eventBytes = s.events.reduce((a, e) => a + e._sz, 0);
      // Rebuild can overshoot the budget too — evict here, not on the next
      // append, so the trimmed window is deterministic.
      this.#evictHead(s, s.events);
      s.mirrorCount = sig.c;
      s.mirrorMaxRow = sig.m;
      s.gen++;
      s.lastHistoryBC = { gen: s.gen, len: s.events.length, revision: s.eventRevision, at: Date.now() };
      this.#broadcast(s.id, {
        type: "history",
        sessionId: s.id,
        events: s.events,
        attached: false,
        gen: s.gen,
        state: s.lockState || "locked",
        availableCommands: s.commands || this.commandsByCwd.get(s.cwd),
        usage: s.usage || this.usageById.get(s.id),
        stats: s.stats || null,
        queue: this.#queueView(s),
      });
    } else {
      // Append-only path: emit events for rows past the watermark.
      const rows = db
        .prepare("SELECT row_id, chat_message FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id")
        .all(s.id, s.mirrorMaxRow);
      const tcMap = this.#mirrorTcMap(s.id);
      const evts = this.#mirrorWalk(s, rows, tcMap);
      for (const update of evts) {
        this.#pushEvent(s, { t: Date.now(), update }, s.events);
        this.#broadcast(s.id, { type: "session_update", sessionId: s.id, update, gen: s.gen });
      }
      s.mirrorCount = sig.c;
      s.mirrorMaxRow = sig.m;
    }
  }

  /**
   * session/load replays text but not image payloads — graft each tool
   * call's persisted `images` onto its last replayed event so history
   * shows the same pictures the live stream did.
   */
  #injectToolImages(s) {
    const db = this.#sessDb();
    if (!db || !s.events?.length) return;
    const byTc = new Map();
    try {
      for (const r of db
        .prepare(
          "SELECT chat_message FROM message_nodes WHERE session_id = ? AND chat_message LIKE '%\"images\"%' ORDER BY row_id"
        )
        .all(s.id)) {
        const m = JSON.parse(r.chat_message);
        if (m.role === "tool" && m.tool_call_id && m.images?.length)
          byTc.set(m.tool_call_id, { mid: m.message_id, images: m.images });
      }
    } catch {
      return;
    }
    if (!byTc.size) return;
    const lastIdx = new Map();
    s.events.forEach((e, i) => {
      const u = e.update || {};
      if (
        (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") &&
        byTc.has(u.toolCallId)
      )
        lastIdx.set(u.toolCallId, i);
    });
    for (const [tc, i] of lastIdx) {
      const u = s.events[i].update;
      if (u.images?.length) continue;
      const rec = byTc.get(tc);
      u.images = rec.images.map((img, j) =>
        rec.mid
          ? {
              url: `/api/sessions/${s.id}/img/${encodeURIComponent(rec.mid)}/${j}`,
              mimeType: img.mime_type || "image/png",
            }
          : { data: img.base64_data, mimeType: img.mime_type || "image/png" }
      );
      s.events[i]._sz = JSON.stringify(u).length;
    }
  }

  /**
   * ACP session/prompt never lands in devin's prompt_history — and replay
   * only surfaces user_message_chunk for prompts recorded there — so prompts
   * sent from the web vanish from reloaded transcripts. Graft missing user
   * messages back from message_nodes, interleaved by the timestamps replay
   * events carry in _meta["cognition.ai/timestamp"]. Dedupe by per-text count
   * (repeated identical prompts stay correct); ids differ between the two
   * stores so matching is on content.
   */
  #injectUserMessages(s) {
    const db = this.#sessDb();
    if (!db || !Array.isArray(s.events)) return;
    let rows;
    try {
      rows = db
        .prepare(
          "SELECT chat_message, created_at FROM message_nodes WHERE session_id = ? AND chat_message LIKE '%\"role\":\"user\"%' ORDER BY row_id"
        )
        .all(s.id);
    } catch {
      return;
    }
    if (!rows.length) return;

    const textOf = (c) =>
      typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("") : "";
    const clean = (t) => (t || "").replace(/\[Image \d+[^\]]*\]\s*/g, "").trim();
    const tsOf = (u) => {
      const t = u?._meta?.["cognition.ai/timestamp"];
      const ms = t ? Date.parse(t) : NaN;
      return Number.isFinite(ms) ? ms : null;
    };
    // Per-event effective timestamp — updates without _meta time inherit the
    // nearest neighbour's so ordering still holds.
    const stamps = s.events.map((e) => tsOf(e.update));
    let last = null;
    for (let i = 0; i < stamps.length; i++) {
      if (stamps[i] == null) stamps[i] = last;
      else last = stamps[i];
    }
    let next = null;
    for (let i = stamps.length - 1; i >= 0; i--) {
      if (stamps[i] == null) stamps[i] = next;
      else next = stamps[i];
    }

    (s.userInjected ||= new Set());
    const OPT_IMG = "__opt-img__"; // optimistic image chunks have no mid/text to dedupe on
    const have = new Map(); // chunk text -> times replay/optimistic already emitted it
    for (const e of s.events) {
      const u = e.update;
      if (u?.sessionUpdate !== "user_message_chunk") continue;
      if (u.content?.type === "text") {
        const t = clean(u.content.text);
        have.set(t, (have.get(t) || 0) + 1);
      } else if (u.content?.type === "image" && u._meta?.["devin-web/optimistic"]) {
        have.set(OPT_IMG, (have.get(OPT_IMG) || 0) + 1);
      }
    }
    const covered = new Map();

    for (const r of rows) {
      let m;
      try {
        m = JSON.parse(r.chat_message);
      } catch {
        continue;
      }
      const mid = m.message_id || "?";
      if (s.userInjected.has(mid)) continue;
      if (m.role && m.role !== "user") {
        // LIKE can catch non-user rows whose serialized content embeds a
        // nested "role":"user" (e.g. the continuation system blob).
        s.userInjected.add(mid);
        continue;
      }
      const text = clean(textOf(m.content));
      const imgs = Array.isArray(m.images) ? m.images : [];
      if ((!text && !imgs.length) || isInternalMessageNode(m, text)) {
        s.userInjected.add(mid);
        continue;
      }
      // Image-only rows have no text to dedupe on — count them against the
      // optimistic image chunks already pushed at send time.
      if (!text && imgs.length) {
        const c = covered.get(OPT_IMG) || 0;
        if (c + imgs.length <= (have.get(OPT_IMG) || 0)) {
          covered.set(OPT_IMG, c + imgs.length);
          s.userInjected.add(mid);
          continue;
        }
      }
      if ((covered.get(text) || 0) < (have.get(text) || 0)) {
        covered.set(text, (covered.get(text) || 0) + 1);
        s.userInjected.add(mid);
        continue;
      }
      s.userInjected.add(mid);
      const raw = Number(r.created_at) || 0;
      const ms = raw > 1e12 ? raw : raw * 1000;
      const meta = { "cognition.ai/timestamp": new Date(ms).toISOString() };
      const evts = [];
      if (text)
        evts.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: meta });
      if (mid !== "?")
        imgs.forEach((im, j) => {
          evts.push({
            sessionUpdate: "user_message_chunk",
            content: {
              type: "image",
              url: `/api/sessions/${s.id}/img/${encodeURIComponent(mid)}/${j}`,
              mimeType: im.mime_type || "image/png",
            },
            _meta: meta,
          });
        });
      let idx = stamps.findIndex((t) => t != null && t > ms);
      if (idx === -1) idx = s.events.length;
      for (const update of evts) {
        const evt = { t: Date.now(), update, _sz: JSON.stringify(update).length };
        s.events.splice(idx, 0, evt);
        stamps.splice(idx, 0, ms);
        s.eventBytes = (s.eventBytes || 0) + evt._sz;
        idx++;
      }
    }
  }

  /** message_id → images[] index for a session (lazy, rebuilt when stale). */
  sessionImage(sessionId, mid, idx) {
    if (/^pi-[a-f0-9]{64}$/.test(mid) && idx === 0) {
      const key = `${sessionId}:${mid}`, cached = this.historyImageCache.get(key);
      if (cached) { this.historyImageCache.delete(key); this.historyImageCache.set(key, cached); return cached; }
      // A cache miss must not load/restart the agent or read an unrelated branch.
      const find = (value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 250) return null;
        if (value.type === "image" && typeof value.data === "string" && this.#historyImage(sessionId, value)?.mid === mid)
          return this.historyImageCache.get(key);
        for (const child of Object.values(value)) if (child && typeof child === "object") { const match = find(child, depth + 1); if (match) return match; }
        return null;
      };
      for (const event of this.historyEvents(sessionId)) { const match = find(event.update); if (match) return match; }
      return null;
    }
    const db = this.#sessDb();
    if (!db) return null;
    let cache = this.imgCache.get(sessionId);
    try {
      const maxRow = db
        .prepare(
          "SELECT MAX(row_id) AS m FROM message_nodes WHERE session_id = ? AND chat_message LIKE '%\"images\"%'"
        )
        .get(sessionId).m;
      if (!maxRow) return null;
      if (!cache || cache.maxRow !== maxRow) {
        cache = { maxRow, byMid: new Map() };
        for (const r of db
          .prepare(
            "SELECT chat_message FROM message_nodes WHERE session_id = ? AND chat_message LIKE '%\"images\"%' ORDER BY row_id"
          )
          .all(sessionId)) {
          const m = JSON.parse(r.chat_message);
          if (m.message_id && Array.isArray(m.images))
            cache.byMid.set(m.message_id, m.images);
        }
        this.#cappedSet(this.imgCache, sessionId, cache, MAX_IMG_CACHE);
      }
    } catch {
      return null;
    }
    const imgs = cache.byMid.get(mid);
    const img = imgs?.[idx];
    return img ? { data: img.base64_data, mimeType: img.mime_type || "image/png" } : null;
  }

  #mirrorTcMap(sessionId) {
    const db = this.#sessDb();
    const m = new Map();
    try {
      for (const r of db
        .prepare("SELECT tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE session_id = ?")
        .all(sessionId)) {
        let call = null;
        let upd = null;
        try { call = r.tool_call_json ? JSON.parse(r.tool_call_json) : null; } catch { /* skip */ }
        try { upd = r.tool_call_update_json ? JSON.parse(r.tool_call_update_json) : null; } catch { /* skip */ }
        m.set(r.tool_call_id, {
          call,
          upd,
          callRaw: r.tool_call_json || "",
          updRaw: r.tool_call_update_json || "",
        });
      }
    } catch { /* table may not exist on older builds */ }
    return m;
  }

  /** Emit tool_call_update events for rows whose update json changed since
   *  the last mirror pass (tool progress doesn't always add message rows). */
  #mirrorToolUpdates(s) {
    if (s.mirrorMaxRow == null) return false;
    const db = this.#sessDb();
    let changed = false;
    if (!s.mirrorTcSeen) s.mirrorTcSeen = new Map();
    try {
      for (const r of db
        .prepare("SELECT tool_call_id, tool_call_json, tool_call_update_json FROM tool_call_state WHERE session_id = ?")
        .all(s.id)) {
        if (!s.mirrorEmittedTc?.has(r.tool_call_id)) continue;
        const prev = s.mirrorTcSeen.get(r.tool_call_id) || { callRaw: "", updRaw: "" };
        const callRaw = r.tool_call_json || "";
        const updRaw = r.tool_call_update_json || "";
        // A stub tool (no tool_call_state row when its message was mirrored)
        // later gains the real call payload — re-emit it so title/kind land.
        if (!prev.callRaw && callRaw) {
          try {
            const update = { sessionUpdate: "tool_call", ...JSON.parse(callRaw) };
            this.#pushEvent(s, { t: Date.now(), update }, s.events);
            this.#broadcast(s.id, { type: "session_update", sessionId: s.id, update, gen: s.gen });
            changed = true;
          } catch { /* unparseable */ }
        }
        if (prev.updRaw !== updRaw && updRaw) {
          try {
            const update = { sessionUpdate: "tool_call_update", ...JSON.parse(updRaw) };
            this.#pushEvent(s, { t: Date.now(), update }, s.events);
            this.#broadcast(s.id, { type: "session_update", sessionId: s.id, update, gen: s.gen });
            changed = true;
          } catch { /* unparseable */ }
        }
        s.mirrorTcSeen.set(r.tool_call_id, { callRaw, updRaw });
      }
    } catch { /* ignore */ }
    return changed;
  }

  /** Walk message_nodes rows → session/update-shaped payloads.
   *  message_nodes stores one context SNAPSHOT per inference call — the same
   *  logical message appears once per rebuilt chain. Dedupe by message_id:
   *  first-seen emits the full text; a longer later version emits the tail
   *  (in-place growth / snapshotting); equal length is skipped outright. */
  #mirrorWalk(s, rows, tcMap) {
    const evts = [];
    (s.mirrorMsgs ||= new Map());
    const textOf = (c) =>
      typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text || "").join("") : "";
    const emitDelta = (mid, kind, text) => {
      if (!text) return;
      const prev = s.mirrorMsgs.get(mid + kind) || 0;
      if (text.length <= prev) return;
      evts.push({ sessionUpdate: kind, content: { type: "text", text: text.slice(prev) } });
      s.mirrorMsgs.set(mid + kind, text.length);
    };
    // Message-level `images` ([{width,height,base64_data,mime_type}]) exist on
    // both user uploads and tool results — they have no ACP event equivalent,
    // so they're emitted as image chunks / tool `images` fields here.
    // Emit a URL, never the base64 — multi-MB payloads in the event buffer get
    // head-evicted by the byte budget, silently deleting older transcript.
    const emitImgs = (mid, images, tcId) => {
      const prev = s.mirrorMsgs.get(mid + ":imgs") || 0;
      if (!Array.isArray(images) || images.length <= prev) return;
      s.mirrorMsgs.set(mid + ":imgs", images.length);
      const usable = mid && mid !== "?";
      // Incremental: only the newly-appended entries — re-sending the whole
      // set would duplicate the earlier ones already rendered client-side.
      const blocks = images.slice(prev).map((im, i) => ({
        ...(usable
          ? { url: `/api/sessions/${s.id}/img/${encodeURIComponent(mid)}/${prev + i}` }
          : { data: im.base64_data }),
        mimeType: im.mime_type || "image/png",
      }));
      if (tcId) {
        evts.push({ sessionUpdate: "tool_call_update", toolCallId: tcId, images: blocks });
      } else {
        for (const b of blocks)
          evts.push({ sessionUpdate: "user_message_chunk", content: { type: "image", ...b } });
      }
    };
    for (const { chat_message } of rows) {
      let m;
      try {
        m = JSON.parse(chat_message);
      } catch {
        continue;
      }
      const mid = m.message_id || "?";
      if (m.role === "user") {
        // Strip the "[Image N: path]" placeholder devin stores for attached
        // images — replay doesn't emit it as text either.
        let uText = textOf(m.content);
        if (m.images?.length) uText = uText.replace(/\[Image \d+[^\]]*\]\s*/g, "").trim();
        if (!isInternalMessageNode(m, uText))
          emitDelta(mid, "user_message_chunk", uText);
        emitImgs(mid, m.images, null);
        // Image blocks embedded in array content — emit each once.
        if (Array.isArray(m.content)) {
          for (const p of m.content) {
            if (p?.type !== "image") continue;
            const ik = `${mid}:img:${p.uri || p.data?.length || "?"}`;
            if (s.mirrorMsgs.get(ik)) continue;
            s.mirrorMsgs.set(ik, 1);
            evts.push({
              sessionUpdate: "user_message_chunk",
              content: { type: "image", data: p.data, mimeType: p.mimeType, uri: p.uri },
            });
          }
        }
      } else if (m.role === "assistant") {
        emitDelta(mid, "agent_thought_chunk", m.thinking?.thinking);
        emitDelta(mid, "agent_message_chunk", textOf(m.content));
        for (const tc of m.tool_calls || []) {
          if (s.mirrorEmittedTc?.has(tc.id)) continue;
          const st = tcMap.get(tc.id);
          if (st?.call) {
            evts.push({ sessionUpdate: "tool_call", ...st.call });
            if (st.upd) evts.push({ sessionUpdate: "tool_call_update", ...st.upd });
          } else {
            evts.push({ sessionUpdate: "tool_call", toolCallId: tc.id, title: "", status: "in_progress" });
          }
          (s.mirrorEmittedTc ||= new Set()).add(tc.id);
          (s.mirrorTcSeen ||= new Map()).set(tc.id, {
            callRaw: st?.callRaw || "",
            updRaw: st?.updRaw || "",
          });
        }
      } else if (m.role === "tool" && m.tool_call_id) {
        // Tool result rows carry their images on the message, not in
        // tool_call_state — surface them on the tool item's `images` field.
        emitImgs(mid, m.images, m.tool_call_id);
      }
    }
    return evts;
  }

  #activityProbe() {
    if (!this.#sessDb()) return null;
    try {
      const rows = this._sessDb
        .prepare(
          `SELECT s.id,
             (SELECT COUNT(*) FROM tool_call_state t
               WHERE t.session_id = s.id AND t.tool_call_update_json IS NULL) pending,
             (SELECT mn.chat_message FROM message_nodes mn
               WHERE mn.session_id = s.id ORDER BY mn.row_id DESC LIMIT 1) last_msg
           FROM sessions s`
        )
        .all();
      const m = new Map();
      for (const r of rows) {
        // "active" = definitely mid-turn; "finished" = last node looks like a
        // completed assistant reply (decide via short freshness window);
        // absent = no signal.
        let verdict = null;
        if (Number(r.pending) > 0) verdict = "active";
        else if (r.last_msg) {
          try {
            const msg = JSON.parse(r.last_msg);
            if (msg.role === "user" || msg.role === "tool") verdict = "active";
            else if (msg.role === "assistant" && msg.tool_calls?.length) verdict = "active";
            else if (msg.role === "assistant") verdict = "finished";
          } catch { /* unparseable — no signal */ }
        }
        m.set(r.id, verdict);
      }
      return m;
    } catch {
      return null;
    }
  }

  async listSessions(cwd, { fresh = false } = {}) {
    // pi's list walks its session dir (~1-3s for ~90 sessions) — serve a
    // short cache to API callers; the state poll passes fresh:true and
    // re-populates it. Mutations bust it via listCacheInvalidate().
    const key = cwd || "";
    const c = this._listCache;
    if (!fresh && c && c.key === key && Date.now() - c.at < LIST_CACHE_MS) return c.data;
    // pi's list filters an unscoped request by its last loaded/created
    // session's cwd (`params.cwd ?? lastSessionCwd`) — an explicit ""
    // defeats that and means "all". It also pages at 50, so follow
    // nextCursor.
    const params = cwd ? { cwd } : this.devinExt ? {} : { cwd: "" };
    const sessions = [];
    let cursor;
    for (let page = 0; page < 40; page++) {
      const res = await this.acp.request("session/list", cursor ? { ...params, cursor } : params);
      sessions.push(...(res.sessions || []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    // Tombstones hide sessions whose agent-side delete is still in flight —
    // otherwise a concurrent poll re-adds the row while the agent's
    // walk-based delete hasn't unlinked the file yet (delete flicker).
    if (this._tombstones?.size) {
      const now = Date.now();
      for (const [id, exp] of this._tombstones) if (exp <= now) this._tombstones.delete(id);
      for (let i = sessions.length - 1; i >= 0; i--)
        if (this._tombstones.has(sessions[i].sessionId)) sessions.splice(i, 1);
    }
    // Sessions created via session/new aren't on the agent's disk yet (pi
    // writes the file on first prompt) — re-add them before enrichment.
    this.#mergeInjected(sessions);
    const activity = this.#activityProbe();
    const now = Date.now();
    for (const it of sessions) {
      // Locally stored rename (agents without a rename RPC) overrides the
      // agent's title — applied BEFORE #setMeta so the override is what gets
      // persisted back, surviving later refreshes.
      it.title = this.state.sessions[it.sessionId]?.customTitle || it.title;
      it.agent = this.agent;
      this.#setMeta(it.sessionId, { cwd: it.cwd, title: it.title, updatedAt: it.updatedAt });
      it.pinned = !!this.state.sessions[it.sessionId]?.pinned;
      it.archived = !!this.state.sessions[it.sessionId]?.archived;
      // Lexical direct-child check only — realpath per row would be a syscall storm.
      it.scratch = !!this.state.sessions[it.sessionId]?.scratch ||
        isScratchDirLexical(this._scratchRoot ??= scratchRoot(), it.cwd);
      // Keep runtime entries fresh
      const s = this.sessions.get(it.sessionId);
      if (s) { s.title = it.title; if (!s.cwd) s.cwd = it.cwd; }
      // working = prompt in-flight under us; held = loaded by our acp, idle;
      // locked-active = held by another process and mid-turn; locked = held by
      // another process, suspended; free = nobody has it.
      if (s?.attached) it.state = this.#isRunning(s) ? "working" : "held";
      else if (it._meta?.["cognition.ai/isLocked"]) {
        const age = it.updatedAt ? now - new Date(it.updatedAt).getTime() : Infinity;
        const verdict = activity?.get(it.sessionId);
        const active =
          verdict === "active" || (verdict === "finished" && age < GEN_WINDOW_MS) ||
          (verdict == null && age < ACTIVE_WINDOW_MS);
        it.state = active ? "locked-active" : "locked";
      } else it.state = "free";
    }
    this._listCache = { key, at: Date.now(), data: sessions };
    return sessions;
  }

  listCacheInvalidate() {
    this._listCache = null;
  }

  /** Patch/remove/add cached rows in place — local mutations (rename, pin,
   *  archive, delete, create) become visible instantly without paying for
   *  another full agent-side list (pi's walks ~90 session files, ~2.5s). */
  listCachePatch(sessionId, patch) {
    const it = this._listCache?.data?.find((x) => x.sessionId === sessionId);
    if (it) Object.assign(it, patch);
  }

  listCacheRemove(sessionId) {
    this._injected?.delete(sessionId);
    if (this._listCache?.data)
      this._listCache.data = this._listCache.data.filter((x) => x.sessionId !== sessionId);
  }

  listCacheAdd(item) {
    // Track created-but-not-yet-listed sessions independently of the cache —
    // a null/expired cache used to swallow the injection entirely, and fresh
    // lists drop the row again until the agent writes the session file.
    (this._injected ||= new Map()).set(item.sessionId, item);
    if (this._listCache?.data) this._listCache.data.unshift(item);
  }

  #mergeInjected(sessions) {
    if (!this._injected?.size) return;
    const have = new Set(sessions.map((x) => x.sessionId));
    for (const [id, it] of [...this._injected]) {
      // Stop patching once the agent lists it itself or the session is dead.
      if (have.has(id) || !this.sessions.get(id)?.attached) {
        this._injected.delete(id);
        continue;
      }
      if (!this._tombstones?.has(id)) sessions.unshift(it);
    }
  }

  /** Queue ONE list rebuild after deletes settle — a refresh already running
   *  when another delete lands is re-run so the last list is post-delete. */
  #scheduleListRefresh() {
    if (this._refreshing) {
      this._refreshQ = true;
      return;
    }
    if (this._refreshT) return;
    this._refreshT = setTimeout(() => {
      this._refreshT = null;
      this._refreshing = true;
      this.listCacheInvalidate();
      this.listSessions(undefined, { fresh: true })
        .catch(() => {})
        .finally(() => {
          this._refreshing = false;
          if (this._refreshQ) {
            this._refreshQ = false;
            this.#scheduleListRefresh();
          }
        });
    }, 3_000);
  }

  /** Lightweight queue preview — goes in queue_update broadcasts + history. */
  #queueView(s) {
    return s.queue.map((q) => ({
      id: q.id,
      at: q.at,
      text: q.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").slice(0, 200),
      images: q.blocks.filter((b) => b.type === "image").length,
      requestId: q.requestId,
    }));
  }

  #broadcastQueue(s) {
    this.#broadcast(s.id, { type: "queue_update", sessionId: s.id, queue: this.#queueView(s) }, { global: true });
  }

  /** A session whose proc died can't still be running a turn — clear the
      in-flight flag and cancel unanswered cards, or the queue parks forever
      behind a ghost and the busy-guard blocks every reattach. */
  #releaseTurn(s) {
    s.prompting = 0;
    s.sdkRunning = false;
    for (const p of s.pendingPermissions.values())
      this.#broadcast(s.id, { type: "permission_resolved", sessionId: s.id, requestId: p.requestId, cancelled: true }, { global: true });
    s.pendingPermissions.clear();
    for (const e of s.pendingElicitations.values())
      this.#broadcast(s.id, { type: "elicitation_resolved", sessionId: s.id, requestId: e.requestId, cancelled: true }, { global: true });
    s.pendingElicitations.clear();
  }

  /** Send the head of the queue once the session goes idle. */
  #drainQueue(s) {
    if (s.deleting || !s.attached || this.#isRunning(s)) return;
    const next = s.queue.shift();
    if (!next) return;
    this.#broadcastQueue(s);
    this.prompt(s.id, s.cwd, next.blocks, { requestId: next.requestId }).then((result) => {
      if (!result?.queued) this.#setPromptReceipt(next.requestId, { status: "completed" });
    }).catch((e) => {
      this.#setPromptReceipt(next.requestId, { status: "failed", error: String(e.message || e) });
      console.error(`[devin-web] queued prompt failed for ${s.id}:`, e);
    });
  }

  /** Public queue preview for history envelopes. */
  queueView(sessionId) {
    const s = this.sessions.get(sessionId);
    return s ? this.#queueView(s) : [];
  }

  /** Remove a queued prompt (client "撤回"). */
  removeQueued(sessionId, queueId) {
    const s = this.sessions.get(sessionId);
    const i = s?.queue.findIndex((q) => q.id === queueId) ?? -1;
    if (i < 0) return false;
    const [q] = s.queue.splice(i, 1);
    this.#setPromptReceipt(q.requestId, { status: "cancelled" });
    this.#broadcastQueue(s);
    return q;
  }

  /** Delivery receipts are retained for 24h; never evict a live/queued request.
   * A duplicate id reuses the same work, including across WebSocket reconnects. */
  submitPrompt(sessionId, cwd, blocks, requestId) {
    if (!requestId) return this.prompt(sessionId, cwd, blocks);
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(requestId))
      return Promise.reject(new Error("无效的发送标识"));
    const hash = createHash("sha256").update(JSON.stringify([sessionId, cwd, blocks])).digest("hex");
    const existing = this.promptReceipts.get(requestId);
    if (existing) return existing.hash === hash ? existing.promise : Promise.reject(new Error("发送标识与原消息不匹配"));
    const now = Date.now();
    for (const [id, entry] of this.promptReceipts) {
      if (["completed", "failed", "cancelled"].includes(entry.status) && now - entry.at > 86400000) this.promptReceipts.delete(id);
    }
    if (this.promptReceipts.size >= 10000) return Promise.reject(new Error("发送确认记录繁忙，请稍后重试"));
    const receipt = { sessionId, requestId, hash, at: now, status: "receiving", accepted: false, promise: null };
    this.promptReceipts.set(requestId, receipt);
    receipt.promise = this.prompt(sessionId, cwd, blocks, { requestId }).then((result) => {
      if (!result?.queued) this.#setPromptReceipt(requestId, { status: "completed" });
      return result;
    }, (error) => {
      this.#setPromptReceipt(requestId, { status: "failed", error: String(error.message || error) });
      throw error;
    });
    return receipt.promise;
  }

  promptStatus(sessionId, requestId) {
    const receipt = this.promptReceipts.get(requestId);
    if (!receipt || receipt.sessionId !== sessionId) return { requestId, status: "unknown" };
    const { status, accepted, queueId, error } = receipt;
    return { requestId, status, accepted, queueId, error };
  }

  #setPromptReceipt(requestId, patch) {
    const receipt = this.promptReceipts.get(requestId);
    if (!receipt) return;
    Object.assign(receipt, patch);
    this.#broadcast(receipt.sessionId, { type: "prompt_delivery", sessionId: receipt.sessionId,
      ...this.promptStatus(receipt.sessionId, requestId) }, { global: true });
  }

  async prompt(sessionId, cwd, blocks, { requestId } = {}) {
    const s = await this.ensureAttached(sessionId, cwd);
    this.#assertNotTreeNavigating(sessionId);
    s.lastActiveAt = Date.now();
    // A turn is already running — park this prompt in the per-session FIFO
    // and drain it when the current prompt resolves. The client gets a
    // queued chip instead of an optimistic user bubble.
    if (this.#isRunning(s)) {
      const q = { id: `q${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, blocks, at: Date.now(), requestId };
      s.queue.push(q);
      this.#broadcastQueue(s);
      this.#setPromptReceipt(requestId, { status: "queued", accepted: true, queueId: q.id });
      return { queued: true, queueId: q.id };
    }
    s.prompting++;
    this.#setPromptReceipt(requestId, { status: "accepted", accepted: true, queueId: undefined });
    this.#broadcast(sessionId, { type: "session_state", sessionId, state: "working" }, { global: true });
    this.#recordPromptHistory(sessionId, blocks);
    // Optimistic transcript entry — web prompts never echo, and the sqlite
    // graft lands only after the turn ends; without it a mid-turn subscriber
    // (app restart, second device) sees a gap where the just-sent message
    // belongs. Rolled back if the prompt fails; superseded by the canonical
    // row graft later.
    const optimistic = [];
    for (const b of blocks) {
      const content =
        b?.type === "text" && b.text
          ? { type: "text", text: b.text }
          : b?.type === "image"
            ? { type: "image", data: b.data, mimeType: b.mimeType, uri: b.uri, url: b.url }
            : null;
      if (!content) continue;
      const update = {
        sessionUpdate: "user_message_chunk",
        content,
        _meta: {
          "cognition.ai/timestamp": new Date().toISOString(),
          "devin-web/optimistic": true,
          ...(requestId ? { "devin-web/requestId": requestId } : {}),
        },
      };
      const evt = { t: Date.now(), update };
      optimistic.push(evt);
      this.#pushEvent(s, evt, s.events);
      this.#broadcast(sessionId, { type: "session_update", sessionId, update, gen: s.gen });
    }
    try {
      const res = await this.acp.request("session/prompt", { sessionId, prompt: blocks });
      return res;
    } catch (e) {
      // The session may be gone agent-side (e.g. closed after an idle
      // detach) — the session id is then unknown. Mark it detached so the
      // poll loop can reattach instead of failing forever.
      if (s.attached && /unknown session|no such session|not found/i.test(String(e?.message))) {
        s.attached = false;
        s.attachWanted = true;
        this.#releaseTurn(s);
        this.#broadcast(sessionId, { type: "session_detached", sessionId }, { global: true });
      }
      // The prompt never ran — pull the optimistic entry back out so it
      // can't haunt future histories (the sender's client keeps its own
      // failed+retry bubble independently).
      if (optimistic.length) {
        for (const evt of optimistic) {
          const i = s.events.indexOf(evt);
          if (i >= 0) {
            s.events.splice(i, 1);
            s.eventBytes = Math.max(0, (s.eventBytes || 0) - evt._sz);
          }
        }
        this.#pushHistory(s);
      }
      throw e;
    } finally {
      s.prompting = Math.max(0, s.prompting - 1);
      // Only claim "held" when we actually still hold it — a mid-prompt
      // detach/lock-loss must not broadcast a false state.
      if (s.attached)
        this.#broadcast(sessionId, { type: "session_state", sessionId, state: this.stateOf(sessionId) }, { global: true });
      // The stored row supersedes the optimistic entry via the text-count
      // dedupe in #injectUserMessages — retry a few times while the turn's
      // snapshot lands, pushing history whenever a graft sticks.
      const graft = () => {
        try {
          const n0 = s.events.length;
          this.#injectUserMessages(s);
          if (s.events.length === n0) return;
          this.#evictHead(s, s.events);
          this.#pushHistory(s);
        } catch { /* best-effort */ }
      };
      for (const d of [2000, 8000, 20000, 45000]) setTimeout(graft, d).unref();
      // FIFO: send the next parked prompt, if any.
      if (!s.prompting && s.attached && s.queue.length) this.#drainQueue(s);
    }
  }

  /** Bump gen + push the consolidated transcript (clients rebuild). */
  #pushHistory(s) {
    s.gen++;
    s.lastHistoryBC = { gen: s.gen, len: s.events.length, revision: s.eventRevision, at: Date.now() };
    this.#broadcast(s.id, {
      type: "history",
      sessionId: s.id,
      events: this.historyEvents(s.id),
      revision: s.eventRevision,
      attached: s.attached,
      gen: s.gen,
      state: this.stateOf(s.id),
      modes: s.modes,
      configOptions: s.configOptions,
      availableCommands: s.commands || this.commandsByCwd.get(s.cwd),
      usage: s.usage || this.usageById.get(s.id),
      stats: s.stats || null,
      queue: this.#queueView(s),
    });
  }

  async cancel(sessionId) {
    this.#assertNotTreeNavigating(sessionId);
    await this.acp.notify("session/cancel", { sessionId });
  }

  #assertNotTreeNavigating(sessionId) {
    if (this.sessions.get(sessionId)?.treeNavigating)
      throw treeError(409, "TREE_BUSY", "会话树正在切换，请完成后再操作此会话");
  }

  processes(sessionId, id) {
    if (this.agent !== "pi" || !this.acp.getProcesses) throw processError(400, "PROCESSES_UNSUPPORTED", "该 Agent 不支持后台任务管理");
    return id ? this.acp.processOutput(sessionId, id) : this.acp.getProcesses(sessionId);
  }

  async stopProcess(sessionId, id) {
    this.#assertNotTreeNavigating(sessionId);
    const s = this.sessions.get(sessionId);
    if (s?.deleting || s?.closing) throw processError(409, "PROCESS_BUSY", "会话正在关闭或删除，请稍后核对任务状态");
    if (this.agent !== "pi" || !this.acp.stopProcess) throw processError(400, "PROCESSES_UNSUPPORTED", "该 Agent 不支持后台任务管理");
    return await this.acp.stopProcess(sessionId, id);
  }

  sessionTree(sessionId, nodeId) {
    if (this.agent !== "pi" || !this.acp.getSessionTree)
      throw treeError(400, "TREE_UNSUPPORTED", "该 Agent 不支持 Pi 会话树");
    if (nodeId) return this.acp.getSessionTreeNode(sessionId, nodeId);
    const tree = this.acp.getSessionTree(sessionId), s = this.sessions.get(sessionId);
    return { ...tree, busy: tree.busy || !!(s?.treeNavigating || s?.deleting || s?.attaching || s?.closing || s?.configuring || s?.prompting || s?.queue?.length) };
  }

  async navigateTree(sessionId, options) {
    const before = this.sessionTree(sessionId), s = this.sessions.get(sessionId);
    if (!s?.attached || before.busy || s.pendingPermissions.size || s.pendingElicitations.size)
      throw treeError(409, "TREE_BUSY", "会话运行、压缩或等待确认中，只能浏览，不能切换分支");
    if ([...this.promptReceipts.values()].some((r) => r.sessionId === sessionId && ["receiving", "accepted", "queued"].includes(r.status)))
      throw treeError(409, "TREE_BUSY", "发送结果仍在确认，请稍后切换分支");
    // Acquire synchronously before any await. Other sessions remain usable.
    s.treeNavigating = true;
    let result;
    try {
      result = await this.acp.navigateSessionTree(sessionId, options);
      return result;
    } finally {
      try {
        // Hooks can change the branch and subsequently throw. Always recover
        // the authoritative native branch, even when the HTTP result is lost.
        if (this.acp.getSessionTree(sessionId).version !== before.version) {
          const snapshot = this.acp.recordedHistorySnapshot(sessionId);
          if (!snapshot) throw new Error("无法恢复切换后的会话历史");
          s.events = []; s.eventBytes = 0; s.historyTruncated = false;
          for (const event of snapshot.events) this.#pushEvent(s, event, s.events);
          if (snapshot.lastEntryKey) this.#pushEvent(s, { t: Date.now(), update: {
            sessionUpdate: "session_info_update", _meta: { piAcp: { historyBoundary: snapshot.lastEntryKey } },
          } }, s.events);
          this.#pushHistory(s);
          this._listCache = null;
          this.#refreshPiStats(s);
        }
        if (result && !result.cancelled) result.historyGen = s.gen;
      } finally { s.treeNavigating = false; s.lastActiveAt = Date.now(); }
    }
  }

  /** Revert steps = the session's prompt checkpoints (listSteps RPC). */
  async revertSteps(sessionId, cwd) {
    if (!this.devinExt) throw new Error("该 agent 不支持分叉");
    const s = await this.ensureAttached(sessionId, cwd);
    const r = await this.acp.request("_cognition.ai/revert/listSteps", { sessionId });
    return r?.steps || [];
  }

  /** Fork the session at a user-prompt step → a NEW session id.
   *  `stepIndex` = index among kind:"prompt" steps (== user message order). */
  async forkAtStep(sessionId, cwd, stepIndex) {
    if (!this.devinExt) throw new Error("该 agent 不支持分叉");
    const steps = await this.revertSteps(sessionId, cwd);
    const prompts = steps.filter((st) => st.kind === "prompt");
    const st = prompts[stepIndex];
    if (!st) throw new Error(`no prompt step at index ${stepIndex}`);
    const r = await this.acp.request("_cognition.ai/revert/forkFromStep", {
      sessionId,
      stepId: st.stepId,
    });
    const nid = r?.forkedSessionId;
    if (!nid) throw new Error("forkFromStep returned no session id");
    // Pre-register with the same cwd so subscribe/history work immediately.
    const ns = this.#entry(nid, this.sessions.get(sessionId)?.cwd || cwd);
    ns.title = `${this.state.sessions[sessionId]?.title || sessionId} (分叉)`;
    this.#setMeta(nid, { title: ns.title });
    return { sessionId: nid, stepId: st.stepId, title: ns.title };
  }

  async setConfigOption(sessionId, configId, value) {
    this.#assertNotTreeNavigating(sessionId);
    const s = this.sessions.get(sessionId);
    if (s) s.configuring = (s.configuring || 0) + 1;
    try { return await this.acp.request("session/set_config_option", { sessionId, configId, value }); }
    finally { if (s) s.configuring--; }
  }

  /** session/prompt doesn't land in devin's prompt_history — and replay only
   *  surfaces user_message_chunk from that table, so web-sent prompts vanish
   *  on reload. Mirror the CLI's own write (single INSERT, safe under WAL). */
  #recordPromptHistory(sessionId, blocks) {
    if (!this.devinExt) return;
    try {
      const text = (blocks || [])
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (!text || !DatabaseSync) return;
      const dbPath =
        process.env.DEVIN_SESSIONS_DB ||
        path.join(os.homedir(), ".local/share/devin/cli/sessions.db");
      const w = new DatabaseSync(dbPath);
      try {
        w.prepare(
          "INSERT INTO prompt_history (content, timestamp, session_id, is_shell) VALUES (?, ?, ?, 0)"
        ).run(text, Math.floor(Date.now() / 1000), sessionId);
      } finally {
        w.close();
      }
    } catch { /* best-effort — #injectUserMessages still covers history */ }
  }

  async renameSession(sessionId, title) {
    // Agents without a rename RPC: the title lives in our own meta only
    // (customTitle overrides the agent's title in listSessions).
    if (!this.devinExt) {
      const s = this.sessions.get(sessionId);
      this.#setMeta(sessionId, { title, customTitle: title });
      this.listCachePatch(sessionId, { title });
      if (s) s.title = title;
      this.#broadcast(
        sessionId,
        {
          type: "session_update",
          sessionId,
          update: { sessionUpdate: "session_info_update", title },
          gen: s?.gen ?? 0,
        },
        { global: true }
      );
      return { ok: true, persisted: true };
    }
    // ACP rename only when we already hold the session — attaching a free one
    // just to set a title replays the whole transcript, and a locked one
    // would fail outright. Otherwise write the sqlite store directly (single
    // UPDATE, safe under WAL, works for locked sessions).
    const s = this.sessions.get(sessionId);
    let done = false;
    if (s?.attached) {
      try {
        await this.acp.request("_cognition.ai/session/rename", { sessionId, title });
        done = true;
      } catch {
        /* fall through to sqlite */
      }
    }
    if (!done) {
      try {
        const dbPath =
          process.env.DEVIN_SESSIONS_DB ||
          path.join(os.homedir(), ".local/share/devin/cli/sessions.db");
        const w = new DatabaseSync(dbPath);
        w.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId);
        w.close();
        done = true;
      } catch {
        /* keep the local title anyway */
      }
    }
    this.#setMeta(sessionId, { title });
    if (s) s.title = title;
    this.#broadcast(
      sessionId,
      {
        type: "session_update",
        sessionId,
        update: { sessionUpdate: "session_info_update", title },
        gen: s?.gen ?? 0,
      },
      { global: true }
    );
    return { ok: true, persisted: done };
  }

  deletions = new Map();

  deletionStatus(sessionId) {
    let entry = this.deletions.get(sessionId);
    if (entry && entry.status !== "deleting" && Date.now() - entry.at > 86400000) { this.deletions.delete(sessionId); entry = null; }
    return entry ? { sessionId, status: entry.status, ...(entry.error ? { error: entry.error } : {}) }
      : { sessionId, status: "unknown" };
  }

  deleteSession(sessionId) {
    this.#assertNotTreeNavigating(sessionId);
    this.deletionStatus(sessionId); // expire completed receipts before deduplication
    const previous = this.deletions.get(sessionId);
    if (previous && ["deleting", "deleted"].includes(previous.status)) return previous.promise;
    for (const [id, entry] of this.deletions) if (entry.status !== "deleting" && Date.now() - entry.at > 86400000) this.deletions.delete(id);
    if (this.deletions.size >= 2000 && !previous) {
      const completed = [...this.deletions].find(([, item]) => item.status !== "deleting");
      if (!completed) throw new Error("删除确认记录繁忙，请稍后操作");
      this.deletions.delete(completed[0]);
    }
    const entry = { status: "deleting", at: Date.now() }; this.deletions.set(sessionId, entry);
    const current = this.sessions.get(sessionId); if (current) current.deleting = true;
    entry.promise = Promise.resolve().then(async () => {
      // The HTTP caller receives acceptance immediately and polls this receipt.
      // Do not turn a transport timeout into a false successful deletion.
      await this.acp.request("session/delete", { sessionId }, 0);
      entry.status = "deleted"; entry.at = Date.now();
      try {
        (this._tombstones ||= new Map()).set(sessionId, Date.now() + 20000);
        this.listCacheRemove(sessionId);
        for (const receipt of this.promptReceipts.values()) if (receipt.sessionId === sessionId && ["receiving", "queued", "accepted"].includes(receipt.status))
          this.#setPromptReceipt(receipt.requestId, { status: "cancelled" });
        this.#broadcast(sessionId, { type: "session_deleted", sessionId }, { global: true });
      } finally {
        this.sessions.delete(sessionId);
        for (const [key, checkpoint] of this.historyCheckpoints) if (checkpoint.sessionId === sessionId) {
          this.historyCheckpointBytes -= checkpoint.hashes.length; this.historyCheckpoints.delete(key);
        }
        for (const [key, image] of this.historyImageCache) if (key.startsWith(`${sessionId}:`)) {
          this.historyImageBytes -= image.data.length; this.historyImageCache.delete(key);
        }
        delete this.state.sessions[sessionId]; this.#saveState(); this.#scheduleListRefresh();
      }
    }).catch((error) => {
      if (entry.status !== "deleted") {
        entry.status = "failed"; entry.error = error.message || "删除失败"; entry.at = Date.now();
        if (current) current.deleting = false;
      }
      throw error;
    });
    return entry.promise;
  }

  /** Scratch quick-chat? Persisted flag first, then the cwd's location. */
  isScratch(sessionId) {
    if (this.state.sessions[sessionId]?.scratch) return true;
    const cwd = this.sessions.get(sessionId)?.cwd || this.state.sessions[sessionId]?.cwd;
    return !!cwd && isScratchDir(scratchRoot(), cwd);
  }

  /** Anything in flight that makes finishing the scratch chat unsafe? */
  scratchBusy(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    return this.#isRunning(s) || this.#hasBackground(s) || s.queue.length > 0 ||
      s.pendingPermissions.size > 0 || s.pendingElicitations.size > 0;
  }

  /** Archive/unarchive a session — hidden from the sidebar unless shown. */
  async setArchived(sessionId, archived) {
    this.#setMeta(sessionId, { archived: !!archived });
    this.listCachePatch(sessionId, { archived: !!archived });
    const s = this.sessions.get(sessionId);
    if (s) s.archived = !!archived;
    this.#broadcast(null, { type: "sessions_changed" });
    return { ok: true };
  }

  /** Pin/unpin a session in the sidebar (local meta only, no agent call). */
  async setPinned(sessionId, pinned) {
    this.#setMeta(sessionId, { pinned: !!pinned });
    this.listCachePatch(sessionId, { pinned: !!pinned });
    const s = this.sessions.get(sessionId);
    if (s) s.pinned = !!pinned;
    // Re-list so every watcher gets the re-sorted sidebar.
    this.#broadcast(null, { type: "sessions_changed" });
    return { ok: true };
  }

  /** Release a session we hold — frees the lock for other processes (e.g. terminal `devin -r`). */
  async closeSession(sessionId) {
    this.#assertNotTreeNavigating(sessionId);
    const s = this.sessions.get(sessionId);
    if (!s?.attached) return { closed: false, reason: "not attached" };
    if (this.#hasBackground(s)) throw processError(409, "PROCESS_BUSY", "请先停止或等待后台任务完成，再释放会话");
    s.closing = true;
    try {
      try {
        await this.acp.request("session/close", { sessionId });
      } catch (error) {
        if (error.code === "PROCESS_BUSY") throw error;
        /* session may already be gone server-side */
      }
      s.attached = false;
      s.attachWanted = false; // explicit release — hand it to whoever wants it
      this.#releaseTurn(s);
      this.#broadcast(sessionId, { type: "session_detached", sessionId }, { global: true });
      this.#broadcast(sessionId, { type: "session_state", sessionId, state: "free" }, { global: true });
      return { closed: true };
    } finally { s.closing = false; }
  }

  permissionResponse(requestId, optionId, cancelled) {
    for (const s of this.sessions.values()) {
      const p = s.pendingPermissions.get(requestId);
      if (p) {
        s.pendingPermissions.delete(requestId);
        p.respond({
          outcome: cancelled
            ? { outcome: "cancelled" }
            : { outcome: "selected", optionId },
        });
        this.#broadcast(
          s.id,
          {
            type: "permission_resolved",
            sessionId: s.id,
            requestId,
            optionId: optionId ?? null,
            cancelled: !!cancelled,
          },
          { global: true }
        );
        return true;
      }
    }
    return false;
  }

  elicitationResponse(requestId, action, content) {
    for (const s of this.sessions.values()) {
      const e = s.pendingElicitations?.get(requestId);
      if (e) {
        s.pendingElicitations.delete(requestId);
        e.respond(
          action === "accept"
            ? { action: "accept", content: content || {} }
            : { action: action === "decline" ? "decline" : "cancel" }
        );
        this.#broadcast(
          s.id,
          { type: "elicitation_resolved", sessionId: s.id, requestId, action },
          { global: true }
        );
        return true;
      }
    }
    return false;
  }

  /** Live state of a session as this process sees it. */
  stateOf(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s?.attached) return s?.lockState || "free";
    return this.#isRunning(s) ? "working" : "held";
  }

  // Aggregate token/cost totals read from the session's own jsonl file
  // (pi-only; devin reports its own usage via usage_update _meta).
  statsFor(sessionId) {
    if (this.agent !== "pi") return Promise.resolve(null);
    return piUsageStats(sessionId).catch(() => null);
  }

  #refreshPiStats(s) {
    if (this.agent !== "pi") return;
    piUsageStats(s.id)
      .then((stats) => {
        if (!stats) return;
        s.stats = stats;
        this.#broadcast(s.id, { type: "session_stats", sessionId: s.id, stats });
      })
      .catch(() => {});
  }

  status() {
    let prompting = 0;
    let queued = 0;
    const attached = [];
    for (const s of this.sessions.values()) {
      if (!s.attached) continue;
      attached.push(s.id);
      if (s.prompting > 0) prompting++;
      queued += s.queue.length;
    }
    return {
      acpReady: this.acp.ready,
      agentInfo: this.acp.agentInfo?.agentInfo,
      attachedSessions: attached,
      promptingSessions: prompting,
      queuedPrompts: queued,
    };
  }
}
