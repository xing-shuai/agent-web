import React, { useMemo, useState } from "react";
import { Plus, FolderOpen, Folder, Loader2, Menu, TerminalSquare, MessageSquare, ChevronRight } from "lucide-react";
import ContextMenu from "./ContextMenu.jsx";
import FullscreenButton from "./FullscreenButton.jsx";
import { states as remoteStates } from "./RemoteHosts.jsx";
import { t } from "../i18n.js";

function shortPath(p) {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function relTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("刚刚");
  if (diff < 3600) return t("{v0} 分钟前", { v0: Math.floor(diff / 60) });
  if (diff < 86400) return t("{v0} 小时前", { v0: Math.floor(diff / 3600) });
  return t("{v0} 天前", { v0: Math.floor(diff / 86400) });
}

function shortCwd(cwd, home) {
  if (!cwd) return "";
  return home && (cwd === home || cwd.startsWith(home + "/")) ? "~" + cwd.slice(home.length) : cwd;
}

const baseName = (p) => String(p || "").split("/").filter(Boolean).at(-1) || p || "";

export default function Welcome({ environmentName, host = "", hosts, onSelectHost, busy = false, sessions, loading = false, activeWorkspace, home, wsUp, creating, agents, onPickAgent, onNewSession, onOpenWorkspace, onOpenSession, onPickWorkspace, onOpenDrawer, onToggleTerminal, terminalOpen }) {
  const recent = useMemo(() => {
    const map = new Map();
    for (const session of sessions || []) {
      if (!session.cwd || session.archived || session.cwd === activeWorkspace) continue;
      const value = map.get(session.cwd) || { count: 0, latest: "" };
      value.count++;
      if ((session.updatedAt || "") > value.latest) value.latest = session.updatedAt;
      map.set(session.cwd, value);
    }
    return [...map.entries()].map(([cwd, value]) => ({ cwd, ...value }))
      .sort((a, b) => b.latest.localeCompare(a.latest)).slice(0, 6);
  }, [sessions, activeWorkspace]);
  const continued = useMemo(() => (sessions || []).filter((session) => !session.archived && (!activeWorkspace || session.cwd === activeWorkspace))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")).slice(0, 8), [sessions, activeWorkspace]);
  const [menu, setMenu] = useState(null);
  const newSession = (event) => {
    if (creating) return;
    if (!activeWorkspace) return onPickWorkspace();
    if ((agents?.length || 0) < 2) return onNewSession(activeWorkspace, agents?.[0]?.id);
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.left, y: rect.bottom + 4, items: agents.map((agent) => ({
      label: t("新建 {v0} 会话", { v0: agent.name }), icon: Plus,
      onClick: () => { onPickAgent?.(agent.id); onNewSession(activeWorkspace, agent.id); },
    })) });
  };

  return <>
    <div className="mobile-bar">
      <button className="icon-ghost" title={t("会话列表")} onClick={onOpenDrawer}><Menu size={18} /></button>
      <span className="mobile-bar-title">Agent Web</span>
      <span className="mobile-bar-actions"><FullscreenButton size={17} /></span>
    </div>
    <div className="welcome">
      <header className="welcome-header">
        <div className="welcome-heading">
          <h1 title={activeWorkspace}>{environmentName && <span className="remote-title">{environmentName}</span>}{activeWorkspace ? baseName(activeWorkspace) : t("继续你的工作")}</h1>
          <p className="sub">{activeWorkspace ? t("选择会话继续，或开启新的任务。") : t("打开最近会话，或选择一个工作区开始。")}</p>
        </div>
        <div className="welcome-head-actions">
          {(hosts?.length > 0 || host !== "") && <select className="welcome-host" aria-label={t("窗格开发环境")} disabled={busy} value={host} onChange={(e) => onSelectHost?.(e.target.value)}>
          <option value="">{t("本机")}</option>
          {(hosts || []).map((h) => {
            const transitional = ["connecting", "reconnecting", "starting", "inspecting", "installing"].includes(h.state);
            return <option key={h.id} value={h.id} disabled={transitional}>{h.label || h.hostname}{h.state === "connected" ? "" : t("（{v0}，选择以连接）", { v0: remoteStates[h.state] || h.state })}</option>;
          })}
          {host && !(hosts || []).some((h) => h.id === host) && <option value={host}>{t("未知远程主机")}</option>}
        </select>}
          <button type="button" className="primary welcome-new" disabled={!!creating} onClick={newSession}>
            {creating ? <Loader2 size={15} className="spin" /> : activeWorkspace ? <Plus size={15} /> : <FolderOpen size={15} />}
            {creating ? t("创建中…") : activeWorkspace ? t("新建会话") : t("选择工作区")}
          </button>
        </div>
      </header>
      <section className="project-sessions" aria-label={t("继续会话")}>
        <div className="welcome-section-head">
          <h2>{t("继续会话")}</h2>
          <div className="welcome-actions">
            {activeWorkspace && <button type="button" onClick={onPickWorkspace}><FolderOpen size={14} />{t("切换工作区")}</button>}
            {onToggleTerminal && <button type="button" data-terminal-toggle="" onClick={onToggleTerminal} aria-expanded={terminalOpen}><TerminalSquare size={14} />{t("终端")}</button>}
          </div>
        </div>
        {loading ? <p className="welcome-empty" role="status"><Loader2 size={13} className="spin" /> {t("正在加载会话…")}</p>
          : continued.length ? continued.map((session) => <button key={session.sessionId} type="button" className="project-session" onClick={() => onOpenSession(session)} title={session.title || session.sessionId}>
            <MessageSquare size={15} /><span>{session.title || session.sessionId}</span>
            <small>{session.agent === "devin" ? "de" : session.agent || "de"} · {relTime(session.updatedAt)}</small><ChevronRight size={14} />
          </button>) : <p className="welcome-empty">{activeWorkspace ? t("此工作区还没有会话，点击上方「新建会话」开始。") : t("还没有最近会话，先选择一个工作区。")}</p>}
      </section>
      {recent.length > 0 && <section className="recent-workspaces" aria-label={t("最近工作区")}>
        <div className="welcome-section-head"><h2>{activeWorkspace ? t("其他最近工作区") : t("最近工作区")}</h2></div>
        {recent.map((workspace) => <button type="button" key={workspace.cwd} className="ws-card" onClick={() => onOpenWorkspace(workspace.cwd)} title={workspace.cwd}>
          <Folder size={15} className="ws-card-ic" />
          <span className="ws-card-name">{baseName(workspace.cwd)}</span>
          <span className="ws-card-path">{shortPath(shortCwd(workspace.cwd, home))}</span>
          <small className="ws-card-meta">{t("{v0} 个会话", { v0: workspace.count })}</small><ChevronRight size={14} />
        </button>)}
      </section>}
      {!wsUp && <div className="conn-hint" role="status"><Loader2 size={13} className="spin" />{t("正在连接后端…")}</div>}
    </div>
    <ContextMenu menu={menu} onClose={() => setMenu(null)} />
  </>;
}
