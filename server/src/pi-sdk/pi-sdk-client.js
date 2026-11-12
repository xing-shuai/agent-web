import { EventEmitter } from "node:events";
import { PiAcpAgent, piHistoryEvents, piMessageKey } from "./pi-acp-agent.js";
import { sessionTree, treeNode, treeVersion, treeError } from "./session-tree.js";
import { processError } from "./processes.js";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * PiSdkClient is a drop-in AcpClient for the pi agent: same public interface
 * and events, but instead of a `pi-acp` subprocess it drives a vendored
 * PiAcpAgent in-process (backed by pi SDK AgentSessions via PiSdkProcess).
 *
 * Events:
 *  - "sessionUpdate"   (sessionId, update)
 *  - "request"         (msg, respond, respondError) — session/request_permission,
 *                      elicitation/create
 *  - "notification"    (method, params)
 *  - "exit"            never fires (no subprocess)
 */
export class PiSdkClient extends EventEmitter {
  constructor({ label = "pi sdk", initMeta = {} } = {}) {
    super();
    this.label = label;
    this.initMeta = initMeta;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.starting = null;
    this.agentInfo = null;
    this.agent = null;
  }

  /** Lazily construct the agent and complete the ACP initialize handshake. */
  ensureStarted() {
    if (this.agent && this.agentInfo) return Promise.resolve(this);
    if (this.starting) return this.starting;

    this.starting = Promise.resolve()
      .then(() => {
        // Minimal AgentSideConnection stand-in: only the methods the
        // vendored agent calls (sessionUpdate, requestPermission,
        // unstable_createElicitation) plus a devin-web `notify` channel —
        // extension ui.notify is routed here so transient notices reach the
        // UI as toasts instead of polluting the transcript.
        const conn = {
          sessionUpdate: async (params) => {
            this.emit("sessionUpdate", params?.sessionId, params?.update, params);
          },
          requestPermission: (params) => this.#agentRequest("session/request_permission", params),
          unstable_createElicitation: (params) =>
            this.#agentRequest("elicitation/create", params),
          notify: (params) => this.emit("notification", "pi/extension_notify", params),
        };
        this.agent = new PiAcpAgent(conn);
        return this.#dispatch("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            // Form-mode elicitation — pi input/editor dialogs arrive via
            // unstable_createElicitation (carried-over elicitation patch).
            elicitation: { form: {} },
            _meta: this.initMeta,
          },
          clientInfo: { name: "devin-web", title: "Agent Web", version: "0.1.0" },
        });
      })
      .then((res) => {
        this.agentInfo = res;
        this.starting = null;
        return this;
      })
      .catch((err) => {
        this.starting = null;
        this.agent = null;
        throw err;
      });
    return this.starting;
  }

  get ready() {
    return !!(this.agent && this.agentInfo);
  }

  /** Agent→client request: emit "request" and resolve with the answer. */
  #agentRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const msg = { jsonrpc: "2.0", id, method, params };
      this.emit(
        "request",
        msg,
        (result) => resolve(result),
        (code, message) => {
          const e = new Error(message || "request rejected");
          e.code = code;
          reject(e);
        }
      );
    });
  }

  /** Synchronous read of the active raw branch, never the compacted context.
   * Used only when the hub's bounded delivery buffer has evicted old history. */
  recordedHistorySnapshot(sessionId) {
    const loaded = this.agent?.sessions.maybeGet(sessionId);
    const manager = loaded?.proc.session?.sessionManager;
    if (!manager) return null;
    const entries = manager.getBranch();
    return { events: piHistoryEvents({ entries, messages: entries.filter((e) => e.type === "message").map((e) => e.message) }, loaded.cwd),
      lastEntryKey: entries.at(-1)?.id ? `entry:${entries.at(-1).id}` : null,
      messageIndexes: new Map(entries.flatMap((e, index) => [[`entry:${e.id}`, index], ...(piMessageKey(e.type === "custom_message" ? e : e.message) ? [[piMessageKey(e.type === "custom_message" ? e : e.message), index]] : [])])) };
  }

  // Read-only and session-local: never restore/load a session for a panel read.
  getProcesses(sessionId) {
    const loaded = this.agent?.sessions.maybeGet(sessionId);
    return { attached: !!loaded, ...(loaded?.proc.processes?.snapshot() || { available: process.platform !== "win32", activeCount: 0, pending: false, processes: [] }) };
  }

  getProcessSummary(sessionId) {
    return this.agent?.sessions.maybeGet(sessionId)?.proc.processes?.summary() || { available: false, activeCount: 0, pending: false };
  }

  processOutput(sessionId, id) {
    const bridge = this.agent?.sessions.maybeGet(sessionId)?.proc.processes;
    if (!bridge) throw processError(409, "PROCESSES_UNAVAILABLE", "会话未加载，无法读取后台任务");
    return bridge.output(id);
  }

  async stopProcess(sessionId, id) {
    const bridge = this.agent?.sessions.maybeGet(sessionId)?.proc.processes;
    if (!bridge) throw processError(409, "PROCESSES_UNAVAILABLE", "会话未加载，无法停止后台任务");
    return await bridge.stop(id);
  }

  sessionActivity(sessionId) {
    const loaded = this.agent?.sessions.maybeGet(sessionId), session = loaded?.proc.session;
    return { background: !!loaded?.proc.processes?.busy,
      running: !!(loaded?.runActive || loaded?.pendingTurn || loaded?.inAgentLoop || loaded?.turnQueue?.length ||
        session?.isIdle === false || session?.isStreaming || session?.isCompacting || session?.isRetrying || session?.pendingMessageCount) };
  }

  // Tree reads never restore/load a session or touch its leaf/context/file.
  getSessionTree(sessionId) {
    return sessionTree(this.agent?.sessions.maybeGet(sessionId));
  }

  getSessionTreeNode(sessionId, nodeId) {
    const loaded = this.agent?.sessions.maybeGet(sessionId);
    if (!loaded?.proc.session?.sessionManager) throw treeError(409, "TREE_NOT_LOADED", "请等待会话加载完成后刷新会话树");
    const manager = loaded.proc.session.sessionManager, entry = manager.getEntry(nodeId);
    if (!entry) throw treeError(404, "TREE_NODE_MISSING", "树节点不存在，请刷新会话树");
    return treeNode(entry, manager, true);
  }

  async navigateSessionTree(sessionId, { targetId, version, summarize = false }) {
    const loaded = this.agent?.sessions.maybeGet(sessionId);
    // The hub serializes Web mutations; recheck native activity after the
    // await as extensions can also drive the SDK outside the hub.
    if (!loaded?.proc.session?.sessionManager) throw treeError(409, "TREE_NOT_LOADED", "请等待会话加载完成后刷新会话树");
    const session = loaded.proc.session;
    const bridge = loaded.proc.processes;
    if (bridge?.navigating) throw treeError(409, "TREE_BUSY", "会话树正在切换，请完成后再操作此会话");
    if (bridge) bridge.navigating = true;
    try {
    await loaded.flushEmits();
    if (this.agent?.sessions.maybeGet(sessionId) !== loaded || loaded.proc.session !== session)
      throw treeError(409, "TREE_STALE", "会话已重新加载，请刷新会话树");
    loaded.proc.assertNoBackgroundTasks?.();
    const state = sessionTree(loaded), manager = session.sessionManager;
    if (state.busy) throw treeError(409, "TREE_BUSY", "会话运行或压缩中，只能浏览，不能切换分支");
    if (version !== treeVersion(manager)) throw treeError(409, "TREE_STALE", "会话树已变化，请刷新后重新选择节点");
    const entry = manager.getEntry(targetId);
    if (!entry || !treeNode(entry, manager).navigable) throw treeError(400, "TREE_TARGET_INVALID", "请选择可继续的消息或摘要节点");
    // Never silently truncate the editable prompt after changing context.
    const editable = entry.type === "custom_message" ? entry.content : entry.message?.role === "user" ? entry.message.content : "";
    const textLength = typeof editable === "string" ? editable.length : Array.isArray(editable)
      ? editable.reduce((size, block) => size + (block.type === "text" && typeof block.text === "string" ? block.text.length : 0), 0) : 0;
    if (textLength > 8 * 1024 * 1024)
      throw treeError(413, "TREE_PROMPT_TOO_LARGE", "该消息过大，无法安全恢复到输入框");
    if (targetId === manager.getLeafId()) return { cancelled: true };
    loaded.contextUsageRevision = (loaded.contextUsageRevision || 0) + 1;
    try {
      const result = await session.navigateTree(targetId, { summarize });
      if (result.cancelled || result.aborted) return { cancelled: true };
      // SDK branch() only moves an in-memory leaf. An append-only, non-context
      // checkpoint preserves even an empty/new-root selection across unloads;
      // old entries and branches remain byte-for-byte intact.
      manager.appendCustomEntry("devin-web.tree-cursor", { targetId });
      return { cancelled: false, editorText: result.editorText || "", images: treeNode(entry, manager).images,
        leafId: manager.getLeafId(), version: treeVersion(manager) };
    } finally { await loaded.publishContextUsage(); }
    } finally { if (bridge) bridge.navigating = false; }
  }

  /** ACP method dispatch → PiAcpAgent methods. */
  async #dispatch(method, params) {
    const agent = this.agent;
    switch (method) {
      case "initialize":
        return await agent.initialize(params);
      case "session/new":
        return await agent.newSession(params);
      case "session/load":
        return await agent.loadSession(params);
      case "session/list":
        return await agent.listSessions(params);
      case "session/delete":
        return await agent.deleteSession(params);
      case "session/prompt":
        return await agent.prompt(params);
      case "session/cancel":
        return await agent.cancel(params);
      case "session/set_config_option":
        return await agent.setSessionConfigOption(params);
      case "session/set_mode":
        return await agent.setSessionMode(params);
      case "session/close":
        return await agent.closeSession(params);
      case "authenticate":
        return await agent.authenticate(params);
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  /** Client→agent request. Same timeout semantics as AcpClient (60s, none
   *  for session/prompt) so a wedged call can't hang SessionHub. */
  async request(method, params = {}, timeoutMs = undefined) {
    await this.ensureStarted();
    if (timeoutMs === undefined)
      timeoutMs = method === "session/prompt" ? 0 : REQUEST_TIMEOUT_MS;
    const work = Promise.resolve()
      .then(() => this.#dispatch(method, params))
      .catch((err) => {
        // Agent errors (incl. RequestError) surface as plain Errors with
        // code/data copied — SessionHub inspects those fields.
        const e = new Error(err?.message ?? String(err));
        if (err?.code !== undefined) e.code = err.code;
        if (err?.status !== undefined) e.status = err.status;
        if (err?.data !== undefined) e.data = err.data;
        throw e;
      });
    if (!timeoutMs) return await work;
    let timer;
    try {
      return await Promise.race([
        work,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const e = new Error(`${method} timed out`);
            e.code = -32000;
            e.data = { "cognition.ai/errorKind": "timeout" };
            reject(e);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Client→agent notification (fire-and-forget, e.g. session/cancel). */
  async notify(method, params = {}) {
    await this.ensureStarted();
    // Don't await: a notification must not block on agent work.
    Promise.resolve()
      .then(() => this.#dispatch(method, params))
      .catch((e) => console.error(`[devin-web] pi ${method} failed:`, e));
  }

  /**
   * Shut down the agent — aborts in-flight turns and disposes every SDK
   * session. Returns a promise so the server can await teardown before
   * exiting; callers that don't care can ignore it.
   */
  async kill() {
    try {
      await this.agent?.dispose();
    } catch {
    }
  }
}
