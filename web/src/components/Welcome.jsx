import React, { useMemo } from "react";
import { Sparkles, Plus, FolderOpen, Folder, Loader2, Menu } from "lucide-react";
import FullscreenButton from "./FullscreenButton.jsx";

function shortPath(p) {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : p;
}

function relTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function shortCwd(cwd, home) {
  if (!cwd) return "";
  if (home && (cwd === home || cwd.startsWith(home + "/")))
    return "~" + cwd.slice(home.length);
  return cwd;
}

const baseName = (p) => {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || p || "";
};

export default function Welcome({ sessions, activeWorkspace, home, wsUp, agents, agentPref, onPickAgent, onNewSession, onPickWorkspace, onOpenDrawer }) {
  const recent = useMemo(() => {
    const m = new Map(); // cwd -> {count, latest}
    for (const s of sessions || []) {
      if (!s.cwd) continue;
      const cur = m.get(s.cwd) || { count: 0, latest: "" };
      cur.count++;
      if ((s.updatedAt || "") > cur.latest) cur.latest = s.updatedAt;
      m.set(s.cwd, cur);
    }
    return [...m.entries()]
      .map(([cwd, v]) => ({ cwd, ...v }))
      .sort((a, b) => (b.latest || "").localeCompare(a.latest || ""))
      .slice(0, 6);
  }, [sessions]);

  return (
    <>
      <div className="mobile-bar">
        <button className="icon-ghost" title="会话列表" onClick={onOpenDrawer}>
          <Menu size={18} />
        </button>
        <span className="mobile-bar-title">Devin Web</span>
        <span className="mobile-bar-actions">
          <FullscreenButton size={17} />
          <button className="icon-ghost" title="新建会话" onClick={() => onNewSession()}>
            <Plus size={18} />
          </button>
        </span>
      </div>
      <div className="welcome">
      <div className="welcome-logo">
        <Sparkles size={28} />
      </div>
      <h1>今天想在哪个项目上工作？</h1>
      <p className="sub">选择一个工作区，或者直接在最近的目录中开始。</p>
      {agents?.length > 1 && (
        <div className="agent-seg">
          {agents.map((a) => (
            <button
              key={a.id}
              className={"agent-seg-opt" + (agentPref === a.id ? " cur" : "")}
              onClick={() => onPickAgent?.(a.id)}
            >
              {a.name}
            </button>
          ))}
        </div>
      )}
      <div className="welcome-actions">
        {activeWorkspace && (
          <button className="primary" onClick={() => onNewSession()}>
            <Plus size={15} /> 在 {shortPath(activeWorkspace)} 中新建会话
          </button>
        )}
        <button className="secondary" onClick={onPickWorkspace}>
          <FolderOpen size={15} /> 选择工作区
        </button>
      </div>
      {recent.length > 0 && (
        <>
          <div className="recent-label">最近的工作区</div>
          <div className="recent-grid">
            {recent.map((r) => (
              <div
                key={r.cwd}
                className="ws-card"
                onClick={() => onNewSession(r.cwd)}
                title={r.cwd}
              >
                <Folder size={17} className="ws-card-ic" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="ws-card-name">{baseName(shortCwd(r.cwd, home)) || r.cwd}</div>
                  <div className="ws-card-path">{shortPath(shortCwd(r.cwd, home))}</div>
                  <div className="ws-card-meta">
                    {r.count} 个会话{r.latest ? ` · ${relTime(r.latest)}` : ""}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {!wsUp && (
        <div className="conn-hint">
          <Loader2 size={13} className="spin" /> 正在连接后端…
        </div>
      )}
      </div>
    </>
  );
}
