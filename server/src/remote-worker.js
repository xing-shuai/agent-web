import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const quoteShell = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const fail = (message) => Object.assign(new Error(message), { status: 409 });

/** Only application sources and exact direct dependency versions are shipped.
 * No local state, model credentials, node_modules, SSH secrets or project files. */
export async function workerBundle(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "server/package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const dependencies = Object.fromEntries(Object.keys(pkg.dependencies).map((name) => {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (!version) throw fail(`无法确定组件依赖版本：${name}`);
    return [name, version];
  }));
  const files = new Map();
  const walk = (dir) => {
    for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = `${dir}/${item.name}`;
      if (item.isDirectory()) walk(name);
      else if (item.isFile() && /\.(js|mjs)$|LICENSE$/.test(item.name)) files.set(name, fs.readFileSync(path.join(root, name)));
    }
  };
  walk("server/src");
  files.set("server/scripts/patch-pi-ask.mjs", fs.readFileSync(path.join(root, "server/scripts/patch-pi-ask.mjs")));
  files.set("web/src/turnTelemetry.js", fs.readFileSync(path.join(root, "web/src/turnTelemetry.js")));
  files.set("package.json", Buffer.from(JSON.stringify({ name: "agent-web-worker", private: true, type: "module", dependencies })));
  files.set("launch.cjs", Buffer.from(`const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
Object.assign(process.env, { HOST:'127.0.0.1', PORT:'0', DEVIN_WEB_WORKER:'1', DEVIN_WEB_TOKEN:config.token,
 DEVIN_WEB_DATA:path.join(config.root,'state'), DEVIN_WEB_WORKER_RUNTIME:path.join(config.root,'runtime.json'),
 DEVIN_WEB_WORKER_VERSION:config.version, DEVIN_WEB_AGENTS:'devin,pi' });
delete process.env.DEVIN_WEB_SSH_MASTER_KEY;
import('./server/src/index.js');
`));
  const hash = createHash("sha256");
  for (const [name, data] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update("\0").update(data).update("\0");
  return { version: hash.digest("hex").slice(0, 24), files };
}

export function sshExec(ssh, command, { timeout = 20000, maxOutput = 65536 } = {}) {
  return new Promise((resolve, reject) => {
    let stream, out = "", err = "", ended = false;
    const finish = (error, result) => {
      if (ended) return; ended = true; clearTimeout(timer);
      if (error) { stream?.close(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(fail("远端操作超时；不会自动重试安装")), timeout);
    ssh.exec(command, (error, channel) => {
      if (error) return finish(fail("远端命令无法启动"));
      stream = channel;
      if (ended) return channel.close();
      channel.setEncoding("utf8"); channel.stderr.setEncoding("utf8");
      channel.on("data", (data) => { out += data; if (out.length + err.length > maxOutput) finish(fail("远端命令输出过大")); });
      channel.stderr.on("data", (data) => { err += data; if (out.length + err.length > maxOutput) finish(fail("远端命令输出过大")); });
      channel.on("error", () => finish(fail("远端命令连接中断")));
      channel.on("close", (code) => finish(null, { code, out, err }));
    });
  });
}
const loginCommand = (script) => `bash -lc ${quoteShell(script)}`;

const usableNode = (version) => {
  const match = /^v?(\d+)\.(\d+)\.\d+$/.exec(version || "");
  return !!match && (+match[1] > 22 || (+match[1] === 22 && +match[2] >= 19));
};

const nodeEnvironment = (info) => info.node.startsWith(info.root + "/runtimes/")
  ? `export PATH=${quoteShell(path.posix.dirname(info.node))}:"$PATH"; ` : "";

/** Probe with bash only: even a missing/broken Node must produce an install plan. */
export async function inspectWorker(ssh, version) {
  if (!/^[a-f0-9]{24}$/.test(version)) throw fail("组件版本无效");
  const result = await sshExec(ssh, loginCommand(`set -eu
[ "$(uname -s)" = Linux ] || exit 41
home=$(cd "$HOME" && pwd -P)
root="$home/.local/share/agent-web-remote"
for suffix in .local .local/share .local/share/agent-web-remote .local/share/agent-web-remote/runtimes .local/share/agent-web-remote/releases .local/share/agent-web-remote/releases/${version}; do
 [ ! -L "$home/$suffix" ] || exit 46
done
[ ! -L "$root/.node-runtime" ] || exit 46
node_path=$(type -P node || true)
if [ -f "$root/.node-runtime" ]; then
 private_node=$(cat "$root/.node-runtime")
 private_node=$(readlink -f "$private_node" 2>/dev/null || true)
 case "$private_node" in "$root"/runtimes/node-v*/bin/node) if [ -x "$private_node" ]; then node_path="$private_node"; export PATH="$(dirname "$private_node"):$PATH"; fi;; esac
fi
node_version=$([ -z "$node_path" ] || "$node_path" --version 2>/dev/null || true)
npm_path=$(type -P npm || true)
devin_path=$(type -P devin || true)
libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
running=0; compatible=1; installed=0; configured=0; systemd=0; linger=0
if [ -f "$root/runtime.json" ]; then
 pid=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$root/runtime.json")
 if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
  running=1
  running_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$root/runtime.json")
  [ "$running_version" = '${version}' ] || compatible=0
 fi
fi
[ ! -f "$root/releases/${version}/.ready" ] || installed=1
[ ! -d "$home/.pi/agent" ] || configured=1
if systemctl --user show-environment >/dev/null 2>&1; then systemd=1; fi
if [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" = yes ]; then linger=1; fi
printf 'AGENT_WEB_INSPECT\\0'
printf '%s\\0' "$home" "$node_path" "$node_version" "$npm_path" "$devin_path" "$(uname -m)" "$libc" "$installed" "$running" "$compatible" "$configured" "$systemd" "$linger" "$(type -P tar || true)" "$(type -P gzip || true)" "$(type -P sha256sum || true)"
`));
  if (result.code === 41) throw fail("首版仅支持 Linux 远端");
  if (result.code === 46) throw fail("远端组件安装目录存在符号链接跳转，请先核实并整理专用目录；未写入文件");
  if (result.code !== 0) throw fail("远端 bash 环境检测失败；请确认 SSH 用户可执行 bash，且登录脚本没有报错");
  const marker = "AGENT_WEB_INSPECT\0", start = result.out.lastIndexOf(marker);
  const fields = start < 0 ? [] : result.out.slice(start + marker.length).split("\0");
  if (fields.length !== 17 || fields.at(-1) !== "") throw fail("远端环境检测返回无效数据");
  const [home, node, nodeVersion, npm, devin, machine, libc, installed, running, compatible, configured, systemd, linger, tar, gzip, sha256sum] = fields;
  if (!path.posix.isAbsolute(home) || /[\r\n]/.test(home)) throw fail("远端用户目录无效");
  const arch = ({ x86_64: "x64", aarch64: "arm64" })[machine];
  const glibc = /glibc (\d+)\.(\d+)/.exec(libc);
  const libcOK = glibc && (+glibc[1] > 2 || (+glibc[1] === 2 && +glibc[2] >= 28));
  const nodeOK = usableNode(nodeVersion) && path.posix.isAbsolute(node);
  const needsNode = !nodeOK || !path.posix.isAbsolute(npm);
  const nodeInstallBlocked = !arch ? "自动安装暂支持 Linux x64 / arm64" : !libcOK ? "官方 Node 22 需要 glibc ≥2.28；不会自动升级系统 libc" : !tar || !gzip || !sha256sum ? "自动安装需要 tar、gzip 和 sha256sum；不会使用 sudo 安装系统工具" : null;
  return { home, root: path.posix.join(home, ".local/share/agent-web-remote"), node, nodeVersion, npm, devin,
    arch, libc, nodeOK, needsNode, nodeInstallBlocked: needsNode ? nodeInstallBlocked : null,
    installed: installed === "1", running: running === "1", compatible: compatible === "1",
    piConfigured: configured === "1", systemd: systemd === "1", linger: linger === "1" };
}

// Public runtime archives only: no host credentials or project data. Cache is
// memory-only, bounded, and survives retries/other hosts but not a restart.
const nodeDownloads = new Map(), activeNodeDownloads = new Map();
const NODE_CACHE_BYTES = 128 * 1024 * 1024, NODE_CACHE_TTL = 30 * 60 * 1000;
function trimNodeDownloads() {
  let bytes = [...nodeDownloads.values()].reduce((n, state) => n + state.size, 0);
  for (const [key, state] of nodeDownloads) {
    if (activeNodeDownloads.has(key)) continue;
    if (Date.now() - state.usedAt > NODE_CACHE_TTL || bytes > NODE_CACHE_BYTES) {
      nodeDownloads.delete(key); bytes -= state.size;
    }
  }
}
const downloadState = () => ({ chunks: [], size: 0, total: null, etag: null, usedAt: Date.now() });
const downloadMiB = (n) => (n / 1048576).toFixed(1);

async function officialDownload(url, maxBytes, fetcher = fetch, {
  state = downloadState(), totalTimeoutMs = 120000, idleTimeoutMs = 30000,
  maxAttempts = 3, retryDelayMs = 1000, onProgress,
} = {}) {
  const deadline = Date.now() + totalTimeoutMs;
  const interrupted = () => fail(`Node 官方文件下载超时或中断（已接收 ${downloadMiB(state.size)} MiB）；未上传或执行。请检查部署主机到 nodejs.org 的网络；重试可复用同一后端仍保留的下载断点。`);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() >= deadline) throw interrupted();
    const controller = new AbortController(); let idleTimer, totalExpired = false, resumed = state.size > 0, restarted = false;
    const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => controller.abort(), idleTimeoutMs); };
    const totalTimer = setTimeout(() => { totalExpired = true; controller.abort(); }, Math.max(1, deadline - Date.now()));
    const report = (extra = {}) => onProgress?.({ stage: "node_download", bytes: state.size, total: state.total, attempt, resumed, restarted, ...extra });
    resetIdle(); report();
    try {
      const headers = { "accept-encoding": "identity" };
      if (state.size) { headers.Range = `bytes=${state.size}-`; if (state.etag) headers["If-Range"] = state.etag; }
      const response = await fetcher(url, { redirect: "error", signal: controller.signal, headers });
      if (response.status === 416 && state.total === state.size && state.size > 0) {
        await response.body?.cancel(); return Buffer.concat(state.chunks, state.size);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        if ([408, 429, 500, 502, 503, 504].includes(response.status)) throw new Error("download temporarily unavailable");
        throw fail(`Node 官方下载源返回 HTTP ${response.status}，未执行安装`);
      }
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding !== "identity") { await response.body.cancel(); throw fail("Node 下载响应编码异常，未执行安装"); }
      const lengthHeader = response.headers.get("content-length"), length = lengthHeader == null ? null : Number(lengthHeader);
      if (length !== null && (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)) {
        await response.body.cancel(); throw fail("Node 下载文件超过大小限制或长度无效");
      }
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") || "");
        if (!range || +range[1] !== state.size || +range[2] < +range[1] || +range[2] >= +range[3] || +range[3] > maxBytes ||
            (length !== null && length !== +range[2] - +range[1] + 1) || (state.total !== null && state.total !== +range[3])) {
          await response.body.cancel(); throw fail("Node 断点下载响应无效，未执行安装");
        }
        state.total = +range[3];
      } else {
        // A server ignoring Range returned the entire archive: start clean,
        // never concatenate it with a prefix from a previous attempt.
        restarted = state.size > 0; resumed = false;
        state.chunks = []; state.size = 0; state.total = length;
        if (restarted) report({ restarted: true });
      }
      state.etag = response.headers.get("etag") || null;
      resetIdle(); let reportedAt = 0;
      for await (const chunk of response.body) {
        resetIdle();
        if (state.size + chunk.length > maxBytes || (state.total !== null && state.size + chunk.length > state.total)) {
          controller.abort(); throw fail("Node 下载文件超过大小限制或声明长度");
        }
        state.chunks.push(Buffer.from(chunk)); state.size += chunk.length; state.usedAt = Date.now();
        if (Date.now() - reportedAt >= 250) { report(); reportedAt = Date.now(); }
      }
      report();
      if (state.total !== null && state.size !== state.total) throw new Error("incomplete download");
      return Buffer.concat(state.chunks, state.size);
    } catch (error) {
      if (error.status) throw error;
      if (totalExpired || Date.now() >= deadline || attempt === maxAttempts) {
        throw interrupted();
      }
      report({ retrying: true });
    } finally { clearTimeout(idleTimer); clearTimeout(totalTimer); controller.abort(); }
    await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, Math.max(0, deadline - Date.now()))));
  }
}

export async function nodeRuntimePlan(info, fetcher = fetch) {
  if (!info.needsNode || info.nodeInstallBlocked) return null;
  const sums = (await officialDownload("https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt", 256 * 1024, fetcher)).toString("utf8");
  const match = sums.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+(node-v(22\.\d+\.\d+)-linux-(x64|arm64)\.tar\.gz)$/.exec(line))
    .find((row) => row && row[4] === info.arch && usableNode(row[3]));
  if (!match) throw fail("官方 Node 22 下载清单没有兼容当前主机的安装包");
  return { version: match[3], file: match[2], sha256: match[1], url: `https://nodejs.org/dist/v${match[3]}/${match[2]}`,
    target: path.posix.join(info.root, "runtimes", match[2].replace(/\.tar\.gz$/, "")) };
}

export async function downloadNodeRuntime(plan, fetcher = fetch, options = {}) {
  if (!/^22\.\d+\.\d+$/.test(plan.version) || !usableNode(plan.version) || !["x64", "arm64"].some((arch) => plan.file === `node-v${plan.version}-linux-${arch}.tar.gz`) ||
      plan.url !== `https://nodejs.org/dist/v${plan.version}/${plan.file}` || !/^[a-f0-9]{64}$/.test(plan.sha256)) throw fail("Node 安装计划无效，请重新检测");
  const key = `${plan.url}:${plan.sha256}`;
  trimNodeDownloads();
  let state = nodeDownloads.get(key);
  if (state?.verified) {
    state.usedAt = Date.now(); nodeDownloads.delete(key); nodeDownloads.set(key, state);
    options.onProgress?.({ stage: "node_download", bytes: state.size, total: state.size, cached: true });
    return state.buffer;
  }
  let work = activeNodeDownloads.get(key);
  if (!work) {
    state ||= downloadState(); nodeDownloads.set(key, state);
    work = { listeners: new Set(), progress: null };
    activeNodeDownloads.set(key, work);
    const notify = (progress) => { work.progress = progress; for (const listener of work.listeners) listener(progress); };
    work.promise = (async () => {
      try {
        const archive = await officialDownload(plan.url, 128 * 1024 * 1024, fetcher, {
          totalTimeoutMs: 15 * 60 * 1000, idleTimeoutMs: 60000, ...options, state, onProgress: notify,
        });
        if (createHash("sha256").update(archive).digest("hex") !== plan.sha256) {
          nodeDownloads.delete(key); throw fail("Node 安装包 SHA256 校验失败；未上传或执行");
        }
        state.buffer = archive; state.chunks = []; state.verified = true; state.usedAt = Date.now();
        return archive;
      } finally { activeNodeDownloads.delete(key); trimNodeDownloads(); }
    })();
  }
  if (options.onProgress) { work.listeners.add(options.onProgress); if (work.progress) options.onProgress(work.progress); }
  try { return await work.promise; }
  finally { work.listeners.delete(options.onProgress); }
}

const sftpOf = (ssh) => new Promise((resolve, reject) => ssh.sftp((e, sftp) => e ? reject(fail("远端 SFTP 不可用")) : resolve(sftp)));
const callSftp = (sftp, method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)));
async function mkdirs(sftp, directory) {
  let current = "/";
  for (const part of directory.split("/").filter(Boolean)) {
    current = path.posix.join(current, part);
    try { await callSftp(sftp, "mkdir", current, { mode: 0o700 }); }
    catch (e) { const stat = await callSftp(sftp, "lstat", current).catch(() => null); if (!stat?.isDirectory()) throw e; }
  }
}
async function upload(sftp, name, data, onProgress) {
  const existing = await callSftp(sftp, "lstat", name).catch((e) => { if (e.code !== 2) throw e; return null; });
  if (existing?.isSymbolicLink()) throw fail("组件目标文件是符号链接，安装已阻止");
  const handle = await callSftp(sftp, "open", name, "w", { mode: 0o600 });
  try {
    for (let offset = 0; offset < data.length; offset += 32768) {
      const length = Math.min(32768, data.length - offset);
      await new Promise((resolve, reject) => sftp.write(handle, data, offset, length, offset, (e) => e ? reject(e) : resolve()));
      onProgress?.({ bytes: offset + length, total: data.length });
    }
  } finally { await callSftp(sftp, "close", handle); }
}

/** Install only after the plan was explicitly confirmed. No shell/profile edits. */
export async function installNodeRuntime(ssh, plan, archive, { onProgress } = {}) {
  const node = plan.nodeInstall;
  if (!node || createHash("sha256").update(archive).digest("hex") !== node.sha256) throw fail("Node 安装包校验失败");
  const checked = await inspectWorker(ssh, plan.version);
  if (checked.home !== plan.home || checked.root !== plan.root || checked.arch !== plan.arch) throw fail("远端环境已变化，请重新检测");
  if (checked.running) throw fail("组件仍在运行，请先明确停止，再安装专用 Node；不会中断已有进程");
  const folder = node.file.replace(/\.tar\.gz$/, "");
  if (!/^node-v22\.\d+\.\d+-linux-(x64|arm64)$/.test(folder) || node.target !== path.posix.join(plan.root, "runtimes", folder)) throw fail("Node 安装目录无效");
  const stage = path.posix.join(plan.root, `.node-stage-${randomUUID()}`), lock = path.posix.join(plan.root, ".node-install-lock");
  const sftp = await sftpOf(ssh); let locked = false;
  try {
    await mkdirs(sftp, path.posix.join(plan.root, "runtimes"));
    try { await callSftp(sftp, "mkdir", lock, { mode: 0o700 }); locked = true; }
    catch { throw fail("已有 Node 安装操作或遗留 .node-install-lock，请核实后处理"); }
    await callSftp(sftp, "mkdir", stage, { mode: 0o700 });
    onProgress?.({ stage: "node_upload", bytes: 0, total: archive.length });
    await upload(sftp, path.posix.join(stage, "archive.tar.gz"), archive, (progress) => onProgress?.({ stage: "node_upload", ...progress }));
    onProgress?.({ stage: "node_validate" });
    const result = await sshExec(ssh, loginCommand(`set -eu
umask 077
stage=${quoteShell(stage)}
target=${quoteShell(node.target)}
trap 'rm -rf -- "$stage"' EXIT
cd "$stage"
printf '%s  archive.tar.gz\\n' ${quoteShell(node.sha256)} | sha256sum -c - >/dev/null || exit 51
[ ! -L "$target" ] || exit 46
if [ -e "$target" ]; then
 [ -f "$target/.node-ready" ] && [ "$(cat "$target/.node-ready")" = ${quoteShell(node.sha256)} ] || exit 52
else
 tar -tzf archive.tar.gz >entries
 awk -v prefix=${quoteShell(folder + "/")} 'index($0,prefix)!=1 || $0 ~ /(^|\\/)\\.\\.(\\/|$)/ {bad=1} END {exit bad}' entries || exit 51
 tar -xzf archive.tar.gz --no-same-owner --no-same-permissions
 [ "$(${quoteShell(path.posix.join(stage, folder, "bin/node"))} --version)" = ${quoteShell("v" + node.version)} ] || exit 53
 PATH=${quoteShell(path.posix.join(stage, folder, "bin"))}:"$PATH" ${quoteShell(path.posix.join(stage, folder, "bin/npm"))} --version >/dev/null || exit 53
 printf '%s' ${quoteShell(node.sha256)} >${quoteShell(path.posix.join(stage, folder, ".node-ready"))}
 mv -- ${quoteShell(path.posix.join(stage, folder))} "$target"
fi
printf '%s\\n' ${quoteShell(path.posix.join(node.target, "bin/node"))} >"$stage/node-runtime"
mv -f -- "$stage/node-runtime" ${quoteShell(path.posix.join(plan.root, ".node-runtime"))}
`), { timeout: 120000, maxOutput: 8192 });
    if (result.code === 52) throw fail("专用 Node 目录存在未完成或不匹配的安装，请检查后重试；未覆盖原目录");
    if (result.code !== 0) throw fail("专用 Node 安装或运行验证失败；可能缺少兼容系统库，未升级系统或改动默认 Node");
  } finally {
    if (locked) await callSftp(sftp, "rmdir", lock).catch(() => {});
    sftp.end();
  }
}

export async function installWorker(ssh, plan, bundle) {
  const checked = await inspectWorker(ssh, bundle.version);
  if (checked.home !== plan.home || checked.node !== plan.node || checked.root !== plan.root) throw fail("远端环境已变化，请重新检测并确认安装");
  if (checked.needsNode) throw fail("需要先确认并安装组件专用 Node 运行时");
  if (checked.installed) return;
  if (checked.running) throw fail("组件仍在运行；请先明确停止组件，再确认安装，避免中断任务");
  const sftp = await sftpOf(ssh), release = path.posix.join(plan.root, "releases", bundle.version);
  const lock = path.posix.join(plan.root, ".install-lock");
  let locked = false;
  try {
    await mkdirs(sftp, plan.root);
    try { await callSftp(sftp, "mkdir", lock, { mode: 0o700 }); locked = true; }
    catch { throw fail("远端已有安装操作或遗留安装锁，请核实后处理 .install-lock"); }
    await mkdirs(sftp, release);
    for (const [name, data] of bundle.files) {
      const target = path.posix.join(release, name);
      await mkdirs(sftp, path.posix.dirname(target)); await upload(sftp, target, data);
    }
    // Logs stay private on the remote host. Do not return npm output (which
    // can contain private registry credentials) to the browser or local logs.
    const result = await sshExec(ssh, loginCommand(`umask 077
cd ${quoteShell(release)} || exit 1
${nodeEnvironment(plan)}
${quoteShell(plan.npm)} install --omit=dev --no-audit --no-fund >install.log 2>&1 || exit 43
${quoteShell(plan.node)} --input-type=module -e ${quoteShell("await import('node-pty'); await import('@earendil-works/pi-coding-agent'); await import('ssh2')")} >>install.log 2>&1 || exit 44
printf '%s' ${quoteShell(bundle.version)} > .ready`), { timeout: 600000, maxOutput: 8192 });
    if (result.code !== 0) throw fail("远端依赖安装或运行检查失败，请检查组件目录 install.log（可能需要原生编译工具）；未启动或重启组件");
  } finally {
    if (locked) await callSftp(sftp, "rmdir", lock).catch(() => {});
    sftp.end();
  }
}

export async function runningWorker(ssh, info) {
  const script = `const fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(info.root)};
const r=JSON.parse(fs.readFileSync(path.join(root,'runtime.json'),'utf8')),c=JSON.parse(fs.readFileSync(path.join(root,'config.json'),'utf8'));
process.kill(r.pid,0);console.log(JSON.stringify({port:r.port,token:c.token}));`;
  const result = await sshExec(ssh, loginCommand(`${nodeEnvironment(info)}${quoteShell(info.node)} -e ${quoteShell(script)}`));
  try {
    const runtime = JSON.parse(result.out.trim().split("\n").at(-1));
    if (result.code !== 0 || !Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || !/^[a-f0-9]{64}$/.test(runtime.token)) throw new Error();
    return runtime;
  } catch { throw fail("无法安全读取运行中的组件信息"); }
}

export async function startWorker(ssh, info, version) {
  if (info.needsNode) throw fail("需要先检测并确认安装组件专用 Node；连接操作不会自动安装运行时");
  if (info.running && !info.compatible) throw fail("远端已有不同版本组件在运行，请先停止后再升级；不会自动中断任务");
  const release = path.posix.join(info.root, "releases", version);
  const script = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=${JSON.stringify(info.root)},release=${JSON.stringify(release)},version=${JSON.stringify(version)};
const configFile=path.join(root,'config.json'),runtimeFile=path.join(root,'runtime.json'),lock=path.join(root,'.start-lock');
let locked=false;try{fs.mkdirSync(lock,{mode:0o700});locked=true}catch{}
let config;try{config=JSON.parse(fs.readFileSync(configFile,'utf8'))}catch(e){if(e.code!=='ENOENT'){if(locked)fs.rmdirSync(lock);process.exit(47)}}
let runtime;try{runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'))}catch{}
let alive=false;if(runtime?.pid){try{process.kill(runtime.pid,0);alive=true}catch{}}
if(locked){
 if(!config){if(alive){fs.rmdirSync(lock);process.exit(47)}config={root,version,token:crypto.randomBytes(32).toString('hex')};}
 if(config.root!==root||!/^[a-f0-9]{64}$/.test(config.token||'')){fs.rmdirSync(lock);process.exit(47)}
 config.version=version;
 fs.writeFileSync(configFile,JSON.stringify(config),{mode:0o600});fs.chmodSync(configFile,0o600);
}
if(locked&&!alive){
 const log=fs.openSync(path.join(root,'worker.log'),'a',0o600);
 const args=[path.join(release,'launch.cjs'),configFile];
 let spawned=false;
 if(${!!info.systemd}){try{cp.execFileSync('systemd-run',['--user','--collect','--unit=agent-web-remote','--setenv=PATH='+process.env.PATH,process.execPath,...args],{timeout:10000,stdio:'ignore'});spawned=true}catch{}}
 if(!spawned){const child=cp.spawn(process.execPath,args,{cwd:release,detached:true,stdio:['ignore',log,log]});child.unref();}
 fs.closeSync(log);
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{for(let i=0;i<100;i++){
 try{config=JSON.parse(fs.readFileSync(configFile,'utf8'));runtime=JSON.parse(fs.readFileSync(runtimeFile,'utf8'));if(runtime.version===version&&Number.isInteger(runtime.port)&&runtime.port>0){process.kill(runtime.pid,0);console.log(JSON.stringify({port:runtime.port,token:config.token}));if(locked)fs.rmdirSync(lock);return}}catch{}
 await wait(200);
}if(locked)fs.rmdirSync(lock);process.exit(45)})();`;
  const result = await sshExec(ssh, loginCommand(`${nodeEnvironment(info)}${quoteShell(info.node)} -e ${quoteShell(script)}`), { timeout: 35000, maxOutput: 16384 });
  if (result.code === 47) throw fail("远端组件配置损坏或令牌缺失；原文件未覆盖，请核查 config.json");
  if (result.code !== 0) throw fail("远端组件未能启动，请检查用户目录 worker.log；现有任务未被主动停止");
  try {
    const runtime = JSON.parse(result.out.trim().split("\n").at(-1));
    if (!Number.isInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535 || !/^[a-f0-9]{64}$/.test(runtime.token)) throw new Error();
    return runtime;
  } catch { throw fail("远端组件启动信息无效"); }
}
