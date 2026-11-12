import { sanitizePath } from "../src/remote-routes.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import express from "express";
import ssh2 from "ssh2";
const { Server, utils } = ssh2;
import { WebSocket } from "ws";
import { HostStore, RemoteHosts } from "../src/remote-hosts.js";
import { remoteAccess, remoteRoutes, remoteWebSocketServer } from "../src/remote-routes.js";
import { workerBundle, nodeRuntimePlan, downloadNodeRuntime } from "../src/remote-worker.js";

const root = path.resolve(import.meta.dirname, "../..");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-web-remote-test-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (predicate) => { for (let i = 0; i < 150; i++) { const value = await predicate(); if (value) return value; await delay(50); } throw new Error("remote fixture timeout"); };

test("SSH credentials are encrypted, identity-bound and never silently replaced", (t) => {
  const dir = temp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32).toString("base64"), file = path.join(dir, "hosts.json");
  const store = new HostStore(file, key);
  const host = store.add({ hostname: "example.invalid", username: "user", password: "private-fixture-password" });
  assert.equal(store.password(host), "private-fixture-password");
  assert.ok(!fs.readFileSync(file, "utf8").includes("private-fixture-password"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const ciphertext = fs.readFileSync(file, "utf8");
  assert.throws(() => new HostStore(file, randomBytes(32).toString("base64")).password(host), /无法解密/);
  const locked = new HostStore(file, "");
  assert.throws(() => locked.password(host), /缺少/);
  assert.throws(() => locked.update(host.id, { password: "new" }), /配置/);
  assert.equal(fs.readFileSync(file, "utf8"), ciphertext);
  host.hostname = "different.invalid"; assert.throws(() => store.password(host), /无法解密/);
  host.hostname = "example.invalid";
  store.update(host.id, { password: "replacement" }); assert.equal(store.password(host), "replacement");
  assert.throws(() => store.add({ hostname: "host; touch bad", username: "user", password: "x" }), /有效/);
  assert.throws(() => new HostStore(file, "not-a-key"), /32 字节/);
  fs.writeFileSync(file, "corrupt"); assert.throws(() => new HostStore(file, key), /未覆盖/);
  assert.equal(fs.readFileSync(file, "utf8"), "corrupt");
});

test("remote control plane requires token, verified origin and HTTPS or direct loopback", () => {
  const request = (headers = {}, peer = "127.0.0.1") => ({ url: "/api/remotes", headers: { host: "localhost:8787", "x-devin-token": "secret", ...headers }, socket: { remoteAddress: peer } });
  assert.equal(remoteAccess(request(), "secret"), null);
  assert.equal(remoteAccess(request(), "").status, 503);
  assert.equal(remoteAccess(request({ "x-devin-token": "wrong" }), "secret").status, 401);
  assert.equal(remoteAccess(request({ origin: "https://evil.example" }), "secret").status, 403);
  assert.equal(remoteAccess(request({ host: "web.example", origin: "http://web.example" }, "192.0.2.1"), "secret").status, 403);
  const proxy = request({ host: "web.example", origin: "https://web.example", "x-forwarded-proto": "https" });
  assert.equal(remoteAccess(proxy, "secret").status, 403, "forwarded TLS is not trusted by default");
  assert.equal(remoteAccess(proxy, "secret", [], "loopback"), null);
  assert.equal(remoteAccess({ ...proxy, socket: { remoteAddress: "192.0.2.1" } }, "secret", [], "loopback").status, 403);
});

test("explicit LAN HTTP exception requires exact private Host/Origin, loopback transport and token", () => {
  const allowed = "192.168.200.112:8788";
  const request = (headers = {}, peer = "127.0.0.1") => ({ url: "/api/remotes", headers: { host: allowed, origin: `http://${allowed}`, "x-devin-token": "secret", ...headers }, socket: { remoteAddress: peer } });
  const check = (req, hosts = allowed) => remoteAccess(req, "secret", ["http://evil.example"], "", hosts);
  assert.equal(check(request(), "").status, 403, "exception is off by default");
  assert.equal(check(request()), null);
  assert.equal(check(request({}, "::ffff:127.0.0.1")), null);
  assert.equal(remoteAccess(request(), "", [], "", allowed).status, 503);
  assert.equal(check(request({ "x-devin-token": "wrong" })).status, 401);
  assert.equal(check(request({ host: "192.168.200.112:8789", origin: "http://192.168.200.112:8789" })).status, 403);
  assert.equal(check(request({ origin: "http://evil.example" })).status, 403, "global allowed origins cannot widen a plaintext exception");
  assert.equal(check(request({ origin: "https://192.168.200.112:8788" })).status, 403);
  for (const peer of ["192.168.200.1", "203.0.113.4"]) assert.equal(check(request({}, peer)).status, 403, "do not infer tunnel safety from spoofable Host headers");
  for (const name of ["forwarded", "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "x-forwarded-host"])
    assert.equal(check(request({ [name]: name === "x-forwarded-proto" ? "http" : "" })).status, 403, "HTTP exception does not trust proxy headers");
  for (const host of ["evil.example:8788", "8.8.8.8:8788", "192.168.200.112.evil.example:8788", "192.168.*:8788", "192.168.200.112:65536", "user@192.168.200.112:8788", "192.168.200.112:8788/path"])
    assert.equal(check(request({ host, origin: `http://${host}` }), host).status, 403, "public, wildcard and malformed entries never enable HTTP");
  assert.equal(check(request(), "10.0.0.1:8788,192.168.200.112:8788"), null);
});

// Real SSH + SFTP, but only a temporary local home and fake npm/Devin. No model
// calls, external host, real user configuration or network package installation.
async function fixture(t, { oldNode = false, missingNode = false, halfOpenHttp = false } = {}) {
  const home = temp(), bin = path.join(home, "bin"), clients = new Set(), channels = new Set();
  fs.mkdirSync(bin);
  const profile = path.join(home, ".profile"); fs.writeFileSync(profile, "# fixture user profile must not change\n");
  let runtimeDownloads = 0;
  let runtimeProvider = { plan: async () => { throw new Error("unexpected runtime fetch in SSH fixture"); }, download: async () => { throw new Error("unexpected archive download"); } };
  if (missingNode) {
    for (const name of ["bash", "uname", "dirname", "readlink", "cat", "getconf", "sed", "id", "tar", "gzip", "sha256sum", "rm", "mv", "awk", "ln"]) {
      const source = execFileSync("which", [name], { encoding: "utf8" }).trim();
      fs.symlinkSync(source, path.join(bin, name));
    }
  }
  if (oldNode || missingNode) {
    if (oldNode) fs.writeFileSync(path.join(bin, "node"), '#!/bin/sh\nif [ "$1" = --version ]; then echo v18.0.0; exit 0; fi\nexit 42\n' , { mode: 0o700 });
    const version = "22.99.0", folder = `node-v${version}-linux-${process.arch}`, unpack = path.join(home, "node-archive-fixture");
    fs.mkdirSync(path.join(unpack, folder, "bin"), { recursive: true });
    fs.writeFileSync(path.join(unpack, folder, "bin/node"), `#!/bin/sh
if [ "$1" = --version ]; then echo v${version}; exit 0; fi
exec ${JSON.stringify(process.execPath)} "$@"
`, { mode: 0o700 });
    fs.writeFileSync(path.join(unpack, folder, "bin/npm"), `#!/bin/sh
if [ "$1" = --version ]; then echo 10.0.0; exit 0; fi
if [ -f ${JSON.stringify(path.join(home, "fail-npm-once"))} ]; then rm ${JSON.stringify(path.join(home, "fail-npm-once"))}; exit 1; fi
[ -e node_modules ] || ln -s ${JSON.stringify(path.join(root, "node_modules"))} node_modules
`, { mode: 0o700 });
    const archiveFile = path.join(home, "fixture-node.tar.gz");
    execFileSync("tar", ["-czf", archiveFile, "-C", unpack, folder]);
    const archive = fs.readFileSync(archiveFile), sha256 = createHash("sha256").update(archive).digest("hex");
    runtimeProvider = {
      plan: async (info) => ({ version, file: folder + ".tar.gz", sha256, url: `https://nodejs.org/dist/v${version}/${folder}.tar.gz`, target: path.join(info.root, "runtimes", folder) }),
      download: async () => { runtimeDownloads++; return archive; },
    };
  }
  const piDir = path.join(home, ".pi", "agent"); fs.mkdirSync(piDir, { recursive: true });
  fs.writeFileSync(path.join(piDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-not-a-real-key" } }), { mode: 0o600 });
  fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }));
  for (const name of ["systemctl", "loginctl"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\n[ -e node_modules ] || ln -s ${JSON.stringify(path.join(root, "node_modules"))} node_modules\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(bin, "devin"), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),rl=require('node:readline').createInterface({input:process.stdin});let cwd;
rl.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;let result={};
if(m.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:'fixture'}};
if(m.method==='session/list')result={sessions:[]};
if(m.method==='session/new'){cwd=m.params.cwd;result={sessionId:'remote-fixture'};}
if(m.method==='session/prompt'){fs.writeFileSync(path.join(cwd,'remote-proof.txt'),'executed in remote workspace');const counter=path.join(cwd,'prompt-count');fs.writeFileSync(counter,String(Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1));process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'remote fixture reply'}}}})+'\\n');result={stopReason:'end_turn'};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
`, { mode: 0o700 });
  const key = utils.generateKeyPairSync("ed25519").private;
  let authenticated = 0, forwarding = 0;
  const server = new Server({ hostKeys: [key] }, (client) => {
    // Tiny SFTP replies must not accumulate Nagle/delayed-ACK latency. Real
    // OpenSSH uses TCP_NODELAY; keep the local fixture's budget comparable.
    client.setNoDelay(true);
    clients.add(client); client.on("close", () => clients.delete(client)); client.on("error", () => {});
    client.on("authentication", (ctx) => {
      authenticated++;
      if (ctx.method === "password" && ctx.username === "fixture" && ctx.password === "test-password") ctx.accept(); else ctx.reject();
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        assert.equal(info.destIP, "127.0.0.1"); forwarding++;
        const socket = net.connect(info.destPort, "127.0.0.1", () => {
          const channel = accept(); channels.add(channel);
          channel.on("close", () => { channels.delete(channel); socket.destroy(); });
          socket.on("error", () => channel.destroy()); channel.on("error", () => socket.destroy());
          if (halfOpenHttp) {
            // Match OpenSSH direct-tcpip: remote TCP EOF can leave the SSH
            // channel half-open until the client closes its writable side.
            // ssh2.Server normally sends CLOSE immediately on finish, which
            // hid the stale HTTP keep-alive pool bug in the original fixture.
            socket.pipe(channel, { end: false }).pipe(socket);
            socket.once("end", () => channel.eof());
          } else socket.pipe(channel).pipe(socket);
        }); socket.on("error", () => reject());
      });
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (accept, _reject, info) => {
          const channel = accept();
          const match = info.command.match(/^bash -lc '(.*)'$/s);
          assert.ok(match, "fixture accepts only the bounded worker shell wrapper");
          const command = match[1].replaceAll("'\\''", "'");
          const env = { ...process.env, HOME: home, PATH: missingNode ? bin : `${bin}:${process.env.PATH}`, DEVIN_WEB_TOKEN: "", DEVIN_WEB_SSH_MASTER_KEY: "", npm_config_offline: "true" };
          delete env.XDG_RUNTIME_DIR; delete env.DBUS_SESSION_BUS_ADDRESS;
          delete env.PI_CODING_AGENT_DIR; delete env.PI_CODING_AGENT_SESSION_DIR;
          const child = spawn("bash", ["-c", command], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false });
          child.on("exit", (code) => { channel.exit(code || 0); channel.end(); });
          channel.on("close", () => { if (child.exitCode == null) child.kill(); });
        });
        session.on("sftp", (accept) => {
          const sftp = accept(), handles = new Map(); let next = 0;
          const status = (id, e) => sftp.status(id, e ? (e.code === "ENOENT" ? 2 : 4) : 0);
          const check = (name, write = false) => {
            const full = path.resolve(name);
            if (full !== home && !full.startsWith(home + path.sep) && (write || !home.startsWith(full + path.sep))) throw new Error("fixture path escape");
            return full;
          };
          sftp.on("MKDIR", (id, name, attrs) => { try { fs.mkdir(check(name), { mode: attrs.mode || 0o700 }, (e) => status(id, e)); } catch (e) { status(id, e); } });
          sftp.on("STAT", (id, name) => { try { fs.stat(check(name), (e, stat) => e ? status(id, e) : sftp.attrs(id, stat)); } catch (e) { status(id, e); } });
          sftp.on("LSTAT", (id, name) => { try { fs.lstat(check(name), (e, stat) => e ? status(id, e) : sftp.attrs(id, stat)); } catch (e) { status(id, e); } });
          sftp.on("RMDIR", (id, name) => { try { fs.rmdir(check(name, true), (e) => status(id, e)); } catch (e) { status(id, e); } });
          sftp.on("OPEN", (id, name, _flags, attrs) => {
            try { fs.open(check(name, true), "w", attrs.mode || 0o600, (e, fd) => {
              if (e) return status(id, e); const handle = Buffer.alloc(4); handle.writeUInt32BE(++next); handles.set(next, fd); sftp.handle(id, handle);
            }); } catch (e) { status(id, e); }
          });
          sftp.on("WRITE", (id, handle, offset, data) => fs.write(handles.get(handle.readUInt32BE(0)), data, 0, data.length, offset, (e) => status(id, e)));
          sftp.on("CLOSE", (id, handle) => { const key = handle.readUInt32BE(0), fd = handles.get(key); handles.delete(key); fs.close(fd, (e) => status(id, e)); });
          sftp.on("close", () => { for (const fd of handles.values()) fs.close(fd, () => {}); });
        });
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const store = new HostStore(path.join(home, "control", "hosts.json"), randomBytes(32).toString("base64"));
  const manager = new RemoteHosts({ store, root, runtimeProvider });
  const host = store.add({ label: "fixture SSH", hostname: "127.0.0.1", port: server.address().port, username: "fixture", password: "test-password" });
  t.after(async () => {
    // Only stop the worker started in this test's own directory.
    const runtimePath = path.join(home, ".local/share/agent-web-remote/runtime.json");
    try { const runtime = JSON.parse(fs.readFileSync(runtimePath)); process.kill(runtime.pid, "SIGTERM"); } catch {}
    manager.dispose(); for (const c of channels) c.destroy(); for (const c of clients) { c.end(); c._sock?.destroy(); }
    await new Promise((resolve) => server.close(resolve)); await delay(150);
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, bin, profile, manager, host, server, clients, counts: () => ({ authenticated, forwarding, runtimeDownloads }) };
}

test("real SSH verifies trust before auth, deploys an isolated worker and proxies remote development", { timeout: 90000 }, async (t) => {
  const f = await fixture(t, { halfOpenHttp: true }), { manager, host, home } = f;
  let observed;
  await assert.rejects(manager.probe(host.id), (e) => { observed = e.fingerprint; return e.code === "HOST_KEY_UNKNOWN"; });
  assert.match(observed, /^SHA256:/); assert.equal(f.counts().authenticated, 0, "no password sent before fingerprint approval");
  assert.ok(!JSON.stringify(manager.list()).includes("test-password"));
  await assert.rejects(manager.trust(host.id, "SHA256:wrong"), /不匹配/);
  const plan = await manager.trust(host.id, observed);
  assert.equal(plan.installed, false); assert.ok(plan.root.startsWith(home));
  assert.equal(plan.systemd, false);
  const redirected = path.join(home, "unexpected-project"); fs.mkdirSync(redirected);
  fs.mkdirSync(path.dirname(plan.root), { recursive: true }); fs.symlinkSync(redirected, plan.root);
  await assert.rejects(manager.probe(host.id), /符号链接/);
  assert.deepEqual(fs.readdirSync(redirected), [], "inspection never writes through redirected install roots");
  fs.unlinkSync(plan.root);
  await assert.rejects(manager.install(host.id, "stale-confirmation"), /确认已过期/);
  await manager.install(host.id, plan.id);
  await manager.connect(host.id);
  assert.equal(manager.list()[0].state, "connected");
  const runtimeFile = path.join(plan.root, "runtime.json"), pid = JSON.parse(fs.readFileSync(runtimeFile)).pid;
  const configFile = path.join(plan.root, "config.json"), originalConfig = fs.readFileSync(configFile);
  manager.disconnect(host.id, false); fs.writeFileSync(configFile, "corrupt");
  await assert.rejects(manager.connect(host.id), /配置损坏/);
  assert.equal(fs.readFileSync(configFile, "utf8"), "corrupt", "corrupt worker tokens are never silently overwritten");
  assert.doesNotThrow(() => process.kill(pid, 0)); fs.writeFileSync(configFile, originalConfig);
  await manager.connect(host.id);
  await manager.probe(host.id);
  assert.equal(manager.list()[0].state, "connected", "detection preserves an already-connected environment");
  // Real workers close idle HTTP connections after 5s. SSH Channel is a
  // half-open Duplex, not a net.Socket: an idle pooled channel may still look
  // writable after the remote TCP peer closed. The first request must not hang.
  await manager.json(host.id, "/api/health");
  await delay(6200);
  const beforeCold = f.counts();
  await new Promise((resolve, reject) => {
    const req = manager.request(host.id, "/api/health");
    const deadline = setTimeout(() => req.destroy(new Error("idle SSH HTTP channel was reused and stalled the first request")), 1500);
    req.on("error", (error) => { clearTimeout(deadline); reject(error); });
    req.on("response", (res) => { res.resume(); res.on("end", () => { clearTimeout(deadline); assert.equal(res.statusCode, 200); resolve(); }); });
    req.end();
  });
  assert.ok(f.counts().forwarding > beforeCold.forwarding, "cold HTTP requests open a fresh channel on the same SSH connection");
  assert.equal(f.counts().authenticated, beforeCold.authenticated, "HTTP channel replacement never repeats SSH password authentication");

  const app = express(); app.use(express.json()); remoteRoutes(app, manager, { token: "main-token" });
  const httpServer = http.createServer(app), bridge = remoteWebSocketServer({ manager, token: "main-token", currentBuild: () => "main-ui-build" });
  httpServer.on("upgrade", bridge.upgrade);
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const sockets = new Set();
  t.after(async () => { for (const ws of sockets) ws.terminate(); for (const ws of bridge.wss.clients) ws.terminate(); bridge.wss.close(); await new Promise((resolve) => httpServer.close(resolve)); });
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const request = async (pathname, body, method) => {
    const res = await fetch(base + pathname, { method: method || (body ? "POST" : "GET"), headers: { "x-devin-token": "main-token", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json(); assert.ok(res.ok, JSON.stringify(json)); return json;
  };
  const prefix = `/api/remotes/${host.id}/proxy`;
  const previousHttpHosts = process.env.DEVIN_WEB_INSECURE_REMOTE_HTTP_HOSTS;
  process.env.DEVIN_WEB_INSECURE_REMOTE_HTTP_HOSTS = "192.168.200.112:8788";
  t.after(() => { if (previousHttpHosts === undefined) delete process.env.DEVIN_WEB_INSECURE_REMOTE_HTTP_HOSTS; else process.env.DEVIN_WEB_INSECURE_REMOTE_HTTP_HOSTS = previousHttpHosts; });
  const lanHeaders = { host: "192.168.200.112:8788", origin: "http://192.168.200.112:8788", "x-devin-token": "main-token" };
  const lanStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + "/api/remotes", { headers: lanHeaders }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
  });
  assert.equal(lanStatus, 200, "explicit LAN entry can manage hosts through its SSH-forwarded connection");
  const lanSocket = new WebSocket(base.replace("http:", "ws:") + `/ws/remotes/${host.id}?token=main-token`, { headers: lanHeaders });
  sockets.add(lanSocket); const lanMessages = [];
  lanSocket.on("message", (raw) => lanMessages.push(JSON.parse(raw))); await once(lanSocket, "open");
  await wait(() => lanMessages.some((m) => m.type === "hello")); lanSocket.close();
  assert.equal((await fetch(base + "/api/remotes")).status, 401);
  assert.equal((await fetch(base + prefix + "/api/worker/stop", { method: "POST", headers: { "x-devin-token": "main-token", "content-type": "application/json" }, body: '{"confirm":true}' })).status, 404, "normal proxies cannot bypass the destructive stop confirmation route");
  const state = await request(prefix + "/api/state"); assert.equal(state.home, home);
  const agents = await request(prefix + "/api/agents"); assert.deepEqual(agents.agents.map((a) => a.id), ["devin", "pi"]);
  const browse = await request(prefix + `/api/fs/browse?path=${encodeURIComponent(home)}`); assert.equal(browse.path, home);
  const pi = await request(prefix + "/api/sessions", { cwd: home, agent: "pi" });
  assert.match(pi.sessionId, /^[a-f0-9-]{36}$/);
  assert.equal(agents.agents.find((agent) => agent.id === "pi").caps.tree, true);
  assert.equal(agents.agents.find((agent) => agent.id === "pi").caps.processes, true);
  const processesPath = prefix + `/api/sessions/${pi.sessionId}/processes`;
  const processes = await request(processesPath);
  assert.equal(processes.attached, true); assert.equal(processes.available, true);
  assert.equal(processes.limit, 8); assert.deepEqual(processes.processes, []);
  const processHeaders = { "x-devin-token": "main-token", "content-type": "application/json" };
  assert.equal((await fetch(base + processesPath + "/missing/output", { headers: processHeaders })).status, 404);
  assert.equal((await fetch(base + processesPath + "/missing/stop", { method: "POST", headers: processHeaders, body: "{}" })).status, 404);
  assert.equal((await fetch(base + processesPath)).status, 401, "task control uses the authenticated SSH proxy");
  const coldProcesses = await request(prefix + "/api/sessions/00000000-0000-0000-0000-000000000000/processes");
  assert.equal(coldProcesses.attached, false, "task reads do not restore a cold worker session");
  const treePath = prefix + `/api/sessions/${pi.sessionId}/tree`;
  const tree = await request(treePath);
  assert.ok(Array.isArray(tree.nodes)); assert.match(tree.version, /^[a-f0-9]{64}$/);
  const treeHeaders = { "x-devin-token": "main-token", "content-type": "application/json" };
  const invalidTree = await fetch(base + treePath + "/navigate", { method: "POST", headers: treeHeaders,
    body: JSON.stringify({ targetId: "missing", version: tree.version, summarize: "true" }) });
  assert.equal(invalidTree.status, 400, "summary must be an explicit boolean, never a truthy string");
  const missingTreeNode = await fetch(base + treePath + "/nodes/missing", { headers: treeHeaders });
  assert.equal(missingTreeNode.status, 404); assert.equal(missingTreeNode.headers.get("cache-control"), "no-store");
  const staleTree = await fetch(base + treePath + "/navigate", { method: "POST", headers: treeHeaders,
    body: JSON.stringify({ targetId: "missing", version: "0".repeat(64), summarize: false }) });
  assert.equal(staleTree.status, 409); assert.equal((await staleTree.json()).code, "TREE_STALE");
  const coldTree = await fetch(base + prefix + "/api/sessions/00000000-0000-0000-0000-000000000000/tree", { headers: treeHeaders });
  assert.equal(coldTree.status, 409, "tree reads never restore an unloaded SDK session");

  const created = await request(prefix + "/api/sessions", { cwd: home, agent: "devin" });
  assert.equal(created.sessionId, "remote-fixture");
  const piMap = JSON.parse(fs.readFileSync(path.join(home, ".pi", "pi-acp", "session-map.json"), "utf8"));
  const piFile = piMap.sessions[pi.sessionId].sessionFile;
  // Persist a fixture header without making a model request, so deletion must
  // unlink an actual file rather than merely clear an in-memory fresh session.
  fs.mkdirSync(path.dirname(piFile), { recursive: true });
  fs.writeFileSync(piFile, JSON.stringify({ type: "session", version: 3, id: pi.sessionId, timestamp: new Date().toISOString(), cwd: home }) + "\n");
  await delay(6200); // DELETE is the first proxy request after idle, not a GET warmup.
  const accepted = await request(prefix + `/api/sessions/${pi.sessionId}`, undefined, "DELETE");
  assert.equal(accepted.status, "deleting");
  await wait(async () => (await request(prefix + "/api/sessions/delete-status", { ids: [pi.sessionId] })).sessions[0].status === "deleted");
  assert.ok(!fs.existsSync(piFile), "the cold DELETE must remove the actual fixture JSONL, not just its sidebar row");
  assert.equal((await request(prefix + `/api/sessions/${pi.sessionId}`, undefined, "DELETE")).status, "deleted", "confirmed repeat is a no-op");
  assert.doesNotThrow(() => process.kill(pid, 0), "deletion does not restart the worker or affect other sessions");

  const ws = new WebSocket(base.replace("http:", "ws:") + `/ws/remotes/${host.id}?token=main-token`); sockets.add(ws);
  const messages = []; ws.on("message", (raw) => messages.push(JSON.parse(raw))); await once(ws, "open");
  const hello = await wait(() => messages.find((m) => m.type === "hello"));
  assert.equal(hello.build, "main-ui-build"); assert.ok(hello.caps.promptAck);
  ws.send(JSON.stringify({ type: "subscribe", sessionId: created.sessionId, cwd: home }));
  await wait(() => messages.some((m) => m.type === "history"));
  const prompt = { type: "prompt", sessionId: created.sessionId, cwd: home, requestId: "remote-request", blocks: [{ type: "text", text: "remote execution" }] };
  ws.send(JSON.stringify(prompt));
  await wait(() => messages.some((m) => m.type === "prompt_delivery" && m.status === "completed"));
  assert.equal(fs.readFileSync(path.join(home, "remote-proof.txt"), "utf8"), "executed in remote workspace");
  const raw = await fetch(base + prefix + `/api/sessions/${created.sessionId}/raw?path=remote-proof.txt`, { headers: { "x-devin-token": "main-token" } });
  assert.equal(await raw.text(), "executed in remote workspace");
  const terminal = new WebSocket(base.replace("http:", "ws:") + `/ws/remotes/${host.id}/terminal?cwd=${encodeURIComponent(home)}&token=main-token`); sockets.add(terminal);
  let output = ""; terminal.on("message", (raw) => { const m = JSON.parse(raw); output += m.data || m.replay || ""; });
  await once(terminal, "open"); terminal.send(JSON.stringify({ type: "input", data: "printf '__SSH_TERMINAL__\\n'\r" }));
  await wait(() => output.includes("__SSH_TERMINAL__"));
  manager.disconnect(host.id);
  assert.doesNotThrow(() => process.kill(pid, 0), "disconnect does not terminate the remote worker");
  await assert.rejects(manager.ensure(host.id), /已断开/);
  await manager.connect(host.id);
  assert.equal(JSON.parse(fs.readFileSync(runtimeFile)).pid, pid, "reconnect reuses the live worker");
  assert.ok(f.counts().forwarding > 3);
  const resumed = new WebSocket(base.replace("http:", "ws:") + `/ws/remotes/${host.id}?token=main-token`); sockets.add(resumed);
  const replayed = []; resumed.on("message", (raw) => replayed.push(JSON.parse(raw))); await once(resumed, "open");
  resumed.send(JSON.stringify(prompt));
  await wait(() => replayed.some((m) => m.type === "prompt_delivery" && m.status === "completed"));
  assert.equal(fs.readFileSync(path.join(home, "prompt-count"), "utf8"), "1", "reconnect receipt reuse does not execute a duplicate prompt");
  for (const client of f.clients) client._sock.destroy();
  await wait(() => !manager.record(host.id).ssh);
  await manager.ensure(host.id);
  assert.equal(JSON.parse(fs.readFileSync(runtimeFile)).pid, pid, "unexpected SSH loss reuses the same remote process");
  const pinned = host.fingerprint, beforeChangedKey = f.counts().authenticated;
  manager.disconnect(host.id); host.fingerprint = "SHA256:not-the-pinned-key";
  await assert.rejects(manager.probe(host.id), (e) => e.code === "HOST_KEY_CHANGED");
  assert.equal(f.counts().authenticated, beforeChangedKey, "changed host keys are rejected before password authentication");
  host.fingerprint = pinned; manager.store.update(host.id, { password: "wrong-password" });
  await assert.rejects(manager.probe(host.id), (e) => e.code === "SSH_AUTH_FAILED");
  const authFailures = f.counts().authenticated;
  await assert.rejects(manager.ensure(host.id), /暂停自动重连/);
  await assert.rejects(manager.ensure(host.id), /暂停自动重连/);
  assert.equal(f.counts().authenticated, authFailures, "automatic retries never repeat a rejected password");
  manager.store.update(host.id, { password: "test-password" });
  const originalBundle = manager.bundleFactory;
  manager.bundleFactory = async (root) => ({ ...await originalBundle(root), version: "000000000000000000000000" });
  const upgrade = await manager.probe(host.id);
  assert.equal(upgrade.compatible, false);
  const alias = manager.store.add({ hostname: "127.0.0.1", port: f.server.address().port, username: "fixture", password: "test-password" });
  manager.record(alias.id).trust = { fingerprint: pinned, identity: JSON.stringify([alias.id, alias.hostname, alias.port, alias.username]), expiresAt: Date.now() - 1 };
  await assert.rejects(manager.trust(alias.id, pinned), /已过期/);
  await assert.rejects(manager.install(host.id, upgrade.id), /先明确停止/);
  assert.doesNotThrow(() => process.kill(pid, 0), "upgrade never implicitly stops the running worker");
  await manager.stop(host.id);
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
});

for (const initial of ["old", "missing"]) test(`confirmed private Node bootstrap works with ${initial} default Node without profile or process changes`, { timeout: 90000 }, async (t) => {
  const f = await fixture(t, { oldNode: initial === "old", missingNode: initial === "missing" }), { manager, host } = f;
  let fingerprint;
  await assert.rejects(manager.probe(host.id), (e) => { fingerprint = e.fingerprint; return e.code === "HOST_KEY_UNKNOWN"; });
  const plan = await manager.trust(host.id, fingerprint);
  assert.equal(plan.nodeVersion, initial === "old" ? "v18.0.0" : ""); assert.equal(plan.needsNode, true);
  assert.equal(plan.nodeInstall.version, "22.99.0");
  assert.equal(f.counts().runtimeDownloads, 0, "detection never downloads or installs a runtime archive");
  assert.ok(!fs.existsSync(path.join(plan.root, ".node-runtime")));
  await assert.rejects(manager.connect(host.id), /先检测并确认/);
  await assert.rejects(manager.install(host.id, "not-confirmed"), /确认已过期/);
  const originalDownload = manager.runtimeProvider.download;
  manager.runtimeProvider.download = async () => Buffer.from("corrupt download");
  await assert.rejects(manager.install(host.id, plan.id), /校验失败/);
  assert.ok(!fs.existsSync(path.join(plan.root, ".node-runtime")));
  manager.runtimeProvider.download = originalDownload;
  fs.writeFileSync(path.join(f.home, "fail-npm-once"), "fixture");
  await assert.rejects(manager.install(host.id, plan.id), /依赖安装/);
  assert.equal(f.counts().runtimeDownloads, 1);
  const installed = await manager.install(host.id, plan.id);
  assert.equal(installed.needsNode, false); assert.equal(installed.nodeVersion, "v22.99.0");
  assert.equal(f.counts().runtimeDownloads, 1, "retrying dependencies never downloads/uploads the already published private runtime again");
  assert.equal(manager.list()[0].progress.stage, "complete");
  assert.ok(installed.node.startsWith(path.join(plan.root, "runtimes")));
  assert.equal(fs.readFileSync(f.profile, "utf8"), "# fixture user profile must not change\n");
  if (initial === "old") assert.equal(execFileSync(path.join(f.bin, "node"), ["--version"], { encoding: "utf8" }).trim(), "v18.0.0", "default Node remains untouched");
  else assert.equal(fs.existsSync(path.join(f.bin, "node")), false, "missing default Node is not installed globally");
  await manager.connect(host.id);
  assert.equal(manager.list()[0].state, "connected");
  const runtimeFile = path.join(plan.root, "runtime.json"), pid = JSON.parse(fs.readFileSync(runtimeFile)).pid;
  manager.disconnect(host.id); await manager.connect(host.id);
  assert.equal(JSON.parse(fs.readFileSync(runtimeFile)).pid, pid, "private Node reconnect never replaces a live component");
  assert.equal(f.counts().runtimeDownloads, 1);
  await manager.stop(host.id);
});

test("Node archive planning pins official version/checksum and refuses corrupt or unexpected sources", async () => {
  const data = Buffer.from("fixture archive"), sha256 = createHash("sha256").update(data).digest("hex");
  const requests = [], fetcher = async (url, options) => {
    requests.push(url); assert.equal(options.redirect, "error");
    return new Response(url.endsWith("SHASUMS256.txt") ? `${sha256}  node-v22.99.0-linux-x64.tar.gz\n` : data);
  };
  const plan = await nodeRuntimePlan({ needsNode: true, arch: "x64", root: "/home/fixture/component" }, fetcher);
  assert.equal(plan.url, "https://nodejs.org/dist/v22.99.0/node-v22.99.0-linux-x64.tar.gz");
  assert.equal(requests.length, 1);
  assert.deepEqual(await downloadNodeRuntime(plan, fetcher), data);
  await assert.rejects(downloadNodeRuntime({ ...plan, url: "http://evil.example/archive" }, fetcher), /计划无效/);
  await assert.rejects(downloadNodeRuntime({ ...plan, sha256: "0".repeat(64) }, fetcher), /SHA256/);
  assert.equal(await nodeRuntimePlan({ needsNode: true, nodeInstallBlocked: "glibc too old" }, fetcher), null);
});

const archivePlan = (data) => ({ version: "22.99.0", file: "node-v22.99.0-linux-x64.tar.gz",
  sha256: createHash("sha256").update(data).digest("hex"), url: "https://nodejs.org/dist/v22.99.0/node-v22.99.0-linux-x64.tar.gz" });
const brokenArchiveResponse = (data, signal) => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(data.subarray(0, 5));
    const timer = setTimeout(() => controller.error(new TypeError("connection lost")), 0);
    signal.addEventListener("abort", () => { clearTimeout(timer); controller.error(signal.reason); }, { once: true });
  },
}), { headers: { "content-length": String(data.length), etag: '"fixture"' } });

test("Node download resumes interrupted bytes automatically and reuses only checksum-verified archives", async () => {
  const data = Buffer.from("resume-" + randomBytes(12).toString("hex")), plan = archivePlan(data), progress = []; let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    if (calls === 1) return brokenArchiveResponse(data, options.signal);
    assert.equal(options.headers.Range, "bytes=5-"); assert.equal(options.headers["If-Range"], '"fixture"');
    return new Response(data.subarray(5), { status: 206, headers: { "content-length": String(data.length - 5), "content-range": `bytes 5-${data.length - 1}/${data.length}` } });
  };
  assert.deepEqual(await downloadNodeRuntime(plan, fetcher, { retryDelayMs: 0, onProgress: (p) => progress.push(p) }), data);
  assert.equal(calls, 2); assert.ok(progress.some((p) => p.retrying));
  assert.deepEqual(await downloadNodeRuntime(plan, fetcher, { onProgress: (p) => progress.push(p) }), data);
  assert.equal(calls, 2, "other confirmed hosts reuse the same verified public archive"); assert.ok(progress.at(-1).cached);
});

test("Node manual retry keeps partial data, handles ignored Range, and refuses invalid Content-Range", async () => {
  for (const mode of ["resume", "ignored", "invalid"]) {
    const data = Buffer.from(mode + randomBytes(12).toString("hex")), plan = archivePlan(data);
    await assert.rejects(downloadNodeRuntime(plan, async (_url, options) => brokenArchiveResponse(data, options.signal), { maxAttempts: 1 }), /下载超时或中断/);
    const fetcher = async (_url, options) => {
      assert.equal(options.headers.Range, "bytes=5-");
      if (mode === "ignored") return new Response(data, { headers: { "content-length": String(data.length) } });
      return new Response(data.subarray(5), { status: 206, headers: { "content-length": String(data.length - 5), "content-range": `bytes ${mode === "invalid" ? 0 : 5}-${data.length - 1}/${data.length}` } });
    };
    if (mode === "invalid") await assert.rejects(downloadNodeRuntime(plan, fetcher), /断点下载响应无效/);
    else assert.deepEqual(await downloadNodeRuntime(plan, fetcher), data, "a whole-file 200 response never gets appended to a partial prefix");
  }
});

test("Node downloads distinguish progress from idle timeouts, bound failures, and deduplicate concurrent hosts", async () => {
  const data = Buffer.from("slow-" + randomBytes(12).toString("hex")), plan = archivePlan(data); let calls = 0;
  const slow = async () => {
    calls++; let offset = 0;
    return new Response(new ReadableStream({ async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (offset === data.length) controller.close();
      else { controller.enqueue(data.subarray(offset, ++offset)); }
    } }), { headers: { "content-length": String(data.length) } });
  };
  assert.deepEqual(await downloadNodeRuntime(plan, slow, { idleTimeoutMs: 60, totalTimeoutMs: 2000, maxAttempts: 1 }), data);
  assert.equal(calls, 1, "continuous progress may outlast the idle timeout without being aborted");
  const failed = archivePlan(Buffer.from("idle-" + randomBytes(12).toString("hex"))); let attempts = 0;
  await assert.rejects(downloadNodeRuntime(failed, (_url, { signal }) => new Promise((_resolve, reject) => {
    attempts++; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { idleTimeoutMs: 10, totalTimeoutMs: 1000, maxAttempts: 2, retryDelayMs: 0 }), (error) => /下载超时或中断/.test(error.message) && !/The operation was aborted/.test(error.message));
  assert.equal(attempts, 2);
  let totalAttempts = 0;
  await assert.rejects(downloadNodeRuntime(archivePlan(randomBytes(12)), (_url, { signal }) => new Promise((_resolve, reject) => {
    totalAttempts++; signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { idleTimeoutMs: 1000, totalTimeoutMs: 10, maxAttempts: 3, retryDelayMs: 0 }), /下载超时或中断/);
  assert.equal(totalAttempts, 1, "the overall deadline stops further transport attempts");
  const sharedData = Buffer.from("shared-" + randomBytes(12).toString("hex")), sharedPlan = archivePlan(sharedData);
  let release; const gate = new Promise((resolve) => { release = resolve; }); let sharedCalls = 0;
  const shared = async () => { sharedCalls++; await gate; return new Response(sharedData); };
  const a = [], b = [];
  const first = downloadNodeRuntime(sharedPlan, shared, { onProgress: (p) => a.push(p) });
  const second = downloadNodeRuntime(sharedPlan, shared, { onProgress: (p) => b.push(p) });
  release(); await Promise.all([first, second]);
  assert.equal(sharedCalls, 1); assert.equal(a.at(-1).bytes, sharedData.length); assert.equal(b.at(-1).bytes, sharedData.length);
});

test("worker deployment bundle excludes local secrets and locks exact dependency versions", async () => {
  const bundle = await workerBundle(root);
  assert.match(bundle.version, /^[a-f0-9]{24}$/);
  assert.ok([...bundle.files.keys()].every((name) => !name.includes("data/") && !name.includes("node_modules/") && !name.includes("auth.json")));
  const manifest = JSON.parse(bundle.files.get("package.json"));
  assert.ok(Object.values(manifest.dependencies).every((version) => /^\d+\.\d+\.\d+/.test(version) && !/[~^]/.test(version)));
});

test("remote proxy paths allow transcript search", () => {
  assert.equal(sanitizePath("/api/sessions/search?q=x"), "/api/sessions/search?q=x");
});

test("remote document scopes REST, images, both sockets and draft storage without local fallback", async () => {
  const { JSDOM } = await import("jsdom"), { createServer } = await import("vite");
  const id = "11111111-1111-4111-8111-111111111111";
  const dom = new JSDOM("", { url: `http://localhost/?remote=${id}&token=fixture-token` });
  const values = { window: dom.window, document: dom.window.document, location: dom.window.location, sessionStorage: dom.window.sessionStorage,
    WebSocket: class { readyState = 1; close() {} }, fetch: async () => ({ ok: true, json: async () => ({}) }) };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const vite = await createServer({ root: path.join(root, "web"), server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const api = await vite.ssrLoadModule("/src/api.js");
    assert.equal(api.initialHost, id);
    const env = api.environment(id);
    assert.equal(api.environment(id), env, "environments are cached per host");
    assert.equal(env.scopedPath("/api/sessions"), `/api/remotes/${id}/proxy/api/sessions`);
    assert.equal(env.scopedPath("/api/remotes"), "/api/remotes", "host administration never goes to a worker");
    assert.equal(env.withToken("/api/sessions/s/raw?path=image.png"), `/api/remotes/${id}/proxy/api/sessions/s/raw?path=image.png&token=fixture-token`);
    assert.ok(env.websocketUrl("/ws").includes(`/ws/remotes/${id}?`));
    assert.ok(env.websocketUrl("/ws/terminal", { cwd: "/project" }).includes(`/ws/remotes/${id}/terminal?`));
    assert.notEqual(env.storageKey("devin-web.draft.same-session"), "devin-web.draft.same-session");
    const local = api.environment("");
    assert.equal(local.scopedPath("/api/sessions"), "/api/sessions");
    assert.equal(local.storageKey("devin-web.draft.same-session"), "devin-web.draft.same-session");
    assert.ok(api.environmentUrl("").includes("token=fixture-token"));
    assert.ok(!api.environmentUrl("").includes("remote="));
    const invalid = api.environment("invalid/host");
    assert.ok(invalid.scopedPath("/api/sessions").startsWith("/api/remotes/invalid%2Fhost/proxy/"), "malformed remote ids never silently select local execution");
  } finally {
    await vite.close(); dom.window.close();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test("remote proxy bounds pre-socket waits, never forwards a timed-out delete later, and reports uncertain outcomes", async (t) => {
  let finishEnsure, calls = 0;
  const agent = new http.Agent(); agent.createConnection = () => {}; // no SSH channel callback / no socket
  t.after(() => agent.destroy());
  const manager = { ensure: () => new Promise((resolve) => { finishEnsure = resolve; }),
    request: () => { calls++; return http.request({ host: "127.0.0.1", port: 1, agent, method: "DELETE" }); } };
  const app = express(); app.use(express.json()); remoteRoutes(app, manager, { token: "test", proxyTimeoutMs: 50 });
  const server = http.createServer(app); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/remotes/host/proxy/api/sessions/target`;
  const send = () => fetch(url, { method: "DELETE", headers: { "x-devin-token": "test" } });
  let response = await send(); assert.equal(response.status, 504); assert.equal((await response.json()).outcomeUnknown, false);
  finishEnsure(); await delay(10); assert.equal(calls, 0, "expired ensure must not later execute deletion");
  manager.ensure = async () => {};
  response = await send(); assert.equal(response.status, 504);
  const error = await response.json(); assert.equal(error.outcomeUnknown, true); assert.equal(error.code, "REMOTE_OUTCOME_UNKNOWN");
  assert.equal(calls, 1, "the absolute deadline also covers an SSH channel that never becomes a socket");
});

test("deletion client verifies lost responses, pending/failure/partial/unknown results without repeating destructive requests", async () => {
  const { JSDOM } = await import("jsdom"), { createServer } = await import("vite");
  const dom = new JSDOM("", { url: "http://localhost/?remote=fixture-host&token=fixture-token" });
  const values = { window: dom.window, document: dom.window.document, location: dom.window.location, sessionStorage: dom.window.sessionStorage,
    WebSocket: class { readyState = 1; close() {} }, fetch: null };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  const vite = await createServer({ root: path.join(root, "web"), server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { deleteSessionsVerified } = (await vite.ssrLoadModule("/src/api.js")).environment("fixture-host");
    const options = { requestTimeoutMs: 20, checkTimeoutMs: 10, verificationTimeoutMs: 40, pollIntervalMs: 1 };
    const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    for (const lost of [false, true]) {
      let deletes = 0, checks = 0, progress = 0;
      globalThis.fetch = async (url, init) => {
        assert.ok(url.startsWith("/api/remotes/fixture-host/proxy/")); assert.equal(init.headers["x-devin-token"], "fixture-token");
        if (!url.endsWith("/delete-status")) { deletes++; return lost ? new Promise(() => {}) : reply({ status: "deleting" }, 202); }
        assert.equal(init.method, "POST"); checks++;
        return reply({ sessions: [{ sessionId: "target", status: checks === 1 ? "deleting" : "deleted" }] });
      };
      await deleteSessionsVerified(["target"], { ...options, onProgress: () => progress++ });
      assert.equal(deletes, 1); assert.equal(checks, 2); assert.equal(progress, 1);
    }
    let mutations = 0;
    globalThis.fetch = async (url) => {
      if (!url.endsWith("/delete-status")) { mutations++; return reply({ status: "deleting" }, 202); }
      return reply({ sessions: [{ sessionId: "one", status: "deleted" }, { sessionId: "two", status: "failed", error: "permission denied" }] });
    };
    await assert.rejects(deleteSessionsVerified(["one", "two"], options), (error) => error.code === "DELETE_FAILED" && error.deletedIds.join() === "one");
    assert.equal(mutations, 1);
    for (const mode of ["hung-check", "restart", "old-worker", "truncated-response"]) {
      mutations = 0;
      globalThis.fetch = async (url) => {
        if (!url.endsWith("/delete-status")) { mutations++; return mode === "truncated-response" ? { ok: true, json: async () => { throw new Error("truncated"); } } : reply({ ok: true }); }
        return mode === "hung-check" ? new Promise(() => {}) : mode === "old-worker" || mode === "truncated-response" ? reply({ error: "unsupported" }, 404)
          : reply({ sessions: [{ sessionId: "target", status: "unknown" }] });
      };
      const start = Date.now();
      await assert.rejects(deleteSessionsVerified(["target"], options), (error) => error.outcomeUnknown && error.code === "DELETE_RESULT_UNKNOWN");
      assert.equal(mutations, 1); assert.ok(Date.now() - start < 500, "neither a lost receipt nor a hung body can leave the dialog waiting forever");
    }
  } finally {
    await vite.close(); dom.window.close();
    for (const [key, descriptor] of previous) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test("remote history output backpressure preserves large snapshots and ordered state without replaying inputs", { timeout: 10000 }, async (t) => {
  const { createServer } = await import("node:http"), { once } = await import("node:events"), { WebSocket, WebSocketServer } = await import("ws");
  const { remoteWebSocketServer } = await import("../src/remote-routes.js");
  const upstreamServer = createServer(), upstreamWss = new WebSocketServer({ server: upstreamServer });
  const text = "full history 中文🚀 ".repeat(180000), requests = [];
  upstreamWss.on("connection", (peer) => peer.on("message", (raw) => {
    requests.push(JSON.parse(raw));
    peer.send(JSON.stringify({ type: "history", text })); peer.send(JSON.stringify({ type: "session_state", state: "held" }));
  }));
  upstreamServer.listen(0, "127.0.0.1"); await once(upstreamServer, "listening");
  const manager = { websocket: async (id, url) => { assert.equal(id, "history-host"); assert.match(url, /^\/ws\?/); return new WebSocket(`ws://127.0.0.1:${upstreamServer.address().port}`); } };
  const proxy = remoteWebSocketServer({ manager, token: "fixture-token" }), server = createServer();
  const handleUpgrade = proxy.wss.handleUpgrade.bind(proxy.wss);
  proxy.wss.handleUpgrade = (req, socket, head, callback) => handleUpgrade(req, socket, head, (peer) => {
    const send = peer.send.bind(peer), getBuffered = Object.getOwnPropertyDescriptor(WebSocket.prototype, "bufferedAmount").get;
    let delayed = false;
    Object.defineProperty(peer, "bufferedAmount", { get: () => delayed ? 3 * 1024 * 1024 : getBuffered.call(peer) });
    peer.send = (data, options, done) => {
      if (JSON.parse(data.toString()).type === "history") { delayed = true; setTimeout(() => { delayed = false; send(data, options, done); }, 30); }
      else send(data, options, done);
    };
    callback(peer);
  });
  server.on("upgrade", proxy.upgrade); server.listen(0, "127.0.0.1"); await once(server, "listening");
  let browser;
  t.after(async () => {
    browser?.terminate(); for (const peer of proxy.wss.clients) peer.terminate(); proxy.wss.close();
    for (const peer of upstreamWss.clients) peer.terminate(); upstreamWss.close();
    await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => upstreamServer.close(resolve))]);
  });
  browser = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/remotes/history-host?token=fixture-token`, { origin: `http://127.0.0.1:${server.address().port}` });
  const messages = [], complete = new Promise((resolve, reject) => {
    browser.on("message", (raw) => { messages.push(JSON.parse(raw)); if (messages.length === 2) resolve(); });
    browser.on("error", reject); browser.on("close", (code) => { if (messages.length < 2) reject(new Error(`snapshot interrupted: ${code}`)); });
  });
  await once(browser, "open"); assert.match(browser.extensions, /permessage-deflate/);
  browser.send(JSON.stringify({ type: "subscribe", sessionId: "large" })); await complete;
  assert.equal(messages[0].type, "history"); assert.equal(messages[0].text, text); assert.equal(messages[1].type, "session_state");
  assert.deepEqual(requests, [{ type: "subscribe", sessionId: "large" }], "backpressure never retries even read subscriptions or queues new mutations");
});

test("file preview reads are scoped, bounded, authenticated and never load an agent", async (t) => {
  const { FilePreviews, filePreviewRoutes } = await import("../src/file-preview.js");
  const dir = temp(), report = path.join(dir, "reports"); fs.mkdirSync(report);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const html = "<!doctype html><h1>Formatted 中文 report</h1><script>not executed by the server</script>";
  fs.writeFileSync(path.join(report, "report.html"), html); fs.writeFileSync(path.join(report, "metrics.json"), '{"iou":85.14}');
  fs.writeFileSync(path.join(dir, "outside.json"), '{"private":true}'); fs.writeFileSync(path.join(report, ".hidden.json"), '{}');
  fs.symlinkSync(path.join(dir, "outside.json"), path.join(report, "escape.json"));
  const previews = new FilePreviews();
  const manifest = await previews.open("a", dir, "reports/report.html");
  assert.equal(manifest.kind, "html"); assert.equal((await previews.read("a", manifest.ticket)).data.toString(), html);
  assert.equal((await previews.read("a", manifest.ticket, "/metrics.json")).data.toString(), '{"iou":85.14}');
  for (const resource of ["../outside.json", "escape.json", ".hidden.json"])
    await assert.rejects(previews.read("a", manifest.ticket, resource), (e) => e.status === 403);
  await assert.rejects(previews.read("other-session", manifest.ticket), (e) => e.status === 410);
  await assert.rejects(previews.open("a", null, "relative.md"), (e) => e.status === 409);
  await assert.rejects(previews.open("a", dir, "reports"), (e) => e.status === 415);
  fs.writeFileSync(path.join(report, "unsupported.bin"), "unknown");
  await assert.rejects(previews.open("a", dir, "reports/unsupported.bin"), (e) => e.status === 415);
  fs.writeFileSync(path.join(report, "too-large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(previews.open("a", dir, "reports/too-large.txt"), (e) => e.status === 413);
  previews.entries.get(manifest.ticket).expires = 0;
  await assert.rejects(previews.read("a", manifest.ticket), (e) => e.status === 410);
  const app = express(); let lookups = 0;
  app.use((req, res, next) => req.headers["x-devin-token"] === "fixture-token" ? next() : res.sendStatus(401));
  filePreviewRoutes(app, (id) => { assert.equal(id, "loaded"); lookups++; return { sessions: new Map([[id, { cwd: dir }]]), state: { sessions: {} } }; });
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/sessions/loaded/preview`;
  assert.equal((await fetch(url + "?path=reports/report.html")).status, 401); assert.equal(lookups, 0);
  const headers = { "x-devin-token": "fixture-token" }, response = await fetch(url + "?path=reports/report.html", { headers }), meta = await response.json();
  assert.equal(response.status, 200);
  const body = await fetch(`${url}/${meta.ticket}/file`, { headers });
  assert.equal(await body.text(), html); assert.match(body.headers.get("content-type"), /text\/html/);
  assert.equal(body.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${url}/${meta.ticket}/file`)).status, 401, "a ticket alone is not a credential");
  assert.equal(sanitizePath(`/api/sessions/loaded/preview/${meta.ticket}/file?path=%2Fmetrics.json`), `/api/sessions/loaded/preview/${meta.ticket}/file?path=%2Fmetrics.json`);

  const proxy = express();
  remoteRoutes(proxy, {
    ensure: async (id) => assert.equal(id, "remote"),
    request: (id, pathname, options) => http.request(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method: options.method, headers: { "x-devin-token": "fixture-token" }, agent: false,
    }),
  }, { token: "coordinator-token" });
  const proxyServer = proxy.listen(0, "127.0.0.1"); await once(proxyServer, "listening");
  t.after(() => new Promise((resolve) => proxyServer.close(resolve)));
  const proxied = await fetch(`http://127.0.0.1:${proxyServer.address().port}/api/remotes/remote/proxy/api/sessions/loaded/preview/${meta.ticket}/file`, { headers: { "x-devin-token": "coordinator-token" } });
  assert.equal(proxied.status, 200); assert.equal(proxied.headers.get("x-preview-kind"), "html");
  assert.match(proxied.headers.get("content-security-policy"), /^sandbox;/); assert.equal(proxied.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await proxied.text(), html);
  const activity = fs.readFileSync(path.join(root, "android/app/src/main/java/ai/devin/web/MainActivity.java"), "utf8");
  assert.doesNotMatch(activity, /addJavascriptInterface|@JavascriptInterface/);
  assert.match(activity, /postWebMessage\(new WebMessage\(nonce, new WebMessagePort\[\]\{ports\[1\]\}\), Uri.parse\(appOrigin\)\)/);
});

test("remote original image JSON keeps gzip headers and exact base64 through the HTTP proxy", async (t) => {
  const { gzipSync } = await import("node:zlib");
  const original = { mimeType: "image/png", data: "AA/中文🚀\r\n".repeat(1024) };
  const worker = http.createServer((req, res) => {
    assert.match(req.headers["accept-encoding"], /gzip/);
    assert.match(req.url, /\?encoding=base64$/);
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", vary: "Accept-Encoding", "cache-control": "private, max-age=3600" });
    res.end(gzipSync(JSON.stringify(original)));
  });
  worker.listen(0, "127.0.0.1"); await once(worker, "listening");
  t.after(() => new Promise((resolve) => worker.close(resolve)));
  const app = express();
  remoteRoutes(app, { ensure: async () => {}, request: (_id, pathname, options) => http.request(`http://127.0.0.1:${worker.address().port}${pathname}`, { headers: options.headers, agent: false }) }, { token: "fixture-token" });
  const proxy = app.listen(0, "127.0.0.1"); await once(proxy, "listening");
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/api/remotes/host/proxy/api/sessions/session/img/pi-${"a".repeat(64)}/0?encoding=base64`, { headers: { "x-devin-token": "fixture-token", "accept-encoding": "gzip" } });
  assert.equal(response.status, 200); assert.equal(response.headers.get("content-encoding"), "gzip"); assert.equal(response.headers.get("vary"), "Accept-Encoding");
  assert.deepEqual(await response.json(), original);
});
