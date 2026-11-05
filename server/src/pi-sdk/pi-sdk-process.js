// PiSdkProcess: in-process replacement for pi-acp's PiRpcProcess.
//
// Instead of spawning `pi --mode rpc` and talking NDJSON to it, each
// instance owns one pi SDK AgentSessionRuntime. The method surface and
// return shapes mirror what PiRpcProcess extracted from RPC responses —
// each method ports the matching `case` of handleCommand in pi's own
// dist/modes/rpc/rpc-mode.js. Session creation mirrors main() in
// dist/main.js for the rpc path (minus CLI-flag handling).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  ProjectTrustStore,
  hasTrustRequiringProjectResources,
  getAgentDir,
  initTheme,
} from "@earendil-works/pi-coding-agent";

// Internal (non-exported) pi modules — the package `exports` map only
// exposes "." so these are imported by absolute file URL from the
// installed package root. The version is pinned exactly, so these paths
// are stable.
const PI_DIST = path.dirname(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))
);
const piInternal = (rel) => pathToFileURL(path.join(PI_DIST, rel)).href;
const { builtInExtensions } = await import(piInternal("extensions/index.js"));
const { configureHttpDispatcher, applyHttpProxySettings } = await import(
  piInternal("core/http-dispatcher.js")
);
const { toJsonEvent } = await import(piInternal("modes/json-event.js"));
const { theme } = await import(piInternal("modes/interactive/theme/theme.js"));

// PI_CODING_AGENT_SESSION_DIR (same env var main() consults).
const ENV_SESSION_DIR = "PI_CODING_AGENT_SESSION_DIR";

function expandTilde(p) {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

// One-time global init (first create): proxy env + the shared undici
// dispatcher, whose error listeners keep mid-stream aborts from crashing
// the process — required now that pi runs in-process.
let globalInit = null;
function ensureGlobalInit(cwd, agentDir) {
  if (!globalInit) {
    globalInit = Promise.resolve().then(() => {
      const bootstrap = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
      applyHttpProxySettings(bootstrap.getGlobalSettings().httpProxy);
      configureHttpDispatcher(bootstrap.getHttpIdleTimeoutMs());
      initTheme(bootstrap.getTheme(), false);
    });
  }
  return globalInit;
}

export class PiSdkProcess {
  runtime;
  session;
  eventHandlers = [];
  pendingExtensionRequests = new Map();
  unsubscribe = null;

  constructor(runtime) {
    this.runtime = runtime;
  }

  /**
   * Mirror main()'s rpc path: create (or open) a SessionManager, build the
   * AgentSessionRuntime, then bind extensions + subscribe like rpc-mode's
   * rebindSession.
   */
  static async create({ cwd, sessionPath }) {
    const agentDir = getAgentDir();
    await ensureGlobalInit(cwd, agentDir);
    const bootstrap = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    const envDir = process.env[ENV_SESSION_DIR];
    const sessionDir = (envDir ? expandTilde(envDir) : undefined) ?? bootstrap.getSessionDir();
    const sessionManager = sessionPath
      ? SessionManager.open(sessionPath, sessionDir)
      : SessionManager.create(cwd, sessionDir);
    const trustStore = new ProjectTrustStore(agentDir);
    const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      // No trust prompting in-process: trust iff the project needs none or
      // the user already trusted it.
      const projectTrusted =
        !hasTrustRequiringProjectResources(cwd) || trustStore.get(cwd) === true;
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        modelRuntimeSignal: AbortSignal.timeout(15_000),
        resourceLoaderOptions: { extensionFactories: builtInExtensions },
      });
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: sessionManager.getCwd(),
      agentDir,
      sessionManager,
    });
    const proc = new PiSdkProcess(runtime);
    // Runtime calls this after every session replacement (switch/new/fork/
    // import) — same hook rpc-mode registers; without it the event
    // subscription stays bound to the invalidated old session.
    runtime.setRebindSession(() => proc.rebindSession());
    await proc.rebindSession();
    // Same as the old spawn path: make sure the session file's parent dir
    // exists so writes don't fail later.
    try {
      const state = await proc.getState();
      if (typeof state?.sessionFile === "string" && state.sessionFile) {
        fs.mkdirSync(path.dirname(state.sessionFile), { recursive: true });
      }
    } catch {
    }
    return proc;
  }

  emit(ev) {
    for (const h of this.eventHandlers) h(ev);
  }

  onEvent(handler) {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }

  /** rpc-mode's rebindSession: (re)bind extensions, (re)subscribe events. */
  async rebindSession() {
    const session = (this.session = this.runtime.session);
    const uiContext = this.createExtensionUIContext();
    await session.bindExtensions({
      uiContext,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async (options) => this.runtime.newSession(options),
        fork: async (entryId, forkOptions) => {
          const result = await this.runtime.fork(entryId, forkOptions);
          return { cancelled: result.cancelled };
        },
        navigateTree: async (targetId, options) => {
          const result = await session.navigateTree(targetId, {
            summarize: options?.summarize,
            customInstructions: options?.customInstructions,
            replaceInstructions: options?.replaceInstructions,
            label: options?.label,
          });
          return { cancelled: result.cancelled };
        },
        switchSession: async (sessionPath, options) =>
          this.runtime.switchSession(sessionPath, options),
        reload: async () => {
          await session.reload();
        },
      },
      shutdownHandler: () => {},
      onError: (err) => {
        this.emit({
          type: "extension_error",
          extensionPath: err.extensionPath,
          event: err.event,
          error: err.error,
        });
      },
    });
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      this.emit(toJsonEvent(event));
    });
  }

  // ===================================================================
  // Extension UI context — ported verbatim from rpc-mode's
  // createExtensionUIContext, with output() emitting to event handlers
  // instead of stdout. sendExtensionUiResponse() resolves by request id.
  // ===================================================================

  createDialogPromise(opts, defaultValue, request, parseResponse) {
    if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timeoutId;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        opts?.signal?.removeEventListener("abort", onAbort);
        this.pendingExtensionRequests.delete(id);
      };
      const onAbort = () => {
        cleanup();
        resolve(defaultValue);
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout) {
        timeoutId = setTimeout(() => {
          cleanup();
          resolve(defaultValue);
        }, opts.timeout);
      }
      this.pendingExtensionRequests.set(id, {
        resolve: (response) => {
          cleanup();
          resolve(parseResponse(response));
        },
        reject,
      });
      this.emit({ type: "extension_ui_request", id, ...request });
    });
  }

  createExtensionUIContext() {
    return {
      select: (title, options, opts) =>
        this.createDialogPromise(
          opts,
          undefined,
          { method: "select", title, options, timeout: opts?.timeout },
          (r) =>
            "cancelled" in r && r.cancelled
              ? undefined
              : "value" in r
                ? r.value
                : undefined
        ),
      confirm: (title, message, opts) =>
        this.createDialogPromise(
          opts,
          false,
          { method: "confirm", title, message, timeout: opts?.timeout },
          (r) =>
            "cancelled" in r && r.cancelled
              ? false
              : "confirmed" in r
                ? r.confirmed
                : false
        ),
      input: (title, placeholder, opts) =>
        this.createDialogPromise(
          opts,
          undefined,
          { method: "input", title, placeholder, timeout: opts?.timeout },
          (r) =>
            "cancelled" in r && r.cancelled
              ? undefined
              : "value" in r
                ? r.value
                : undefined
        ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        });
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        this.emit({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        });
      },
      setWorkingMessage: (_message) => {},
      setWorkingVisible: (_visible) => {},
      setWorkingIndicator: (_options) => {},
      setHiddenThinkingLabel: (_label) => {},
      setWidget: (key, content, options) => {
        if (content === undefined || Array.isArray(content)) {
          this.emit({
            type: "extension_ui_request",
            id: crypto.randomUUID(),
            method: "setWidget",
            widgetKey: key,
            widgetLines: content,
            widgetPlacement: options?.placement,
          });
        }
      },
      setFooter: (_factory) => {},
      setHeader: (_factory) => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "setTitle",
          title,
        });
      },
      custom: async () => undefined,
      pasteToEditor(text) {
        this.setEditorText(text);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: crypto.randomUUID(),
          method: "set_editor_text",
          text,
        });
      },
      getEditorText: () => "",
      editor: (title, prefill) => {
        const id = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          this.pendingExtensionRequests.set(id, {
            resolve: (response) => {
              if ("cancelled" in response && response.cancelled) {
                resolve(undefined);
              } else if ("value" in response) {
                resolve(response.value);
              } else {
                resolve(undefined);
              }
            },
            reject,
          });
          this.emit({ type: "extension_ui_request", id, method: "editor", title, prefill });
        });
      },
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return theme;
      },
      getAllThemes: () => [],
      getTheme: (_name) => undefined,
      setTheme: (_theme) => ({
        success: false,
        error: "Theme switching not supported in RPC mode",
      }),
      getToolsExpanded: () => false,
      setToolsExpanded: (_expanded) => {},
    };
  }

  /** rpc-mode's extension_ui_response handling. */
  async sendExtensionUiResponse(response) {
    const pending = this.pendingExtensionRequests.get(response.id);
    if (pending) {
      this.pendingExtensionRequests.delete(response.id);
      pending.resolve(response);
    }
  }

  // ===================================================================
  // Command methods — each ports a handleCommand case from rpc-mode.
  // ===================================================================

  /** Resolve on preflight (like the RPC response did); reject if the
   *  prompt fails before being accepted. */
  async prompt(message, images = []) {
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve();
      };
      this.session
        .prompt(message, {
          images,
          source: "rpc",
          preflightResult: () => done(),
        })
        .then(() => done())
        .catch((e) => done(e instanceof Error ? e : new Error(String(e))));
    });
  }

  async abort() {
    await this.session.abort();
  }

  async getState() {
    const session = this.session;
    return {
      model: session.model,
      thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      autoCompactionEnabled: session.autoCompactionEnabled,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
    };
  }

  async getAvailableModels() {
    return { models: this.session.modelRuntime.getAvailableSnapshot() };
  }

  async setModel(provider, modelId) {
    const models = this.session.modelRuntime.getAvailableSnapshot();
    const model = models.find((m) => m.provider === provider && m.id === modelId);
    if (!model) {
      throw new Error(`Model not found: ${provider}/${modelId}`);
    }
    await this.session.setModel(model);
    return model;
  }

  async getAvailableThinkingLevels() {
    return this.session.getAvailableThinkingLevels();
  }

  async setThinkingLevel(level) {
    this.session.setThinkingLevel(level);
  }

  async setSteeringMode(mode) {
    this.session.setSteeringMode(mode);
  }

  async setFollowUpMode(mode) {
    this.session.setFollowUpMode(mode);
  }

  async compact(customInstructions) {
    return await this.session.compact(customInstructions);
  }

  async setAutoCompaction(enabled) {
    this.session.setAutoCompactionEnabled(enabled);
  }

  async getSessionStats(_timeoutMs) {
    return (await this.session.getSessionStats()) ?? {};
  }

  async setSessionName(name) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) throw new Error("Session name cannot be empty");
    this.session.setSessionName(trimmed);
  }

  async exportHtml(outputPath) {
    const p = await this.session.exportToHtml(outputPath);
    return { path: String(p ?? "") };
  }

  async switchSession(sessionPath) {
    const result = await this.runtime.switchSession(sessionPath);
    if (!result.cancelled) {
      await this.rebindSession();
    }
  }

  async getMessages() {
    return { messages: this.session.messages };
  }

  async getCommands() {
    const commands = [];
    for (const command of this.session.extensionRunner.getRegisteredCommands()) {
      commands.push({
        name: command.invocationName,
        description: command.description,
        source: "extension",
        sourceInfo: command.sourceInfo,
      });
    }
    for (const template of this.session.promptTemplates) {
      commands.push({
        name: template.name,
        description: template.description,
        source: "prompt",
        sourceInfo: template.sourceInfo,
      });
    }
    for (const skill of this.session.resourceLoader.getSkills().skills) {
      commands.push({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill",
        sourceInfo: skill.sourceInfo,
      });
    }
    return { commands };
  }

  /** Prelude lines were a subprocess-stdout concept — none in-process. */
  consumePreludeLines() {
    return [];
  }

  async dispose() {
    try {
      this.unsubscribe?.();
    } catch {
    }
    this.unsubscribe = null;
    for (const [, p] of this.pendingExtensionRequests) {
      try {
        p.resolve({ cancelled: true });
      } catch {
      }
    }
    this.pendingExtensionRequests.clear();
    await this.runtime.dispose();
  }
}
