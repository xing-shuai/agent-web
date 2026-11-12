import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Columns2, Rows2, 
  Sparkles,
  MessageSquareDashed,
  PanelLeftClose,
  PanelLeftOpen,
  FolderPlus,
  Plus,
  Search,
  Filter,
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
  Loader2,
  ShieldAlert,
  X,
} from "lucide-react";
import { useEnvironment } from "../environmentContext.js";
import { useLayer } from "../layers.js";
import ContextMenu from "./ContextMenu.jsx";
import ConfirmDialog from "./ConfirmDialog.jsx";
import SettingsMenu from "./SettingsMenu.jsx";
import ThemeMenu from "./ThemeMenu.jsx";
import AccountUsage from "./AccountUsage.jsx";
import { t } from "../i18n.js";
import useCopyText from "../hooks/useCopyText.js";

function relTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("刚刚");
  if (diff < 3600) return t("{v0} 分钟前", { v0: Math.floor(diff / 60) });
  if (diff < 86400) return t("{v0} 小时前", { v0: Math.floor(diff / 3600) });
  return t("{v0} 天前", { v0: Math.floor(diff / 86400) });
}

function shortCwd(cwd, home) {
  if (!cwd) return t("(未知目录)");
  if (home && (cwd === home || cwd.startsWith(home + "/")))
    return "~" + cwd.slice(home.length);
  return cwd;
}

const baseName = (p) => {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || p || "";
};

function sessionStatus(s, agentName, attention) {
  if (attention) return { cls: "st-attention", label: t("等待确认"), title: t("{v0} 需要你的确认或回答", { v0: agentName }) };
  if (s.state === "working")
    return { cls: "st-work", label: t("工作中"), title: t("{v0} 正在工作", { v0: agentName }) };
  if (s.state === "held") return { cls: "st-held", label: t("挂起"), title: t("已连接，等待输入") };
  if (s.state === "locked-active")
    return {
      cls: "st-run",
      label: t("他端运行"),
      title: t("他端进程 {v0} 正在运行", { v0: s._meta?.["cognition.ai/lockHolderPid"] || "?" }),
    };
  if (s.state === "locked" || (!s.state && s._meta?.["cognition.ai/isLocked"]))
    return {
      cls: "st-lock",
      label: t("他端挂起"),
      title: s._meta?.["cognition.ai/lockHolderPid"]
        ? t("被进程 {v0} 占用（挂起）", { v0: s._meta["cognition.ai/lockHolderPid"] })
        : t("被其他进程占用（挂起）"),
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
  environmentControl,
  collapsedSidebar = false,
  onToggleSidebar,
  sessions,
  loading = false,
  activeId,
  activeWorkspace,
  home,
  wsUp,
  drawerOpen,
  onCloseDrawer,
  onNewSession,
  onOpenSession,
  onSearchOpen,
  onOpenSessionSplit,
  onDeleteSession,
  onDeleteSessions,
  onRenameSession,
  onReleaseSession,
  onExportSession,
  onPickWorkspace,
  onFocusWorkspace,
  onOpenWorkspace,
  onPinSession,
  onArchiveSession,
  unreadIds,
  attentionIds,
  agentsById,
  usageAgent,
  usageProvider,
  onPickAgent,
  creating,
  notifyEnabled,
  onToggleNotify,
  onOpenQuick,
  onToggleQuick,
  quickDot,
  quickSessionId,
  localAgents,
}) {
  const env = useEnvironment();
  const { copy } = useCopyText();
  const { storageKey } = env;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey("devin-web.collapsed")) || "{}");
    } catch {
      return {};
    }
  });
  const drawerRef = useRef(null);
  const previousCollapsed = useRef(collapsedSidebar);
  const [animating, setAnimating] = useState(false);
  useLayoutEffect(() => {
    if (previousCollapsed.current === collapsedSidebar) return;
    previousCollapsed.current = collapsedSidebar;
    const reduced = document.documentElement.dataset.motion === "off" || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduced) { setAnimating(false); return; }
    setAnimating(true);
    const timer = setTimeout(() => setAnimating(false), 220);
    return () => clearTimeout(timer);
  }, [collapsedSidebar]);
  useLayer({ open: !!drawerOpen, ref: drawerRef, onClose: onCloseDrawer, modal: true, initialFocus: ".sidebar-head button" });
  const [menu, setMenu] = useState(null);
  const [query, setQuery] = useState("");
  const [contentSearch, setContentSearch] = useState({ status: "idle", results: [], truncated: false, error: null });
  const searchSeq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { searchSeq.current++; setContentSearch({ status: "idle", results: [], truncated: false, error: null }); return; }
    const seq = ++searchSeq.current;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setContentSearch((prev) => ({ ...prev, status: "loading", error: null }));
      env.api.get(`/api/sessions/search?q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((r) => { if (seq === searchSeq.current) setContentSearch({ status: "done", results: r.results || [], truncated: !!r.truncated, error: null }); })
        .catch((e) => { if (seq === searchSeq.current && e.name !== "AbortError") setContentSearch({ status: "done", results: [], truncated: false,
          error: e.status === 404 ? t("该环境的远端组件版本较旧，不支持内容搜索（需更新组件）") : e.message }); });
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, env]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [statusFilters, setStatusFilters] = useState(() => new Set());
  const filterRef = useRef(null), filterTrigger = useRef(null);
  useLayer({ open: filterOpen, ref: filterRef, triggerRef: filterTrigger, onClose: () => setFilterOpen(false), initialFocus: "input" });
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

  const toggle = (cwd, defaultCollapsed = false) =>
    setCollapsed((c) => {
      const cur = defaultCollapsed ? c[cwd] !== false : !!c[cwd];
      const n = { ...c, [cwd]: !cur };
      localStorage.setItem(storageKey("devin-web.collapsed"), JSON.stringify(n));
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
    () => localStorage.getItem(storageKey("devin-web.showArchived")) === "1"
  );
  const archivedCount = useMemo(
    () => sessions.reduce((n, s) => n + (s.archived ? 1 : 0), 0),
    [sessions]
  );

  const changeArchived = (value) => {
    localStorage.setItem(storageKey("devin-web.showArchived"), value ? "1" : "0");
    setShowArchived(value);
  };
  const resetFilters = () => { setStatusFilters(new Set()); changeArchived(false); };
  const filterOptions = [{ id: "running", label: t("运行中") }, { id: "attention", label: t("待确认") }, { id: "unread", label: t("未读") }];
  const filterSummary = [...filterOptions.filter((option) => statusFilters.has(option.id)).map((option) => option.label), ...(showArchived ? [t("含归档")] : [])].join(" / ");

  const groups = useMemo(() => {
    const m = new Map();
    const scratchList = [];
    for (const s of sessions) {
      if (s.archived && !showArchived) continue;
      if (statusFilters.size && !(
        (statusFilters.has("running") && ["working", "locked-active"].includes(s.state)) ||
        (statusFilters.has("attention") && attentionIds?.has(s.sessionId)) ||
        (statusFilters.has("unread") && s.sessionId !== activeId && unreadIds?.has(s.sessionId))
      )) continue;
      if (s.scratch) { scratchList.push(s); continue; }
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
    // All scratch sessions share one synthetic group — always last.
    if (scratchList.length) {
      scratchList.sort(sessCmp);
      groups.push({ cwd: "__scratch__", sessions: scratchList, scratch: true,
        latest: scratchList[0]?.updatedAt || "", bestRank: 4 });
    }
    return groups;
  }, [sessions, sortBy, showArchived, statusFilters, attentionIds, unreadIds, activeId]);

  // Scratch group is collapsed by default; other groups default open.
  const groupCollapsed = (g) => (g.scratch ? collapsed[g.cwd] !== false : !!collapsed[g.cwd]);

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
          label: t("打开会话"),
          icon: MessageSquare,
          onClick: () => {
            onFocusWorkspace(cwd);
            onOpenSession(s);
          },
        },
        ...(window.innerWidth <= 768 || !onOpenSessionSplit ? [] : [
          { label: t("在右侧拆分打开"), icon: Columns2, onClick: () => onOpenSessionSplit(s, cwd, "row") },
          { label: t("在下方拆分打开"), icon: Rows2, onClick: () => onOpenSessionSplit(s, cwd, "column") },
        ]),
        { label: t("批量选择"), icon: CheckSquare, onClick: () => enterSelect(s.sessionId) },
        {
          label: s.pinned ? t("取消置顶") : t("置顶会话"),
          icon: s.pinned ? PinOff : Pin,
          onClick: () => onPinSession?.(s.sessionId, !s.pinned),
        },
        {
          label: s.archived ? t("取消归档") : t("归档会话"),
          icon: s.archived ? ArchiveRestore : Archive,
          onClick: () => onArchiveSession?.(s.sessionId, !s.archived),
        },
        { label: t("重命名"), icon: Pencil, onClick: () => setRenaming(s.sessionId) },
        { label: t("复制会话 ID"), icon: Copy, onClick: () => copy(s.sessionId) },
        { label: t("导出为 Markdown"), icon: Download, onClick: () => onExportSession?.(s.sessionId) },
        { label: t("导出为 JSON"), icon: FileJson, onClick: () => onExportSession?.(s.sessionId, "json") },
        ...(s.state === "held" || s.state === "working"
          ? [
              {
                label: t("释放占用（允许其他进程打开）"),
                icon: Unplug,
                onClick: () => onReleaseSession?.(s.sessionId),
              },
            ]
          : []),
        { sep: true },
        {
          label: t("删除会话"),
          icon: Trash2,
          danger: true,
          onClick: () => setConfirmDel(s),
        },
      ],
    });
  };

  const creationItems = (cwd) => {
    const agents = [...(agentsById?.values() || [])];
    return (agents.length ? agents : [null]).map((agent) => ({
      label: agents.length > 1 ? t("新建 {v0} 会话", { v0: agent.name }) : t("在此目录新建会话"),
      icon: Plus,
      onClick: () => {
        if (creating) return;
        if (agent) onPickAgent?.(agent.id);
        onNewSession(cwd, agent?.id);
      },
    }));
  };

  const newAtWorkspace = (e, cwd) => {
    e.stopPropagation();
    if (creating) return;
    const items = creationItems(cwd);
    if (items.length === 1) return items[0].onClick();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: Math.max(8, rect.right - 200), y: rect.bottom + 4, items });
  };

  const groupMenu = (e, g) => {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(g.scratch ? [] : creationItems(g.cwd)),
        {
          label: collapsed[g.cwd] ? t("展开") : t("折叠"),
          icon: collapsed[g.cwd] ? ChevronsUpDown : ChevronsDownUp,
          onClick: () => toggle(g.cwd, !!g.scratch),
        },
        ...(g.scratch ? [] : [{ label: t("复制路径"), icon: Copy, onClick: () => copy(g.cwd) }]),
        { sep: true },
        {
          label: showArchived ? t("隐藏已归档会话") : t("显示已归档会话 ({v0})", { v0: archivedCount }),
          icon: showArchived ? Archive : ArchiveRestore,
          onClick: () => changeArchived(!showArchived),
        },
      ],
    });
  };

  const toggleSidebar = () => {
    const previousFocus = document.activeElement;
    onToggleSidebar?.();
    requestAnimationFrame(() => {
      if (document.activeElement !== previousFocus && document.activeElement !== document.body) return;
      drawerRef.current?.querySelector(collapsedSidebar ? ".sb-collapse" : ".sb-expand")?.focus({ preventScroll: true });
    });
  };
  return (
    <aside ref={drawerRef} role={drawerOpen ? "dialog" : undefined} aria-modal={drawerOpen || undefined} aria-label={t("会话与工作区")}
      className={"sidebar" + (drawerOpen ? " open" : "") + (collapsedSidebar ? " sidebar-collapsed" : "") + (animating ? " sidebar-animating" : "")}
      style={{ "--sb-w": width + "px" }}
    >
      <div className="sb-rail">
        <button type="button" className="icon-ghost sb-expand" title={t("展开侧栏")} aria-label={t("展开侧栏")} onClick={toggleSidebar}><PanelLeftOpen size={18} /></button>
        <button type="button" className="icon-ghost" title={t("会话列表")} aria-label={t("展开会话列表")} onClick={toggleSidebar}><MessageSquare size={18} /></button>
        <button type="button" className="icon-ghost" title={t("新建会话")} aria-label={t("新建会话")} disabled={!!creating} onClick={() => onNewSession(activeWorkspace)}><Plus size={18} /></button>
        <button type="button" className="icon-ghost" title={t("选择目录")} aria-label={t("选择目录")} onClick={onPickWorkspace}><FolderPlus size={18} /></button>
      </div>
      <div className="sidebar-head">
        <span className="logo">
          <span className="logo-mark">
            <Sparkles size={15} />
          </span>
          Agent Web
        </span>
        {onToggleSidebar && <button type="button" className="icon-ghost sb-collapse" title={t("收起侧栏")} aria-label={t("收起侧栏")} onClick={toggleSidebar}><PanelLeftClose size={17} /></button>}
        <button className="icon-ghost" title={t("选择目录")} onClick={onPickWorkspace}>
          <FolderPlus size={17} />
        </button>
      </div>

      <div className="sb-tools">
        <div className="sb-search">
          <Search size={14} />
          <input
            placeholder={t("搜索会话…")}
            aria-label={t("搜索会话或工作区")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sb-filters">
          <button type="button" ref={filterTrigger} className={"icon-ghost" + (filterSummary ? " on" : "")} title={filterSummary ? t("筛选：{v0}", { v0: filterSummary }) : t("筛选会话")} aria-label={t("筛选会话")} aria-expanded={filterOpen} onClick={() => setFilterOpen((open) => !open)}><Filter size={15} /></button>
          {filterOpen && <div ref={filterRef} className="sb-filter-panel" role="group" aria-label={t("会话筛选")}>
            <strong>{t("会话状态")}</strong>
            <p>{t("多选匹配任一状态；不选则显示全部状态。")}</p>
            {filterOptions.map((option) => <label key={option.id}><input type="checkbox" checked={statusFilters.has(option.id)} onChange={(event) => {
              const checked = event.target.checked;
              setStatusFilters((previous) => { const next = new Set(previous); if (checked) next.add(option.id); else next.delete(option.id); return next; });
            }} />{option.label}</label>)}
            <label className="archive-filter"><input type="checkbox" checked={showArchived} onChange={(event) => changeArchived(event.target.checked)} />{t("显示已归档（{v0}）", { v0: archivedCount })}</label>
            <button type="button" className="secondary" disabled={!filterSummary} onClick={resetFilters}>{t("清除筛选")}</button>
          </div>}
        </div>
        <button type="button" className={"icon-ghost" + (selectMode ? " on" : "")} title={t("更多列表操作")} aria-label={t("更多列表操作")} aria-haspopup="menu" onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.right - 224, y: rect.bottom + 4, items: [
            { label: selectMode ? t("退出批量选择") : t("批量选择"), icon: CheckSquare, onClick: () => selectMode ? exitSelect() : enterSelect() },
            { label: t("排序方式"), icon: ArrowUpDown, children: [
              ["recent", t("最近活跃")], ["state", t("状态优先")], ["name", t("按名称")], ["created", t("按创建时间")],
            ].map(([value, label]) => ({ label, checked: sortBy === value, onClick: () => {
              localStorage.setItem("devin-web.sort", value); setSortBy(value);
            } })) },
          ] });
        }}><MoreHorizontal size={17} /></button>
      </div>

      {onToggleQuick && (
        <button type="button" className={"sb-quick" + (quickDot ? " dot-" + quickDot : "")} onClick={onToggleQuick}
          title={t("快速对话")} aria-label={t("快速对话")}>
          <MessageSquareDashed size={15} /><span className="sb-quick-label">{t("快速对话")}</span>
          {quickDot && <i className="quick-dot" aria-hidden="true" />}
        </button>
      )}
      {filterSummary && <div className="sb-filter-summary" role="status"><span>{t("{v0} · {v1} 个会话", { v0: filterSummary, v1: visibleIds.length })}</span><button type="button" className="icon-ghost" aria-label={t("清除会话筛选")} onClick={resetFilters}><X size={13} /></button></div>}
      <div className="session-list" aria-busy={loading}>
        {loading && sessions.length === 0 && <div className="sessions-skeleton" role="status" aria-label={t("正在加载会话列表")}>
          <div className="sessions-loading-label"><Loader2 size={13} className="spin" />{t("正在加载会话…")}</div>
          {Array.from({ length: 6 }, (_, i) => <div className="session-skeleton" key={i} aria-hidden="true" style={{ "--row": i }}>
            <span className="skeleton-dot" /><span className="skeleton-lines"><i /><i /></span>
          </div>)}
        </div>}
        {query.trim().length >= 2 && contentSearch.status !== "idle" && <div className="content-matches">
          <h3>{t("内容匹配")}{contentSearch.status === "loading" && <Loader2 size={12} className="spin" />}</h3>
          {contentSearch.error && <div className="dim pad">{contentSearch.error}</div>}
          {contentSearch.results.map((r) => {
            const inTitle = filtered.some((g) => g.sessions.some((x) => x.sessionId === r.sessionId));
            return <button key={r.sessionId} type="button" className={"session-row content-hit" + (inTitle ? " title-also" : "")} onClick={() => onSearchOpen?.(r, query.trim())}>
              <div className="sr-top">{r.title || r.sessionId}<span className="agent-tag">{r.agent}</span></div>
              <div className="sr-snippet">{r.snippet.slice(0, r.matchStart)}<mark>{r.snippet.slice(r.matchStart, r.matchEnd)}</mark>{r.snippet.slice(r.matchEnd)}</div>
              <div className="sr-meta"><span>{r.countCapped ? `${r.count}+ ${t("处")}` : t("{v0} 处", { v0: r.count })}</span></div>
            </button>;
          })}
          {contentSearch.status === "done" && !contentSearch.error && contentSearch.results.length === 0 && <div className="dim pad">{t("无内容匹配")}</div>}
          {contentSearch.truncated && <div className="dim pad">{t("结果已截断（时间预算内仅搜索了部分会话）")}</div>}
        </div>}
        {(!loading || sessions.length > 0) && filtered.length === 0 && <div className="dim pad">{query ? t("无匹配会话") : filterSummary ? t("暂无符合筛选条件的会话") : t("暂无会话")}</div>}
        {filtered.map((g) => (
          <div
            key={g.cwd}
            className={
              "ws-group" + (!g.scratch && g.cwd === activeWorkspace ? " current" : "") + (groupCollapsed(g) ? "" : " open") + (g.scratch ? " scratch" : "")
            }
          >
            <div
              className="ws-head"
              title={g.scratch ? t("临时对话") : g.cwd}
              onContextMenu={(e) => groupMenu(e, g)}
            >
              {selectMode && (
                <input
                  type="checkbox"
                  className="sr-check"
                  aria-label={t("选择 {v0} 下的会话", { v0: g.cwd })}
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
              <button type="button" className="ws-chev" aria-label={g.scratch ? t("{v0}临时对话", { v0: groupCollapsed(g) ? t("展开") : t("折叠") }) : t("{v0}工作区 {v1}", { v0: groupCollapsed(g) ? t("展开") : t("折叠"), v1: g.cwd })} aria-expanded={!groupCollapsed(g)} onClick={() => toggle(g.cwd, !!g.scratch)}><ChevronRight size={13} /></button>
              <button type="button" className="ws-focus" aria-label={g.scratch ? t("临时对话") : t("进入工作区 {v0}", { v0: g.cwd })} aria-current={!g.scratch && g.cwd === activeWorkspace ? "location" : undefined} onClick={() => g.scratch ? toggle(g.cwd, true) : (onOpenWorkspace || onFocusWorkspace)?.(g.cwd)}>
                <span className="ws-ic">{g.scratch ? <MessageSquareDashed size={15} /> : groupCollapsed(g) ? <Folder size={15} /> : <FolderOpen size={15} />}</span>
                <span className="ws-name">{g.scratch ? t("临时对话") : baseName(shortCwd(g.cwd, home)) || g.cwd}</span>
                <span className="cnt">{g.sessions.length}</span>
              </button>
              {!g.scratch && (
                <button
                  className="ws-add"
                  type="button" title={creating ? t("正在创建会话…") : t("在此目录新建会话")}
                  aria-label={t("在 {v0} 新建会话", { v0: g.cwd })} disabled={!!creating}
                  onClick={(e) => newAtWorkspace(e, g.cwd)}
                >
                  <Plus size={13} />
                </button>
              )}
            </div>
            {!groupCollapsed(g) && (
              <div className="ws-body">
                {g.sessions.map((s) => {
                  const unread = unreadIds?.has(s.sessionId) && s.sessionId !== activeId;
                  const attention = attentionIds?.has(s.sessionId);
                  const agentId = s.agent || "devin";
                  const agentName = agentsById?.get(agentId)?.name || s.agent || "Devin";
                  const state = sessionStatus(s, agentName, attention);
                  const st = state || (unread ? { cls: "st-unread", label: t("未读"), title: t("有未读消息") } : null);
                  return (
                    <div
                      key={s.sessionId}
                      className={"session-row" + ((s.sessionId === activeId || s.sessionId === quickSessionId) ? " active" : "") + (unread ? " unread" : "") + (attention ? " attention" : "") + (selectMode && sel.has(s.sessionId) ? " sel" : "")}
                      onClick={() => {
                        if (selectMode) return toggleSel(s.sessionId);
                        if (g.scratch) return onOpenQuick?.(s);
                        onFocusWorkspace(g.cwd);
                        onOpenSession(s);
                      }}
                      onContextMenu={(e) => sessionMenu(e, s, g.cwd)}
                      title={s.title || s.sessionId}
                    >
                      {!selectMode && renaming !== s.sessionId && <button type="button" className="session-open" aria-label={t("打开会话 {v0} · {v1}{v2}", { v0: s.title || s.sessionId, v1: agentName, v2: st ? ` · ${st.label}` : "" })} aria-current={s.sessionId === activeId ? "page" : undefined} />}
                      <div className="sr-top">
                        {selectMode && (
                          <input
                            type="checkbox"
                            className="sr-check"
                            aria-label={t("选择会话 {v0}", { v0: s.title || s.sessionId })}
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
                            {unread && state && !attention && <span className="session-unread-dot" title={t("有未读消息")} />}
                            {s.pinned && <Pin size={11} className="pin-ic" />}
                            {(agentsById?.size || 0) > 1 && (
                              <span className="sb-agent-tag" title={agentName} aria-label={agentName}>
                                {agentId === "devin" ? "de" : agentName}
                              </span>
                            )}
                            {s.title || s.sessionId}
                          </div>
                        )}
                      </div>
                      <div className="sr-meta">
                        {st && <span className={"session-status " + st.cls} title={st.title} role="img" aria-label={st.label}>
                          {attention ? <ShieldAlert size={11} aria-hidden="true" /> : <span className="st-dot" aria-hidden="true" />}
                          <span className="st-label" aria-hidden="true">{st.label}</span>
                        </span>}
                        <span className="sr-time" title={s.updatedAt}>{relTime(s.updatedAt)}</span>
                      </div>
                      <button
                        className="sr-more"
                        title={t("更多操作")}
                        aria-label={t("会话 {v0} 的更多操作", { v0: s.title || s.sessionId })}
                        aria-haspopup="menu"
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
          <span className="sel-n">{t("已选 {v0}", { v0: sel.size })}</span>
          <button
            className="sel-btn"
            onClick={() => setSel(new Set(visibleIds))}
          >
            {t("全选")}
          </button>
          <button className="sel-btn" onClick={() => setSel(new Set())}>
            {t("清空")}
          </button>
          <span className="sel-sp" />
          <button
            className="sel-btn danger"
            disabled={!sel.size}
            onClick={() => setConfirmBatch(true)}
          >
            {t("删除")}
          </button>
          <button className="sel-btn" title={t("退出批量选择")} onClick={exitSelect}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="sb-foot">
        {environmentControl || <span className="sb-conn"><span className={"conn" + (wsUp ? " up" : "")} /><span>{wsUp ? t("已连接") : t("连接断开")}</span></span>}
        <AccountUsage agent={usageAgent} provider={usageProvider} />
        {onToggleNotify && (
          <button
            className={"icon-ghost" + (notifyEnabled ? " on" : "")}
            title={notifyEnabled ? t("关闭完成通知") : t("任务完成时通知我")}
            onClick={onToggleNotify}
          >
            {notifyEnabled ? <Bell size={15} /> : <BellOff size={15} />}
          </button>
        )}
        <SettingsMenu agents={localAgents} />
        <ThemeMenu />
      </div>

      <div className="sb-resize" onMouseDown={startResize} title={t("拖拽调整宽度")} />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {confirmDel && (
        <ConfirmDialog
          title={t("删除会话")}
          message={t("确定删除会话「{v0}」吗？此操作不可撤销。", { v0: confirmDel.title || confirmDel.sessionId })}
          confirmLabel={t("删除")}
          onConfirm={async ({ onProgress } = {}) => {
            await onDeleteSession(confirmDel.sessionId, { onProgress: () => onProgress?.(t("核对结果…")) });
            setConfirmDel(null);
          }}
          onCancel={() => setConfirmDel(null)}
        />
      )}
      {confirmBatch && (
        <ConfirmDialog
          title={t("批量删除会话")}
          message={t("确定删除选中的 {v0} 个会话吗？此操作不可撤销。", { v0: sel.size })}
          confirmLabel={t("删除 {v0} 个", { v0: sel.size })}
          onConfirm={async ({ onProgress } = {}) => {
            await onDeleteSessions?.([...sel], { onProgress: () => onProgress?.(t("核对结果…")) });
            exitSelect();
          }}
          onCancel={() => setConfirmBatch(false)}
        />
      )}
    </aside>
  );
}
