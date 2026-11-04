import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

const MAX_BUFFERED_EVENTS = 8000;
// Event payloads can each carry multi-hundred-KB outputs — cap the replay
// buffer by bytes too, not just count (drop oldest, keep ≥100 tail events).
// Byte budget for one session's buffered transcript. Long sessions easily
// exceed 8 MB of text (thought chunks are large), and crossing the cap
// head-evicts the *oldest* events — which used to silently delete early
// history (incl. persisted images). 32 MB covers very long transcripts while
// still bounding per-session memory.
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
          evt._sz = JSON.stringify(evt.update).length;
          s.replayEvents.push(evt);
          if (s.replayEvents.length > MAX_BUFFERED_EVENTS)
            s.replayEvents.splice(0, s.replayEvents.length - MAX_BUFFERED_EVENTS);
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
        }
        s.lastActiveAt = Date.now();
      }
      // Only stream live updates for sessions we actually hold — replay is
      // delivered as one consolidated `history` once attach resolves, and
      // post-failure stragglers must not broadcast (their gen would
      // ping-pong the client's transcript reset).
      if (s && (s.attaching || !s.attached)) return;
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
        !s.prompting &&
        !s.attaching &&
        s.pendingPermissions.size === 0 &&
        now - (s.lastActiveAt || 0) > IDLE_DETACH_MS
      ) {
        console.log(`[devin-web] auto-detaching idle session ${s.id}`);
        this.closeSession(s.id).catch(() => {});
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
    const list = await this.listSessions(undefined, { fresh: true });
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
    if (!this.state.workspaces.includes(dir)) {
      this.state.workspaces.push(dir);
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

  /** Head-evict oldest buffered events until the byte/count budget holds. */
  #evictHead(s, arr) {
    while (
      (s.eventBytes > MAX_BUFFERED_BYTES || arr.length > MAX_BUFFERED_EVENTS) &&
      arr.length > 100
    ) {
      s.eventBytes -= arr[0]._sz || 0;
      arr.shift();
    }
  }

  /** Push a buffered event with the byte-budget eviction applied. */
  #pushEvent(s, evt, arr) {
    evt._sz = JSON.stringify(evt.update).length;
    arr.push(evt);
    s.eventBytes = (s.eventBytes || 0) + evt._sz;
    this.#evictHead(s, arr);
  }

  // By default a session-scoped message goes only to that session's
  // subscribers — `history`/`session_update` payloads are heavy (up to the
  // 32MB buffer) and watchers' clients fold every transcript they receive.
  // Lightweight metadata (state badges, deletions, agent notices) passes
  // {global:true} so watchers' sidebars stay live.
  #broadcast(sessionId, msg, { global = false } = {}) {
    const data = JSON.stringify(msg);
    const targets = new Set();
    const s = sessionId && this.sessions.get(sessionId);
    if (s) for (const ws of s.subscribers) targets.add(ws);
    if (global || sessionId == null) for (const ws of this.allSubscribers) targets.add(ws);
    for (const ws of targets) {
      // A socket that both `watch`es and subscribes must get each message once.
      if (ws.readyState === 1) this.#send(ws, data);
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
    if (s.attached) return s;
    if (s.attaching) return s.attaching;
    // Replay lands in a side buffer (see the sessionUpdate handler) — the
    // mirrored events stay intact until the load actually succeeds, so a
    // failed attempt changes nothing for subscribers.
    s.replayEvents = [];
    const loadReq = this.acp.request("session/load", { sessionId, cwd: s.cwd, mcpServers: [] });
    s.attaching = Promise.race([
      loadReq,
      // A hung session/load (busy/wedged agent) must not hold s.attaching
      // forever — it starves the sqlite mirror via the attaching guard.
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("session/load timed out")), ATTACH_TIMEOUT_MS)
      ),
    ])
      .then((res) => {
        s.attached = true;
        s.attachWanted = false;
        s.lastActiveAt = Date.now();
        s.attaching = null;
        // Transcript is being replaced (mirror → live replay): bump gen so
        // clients reset, swap in the buffered replay, drop mirror state.
        s.gen++;
        s.events = s.replayEvents || [];
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
        s.lastHistoryBC = { gen: s.gen, len: s.events.length, at: Date.now() };
        this.#broadcast(sessionId, {
          type: "history",
          sessionId,
          events: s.events,
          attached: true,
          gen: s.gen,
          state: "held",
          modes: s.modes,
          configOptions: s.configOptions,
          availableCommands: s.commands || this.commandsByCwd.get(s.cwd),
          usage: s.usage || this.usageById.get(sessionId),
          queue: this.#queueView(s),
        });
        this.#broadcast(sessionId, { type: "session_attached", sessionId }, { global: true });
        this.#broadcast(sessionId, { type: "session_state", sessionId, state: "held" }, { global: true });
        return s;
      })
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
      () => {
        if (!s.attached && !s.attaching)
          this.ensureAttached(sessionId, s.cwd).catch(() => {});
      },
      () => {}
    );
    return s.attaching;
  }

  async createSession(cwd) {
    const res = await this.acp.request("session/new", { cwd, mcpServers: [] });
    const s = this.#entry(res.sessionId, cwd);
    s.attached = true;
    s.modes = res.modes;
    s.configOptions = res.configOptions;
    this.#setMeta(res.sessionId, { cwd, createdAt: new Date().toISOString() });
    this.addWorkspace(cwd);
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
        state: "held",
      });
    }
    return { sessionId: res.sessionId, modes: res.modes, configOptions: res.configOptions };
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
      s.lastHistoryBC = { gen: s.gen, len: s.events.length, at: Date.now() };
      this.#broadcast(s.id, {
        type: "history",
        sessionId: s.id,
        events: s.events,
        attached: false,
        gen: s.gen,
        state: s.lockState || "locked",
        availableCommands: s.commands || this.commandsByCwd.get(s.cwd),
        usage: s.usage || this.usageById.get(s.id),
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
    // pi-acp filters an unscoped list by its last loaded/created session's
    // cwd (`params.cwd ?? lastSessionCwd`) — an explicit "" defeats that and
    // means "all". It also pages at 50, so follow nextCursor.
    const params = cwd ? { cwd } : this.devinExt ? {} : { cwd: "" };
    const sessions = [];
    let cursor;
    for (let page = 0; page < 40; page++) {
      const res = await this.acp.request("session/list", cursor ? { ...params, cursor } : params);
      sessions.push(...(res.sessions || []));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
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
      // Keep runtime entries fresh
      const s = this.sessions.get(it.sessionId);
      if (s) { s.title = it.title; if (!s.cwd) s.cwd = it.cwd; }
      // working = prompt in-flight under us; held = loaded by our acp, idle;
      // locked-active = held by another process and mid-turn; locked = held by
      // another process, suspended; free = nobody has it.
      if (s?.attached) it.state = s.prompting ? "working" : "held";
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
    if (this._listCache?.data)
      this._listCache.data = this._listCache.data.filter((x) => x.sessionId !== sessionId);
  }

  listCacheAdd(item) {
    if (this._listCache?.data) this._listCache.data.unshift(item);
  }

  /** Lightweight queue preview — goes in queue_update broadcasts + history. */
  #queueView(s) {
    return s.queue.map((q) => ({
      id: q.id,
      at: q.at,
      text: q.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").slice(0, 200),
      images: q.blocks.filter((b) => b.type === "image").length,
    }));
  }

  #broadcastQueue(s) {
    this.#broadcast(s.id, { type: "queue_update", sessionId: s.id, queue: this.#queueView(s) }, { global: true });
  }

  /** Send the head of the queue once the session goes idle. */
  #drainQueue(s) {
    const next = s.queue.shift();
    if (!next) return;
    this.#broadcastQueue(s);
    this.prompt(s.id, s.cwd, next.blocks).catch((e) => {
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
    this.#broadcastQueue(s);
    return q;
  }

  async prompt(sessionId, cwd, blocks) {
    const s = await this.ensureAttached(sessionId, cwd);
    s.lastActiveAt = Date.now();
    // A turn is already running — park this prompt in the per-session FIFO
    // and drain it when the current prompt resolves. The client gets a
    // queued chip instead of an optimistic user bubble.
    if (s.prompting > 0) {
      const q = { id: `q${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, blocks, at: Date.now() };
      s.queue.push(q);
      this.#broadcastQueue(s);
      return { queued: true, queueId: q.id };
    }
    s.prompting++;
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
      if (s.attached && !s.prompting)
        this.#broadcast(sessionId, { type: "session_state", sessionId, state: "held" }, { global: true });
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
    s.lastHistoryBC = { gen: s.gen, len: s.events.length, at: Date.now() };
    this.#broadcast(s.id, {
      type: "history",
      sessionId: s.id,
      events: s.events,
      attached: s.attached,
      gen: s.gen,
      state: this.stateOf(s.id),
      modes: s.modes,
      configOptions: s.configOptions,
      availableCommands: s.commands || this.commandsByCwd.get(s.cwd),
      usage: s.usage || this.usageById.get(s.id),
      queue: this.#queueView(s),
    });
  }

  async cancel(sessionId) {
    await this.acp.notify("session/cancel", { sessionId });
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
    return this.acp.request("session/set_config_option", { sessionId, configId, value });
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

  async deleteSession(sessionId) {
    const del = this.acp.request("session/delete", { sessionId }).catch(() => {
      /* best-effort: still remove locally */
    });
    // pi-acp's delete does a full session-dir walk (~seconds) — don't hold
    // the API on it; re-list once the store has actually settled instead.
    if (this.devinExt) await del;
    else
      del.finally(() => {
        this.listCacheInvalidate();
        // Repopulate in the background so the next /api/sessions stays fast.
        this.listSessions(undefined, { fresh: true }).catch(() => {});
      });
    this.listCacheRemove(sessionId);
    const s = this.sessions.get(sessionId);
    if (s) {
      this.#broadcast(sessionId, { type: "session_deleted", sessionId }, { global: true });
      this.sessions.delete(sessionId);
    }
    delete this.state.sessions[sessionId];
    this.#saveState();
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
    const s = this.sessions.get(sessionId);
    if (!s?.attached) return { closed: false, reason: "not attached" };
    try {
      await this.acp.request("session/close", { sessionId });
    } catch {
      /* session may already be gone server-side */
    }
    s.attached = false;
    s.attachWanted = false; // explicit release — hand it to whoever wants it
    s.pendingPermissions.clear();
    this.#broadcast(sessionId, { type: "session_detached", sessionId }, { global: true });
    this.#broadcast(sessionId, { type: "session_state", sessionId, state: "free" }, { global: true });
    return { closed: true };
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

  /** Live state of a session as this process sees it. */
  stateOf(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s?.attached) return s?.lockState || "free";
    return s.prompting ? "working" : "held";
  }

  status() {
    return {
      acpReady: this.acp.ready,
      agentInfo: this.acp.agentInfo?.agentInfo,
      attachedSessions: [...this.sessions.values()].filter((s) => s.attached).map((s) => s.id),
    };
  }
}
