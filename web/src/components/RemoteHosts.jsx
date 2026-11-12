import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Server, Laptop, Plus, X, Loader2, ChevronDown, MoreHorizontal } from "lucide-react";
import { controlApi } from "../api.js";
import { useLayer } from "../layers.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import ContextMenu from "./ContextMenu.jsx";
import { t } from "../i18n.js";

export const states = { disconnected: t("未连接"), connecting: t("连接中"), inspecting: t("检测中"), needs_trust: t("待确认指纹"), needs_install: t("待安装"), ready: t("可连接"), installing: t("安装中"), starting: t("启动中"), connected: t("已连接"), reconnecting: t("重连中"), error: t("连接异常") };
const emptyForm = { label: "", hostname: "", port: "22", username: "", password: "" };

/** Control-plane calls deliberately stay local, even in a remote document. */
export default function RemoteHosts({ currentHost = "", onEnter, onHosts, poll = false, wsUp = false, openRequest = 0 }) {
  const [open, setOpen] = useState(false), [hosts, setHosts] = useState([]);
  const [form, setForm] = useState(emptyForm), [adding, setAdding] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [busy, setBusy] = useState(null), [error, setError] = useState(null);
  const [hostMenu, setHostMenu] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [trust, setTrust] = useState(null), [installation, setInstallation] = useState(null), [confirm, setConfirm] = useState(null);
  const [passwordHost, setPasswordHost] = useState(null), [password, setPassword] = useState("");
  const panelRef = useRef(null), triggerRef = useRef(null), mounted = useRef(true);
  const close = () => { if (!busy) { setOpen(false); setForm(emptyForm); setPassword(""); setAdding(false); setPasswordHost(null); } };
  useLayer({ open, ref: panelRef, triggerRef, modal: true, onClose: close, initialFocus: ".remote-close" });
  const refresh = useCallback(async () => {
    try {
      const data = await controlApi.get("/api/remotes");
      if (!mounted.current) return;
      setStatusError(null); setHosts(data.hosts || []); setKeyConfigured(!!data.keyConfigured);
      onHosts?.(data.hosts || []);
    } catch (e) {
      if (mounted.current) {
        setStatusError(e.status === 404 ? t("功能未启用") : t("状态不可用"));
        setError(e.status === 404 ? t("当前后端尚未启用远程主机功能，需更新并重启后端后使用。") : e.message);
      }
    }
  }, [onHosts]);
  useEffect(() => { mounted.current = true; refresh(); return () => { mounted.current = false; }; }, [refresh]);
  useEffect(() => { if (openRequest) setOpen(true); }, [openRequest]);
  useEffect(() => {
    const busy = open || hosts.some((h) => h.busy || ["connecting", "reconnecting", "starting", "inspecting", "installing"].includes(h.state));
    const interval = busy ? 4000 : poll ? 20000 : 0;
    if (!interval) return;
    const update = () => { if (!document.hidden) refresh(); };
    const timer = setInterval(update, interval);
    document.addEventListener("visibilitychange", update);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", update); };
  }, [open, poll, refresh, hosts]);
  const operation = async (host, action, body = {}) => {
    setBusy(host?.id || "new"); setError(null);
    try {
      const result = await controlApi.post(host ? `/api/remotes/${host.id}/${action}` : "/api/remotes", body);
      if (action === "probe" || action === "trust") setInstallation({ host, plan: result });
      if (!host) { setForm(emptyForm); setAdding(false); }
      return result;
    } catch (e) {
      if (e.code === "HOST_KEY_UNKNOWN") setTrust({ host, fingerprint: e.fingerprint });
      else setError(e.message);
      return null;
    } finally { await refresh(); if (mounted.current) setBusy(null); }
  };
  const enter = (id) => { if (id !== currentHost) onEnter?.(id); close(); };
  const selected = hosts.find((h) => h.id === currentHost);
  const alias = currentHost ? selected?.label || selected?.hostname || t("远程主机") : t("本机");
  const hostConnected = !currentHost || (!statusError && selected?.state === "connected");
  const connected = wsUp && hostConnected;
  const connectionLabel = !currentHost ? (wsUp ? t("已连接") : t("连接断开")) : statusError || (
    selected?.state === "connected" ? (wsUp ? t("已连接") : t("页面重连")) : states[selected?.state] || t("检测中"));
  const rowBusy = (host) => !!busy || host.busy;
  const mainAction = (host) => {
    if (host.state === "connected") return { label: host.id === currentHost ? t("当前环境") : t("进入环境"), disabled: host.id === currentHost, run: () => enter(host.id) };
    if (["connecting", "reconnecting", "starting", "inspecting", "installing"].includes(host.state)) return { label: states[host.state], disabled: true };
    if (host.fingerprint && ["disconnected", "ready"].includes(host.state)) return { label: t("连接"), run: () => operation(host, "connect") };
    return { label: t("检测 / 安装"), run: () => operation(host, "probe") };
  };
  const moreActions = (event, host) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHostMenu({ hostId: host.id, x: rect.right - 200, y: rect.bottom + 4, items: [
      { label: t("检测 / 安装"), onClick: () => operation(host, "probe") },
      ...(["connected", "connecting", "reconnecting"].includes(host.state) ? [{ label: t("断开连接（任务继续）"), onClick: () => operation(host, "disconnect") }] : []),
      { label: t("更新密码"), onClick: () => { setPasswordHost(host); setPassword(""); } },
      { sep: true },
      { label: t("停止组件"), danger: true, onClick: () => setConfirm({ host, action: "stop" }) },
      { label: t("删除配置"), danger: true, onClick: () => setConfirm({ host, action: "delete" }) },
    ] });
  };
  const field = (key, label, props = {}) => <label className="remote-field">{label}<input {...props} value={form[key]} onChange={(e) => { const value = e.target.value; setForm((previous) => ({ ...previous, [key]: value })); }} /></label>;

  return <>
    <button ref={triggerRef} className="environment-control" title={`${alias}${selected ? ` (${selected.username}@${selected.hostname}:${selected.port})` : ""} · ${t("{v0} — 切换开发环境 / 管理 SSH 主机", { v0: connectionLabel })}`} onClick={() => { setOpen(true); refresh(); }}>
      <i className={"conn" + (connected ? " up" : "")} aria-hidden="true" />
      <span>{alias}</span>
      <small role="status">{connectionLabel}</small><ChevronDown size={12} />
    </button>
    {open && createPortal(<div className="modal-back" onClick={close}>
      <div ref={panelRef} className="modal remote-modal" role="dialog" aria-modal="true" aria-label={t("开发环境与 SSH 主机")} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h3>{t("开发环境 / SSH 主机")}</h3><button type="button" className="icon-ghost remote-close" aria-label={t("关闭主机管理")} disabled={!!busy} onClick={close}><X size={17} /></button></div>
        <div className="remote-body">
          {error && <p className="error-line" role="alert">{error}</p>}
          {!keyConfigured && <p className="remote-note">{t("密码加密保存需要服务器配置独立的 DEVIN_WEB_SSH_MASTER_KEY；不要把主密钥和主机配置放在一起。")}</p>}
          <div className="remote-row"><Laptop size={16} /><strong>{t("本机环境")}</strong><button className="secondary" disabled={!!busy} onClick={() => enter("")}>{!currentHost ? t("当前环境") : t("进入")}</button></div>
          {hosts.map((host) => {
            const action = mainAction(host);
            return <section key={host.id} className={"remote-host" + (host.id === currentHost ? " current" : "")}>
            <div className="remote-row"><Server size={15} /><strong title={host.label}>{host.label}</strong><small role="status">{states[host.state] || host.state}</small></div>
            <div className="remote-address">{host.username}@{host.hostname}:{host.port}</div>
            {host.fingerprint && <code className="remote-fingerprint" title={host.fingerprint}>{host.fingerprint}</code>}
            {host.error && <p className="error-line">{host.error}</p>}
            {host.busy && <RemoteProgress progress={host.progress} />}
            <div className="remote-actions">
              <button type="button" className="primary" disabled={rowBusy(host) || host.credentialLocked || action.disabled} onClick={action.run}>{action.label}</button>
              <button type="button" className="secondary" disabled={rowBusy(host)} aria-label={t("{v0} 的更多操作", { v0: host.label })} aria-haspopup="menu" aria-expanded={hostMenu?.hostId === host.id} onClick={(event) => moreActions(event, host)}><MoreHorizontal size={15} />{t("更多")}</button>
            </div>
            {passwordHost?.id === host.id && <form className="remote-password" onSubmit={async (e) => {
              e.preventDefault(); setBusy(host.id); setError(null);
              try { await controlApi.post(`/api/remotes/${host.id}`, { password }); setPassword(""); setPasswordHost(null); await refresh(); }
              catch (e) { setError(e.message); } finally { setBusy(null); }
            }}><input type="password" aria-label={t("新的 SSH 密码")} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><button className="secondary" disabled={!!busy}>{t("加密保存")}</button></form>}
          </section>; })}
          <button className="secondary remote-add" disabled={!!busy || !keyConfigured} onClick={() => setAdding(!adding)}><Plus size={14} />{t("添加 SSH 主机")}</button>
          {adding && <form className="remote-form" onSubmit={(e) => { e.preventDefault(); operation(null, "", form); }}>
            {field("label", t("名称"), { placeholder: t("开发服务器"), maxLength: 80 })}
            {field("hostname", t("主机地址"), { required: true, placeholder: t("IP 或域名"), autoComplete: "off" })}
            {field("port", t("端口"), { required: true, type: "number", min: 1, max: 65535 })}
            {field("username", t("Linux 用户名"), { required: true, autoComplete: "username" })}
            {field("password", t("SSH 密码"), { required: true, type: "password", autoComplete: "new-password" })}
            <button className="primary" disabled={!!busy}>{t("加密保存主机")}</button>
          </form>}
          {busy && <div className="remote-note" role="status"><Loader2 size={13} className="spin" />{t("正在处理，请勿重复操作；依赖安装可能需要数分钟。")}</div>}
          <p className="remote-note">{t("断开只关闭 SSH 连接，不主动结束远端任务。停止组件会结束其任务和 Shell。模型凭据保留在远端。")}</p>
        </div>
      </div>
    </div>, document.body)}
    <ContextMenu menu={hostMenu} onClose={() => setHostMenu(null)} />
    {trust && <ConfirmDialog title={t("确认 SSH 主机指纹")} confirmLabel={t("已独立核验，信任此指纹")} onCancel={() => setTrust(null)}
      message={<><span>{t("首次连接 {v0}，请与服务器管理员提供的指纹核对；不要仅因为页面显示就信任。", { v0: trust.host.hostname })}</span><code className="remote-fingerprint">{trust.fingerprint}</code></>}
      onConfirm={async () => { const current = trust; setTrust(null); await operation(current.host, "trust", { fingerprint: current.fingerprint }); }} />}
    {installation && <InstallDialog installation={installation} error={error} progress={hosts.find((host) => host.id === installation.host.id)?.progress} busy={!!busy} onClose={() => setInstallation(null)} onInstall={async () => {
      const { host, plan } = installation;
      const result = await operation(host, "install", { confirm: true, planId: plan.id });
      if (result) { setInstallation(null); await operation(host, "connect"); }
    }} onConnect={async () => { const { host } = installation; setInstallation(null); await operation(host, "connect"); }} />}
    {confirm && <ConfirmDialog title={confirm.action === "stop" ? t("停止远端组件") : t("删除远程主机配置")}
      message={confirm.action === "stop" ? t("停止 {v0} 的 Agent Web 组件，会中断该组件中的 Agent 任务并结束所有终端 Shell。其他浏览器也会受到影响。", { v0: confirm.host.label })
        : t("删除 {v0} 的主机配置和加密密码；只断开连接，不删除远端组件、项目或会话记录。", { v0: confirm.host.label })}
      confirmLabel={confirm.action === "stop" ? t("停止组件") : t("删除配置")} onCancel={() => setConfirm(null)} onConfirm={async () => {
        if (confirm.action === "delete") await controlApi.del(`/api/remotes/${confirm.host.id}`);
        else await controlApi.post(`/api/remotes/${confirm.host.id}/stop`, { confirm: true });
        setConfirm(null); await refresh();
      }} />}
  </>;
}

function RemoteProgress({ progress }) {
  if (!progress) return null;
  const labels = { node_download: t("部署主机下载 Node"), node_upload: t("SSH 上传 Node"), node_validate: t("远端校验 / 解压 Node"), dependencies: t("安装并检查组件依赖"), complete: t("安装完成") };
  const bytes = Number.isFinite(progress.bytes) ? (progress.bytes / 1048576).toFixed(1) : null;
  const total = progress.total > 0 ? (progress.total / 1048576).toFixed(1) : null;
  const percent = total ? Math.min(100, Math.floor(progress.bytes / progress.total * 100)) : null;
  return <p className="remote-note remote-progress" role="status">
    <Loader2 size={13} className="spin" /> {labels[progress.stage] || t("处理中")}
    {bytes !== null && ` · ${bytes}${total ? ` / ${total}` : ""} MiB${percent !== null ? `（${percent}%）` : ""}`}
    {progress.cached ? t(" · 复用已校验安装包") : progress.restarted ? t(" · 下载源未接受断点，正在重新下载") : progress.retrying ? t(" · 连接中断，自动续传中") : progress.attempt > 1 ? t(" · 续传尝试 {v0}", { v0: progress.attempt }) : progress.resumed ? t(" · 从保留断点继续") : ""}
  </p>;
}

function InstallDialog({ installation: { host, plan }, error, progress, busy, onClose, onInstall, onConnect }) {
  const panel = useRef(null);
  useLayer({ ref: panel, modal: true, onClose: () => { if (!busy) onClose(); }, initialFocus: ".remote-install-cancel" });
  return createPortal(<div className="modal-back"><div ref={panel} className="modal remote-modal" role="dialog" aria-modal="true" aria-label={t("远端组件安装确认")} tabIndex={-1}>
    <div className="modal-head"><h3>{t("{v0} · 环境检测", { v0: host.label })}</h3></div>
    <div className="remote-body">
      {error && <p className="error-line" role="alert">{error}</p>}
      {busy && <RemoteProgress progress={progress} />}
      <p>Linux · Node {plan.nodeVersion || t("未安装 / 不可用")} · {plan.devin ? t("已发现 Devin") : t("未发现 Devin（需在远端安装并登录）")}</p>
      {plan.needsNode && <div className="remote-runtime-plan">
        {plan.nodeInstall ? <>
          <p>{t("确认后自动安装组件专用 Node {v0}（含 npm），无需手动 SSH 升级。", { v0: plan.nodeInstall.version })}</p>
          <code className="remote-fingerprint">{plan.nodeInstall.target}</code>
          <p className="remote-note">{t("由部署主机从 nodejs.org 下载并校验 SHA256，支持断点续传及已校验包复用（重启清空缓存）。不使用 sudo，不替换系统 / 用户默认 Node，不修改 shell 配置。仅后续启动的组件及其子进程使用此运行时。")}</p>
          <code className="remote-fingerprint" title={t("安装包 SHA256")}>SHA256: {plan.nodeInstall.sha256}</code>
        </> : <p className="error-line" role="alert">{plan.nodeInstallBlocked || t("无法生成专用 Node 安装计划，请重新检测。")}</p>}
      </div>}
      <p>{plan.piConfigured ? t("已发现 Pi 配置目录，请确认模型凭据可用。") : t("未发现 Pi 配置，安装后仍需在远端配置模型凭据。")}</p>
      <p>{t("组件目录：")}<code className="remote-fingerprint">{plan.root}</code></p>
      <p>{plan.systemd && plan.linger ? t("支持用户级服务与退出登录后保活；不保证主机重启后自动恢复任务。") : t("当前环境不能保证用户退出后保活；SSH 断线不主动停止组件，但系统可能清理后台进程。")}</p>
      {plan.running && (!plan.compatible || plan.needsNode) && <p className="error-line">{t("组件仍在运行，升级组件或补齐专用 Node 前，请先关闭此窗口并明确停止组件，再检测安装。")}</p>}
      {(!plan.installed || plan.needsNode) && <ul>{plan.operations?.map((text) => <li key={text}>{text}</li>)}</ul>}
      <p className="remote-note">{t("不使用 sudo，不自动安装系统依赖。安装过程会访问远端 npm 仓库；所有操作使用该 SSH 账号权限，并非沙箱。")}</p>
    </div>
    <div className="modal-actions"><button className="secondary remote-install-cancel" disabled={busy} onClick={onClose}>{t("取消")}</button>
      <button className="primary" disabled={busy || (plan.running && (!plan.compatible || plan.needsNode)) || (plan.needsNode && !plan.nodeInstall)} onClick={plan.installed && !plan.needsNode ? onConnect : onInstall}>{busy ? t("正在处理…") : plan.needsNode ? t("确认自动安装 Node 并继续") : plan.installed ? t("连接已有组件") : t("确认安装并连接")}</button></div>
  </div></div>, document.body);
}
