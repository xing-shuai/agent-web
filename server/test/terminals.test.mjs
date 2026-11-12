import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocket } from "ws";
import { TerminalHub, terminalAccess, terminalWebSocketServer } from "../src/terminals.js";

test("touch terminal keys respect cursor modes and one-shot ASCII Ctrl", async () => {
  const { ctrlCharacter, terminalKeySequence } = await import("../../web/src/terminalKeys.js");
  assert.equal(terminalKeySequence("interrupt"), "\x03");
  assert.equal(terminalKeySequence("tab"), "\t");
  assert.equal(terminalKeySequence("escape"), "\x1b");
  assert.equal(terminalKeySequence("up"), "\x1b[A");
  assert.equal(terminalKeySequence("left", { applicationCursorKeysMode: true }), "\x1bOD");
  assert.equal(terminalKeySequence("home", { applicationCursorKeysMode: true }), "\x1bOH");
  assert.equal(terminalKeySequence("end"), "\x1b[F");
  assert.equal(terminalKeySequence("up", {}, true), "\x1b[1;5A");
  assert.equal(terminalKeySequence("delete", {}, true), "\x1b[3;5~");
  assert.equal(terminalKeySequence("pageUp"), "\x1b[5~");
  assert.equal(terminalKeySequence("pageDown"), "\x1b[6~");
  assert.equal(terminalKeySequence("unknown"), "");
  assert.equal(ctrlCharacter("c"), "\x03");
  assert.equal(ctrlCharacter("R"), "\x12");
  assert.equal(ctrlCharacter("a"), "\x01");
  assert.equal(ctrlCharacter("["), "\x1b");
  assert.equal(ctrlCharacter(" "), "\x00");
  assert.equal(ctrlCharacter("?"), "\x7f");
  for (const value of ["中文", "ß", "hello", "\x1b[A", "", "🙂"]) assert.equal(ctrlCharacter(value), null);
});

test("touch selection maps buffer cells and preserves wide glyph boundaries", async () => {
  const { terminalCellAt, terminalWordRange, terminalSelectionSpan } = await import("../../web/src/terminalTouch.js");
  const cells = [..."hello "].map((chars) => ({ getChars: () => chars, getWidth: () => 1 }));
  for (const chars of ["世", "界"]) cells.push({ getChars: () => chars, getWidth: () => 2 }, { getChars: () => "", getWidth: () => 0 });
  cells.push({ getChars: () => " ", getWidth: () => 1 }, { getChars: () => "x", getWidth: () => 1 });
  const terminal = { cols: 12, rows: 2, buffer: { active: { viewportY: 5, length: 10, getLine: () => ({ getCell: (x) => cells[x] }) } } };
  const box = { left: 10, top: 20, width: 120, height: 40 };
  assert.deepEqual(terminalCellAt(terminal, box, 85, 25), { x: 6, y: 5 }, "continuation cells snap to the whole CJK glyph");
  assert.deepEqual(terminalCellAt(terminal, box, 80, 25, true, true), { x: 8, y: 5 }, "end boundaries include, never split, a wide glyph");
  assert.deepEqual(terminalCellAt(terminal, box, -100, -100), { x: 0, y: 0 });
  assert.deepEqual(terminalCellAt(terminal, box, 999, 999, true), { x: 12, y: 9 });
  assert.deepEqual(terminalWordRange(terminal, { x: 6, y: 5 }), { start: { x: 6, y: 5 }, end: { x: 10, y: 5 } });
  assert.equal(terminalWordRange(terminal, { x: 5, y: 5 }), null, "whitespace does not invent a word");
  assert.deepEqual(terminalSelectionSpan(12, { x: 6, y: 5 }, { x: 2, y: 6 }), { column: 6, row: 5, length: 8 });
});

const request = (headers = {}, remoteAddress = "127.0.0.1", url = "/ws/terminal") => ({
  url, headers: { host: "localhost:8787", origin: "http://localhost:8787", ...headers }, socket: { remoteAddress },
});

test("terminal auth requires actual loopback + local host, or a valid token", () => {
  for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(terminalAccess(request({}, ip)), null);
  assert.equal(terminalAccess(request({ host: "[::1]:8787", origin: "http://[::1]:8787" }, "::1")), null);
  assert.equal(terminalAccess(request({}, "192.168.1.10")).status, 403);
  assert.equal(terminalAccess(request({ host: "evil.example", origin: "http://evil.example" })).status, 403, "DNS rebinding is not local access");
  for (const header of ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"])
    assert.equal(terminalAccess(request({ [header]: "127.0.0.1" })).status, 403, "proxy headers cannot grant local access");
  assert.equal(terminalAccess(request({ origin: "http://evil.example" })).status, 403);
  assert.equal(terminalAccess(request({ origin: "http://localhost:5173" })).status, 403, "different ports are different origins");
  assert.equal(terminalAccess(request({ origin: "http://localhost:5173" }), "", ["http://localhost:5173"]), null);
  assert.equal(terminalAccess(request(), "secret").status, 401, "configured auth is required even locally");
  assert.equal(terminalAccess(request({}, "127.0.0.1", "/ws/terminal?token=bad"), "secret").status, 401);
  assert.equal(terminalAccess(request({ host: "web.example", origin: "https://web.example" }, "192.168.1.10", "/ws/terminal?token=secret"), "secret"), null);
  assert.equal(terminalAccess(request({ "x-devin-token": "secret", "x-forwarded-for": "192.168.1.10" }), "secret"), null);
  assert.equal(terminalAccess(request({ origin: "null" }), "secret").status, 403);
});

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages = [];
  send(raw) { this.messages.push(JSON.parse(raw)); }
  close(code) { this.code = code; this.readyState = 3; this.emit("close"); }
  terminate() { this.close(1006); }
  input(message) { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

function fakePty() {
  const pty = { writes: [], sizes: [], kills: 0 };
  pty.onData = (fn) => { pty.output = fn; return { dispose() {} }; };
  pty.onExit = (fn) => { pty.exit = fn; return { dispose() {} }; };
  pty.write = (data) => pty.writes.push(data);
  pty.resize = (cols, rows) => pty.sizes.push([cols, rows]);
  pty.kill = () => { pty.kills++; pty.exit({ exitCode: 0, signal: 1 }); };
  return pty;
}

function fixture(t, maxTerminals = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-terminal-test-"));
  const workspaces = ["a", "b", "c", "d", "e"].map((name) => {
    const dir = path.join(root, name); fs.mkdirSync(dir); return dir;
  });
  const calls = [];
  const hub = new TerminalHub({ workspaces: () => workspaces, maxTerminals, spawnPty: (shell, args, options) => {
    const pty = fakePty(); calls.push({ shell, args, options, pty }); return pty;
  } });
  t.after(() => { hub.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const attach = (cwd = workspaces[0], extra = {}) => {
    const ws = new Socket(); hub.attach(ws, { cwd, ...extra }); return ws;
  };
  return { root, workspaces, calls, hub, attach };
}

test("workspace PTYs survive detach, replay bounded output, and share only canonical workspaces", (t) => {
  const { root, workspaces, calls, hub, attach } = fixture(t);
  assert.deepEqual(hub.status(workspaces[0]), { cwd: workspaces[0], running: false });
  assert.equal(calls.length, 0, "preflight never creates a process");
  const a = attach();
  const pty = calls[0].pty;
  assert.equal(calls[0].options.cwd, workspaces[0]);
  assert.equal(calls[0].options.env.TERM, "xterm-256color");
  assert.equal(calls[0].options.env.DEVIN_WEB_TOKEN, undefined);
  a.input({ type: "input", data: "ls\r" });
  assert.deepEqual(pty.writes, ["ls\r"]);
  a.input({ type: "resize", cols: 100, rows: 40 });
  a.input({ type: "resize", cols: 999999, rows: -1 });
  assert.deepEqual(pty.sizes, [[100, 40]]);
  pty.output("first output");
  a.close(1000);
  assert.equal(pty.kills, 0, "detaching is not termination");
  pty.output("X".repeat(300_000));
  const alias = path.join(root, "alias"); fs.symlinkSync(workspaces[0], alias);
  const b = attach(alias);
  assert.equal(calls.length, 1, "a symlink reattaches to the same workspace process");
  const ready = b.messages[0];
  assert.equal(ready.cols, 100);
  assert.ok(ready.replay.length <= 256 * 1024);
  assert.ok(ready.replay.endsWith("X".repeat(100)));
  assert.equal(hub.sessions.get(workspaces[0]).clients.size, 1);
  const invalid = attach(root);
  assert.equal(invalid.messages[0].type, "terminal_error");
  assert.equal(calls.length, 1, "unregistered directories cannot spawn shells");
  assert.equal(attach("relative/path").code, 1008);
});

test("termination, restart, resource caps and shutdown are explicit and bounded", (t) => {
  const { workspaces, calls, hub, attach } = fixture(t, 1);
  const a = attach();
  assert.equal(attach(workspaces[1]).code, 1008, "live processes are never evicted");
  a.input({ type: "restart" });
  assert.equal(calls.length, 1, "cannot replace an active shell");
  a.input({ type: "input", data: "x".repeat(40_000) });
  assert.equal(calls[0].pty.writes.length, 0, "oversized input is rejected");
  a.emit("message", Buffer.from("not JSON"));
  assert.equal(a.messages.at(-1).type, "terminal_error");
  a.input({ type: "terminate" });
  assert.equal(a.messages.at(-1).type, "terminal_exit");
  a.input({ type: "restart" });
  assert.equal(calls.length, 2);
  assert.equal(a.messages.at(-1).replay, "");
  a.input({ type: "terminate" });
  const b = attach(workspaces[1]); b.input({ type: "terminate" });
  assert.equal(attach(workspaces[2]).code, 1008, "connected exited caches are bounded too");
  a.close(1000);
  const c = attach(workspaces[2]);
  assert.equal(c.messages[0].type, "terminal_ready", "disconnected exited caches can be reclaimed");
  hub.dispose();
  assert.equal(c.code, 1001);
  assert.equal(calls.at(-1).pty.kills, 1);
  assert.equal(attach(workspaces[3]).code, 1008, "shutdown cannot create another shell");
});

test("slow terminal browsers are disconnected without killing the shared shell", (t) => {
  const { attach, calls, hub, workspaces } = fixture(t);
  const ws = attach();
  ws.bufferedAmount = 2 * 1024 * 1024;
  calls[0].pty.output("output");
  assert.equal(ws.code, 1013);
  assert.equal(calls[0].pty.kills, 0);
  assert.equal(hub.sessions.get(workspaces[0]).clients.size, 0);
});

function messages(ws) {
  const received = [];
  ws.on("message", (raw) => received.push(JSON.parse(raw)));
  return received;
}
async function waitFor(predicate) {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for terminal event");
}

test("real PTY over WebSocket supports resize, Ctrl+C, reconnect and exit/restart", { timeout: 20_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "devin-real-terminal-"));
  const hub = new TerminalHub({ workspaces: () => [root], shell: "/bin/sh" });
  const server = http.createServer();
  const wss = terminalWebSocketServer({ hub, token: "test-token" });
  server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)));
  const clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    hub.dispose();
    await Promise.all([new Promise((resolve) => wss.close(resolve)), new Promise((resolve) => server.close(resolve))]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `ws://127.0.0.1:${server.address().port}/ws/terminal?cwd=${encodeURIComponent(root)}`;
  const denied = async (url, origin) => {
    const ws = new WebSocket(url, origin ? { origin } : {}); clients.push(ws);
    const error = await new Promise((resolve) => ws.once("error", resolve));
    return error.message;
  };
  assert.match(await denied(base), /401/);
  assert.match(await denied(base + "&token=test-token", "https://evil.example"), /403/);
  assert.equal(hub.sessions.size, 0, "failed upgrades never start a PTY");
  const connect = async () => {
    const ws = new WebSocket(base + "&token=test-token&cols=80&rows=24"); clients.push(ws);
    const log = messages(ws);
    await waitFor(() => log.find((m) => m.type === "terminal_ready"));
    return { ws, log, send: (message) => ws.send(JSON.stringify(message)) };
  };
  const a = await connect();
  const processId = hub.sessions.get(root).pty.pid;
  a.send({ type: "resize", cols: 100, rows: 40 });
  a.send({ type: "input", data: "export PTY_STATE=kept; stty size; printf 'PTY_%s\\n' OK\r" });
  const output = (log) => log.filter((m) => m.type === "terminal_output").map((m) => m.data).join("");
  await waitFor(() => output(a.log).includes("PTY_OK"));
  assert.match(output(a.log), /40 100/);
  a.send({ type: "input", data: "printf 'JOB_%s\\n' RUNNING; sleep 30\r" });
  await waitFor(() => output(a.log).includes("JOB_RUNNING"));
  a.send({ type: "input", data: "\x03" });
  a.send({ type: "input", data: "printf 'CTRL_%s\\n' OK\r" });
  await waitFor(() => output(a.log).includes("CTRL_OK"));
  a.ws.close(); await once(a.ws, "close");
  assert.equal(hub.sessions.get(root).pty.pid, processId);
  const b = await connect();
  assert.match(b.log[0].replay, /PTY_OK/);
  b.send({ type: "input", data: "printf 'STATE_%s\\n' \"$PTY_STATE\"\r" });
  await waitFor(() => output(b.log).includes("STATE_kept"));
  assert.equal(hub.sessions.get(root).pty.pid, processId);
  b.send({ type: "input", data: "exit 7\r" });
  assert.equal((await waitFor(() => b.log.find((m) => m.type === "terminal_exit"))).exitCode, 7);
  b.send({ type: "restart" });
  await waitFor(() => b.log.filter((m) => m.type === "terminal_ready").length === 2);
  assert.notEqual(hub.sessions.get(root).pty.pid, processId);
  b.send({ type: "terminate" });
  await waitFor(() => b.log.filter((m) => m.type === "terminal_exit").length === 2);
});
