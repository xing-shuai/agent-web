import { stripVTControlCharacters } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";

// Public upstream event protocol, pinned with @aliou/pi-processes@0.13.6.
const channel = (name) => `processes:${name}`;
const LIVE = new Set(["running", "terminating", "terminate_timeout"]);
export const processError = (status, code, message) => Object.assign(new Error(message), { status, code });
const clip = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
const publicProcess = (p) => ({
  id: p.id, name: clip(p.name, 512), command: clip(p.command, 8192), cwd: clip(p.cwd, 4096),
  pid: p.pid, status: p.status, startTime: p.startTime, endTime: p.endTime,
  exitCode: p.exitCode, endReason: p.endReason, signal: p.signal?.name || null,
  error: clip(p.errorMessage, 2048),
});

/** A session-local observer/controller, never a process runner or task store. */
export class ProcessBridge {
  constructor(events, { limit = Number(process.env.MAX_BACKGROUND_PROCESSES_PER_SESSION || 8) } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("MAX_BACKGROUND_PROCESSES_PER_SESSION 必须为正整数");
    this.events = events;
    this.limit = limit;
    this.launches = new Set();
    this.launchContext = new AsyncLocalStorage();
    this.wrapped = new WeakSet();
    this.starting = new Set();
    this.settling = false;
    this.navigating = false;
    this.onChange = () => {};
  }

  request(name, params = {}) {
    let value, replies = 0;
    this.events.emit(channel(`request:${name}`), { ...params, reply: (result) => { value = result; replies++; } });
    if (replies > 1) throw processError(409, "PROCESSES_CONFLICT", "后台进程插件重复加载，请禁用个人或项目配置中的重复插件");
    if (!replies) throw processError(409, "PROCESSES_UNAVAILABLE", "后台进程插件尚未就绪或已关闭");
    return value;
  }

  snapshot() {
    let processes;
    try { processes = this.request("list"); } catch { processes = null; }
    const available = Array.isArray(processes);
    processes ||= [];
    return { available, limit: this.limit, activeCount: processes.filter((p) => LIVE.has(p.status)).length,
      pending: this.starting.size > 0 || this.launches.size > 0 || this.settling, processes: processes.map(publicProcess).reverse() };
  }

  get busy() { const s = this.snapshot(); return !!(s.activeCount || s.pending); }

  summary() {
    const { processes, ...summary } = this.snapshot();
    return summary;
  }

  bind = (pi) => {
    this.starting.clear(); this.settling = false;
    let previous;
    const changed = () => { const next = this.summary(), key = JSON.stringify(next); if (key !== previous) { previous = key; this.onChange(next); } };
    this.changed = changed;
    const disposers = [
      this.events.on(channel("started"), () => { const launch = this.launchContext.getStore(); if (launch) launch.spawned = true; }),
      this.events.on(channel("changed"), changed),
      this.events.on(channel("ended"), () => {
        // Upstream defers completion delivery to setImmediate. Keep retention
        // and tree guards closed until that delivery had its chance to run.
        this.settling = true; changed();
        clearImmediate(this.settleTimer);
        this.settleTimer = setImmediate(() => { this.settling = false; changed(); });
      }),
    ];
    pi.on("tool_call", (event) => {
      if (event.toolName !== "process" || event.input?.action !== "start") return;
      if (this.navigating) return { block: true, reason: "会话树正在切换，不能启动后台任务" };
      this.starting.add(event.toolCallId); changed();
    });
    pi.on("tool_execution_end", (event) => { if (this.starting.delete(event.toolCallId)) changed(); });
    for (const event of ["session_before_tree", "session_before_switch", "session_before_fork"])
      pi.on(event, () => this.busy ? { cancel: true } : undefined);
    pi.on("session_start", changed);
    pi.on("session_shutdown", () => {
      clearImmediate(this.settleTimer);
      for (const dispose of disposers) dispose();
      this.starting.clear(); this.settling = false;
      changed();
    });
  };

  // Wrap the registered tool at the SDK integration boundary, not upstream
  // package files. Reservations cover async starts and parallel nested calls.
  wrapTools = (loaded) => {
    for (const extension of loaded.extensions) {
      const tool = extension.tools.get("process");
      if (!tool || this.wrapped.has(tool.definition)) continue;
      const original = tool.definition.execute;
      tool.definition = { ...tool.definition, execute: async (...args) => {
        if (args[1]?.action !== "start") return original(...args);
        if (this.navigating) throw processError(409, "PROCESS_BUSY", "会话树正在切换，不能启动后台任务");
        const reserved = [...this.launches].filter((launch) => !launch.spawned).length;
        const processes = this.request("list"); // Fail closed on duplicate/missing engines.
        if (!Array.isArray(processes)) throw processError(409, "PROCESSES_UNAVAILABLE", "后台进程插件尚未就绪或已关闭");
        if (processes.filter((p) => LIVE.has(p.status)).length + reserved >= this.limit)
          throw processError(409, "PROCESS_CAPACITY", `本会话最多运行 ${this.limit} 个后台任务，请先停止或等待现有任务完成`);
        const launch = { spawned: false }; this.launches.add(launch);
        try { return await this.launchContext.run(launch, () => original(...args)); }
        finally { this.launches.delete(launch); this.changed?.(); }
      } };
      this.wrapped.add(tool.definition);
    }
    return loaded;
  };

  output(id) {
    if (!this.request("get", { id })) throw processError(404, "PROCESS_MISSING", "后台任务不存在或已清理");
    const lines = this.request("combined_output", { id, tailLines: 200 });
    const text = stripVTControlCharacters((lines || []).map((line) => line.text).join("\n"));
    const bytes = Buffer.from(text);
    return { id, text: bytes.subarray(Math.max(0, bytes.length - 65536)).toString("utf8"),
      truncated: bytes.length > 65536 || (lines?.length || 0) >= 200 };
  }

  async stop(id) {
    if (!this.request("get", { id })) throw processError(404, "PROCESS_MISSING", "后台任务不存在或已清理");
    // No retries. A lost response must be verified by reading the list.
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(processError(504, "PROCESS_STOP_UNKNOWN", "停止结果尚未确认，请刷新任务列表核对，不会自动重试")), 12000);
      this.events.emit(channel("command:kill"), { id, timeoutMs: 5000, reply: (result) => {
        clearTimeout(timer);
        if (!result.ok) reject(processError(409, "PROCESS_STOP_FAILED", "后台任务未确认停止，请刷新任务列表核对"));
        else resolve({ process: publicProcess(result.info) });
      } });
    });
  }
}

// Hide only the upstream npm package's extension entry points from Web's
// loader. CLI keeps its original settings, skills and TUI extensions; Web
// always uses its pinned engine + lifecycle wrapper, even after /reload.
export function processSettingsForWeb(settingsManager) {
  return new Proxy(settingsManager, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key === "getGlobalSettings" || key === "getProjectSettings") return () => {
      const settings = value.call(target);
      return { ...settings, packages: settings.packages?.map((entry) => {
        const source = typeof entry === "string" ? entry : entry.source;
        return source === "npm:@aliou/pi-processes" || source?.startsWith("npm:@aliou/pi-processes@")
          ? { ...(typeof entry === "string" ? { source } : entry), extensions: [] } : entry;
      }) };
    };
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

export function createProcessResources(extensionFactories = []) {
  const eventBus = createEventBus(), processes = new ProcessBridge(eventBus);
  return { processes, resourceLoaderOptions: {
    eventBus,
    additionalExtensionPaths: process.platform === "win32" ? [] : [fileURLToPath(new URL("./processes-extension.js", import.meta.url))],
    extensionFactories: [...extensionFactories, processes.bind], extensionsOverride: processes.wrapTools,
  } };
}

export function processNotification(message) {
  if (message?.customType !== "ad-process:notification" || !message.details) return null;
  const d = message.details;
  return { id: `${d.timestamp}:${d.processId}:${d.kind}:${d.logMatch?.pattern || ""}`,
    processId: clip(d.processId, 128), name: clip(d.processName, 512), kind: clip(d.kind, 64),
    summary: clip(d.summary, 4096), exitCode: d.exitCode, at: d.timestamp };
}
