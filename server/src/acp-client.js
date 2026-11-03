import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * AcpClient manages a single `devin acp` subprocess and speaks
 * newline-delimited JSON-RPC 2.0 over its stdin/stdout.
 *
 * Events:
 *  - "sessionUpdate"   (sessionId, update)
 *  - "request"         (msg, respond)   — agent→client JSON-RPC requests
 *                                       (session/request_permission, fs/*, terminal/*)
 *  - "notification"    (method, params) — non-session notifications
 *  - "exit"            (code, signal)
 */
export class AcpClient extends EventEmitter {
  constructor(devinBin = "devin") {
    super();
    this.devinBin = devinBin;
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
      const proc = spawn(this.devinBin, ["acp"], {
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
        for (const p of pendings)
          p.reject(new Error(`devin acp exited (code=${code} signal=${signal})`));
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
          // Devin extension flags — these gate which slash commands the agent
          // advertises in available_commands_update.
          //   chains:                 +/btw
          //   workspaceDirCommands:   +/add-dir /undo-add-dir /remove-dir
          _meta: {
            "cognition.ai/chains": true,
            "cognition.ai/workspaceDirCommands": true,
          },
        },
        clientInfo: { name: "devin-web", title: "Devin Web", version: "0.1.0" },
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
      throw new Error("devin acp is not running");
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Client→agent request. Auto-starts the process. */
  async request(method, params = {}) {
    await this.ensureStarted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (e) {
        this.pending.delete(id);
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
