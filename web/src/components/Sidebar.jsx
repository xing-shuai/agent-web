import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Sparkles,
  FolderPlus,
  Plus,
  Search,
  ArrowUpDown,
  ChevronRight,
  Folder,
  FolderOpen,
  MoreHorizontal,
  MessageSquare,
  Pencil,
  Copy,
  Download,
  Unplug,
  Trash2,
  ChevronsDownUp,
  ChevronsUpDown,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  FileJson,
  Bell,
  BellOff,
  CheckSquare,
  ChevronDown,
  Loader2,
  X,
} from "lucide-react";
import ContextMenu from "./ContextMenu.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import SettingsMenu from "./SettingsMenu.jsx";
import ThemeMenu from "./ThemeMenu.jsx";
import AccountUsage from "./AccountUsage.jsx";

function relTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function shortCwd(cwd, home) {
  if (!cwd) return "(未知目录)";
  if (home && (cwd === home || cwd.startsWith(home + "/")))
    return "~" + cwd.slice(home.length);
  return cwd;
}

const baseName = (p) => {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || p || "";
};

const parentDir = (p) => {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  return i > 0 ? s.slice(0, i) : i === 0 ? "/" : "";
};

const copy = (t) => navigator.clipboard?.writeText(t).catch(() => {});

function sessionStatus(s, agentName) {
  if (s.state === "working")
    return { cls: "st-work", label: "工作中", title: `${agentName} 正在工作` };
  if (s.state === "held") return { cls: "st-held", label: "挂起", title: "已连接，等待输入" };
  if (s.state === "locked-active")
    return {
      cls: "st-run",
      label: "他端运行",
      title: `他端进程 ${s._meta?.["cognition.ai/lockHolderPid"] || "?"} 正在运行`,
    };
  if (s.state === "locked" || (!s.state && s._meta?.["cognition.ai/isLocked"]))
    return {
      cls: "st-lock",
      label: "他端挂起",
      title: s._meta?.["cognition.ai/lockHolderPid"]
        ? `被进程 ${s._meta["cognition.ai/lockHolderPid"]} 占用（挂起）`
        : "被其他进程占用（挂起）",
    };
  return null;
}

function RenameInput({ initial, onSave, onCancel }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSave(e.currentTarget.value.trim());
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={onCancel}
    />
  );
}

export default function Sidebar({
  sessions,
  activeId,
  activeWorkspace,
  home,
  wsUp,
  drawerOpen,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onDeleteSessions,
  onRenameSession,
  onReleaseSession,
  onExportSession,
  onPickWorkspace,
  onFocusWorkspace,
  onPinSession,
  onArchiveSession,
  unreadIds,
  agentsById,
  usageAgent,
  usageProvider,
  agentPref,
  onPickAgent,
  creating,
  notifyEnabled,
  onToggleNotify,
}) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("devin-web.collapsed") || "{}");
    } catch {
      return {};
    }
  });
  const [menu, setMenu] = useState(null);
  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState(null); // sessionId being renamed
  const [confirmDel, setConfirmDel] = useState(null); // session pending delete
  const [selectMode, setSelectMode] = useState(false);
  const [sel, setSel] = useState(() => new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [sortBy, setSortBy] = useState(() => localStorage.getItem("devin-web.sort") || "recent");
  const [width, setWidth] = useState(() => {
    const w = +localStorage.getItem("devin-web.sbWidth") || 280;
    return Math.min(560, Math.max(200, w));
  });

  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev) => {
      w = Math.min(560, Math.max(200, startW + ev.clientX - startX));
      setWidth(w);
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing");
      localStorage.setItem("devin-web.sbWidth", w);
    };
    document.body.classList.add("resizing");
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const toggle = (cwd) =>
    setCollapsed((c) => {
      const n = { ...c, [cwd]: !c[cwd] };
      localStorage.setItem("devin-web.collapsed", JSON.stringify(n));
      return n;
    });

  // Prune selections whose rows disappeared (deleted elsewhere / filtered).
  useEffect(() => {
    setSel((prev) => {
      const live = new Set(sessions.map((s) => s.sessionId));
      let changed = false;
      const next = new Set();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sessions]);

  const toggleSel = (id) =>
    setSel((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const enterSelect = (id) => {
    setSelectMode(true);
    if (id) setSel(new Set([id]));
  };

  const exitSelect = () => {
    setSelectMode(false);
    setSel(new Set());
    setConfirmBatch(false);
  };

  const [showArchived, setShowArchived] = useState(
    () => localStorage.getItem("devin-web.showArchived") === "1"
  );
  const archivedCount = useMemo(
    () => sessions.reduce((n, s) => n + (s.archived ? 1 : 0), 0),
    [sessions]
  );

  const groups = useMemo(() => {
    const m = new Map();
    for (const s of sessions) {
      if (s.archived && !showArchived) continue;
      const k = s.cwd || "";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    const createdOf = (s) => s.createdAt || s._meta?.["cognition.ai/createdAt"] || "";
    const rank = { working: 0, "locked-active": 1, held: 2, locked: 3, free: 4 };
    const baseCmp =
      sortBy === "name"
        ? (a, b) => (a.title || a.sessionId).localeCompare(b.title || b.sessionId)
        : sortBy === "created"
          ? (a, b) => createdOf(b).localeCompare(createdOf(a))
          : sortBy === "state"
            ? (a, b) =>
                (rank[a.state] ?? 4) - (rank[b.state] ?? 4) ||
                (b.updatedAt || "").localeCompare(a.updatedAt || "")
            : (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "");
    // Pinned sessions always float to the top inside their workspace group.
    const sessCmp = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || baseCmp(a, b);
    const groups = [...m.entries()].map(([cwd, list]) => {
      const sorted = list.sort(sessCmp);
      return {
        cwd,
        sessions: sorted,
        latest: list[0]?.updatedAt || "",
        bestRank: Math.min(...list.map((s) => rank[s.state] ?? 4)),
      };
    });
    if (sortBy === "name") groups.sort((a, b) => a.cwd.localeCompare(b.cwd));
    else if (sortBy === "created")
      groups.sort((a, b) => createdOf(b.sessions[0] || {}).localeCompare(createdOf(a.sessions[0] || {})));
    else if (sortBy === "state") groups.sort((a, b) => a.bestRank - b.bestRank || b.latest.localeCompare(a.latest));
    else groups.sort((a, b) => b.latest.localeCompare(a.latest));
    return groups;
  }, [sessions, sortBy]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => {
        if (g.cwd.toLowerCase().includes(q)) return g;
        const sessions = g.sessions.filter(
          (s) =>
            (s.title || "").toLowerCase().includes(q) ||
            (s.sessionId || "").toLowerCase().includes(q)
        );
        return sessions.length ? { ...g, sessions } : null;
      })
      .filter(Boolean);
  }, [groups, query]);

  const visibleIds = useMemo(
    () => filtered.flatMap((g) => g.sessions.map((s) => s.sessionId)),
    [filtered]
  );

  const sessionMenu = (e, s, cwd) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "打开会话",
          icon: MessageSquare,
          onClick: () => {
            onFocusWorkspace(cwd);
            onOpenSession(s);
          },
        },
        { label: "批量选择", icon: CheckSquare, onClick: () => enterSelect(s.sessionId) },
        {
          label: s.pinned ? "取消置顶" : "置顶会话",
          icon: s.pinned ? PinOff : Pin,
          onClick: () => onPinSession?.(s.sessionId, !s.pinned),
        },
        {
          label: s.archived ? "取消归档" : "归档会话",
          icon: s.archived ? ArchiveRestore : Archive,
          onClick: () => onArchiveSession?.(s.sessionId, !s.archived),
        },
        { label: "重命名", icon: Pencil, onClick: () => setRenaming(s.sessionId) },
        { label: "复制会话 ID", icon: Copy, onClick: () => copy(s.sessionId) },
        { label: "导出为 Markdown", icon: Download, onClick: () => onExportSession?.(s.sessionId) },
        { label: "导出为 JSON", icon: FileJson, onClick: () => onExportSession?.(s.sessionId, "json") },
        ...(s.state === "held" || s.state === "working"
          ? [
              {
                label: "释放占用（允许其他进程打开）",
                icon: Unplug,
                onClick: () => onReleaseSession?.(s.sessionId),
              },
            ]
          : []),
        { sep: true },
        {
          label: "删除会话",
          icon: Trash2,
          danger: true,
          onClick: () => setConfirmDel(s),
        },
      ],
    });
  };

  const groupMenu = (e, g) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "在此目录新建会话", icon: Plus, onClick: () => onNewSession(g.cwd) },
        {
          label: collapsed[g.cwd] ? "展开" : "折叠",
          icon: collapsed[g.cwd] ? ChevronsUpDown : ChevronsDownUp,
          onClick: () => toggle(g.cwd),
        },
        { label: "复制路径", icon: Copy, onClick: () => copy(g.cwd) },
        { sep: true },
        {
          label: showArchived ? "隐藏已归档会话" : `显示已归档会话 (${archivedCount})`,
          icon: showArchived ? Archive : ArchiveRestore,
          onClick: () => {
            setShowArchived((v) => {
              localStorage.setItem("devin-web.showArchived", v ? "0" : "1");
              return !v;
            });
          },
        },
      ],
    });
  };

  return (
    <aside
      className={"sidebar" + (drawerOpen ? " open" : "")}
      style={{ "--sb-w": width + "px" }}
    >
      <div className="sidebar-head">
        <span className="logo">
          <span className="logo-mark">
            <Sparkles size={15} />
          </span>
          Agent Web
        </span>
        <button className="icon-ghost" title="选择目录" onClick={onPickWorkspace}>
          <FolderPlus size={17} />
        </button>
      </div>

      <div className="new-session-row">
        <button
          className="new-session"
          disabled={!!creating}
          onClick={() => onNewSession(activeWorkspace)}
        >
          {creating ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
          {creating ? "创建中…" : "新建会话"}
        </button>
        {(agentsById?.size || 0) > 1 && (
          <button
            className="new-session-pick"
            title="选择要新建的 Agent"
            disabled={!!creating}
            onClick={(e) =>
              setMenu({
                x: e.clientX,
                y: e.clientY,
                items: [...agentsById.values()].map((a) => ({
                  label: `新建 ${a.name} 会话`,
                  icon: Plus,
                  onClick: () => {
                    onPickAgent?.(a.id);
                    onNewSession(activeWorkspace, a.id);
                  },
                })),
              })
            }
          >
            {agentsById.get(agentPref)?.name || "Devin"}
            <ChevronDown size={13} />
          </button>
        )}
      </div>

      <div className="sb-tools">
        <div className="sb-search">
          <Search size={14} />
          <input
            placeholder="搜索会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button
          className={"icon-ghost" + (selectMode ? " on" : "")}
          title={selectMode ? "退出批量选择" : "批量选择"}
          onClick={() => (selectMode ? exitSelect() : enterSelect())}
        >
          <CheckSquare size={15} />
        </button>
        <span className="sort-pill" title="排序方式">
          <select
            className="sort-sel"
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value);
              localStorage.setItem("devin-web.sort", e.target.value);
            }}
          >
            <option value="recent">最近活跃</option>
            <option value="state">状态优先</option>
            <option value="name">按名称</option>
            <option value="created">按创建时间</option>
          </select>
          <ArrowUpDown size={13} />
        </span>
      </div>

      <div className="session-list">
        {filtered.length === 0 && <div className="dim pad">{query ? "无匹配会话" : "暂无会话"}</div>}
        {filtered.map((g) => (
          <div
            key={g.cwd}
            className={
              "ws-group" + (g.cwd === activeWorkspace ? " current" : "") + (collapsed[g.cwd] ? "" : " open")
            }
          >
            <div
              className="ws-head"
              title={g.cwd}
              onClick={() => {
                onFocusWorkspace(g.cwd);
                toggle(g.cwd);
              }}
              onContextMenu={(e) => groupMenu(e, g)}
            >
              {selectMode && (
                <input
                  type="checkbox"
                  className="sr-check"
                  checked={g.sessions.length > 0 && g.sessions.every((s) => sel.has(s.sessionId))}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        g.sessions.some((s) => sel.has(s.sessionId)) &&
                        !g.sessions.every((s) => sel.has(s.sessionId));
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setSel((prev) => {
                      const next = new Set(prev);
                      for (const s of g.sessions)
                        on ? next.add(s.sessionId) : next.delete(s.sessionId);
                      return next;
                    });
                  }}
                />
              )}
              <span className="ws-chev">
                <ChevronRight size={13} />
              </span>
              <span className="ws-ic">
                {collapsed[g.cwd] ? <Folder size={15} /> : <FolderOpen size={15} />}
              </span>
              <span className="ws-name">{baseName(shortCwd(g.cwd, home)) || g.cwd}</span>
              <span className="ws-sub">{shortCwd(parentDir(g.cwd), home)}</span>
              <span className="cnt">{g.sessions.length}</span>
              <button
                className="ws-add"
                title="在此目录新建会话"
                onClick={(e) => {
                  e.stopPropagation();
                  onNewSession(g.cwd);
                }}
              >
                <Plus size={13} />
              </button>
            </div>
            {!collapsed[g.cwd] && (
              <div className="ws-body">
                {g.sessions.map((s) => {
                  const st = sessionStatus(
                    s,
                    agentsById?.get(s.agent || "devin")?.name || s.agent || "Devin"
                  );
                  return (
                    <div
                      key={s.sessionId}
                      className={"session-row" + (s.sessionId === activeId ? " active" : "") + (selectMode && sel.has(s.sessionId) ? " sel" : "")}
                      onClick={() => {
                        if (selectMode) return toggleSel(s.sessionId);
                        onFocusWorkspace(g.cwd);
                        onOpenSession(s);
                      }}
                      onContextMenu={(e) => sessionMenu(e, s, g.cwd)}
                      title={s.title || s.sessionId}
                    >
                      <div className="sr-top">
                        {selectMode && (
                          <input
                            type="checkbox"
                            className="sr-check"
                            checked={sel.has(s.sessionId)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleSel(s.sessionId)}
                          />
                        )}
                        {renaming === s.sessionId ? (
                          <RenameInput
                            initial={s.title || s.sessionId}
                            onSave={(v) => {
                              setRenaming(null);
                              if (v && v !== (s.title || s.sessionId)) onRenameSession(s.sessionId, v);
                            }}
                            onCancel={() => setRenaming(null)}
                          />
                        ) : (
                          <div className="session-title">
                            {s.pinned && <Pin size={11} className="pin-ic" />}
                            {(agentsById?.size || 0) > 1 && (
                              <span className="sb-agent-tag">
                                {agentsById?.get(s.agent || "devin")?.name || s.agent || "Devin"}
                              </span>
                            )}
                            {s.title || s.sessionId}
                          </div>
                        )}
                        <span className="sr-time">{relTime(s.updatedAt)}</span>
                      </div>
                      {st && (
                        <div className={"session-status " + st.cls} title={st.title}>
                          <span className="st-dot" />
                          <span className="st-label">{st.label}</span>
                        </div>
                      )}
                      {unreadIds?.has(s.sessionId) && s.sessionId !== activeId && (
                        <span className="unread-dot" title="有新内容" />
                      )}
                      <button
                        className="sr-more"
                        title="更多操作"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          sessionMenu({ preventDefault() {}, stopPropagation() {}, clientX: r.left, clientY: r.bottom + 4 }, s, g.cwd);
                        }}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {selectMode && (
        <div className="sel-bar">
          <span className="sel-n">已选 {sel.size}</span>
          <button
            className="sel-btn"
            onClick={() => setSel(new Set(visibleIds))}
          >
            全选
          </button>
          <button className="sel-btn" onClick={() => setSel(new Set())}>
            清空
          </button>
          <span className="sel-sp" />
          <button
            className="sel-btn danger"
            disabled={!sel.size}
            onClick={() => setConfirmBatch(true)}
          >
            删除
          </button>
          <button className="sel-btn" title="退出批量选择" onClick={exitSelect}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="sb-foot">
        <span className={"conn" + (wsUp ? " up" : "")} />
        <span>{wsUp ? "已连接" : "连接断开"}</span>
        <AccountUsage agent={usageAgent} provider={usageProvider} />
        {onToggleNotify && (
          <button
            className={"icon-ghost" + (notifyEnabled ? " on" : "")}
            title={notifyEnabled ? "关闭完成通知" : "任务完成时通知我"}
            onClick={onToggleNotify}
          >
            {notifyEnabled ? <Bell size={15} /> : <BellOff size={15} />}
          </button>
        )}
        <SettingsMenu />
        <ThemeMenu />
      </div>

      <div className="sb-resize" onMouseDown={startResize} title="拖拽调整宽度" />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {confirmDel && (
        <ConfirmDialog
          title="删除会话"
          message={`确定删除会话「${confirmDel.title || confirmDel.sessionId}」吗？此操作不可撤销。`}
          confirmLabel="删除"
          onConfirm={() => {
            onDeleteSession(confirmDel.sessionId);
            setConfirmDel(null);
          }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
      {confirmBatch && (
        <ConfirmDialog
          title="批量删除会话"
          message={`确定删除选中的 ${sel.size} 个会话吗？此操作不可撤销。`}
          confirmLabel={`删除 ${sel.size} 个`}
          onConfirm={() => {
            onDeleteSessions?.([...sel]);
            exitSelect();
          }}
          onCancel={() => setConfirmBatch(false)}
        />
      )}
    </aside>
  );
}
