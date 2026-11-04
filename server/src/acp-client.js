import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * AcpClient manages a single agent ACP subprocess (e.g. `devin acp`,
 * `pi-acp`) and speaks newline-delimited JSON-RPC 2.0 over its stdin/stdout.
 *
 * Events:
 *  - "sessionUpdate"   (sessionId, update)
 *  - "request"         (msg, respond)   — agent→client JSON-RPC requests
 *                                       (session/request_permission, fs/*, terminal/*)
 *  - "notification"    (method, params) — non-session notifications
 *  - "exit"            (code, signal)
 */
export class AcpClient extends EventEmitter {
  constructor({ bin = "devin", args = ["acp"], label = "devin acp", initMeta = {} } = {}) {
    super();
    this.bin = bin;
    this.args = args;
    this.label = label;
    this.initMeta = initMeta;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> {resolve, reject}
    this.buf = "";
    this.starting = null;
    this.agentInfo = null;
  }

  /** Lazily spawn the process and complete the ACP initialize handshake. */
  ensureStarted() {
    if (this.proc && !this.proc.killed) return Promise.resolve(this);
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      const proc = spawn(this.bin, this.args, {
        stdio: ["pipe", "pipe", "inherit"],
      });
      this.proc = proc;
      this.buf = "";

      proc.stdout.on("data", (d) => this.#onData(d));
      // Writes racing a dying process would otherwise raise an unhandled
      // 'error' event on stdin and kill the whole server.
      proc.stdin.on("error", () => {});
      proc.on("error", (err) => {
        this.proc = null;
        this.starting = null;
        reject(err);
      });
      proc.on("exit", (code, signal) => {
        const pendings = [...this.pending.values()];
        this.pending.clear();
        for (const p of pendings) {
          clearTimeout(p.timer);
          p.reject(new Error(`${this.label} exited (code=${code} signal=${signal})`));
        }
        this.proc = null;
        this.starting = null;
        this.agentInfo = null;
        this.emit("exit", code, signal);
      });

      this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Form-mode elicitation — agents may ask structured questions
          // (devin ask_user_question); we render them as answer cards.
          elicitation: { form: {} },
          _meta: this.initMeta,
        },
        clientInfo: { name: "devin-web", title: "Agent Web", version: "0.1.0" },
      })
        .then((res) => {
          this.agentInfo = res;
          this.starting = null;
          resolve(this);
        })
        .catch((err) => {
          this.starting = null;
          // A wedged process that fails initialize must not linger —
          // ensureStarted would otherwise keep reusing it and every later
          // request would pend forever.
          if (this.proc === proc) {
            proc.kill("SIGKILL");
            this.proc = null;
          }
          reject(err);
        });
    });
    return this.starting;
  }

  get ready() {
    return !!(this.proc && !this.proc.killed && this.agentInfo);
  }

  #onData(chunk) {
    this.buf += chunk.toString("utf8");
    const lines = this.buf.split("\n");
    this.buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      this.#onMessage(msg);
    }
  }

  #onMessage(msg) {
    // Response to a pending client→agent request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) {
          const e = new Error(msg.error.message || "JSON-RPC error");
          e.code = msg.error.code;
          e.data = msg.error.data;
          p.reject(e);
        } else {
          p.resolve(msg.result);
        }
        return;
      }
      // Unknown response id — ignore.
      return;
    }

    // Agent→client request (has id + method): must be answered.
    if (msg.id !== undefined && msg.method) {
      const respond = (result) => {
        try {
          this.#send({ jsonrpc: "2.0", id: msg.id, result });
        } catch {
          /* process died mid-request — nothing left to answer to */
        }
      };
      const respondError = (code, message) => {
        try {
          this.#send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
        } catch {
          /* same */
        }
      };
      this.emit("request", msg, respond, respondError);
      return;
    }

    // Notification
    if (msg.method === "session/update") {
      this.emit("sessionUpdate", msg.params?.sessionId, msg.params?.update, msg.params);
    } else if (msg.method) {
      this.emit("notification", msg.method, msg.params ?? {});
    }
  }

  #send(obj) {
    if (!this.proc || this.proc.killed || this.proc.exitCode != null || this.proc.stdin.destroyed)
      throw new Error(`${this.label} is not running`);
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Client→agent request. Auto-starts the process.
   *  Every request gets a timeout — a wedged agent must not leave entries in
   *  `pending` forever (callers' promises would hang, leaking memory and
   *  state like a stuck `prompting` flag). session/prompt is exempt: a turn
   *  legitimately runs for a long time. */
  async request(method, params = {}, timeoutMs = undefined) {
    await this.ensureStarted();
    if (timeoutMs === undefined)
      timeoutMs = method === "session/prompt" ? 0 : REQUEST_TIMEOUT_MS;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            if (!this.pending.delete(id)) return;
            const e = new Error(`${method} timed out`);
            e.code = -32000;
            e.data = { "cognition.ai/errorKind": "timeout" };
            reject(e);
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** Client→agent notification. */
  async notify(method, params = {}) {
    await this.ensureStarted();
    this.#send({ jsonrpc: "2.0", method, params });
  }

  kill() {
    if (this.proc) this.proc.kill("SIGTERM");
  }
}
