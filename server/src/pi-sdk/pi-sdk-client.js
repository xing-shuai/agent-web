import { EventEmitter } from "node:events";
import { PiAcpAgent } from "./pi-acp-agent.js";

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
        // unstable_createElicitation).
        const conn = {
          sessionUpdate: async (params) => {
            this.emit("sessionUpdate", params?.sessionId, params?.update, params);
          },
          requestPermission: (params) => this.#agentRequest("session/request_permission", params),
          unstable_createElicitation: (params) =>
            this.#agentRequest("elicitation/create", params),
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
