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

} from "lucide-react";
import ContextMenu from "./ContextMenu.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import FullscreenButton from "./FullscreenButton.jsx";
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

function sessionStatus(s) {
  if (s.state === "working")
    return { cls: "st-work", label: "工作中", title: "Devin 正在工作" };
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
  onRenameSession,
  onReleaseSession,
  onExportSession,
  onPickWorkspace,
  onFocusWorkspace,
  unreadIds,
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

  const groups = useMemo(() => {
    const m = new Map();
    for (const s of sessions) {
      const k = s.cwd || "";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    const createdOf = (s) => s.createdAt || s._meta?.["cognition.ai/createdAt"] || "";
    const rank = { working: 0, "locked-active": 1, held: 2, locked: 3, free: 4 };
    const sessCmp =
      sortBy === "name"
        ? (a, b) => (a.title || a.sessionId).localeCompare(b.title || b.sessionId)
        : sortBy === "created"
          ? (a, b) => createdOf(b).localeCompare(createdOf(a))
          : sortBy === "state"
            ? (a, b) =>
                (rank[a.state] ?? 4) - (rank[b.state] ?? 4) ||
                (b.updatedAt || "").localeCompare(a.updatedAt || "")
            : (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "");
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
        { label: "重命名", icon: Pencil, onClick: () => setRenaming(s.sessionId) },
        { label: "复制会话 ID", icon: Copy, onClick: () => copy(s.sessionId) },
        { label: "导出为 Markdown", icon: Download, onClick: () => onExportSession?.(s.sessionId) },
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
          Devin Web
        </span>
        <button className="icon-ghost" title="选择目录" onClick={onPickWorkspace}>
          <FolderPlus size={17} />
        </button>
      </div>

      <button className="new-session" onClick={() => onNewSession(activeWorkspace)}>
        <Plus size={16} /> 新建会话
      </button>

      <div className="sb-tools">
        <div className="sb-search">
          <Search size={14} />
          <input
            placeholder="搜索会话…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
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
                  const st = sessionStatus(s);
                  return (
                    <div
                      key={s.sessionId}
                      className={"session-row" + (s.sessionId === activeId ? " active" : "")}
                      onClick={() => {
                        onFocusWorkspace(g.cwd);
                        onOpenSession(s);
                      }}
                      onContextMenu={(e) => sessionMenu(e, s, g.cwd)}
                      title={s.title || s.sessionId}
                    >
                      <div className="sr-top">
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
                          <div className="session-title">{s.title || s.sessionId}</div>
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

      <AccountUsage />
      <div className="sb-foot">
        <span className={"conn" + (wsUp ? " up" : "")} />
        <span>{wsUp ? "已连接" : "连接断开"}</span>
        <FullscreenButton />
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
    </aside>
  );
}
