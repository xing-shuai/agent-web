import { HISTORY_COMPRESSION } from "./history-wire.js";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv } from "node:crypto";
import ssh2 from "ssh2";
import { WebSocket } from "ws";
import { workerBundle, inspectWorker, installWorker, startWorker, runningWorker, nodeRuntimePlan, downloadNodeRuntime, installNodeRuntime } from "./remote-worker.js";

export const remoteError = (message, status = 400, code) => Object.assign(new Error(message), { status, code });
const { Client } = ssh2;
const fingerprint = (key) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
const identity = (host) => JSON.stringify([host.id, host.hostname, host.port, host.username]);

/** Authenticated encryption binds credentials to the immutable connection identity. */
export class HostStore {
  constructor(file, masterKey = process.env.DEVIN_WEB_SSH_MASTER_KEY || "") {
    this.file = file;
    this.key = null;
    if (masterKey) {
      const key = Buffer.from(masterKey.trim(), "base64");
      if (key.length !== 32 || key.toString("base64") !== masterKey.trim())
        throw remoteError("DEVIN_WEB_SSH_MASTER_KEY 必须是 32 字节密钥的标准 Base64", 503);
      this.key = key;
    }
    try { this.hosts = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { if (e.code !== "ENOENT") throw remoteError("远程主机配置损坏，未覆盖原文件", 503); this.hosts = []; }
    if (!Array.isArray(this.hosts) || this.hosts.length > 32) throw remoteError("远程主机配置无效", 503);
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.hosts, null, 2), { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, this.file);
  }
  get(id) {
    const host = this.hosts.find((h) => h.id === id);
    if (!host) throw remoteError("远程主机不存在", 404);
    return host;
  }
  encrypt(host, password) {
    if (!this.key) throw remoteError("请配置 DEVIN_WEB_SSH_MASTER_KEY 后保存 SSH 密码", 503);
    if (typeof password !== "string" || !password || password.length > 4096) throw remoteError("请输入有效的 SSH 密码");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(identity(host)));
    const data = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }
  password(host) {
    if (!this.key) throw remoteError("SSH 凭据已锁定：缺少 DEVIN_WEB_SSH_MASTER_KEY", 503);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(host.secret.iv, "base64"));
      decipher.setAAD(Buffer.from(identity(host)));
      decipher.setAuthTag(Buffer.from(host.secret.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(host.secret.data, "base64")), decipher.final()]).toString("utf8");
    } catch { throw remoteError("无法解密 SSH 凭据，请核对主密钥；原凭据未被覆盖", 503); }
  }
  add(input) {
    if (this.hosts.length >= 16) throw remoteError("最多保存 16 台远程主机");
    const hostname = String(input.hostname || "").trim().replace(/^\[|\]$/g, "");
    const username = String(input.username || "").trim();
    const port = input.port == null || input.port === "" ? 22 : Number(input.port);
    if (!/^[a-zA-Z0-9_.:-]{1,253}$/.test(hostname) || !/^[a-zA-Z0-9_.@-]{1,128}$/.test(username) || !Number.isInteger(port) || port < 1 || port > 65535)
      throw remoteError("请填写有效的主机、端口和 Linux 用户名");
    const host = { id: randomUUID(), label: String(input.label || hostname).trim().slice(0, 80), hostname, port, username,
      fingerprint: null, enabled: false };
    host.secret = this.encrypt(host, input.password);
    this.hosts.push(host); this.save(); return host;
  }
  update(id, input) {
    const host = this.get(id);
    const secret = input.password ? this.encrypt(host, input.password) : host.secret;
    if (input.label != null) host.label = String(input.label).trim().slice(0, 80) || host.hostname;
    host.secret = secret; this.save(); return host;
  }
  remove(id) { this.get(id); this.hosts = this.hosts.filter((h) => h.id !== id); this.save(); }
}

/** A single pinned, password-authenticated SSH transport per registered host.
 * No passwords in shell arguments, no local TCP listener, and no blind prompt replay. */
export class RemoteHosts {
  constructor({ store, root, clientFactory = () => new Client(), bundle = workerBundle, runtimeProvider = { plan: nodeRuntimePlan, download: downloadNodeRuntime } } = {}) {
    this.store = store; this.root = root; this.clientFactory = clientFactory; this.bundleFactory = bundle; this.runtimeProvider = runtimeProvider;
    this.connections = new Map(); this.disposed = false;
  }
  record(id) {
    this.store.get(id);
    if (!this.connections.has(id)) this.connections.set(id, { state: "disconnected", clients: new Set(), desired: false });
    return this.connections.get(id);
  }
  list() {
    return this.store.hosts.map((host) => {
      const { id, label, hostname, port, username, fingerprint, enabled } = host;
      const record = this.connections.get(id);
      return { id, label, hostname, port, username, fingerprint, enabled, credentialLocked: !this.store.key,
        state: record?.state || "disconnected", error: record?.error || null, progress: record?.progress || null, busy: !!record?.operation,
        plan: record?.plan ? this.publicPlan(record.plan) : null };
    });
  }
  publicPlan(plan) {
    const { id, version, home, root, node, nodeVersion, npm, devin, piConfigured, systemd, linger, installed, running, compatible, expiresAt, arch, libc, needsNode, nodeInstall, nodeInstallBlocked } = plan;
    return { id, version, home, root, node, nodeVersion, npm, devin, piConfigured, systemd, linger, installed, running, compatible, expiresAt, arch, libc, needsNode, nodeInstall, nodeInstallBlocked,
      operations: [...(nodeInstall ? [`下载官方 Node ${nodeInstall.version}，SHA256 校验后安装到组件专用目录；不使用 sudo、不替换默认 Node`] : []), "在所示用户目录上传 Agent Web 后端及 Pi SDK 运行依赖", "运行 npm install --omit=dev（会下载依赖及运行原生模块安装脚本）", "启动仅监听 127.0.0.1 的用户态组件；不使用 sudo，不修改项目文件", "远端 Pi 使用现有配置；当前 ask_user 兼容补丁可能更新已安装的 pi-ask 扩展"] };
  }
  async exclusive(id, action) {
    const record = this.record(id);
    if (record.operation) throw remoteError("此主机正在处理另一项操作", 409);
    const work = action(record);
    record.operation = work;
    try { return await work; }
    catch (e) {
      if (["SSH_AUTH_FAILED", "HOST_KEY_CHANGED"].includes(e.code)) record.blocked = e.code;
      record.error = e.message; record.state = e.code === "HOST_KEY_UNKNOWN" ? "needs_trust" : "error";
      throw e;
    } finally { record.operation = null; }
  }
  async ssh(id) {
    if (this.disposed) throw remoteError("服务正在关闭", 503);
    const host = this.store.get(id), record = this.record(id);
    if (record.ssh) return record.ssh;
    if (record.handshake) return record.handshake;
    record.state = "connecting"; record.error = null;
    record.handshake = new Promise((resolve, reject) => {
      const client = this.clientFactory(), epoch = record.epoch || 0;
      record.pendingSSH = client;
      let observed, ready = false;
      const fail = (error) => {
        if (ready) return;
        if (observed && observed !== host.fingerprint) {
          if (host.fingerprint) reject(remoteError("SSH 主机指纹发生变化，连接已阻止；请独立核验主机后重新添加配置", 409, "HOST_KEY_CHANGED"));
          else {
            record.trust = { fingerprint: observed, identity: identity(host), expiresAt: Date.now() + 300000 };
            reject(Object.assign(remoteError("首次连接需要确认 SSH 主机指纹", 409, "HOST_KEY_UNKNOWN"), { fingerprint: observed }));
          }
        } else reject(remoteError(error.level === "client-authentication" ? "SSH 密码认证失败，请更新密码（首版不支持多因素认证）" : "SSH 连接失败，请检查地址、端口、密码及网络", 502, error.level === "client-authentication" ? "SSH_AUTH_FAILED" : "SSH_FAILED"));
        client.end();
      };
      client.on("error", (error) => { fail(error); if (ready) this.lost(id, client); });
      client.on("close", () => { if (!ready) fail(new Error("closed")); else this.lost(id, client); });
      client.once("ready", () => {
        if ((record.epoch || 0) !== epoch || this.disposed) { client.end(); return reject(remoteError("SSH 连接已取消", 409)); }
        ready = true; record.blocked = null; record.ssh = client; record.state = "inspecting"; resolve(client);
      });
      try {
        client.connect({ host: host.hostname, port: host.port, username: host.username, password: this.store.password(host),
          authHandler: ["password"], readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
          hostVerifier: (key) => { observed = fingerprint(key); return !!host.fingerprint && observed === host.fingerprint; } });
      } catch (e) { client.destroy(); reject(e); }
    }).finally(() => { record.handshake = null; record.pendingSSH = null; });
    return record.handshake;
  }
  lost(id, client) {
    const record = this.connections.get(id);
    if (!record || record.ssh !== client) return;
    record.ssh = null; record.runtime = null; record.agent?.destroy();
    for (const ws of record.clients) ws.close(1012, "remote disconnected");
    record.state = record.desired ? "reconnecting" : "disconnected";
    if (record.desired && !this.disposed) {
      clearTimeout(record.retry);
      record.retry = setTimeout(() => this.ensure(id).catch(() => {}), 3000);
      record.retry.unref();
    }
  }
  async trust(id, value) {
    const host = this.store.get(id), record = this.record(id), pending = record.trust;
    if (host.fingerprint || !pending || pending.expiresAt < Date.now() || pending.identity !== identity(host) || value !== pending.fingerprint)
      throw remoteError("指纹确认已过期或不匹配，请重新检测", 409);
    host.fingerprint = value; this.store.save(); record.trust = null;
    return this.probe(id);
  }
  async probe(id) {
    return this.exclusive(id, async (record) => {
      const ssh = await this.ssh(id);
      const bundle = await this.bundleFactory(this.root);
      const info = await inspectWorker(ssh, bundle.version);
      const nodeInstall = info.needsNode ? await this.runtimeProvider.plan(info) : null;
      record.plan = { ...info, nodeInstall, id: randomUUID(), version: bundle.version, expiresAt: Date.now() + 600000 };
      record.state = record.runtime && record.ssh ? "connected" : info.installed && !info.needsNode ? "ready" : "needs_install";
      record.error = null;
      return this.publicPlan(record.plan);
    });
  }
  async install(id, planId) {
    return this.exclusive(id, async (record) => {
      const plan = record.plan;
      if (!plan || plan.id !== planId || plan.expiresAt < Date.now()) throw remoteError("安装确认已过期，请重新检测", 409);
      let ssh = await this.ssh(id); const bundle = await this.bundleFactory(this.root);
      if (bundle.version !== plan.version) throw remoteError("本地组件已更新，请重新检测并确认", 409);
      record.state = "installing"; record.error = null; record.progress = null;
      const progress = (value) => { record.progress = value; };
      let installing = plan;
      if (plan.needsNode) {
        if (!plan.nodeInstall) throw remoteError(plan.nodeInstallBlocked || "专用 Node 安装计划不可用，请重新检测", 409);
        const current = await inspectWorker(ssh, bundle.version);
        if (current.running) throw remoteError("组件仍在运行，请先明确停止后再安装专用 Node", 409);
        // A previous confirmed attempt may already have published this exact
        // private runtime before dependency installation failed. Do not upload
        // or install Node again in that case.
        if (current.needsNode || current.node !== plan.nodeInstall.target + "/bin/node" || current.nodeVersion !== "v" + plan.nodeInstall.version) {
          progress({ stage: "node_download", bytes: 0, total: null });
          const archive = await this.runtimeProvider.download(plan.nodeInstall, undefined, { onProgress: progress });
          ssh = await this.ssh(id); // download may outlive an idle SSH transport
          await installNodeRuntime(ssh, plan, archive, { onProgress: progress });
        }
        installing = { ...plan, ...await inspectWorker(ssh, bundle.version), nodeInstall: null };
        if (installing.needsNode) throw remoteError("专用 Node 安装后验证未通过，未启动组件", 409);
      }
      progress({ stage: "dependencies" });
      await installWorker(ssh, installing, bundle);
      progress({ stage: "complete" });
      record.state = record.runtime && record.ssh ? "connected" : "ready"; record.plan = { ...installing, installed: true };
      return this.publicPlan(record.plan);
    });
  }
  async connect(id) {
    return this.exclusive(id, async (record) => {
      const bundle = await this.bundleFactory(this.root);
      if (record.runtime && record.ssh && record.version === bundle.version && record.state === "connected") return { connected: true };
      const ssh = await this.ssh(id), info = await inspectWorker(ssh, bundle.version);
      if (info.needsNode) throw remoteError("需要先检测并确认安装组件专用 Node，不能自动跳过安装确认", 409, "NEEDS_NODE");
      if (!info.installed) throw remoteError("请先检测并确认安装远端组件", 409, "NEEDS_INSTALL");
      record.state = "starting";
      const runtime = await startWorker(ssh, info, bundle.version);
      record.runtime = runtime;
      record.agent?.destroy();
      // An SSH Channel can remain writable after the remote HTTP TCP peer
      // sends EOF. Pooling it as a net.Socket loses the first request after
      // idle (including DELETE). Reuse SSH, not idle HTTP channels.
      record.agent = new http.Agent({ keepAlive: false, maxSockets: 8 });
      record.agent.createConnection = (_options, callback) => { this.channel(id).then((stream) => callback(null, stream), callback); };
      try {
        const health = await this.json(id, "/api/health");
        if (health.workerProtocol !== 1 || health.workerVersion !== bundle.version) throw new Error("incompatible worker");
      } catch {
        record.runtime = null; record.agent.destroy();
        throw remoteError("远端组件握手失败或版本不兼容；不会自动停止或覆盖现有组件", 502);
      }
      record.desired = true; record.state = "connected"; record.error = null; record.version = bundle.version;
      const host = this.store.get(id); host.enabled = true; this.store.save();
      return { connected: true };
    });
  }
  async ensure(id) {
    const host = this.store.get(id), record = this.record(id);
    if (record.runtime && record.ssh && record.state === "connected") return record;
    if (record.blocked) throw remoteError("SSH 认证或主机指纹需要手动处理，已暂停自动重连", 409, record.blocked);
    if (!record.desired && !host.enabled) throw remoteError("此主机已断开，请先手动连接", 409);
    if (record.operation) await record.operation;
    else await this.connect(id);
    if (!record.runtime || record.state !== "connected") throw remoteError("远端组件尚未连接", 503);
    return record;
  }
  channel(id) {
    const record = this.record(id);
    if (!record.ssh || !record.runtime) return Promise.reject(remoteError("SSH 隧道已断开", 503));
    return new Promise((resolve, reject) => record.ssh.forwardOut("127.0.0.1", 0, "127.0.0.1", record.runtime.port,
      (error, channel) => {
        if (error) return reject(remoteError("无法建立组件隧道", 502));
        // Node HTTP/WS expect the TCP socket methods; SSH carries keepalives.
        channel.setKeepAlive = channel.setNoDelay = channel.ref = channel.unref = () => channel;
        channel.destroySoon = channel.destroy.bind(channel);
        let timer, timeout = 0;
        const reset = () => { clearTimeout(timer); if (timeout) { timer = setTimeout(() => channel.emit("timeout"), timeout); timer.unref(); } };
        channel.setTimeout = (ms, callback) => { timeout = ms; if (callback) channel.once("timeout", callback); reset(); return channel; };
        channel.on("data", reset); channel.once("close", () => clearTimeout(timer));
        resolve(channel);
      }));
  }
  request(id, pathname, { method = "GET", body, headers = {} } = {}) {
    const record = this.record(id);
    if (!record.runtime) throw remoteError("远端组件未连接", 503);
    return http.request({ hostname: "127.0.0.1", port: record.runtime.port, path: pathname, method, agent: record.agent,
      headers: { ...headers, host: `127.0.0.1:${record.runtime.port}`, "x-devin-token": record.runtime.token,
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } });
  }
  async json(id, pathname, method = "GET", payload) {
    return new Promise((resolve, reject) => {
      const body = payload ? JSON.stringify(payload) : undefined;
      const req = this.request(id, pathname, { method, body }); let data = "";
      req.setTimeout(15000, () => req.destroy(remoteError("远端组件响应超时", 504)));
      req.on("error", reject);
      req.on("response", (res) => {
        res.on("error", reject); res.on("data", (chunk) => { data += chunk; if (data.length > 1024 * 1024) req.destroy(new Error("remote response too large")); });
        res.on("end", () => {
          if (res.statusCode >= 400) return reject(remoteError("远端组件请求失败", res.statusCode));
          try { resolve(JSON.parse(data)); } catch { reject(remoteError("远端组件响应无效", 502)); }
        });
      });
      req.end(body);
    });
  }
  async websocket(id, pathname) {
    const record = await this.ensure(id);
    if (record.clients.size >= 32) throw remoteError("此主机的浏览器连接过多", 429);
    const stream = await this.channel(id);
    const url = new URL(pathname, "ws://127.0.0.1"); url.port = record.runtime.port;
    url.searchParams.delete("token"); url.searchParams.set("token", record.runtime.token);
    const ws = new WebSocket(url, { createConnection: () => stream, maxPayload: 16 * 1024 * 1024, perMessageDeflate: url.pathname === "/ws" ? HISTORY_COMPRESSION : false, handshakeTimeout: 15000 });
    record.clients.add(ws); ws.on("close", () => record.clients.delete(ws));
    return ws;
  }
  disconnect(id, persist = true) {
    const record = this.record(id);
    record.desired = false; record.epoch = (record.epoch || 0) + 1; clearTimeout(record.retry);
    record.pendingSSH?.end();
    if (persist) { this.store.get(id).enabled = false; this.store.save(); }
    for (const ws of record.clients) ws.close(1001, "remote detached");
    record.agent?.destroy(); record.ssh?.end(); record.ssh = null; record.runtime = null; record.state = "disconnected";
  }
  async stop(id) {
    return this.exclusive(id, async (record) => {
      const ssh = await this.ssh(id), bundle = await this.bundleFactory(this.root);
      const info = await inspectWorker(ssh, bundle.version);
      if (!info.running) { this.disconnect(id); return; }
      record.runtime = await runningWorker(ssh, info);
      record.agent?.destroy(); record.agent = new http.Agent({ keepAlive: false });
      record.agent.createConnection = (_options, callback) => { this.channel(id).then((stream) => callback(null, stream), callback); };
      const health = await this.json(id, "/api/health");
      if (health.workerProtocol !== 1) throw remoteError("不能安全识别远端组件，不会发送停止请求", 409);
      await this.json(id, "/api/worker/stop", "POST", { confirm: true });
      this.disconnect(id);
    });
  }
  dispose() { this.disposed = true; for (const id of this.connections.keys()) this.disconnect(id, false); }
}
