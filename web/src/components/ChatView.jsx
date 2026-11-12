import React, { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AgentMarkdown, FilePreviewContext, ImgSessionCtx } from "./Markdown.jsx";
import useCopyText from "../hooks/useCopyText.js";
import {
  Sparkles,
  TerminalSquare,
  Brain,
  ChevronRight,
  Loader2,
  Lock,
  ShieldAlert,
  RotateCw,
  FolderOpen,
  Copy,
  Check,
  Menu,
  Download,
  Rows3,
  MoreHorizontal,
  Command,
  ArrowDown,
  GitFork,
  GitBranch,
  Activity,
  Pencil,
  FileDiff,
  Search,
  ChevronUp,
  ChevronDown,
  X,
} from "lucide-react";
import ToolCall, { PlanBox, ToolGroup, ThoughtBlock, compactThoughtText } from "./ToolCall.jsx";
import PermissionPrompt from "./PermissionPrompt.jsx";
import ElicitationCard from "./ElicitationCard.jsx";
import InputBar from "./InputBar.jsx";
import SessionTree from "./SessionTree.jsx";
import ProcessesPanel from "./ProcessesPanel.jsx";
import UsagePop from "./UsagePop.jsx";
import ConfigMenu from "./ConfigMenu.jsx";
import ContextMenu from "./ContextMenu.jsx";
import NiceSelect from "./NiceSelect.jsx";
import { getView, setView, VIEWS } from "../theme.js";
import { useEnvironment } from "../environmentContext.js";
import { getUi } from "../ui.js";
import { activeBlockKeys } from "../sessionReducer.js";
import StreamBlock from "./StreamBlock.jsx";
import Disclosure from "./Disclosure.jsx";
import TodoNotice from "./TodoNotice.jsx";
import { TranscriptSearch, transcriptHits, highlightMatch, revealMatch } from "../transcriptSearch.js";
import { captureTranscriptAnchor, restoreTranscriptAnchor } from "../transcriptScroll.js";

import { useLayer, layerBlocks } from "../layers.js";
import { liveTpsAt } from "../turnTelemetry.js";
import { t } from "../i18n.js";

const LazyFilePreview = React.lazy(() => import("./FilePreview.jsx"));
const inactiveKeys = new Set(); // Read-only projection shared by inactive groups.

// SDK telemetry is measured at the source; ACP-only backends use event-delta
// estimates. Never rescan accumulated history or count tool execution as output.
function useLiveTps(session, sessionId) {
  const [rate, setRate] = useState(null);
  const measurement = useRef(null);
  const live = session.telemetry ? session.telemetry.live : session.streamRate?.live;
  const enabled = !!(session.running && live);
  useLayoutEffect(() => {
    measurement.current = { live, received: performance.now() };
  }, [live, sessionId, session.gen]);
  useEffect(() => {
    if (!enabled) { setRate(null); return; }
    const update = () => {
      const { live: latest, received } = measurement.current;
      const value = liveTpsAt(latest, performance.now() - received);
      setRate((previous) => {
        if (!value) return null;
        if (previous?.sessionId === sessionId && previous.gen === session.gen &&
            previous.tps === value.tps && previous.stale === value.stale) return previous;
        return { ...value, sessionId, gen: session.gen };
      });
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [enabled, sessionId, session.gen]);
  if (!enabled) return null;
  // Keep the mounted readout between snapshots; only the display clock changes
  // its digits. Tool/TTFT status remains immediate, and new contexts never reuse
  // another session/generation's rate. No smoothing changes the measurement.
  if (live.stale) return live;
  return rate?.sessionId === sessionId && rate.gen === session.gen ? { ...rate, stale: false } : liveTpsAt(live);
}

// The readout updates four times a second while running; keeping it inside
// its own component confines those renders to this span.
function LiveTps({ session, sessionId }) {
  const tps = useLiveTps(session, sessionId);
  return tps != null && (
    <span className={"tps" + (tps.stale ? " stale" : "")} title={tps.stale ? t("上次模型输出速率（等待或工具执行中）") : t("最近 2 秒的输出估算，含思考和工具参数；完成后按真实用量校准")}> ~<span className="tps-value">{tps.tps.toFixed(1)}</span> tok/s</span>
  );
}

const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtHM = (t) => new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
const fmtTok = (n) => (n == null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function shortCwd(cwd, home) {
  if (!cwd) return "";
  if (home && (cwd === home || cwd.startsWith(home + "/")))
    return "~" + cwd.slice(home.length);
  return cwd;
}

function PathChip({ cwd, home }) {
  const { copied, copy } = useCopyText();
  if (!cwd) return null;
  return (
    <button
      className="path-chip"
      title={t("{v0}（点击复制）", { v0: cwd })}
      onClick={() => copy(cwd)}
    >
      {copied === cwd ? <Check size={12} /> : <FolderOpen size={12} />}
      <span className="pc-path">{shortCwd(cwd, home)}</span>
    </button>
  );
}

// Memoized at the item level — applyUpdate only replaces the object refs it
// actually changes, so an unchanged ref means "skip the markdown re-render".
const MemoToolCall = React.memo(ToolCall);
// A toolgroup's items array is rebuilt immutably when the run grows — an
// element-wise compare lets unchanged groups skip re-rendering.
const MemoToolGroup = React.memo(ToolGroup, (a, b) =>
  a.items.length === b.items.length && a.items.every((x, i) => x === b.items[i]));
const MemoPlanBox = React.memo(PlanBox);

/** Per-turn summary of files touched by edit/delete/move tool calls. */
function FilesTouchedChip({ paths }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="files-touched">
      <button className="ft-chip" onClick={() => setOpen((o) => !o)}>
        <FileDiff size={13} />
        {t("本轮变更 {v0} 个文件", { v0: paths.length })}
        <ChevronRight size={12} className={"ft-chev" + (open ? " open" : "")} />
      </button>
      {open && (
        <div className="ft-list">
          {paths.map((p) => (
            <div key={p} className="ft-path" title={p}>
              {p}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CompactionNode({ item }) {
  const [open, setOpen] = useState(false);
  const search = React.useContext(TranscriptSearch), forced = search.keys.has(item.key);
  const branch = item.kind === "branchSummary";
  const status = branch ? t("分支摘要") : ({ running: t("正在压缩上下文"), completed: t("上下文已压缩"), failed: t("上下文压缩失败"), cancelled: t("上下文压缩已取消") })[item.status] || t("上下文压缩");
  const tokens = (value) => Number.isFinite(value) ? value.toLocaleString() : null;
  return <details className={`compaction-node ${item.status}`} data-search-key={item.key} open={open || forced} onToggle={(e) => { if (!forced) setOpen(e.currentTarget.open); }}>
    <summary><span>{status}</span>
      {Number.isFinite(item.at) && <time dateTime={new Date(item.at).toISOString()} title={new Date(item.at).toLocaleString()}>{fmtHM(item.at)}</time>}
      {tokens(item.tokensBefore) && <small>{tokens(item.tokensBefore)}{tokens(item.estimatedTokensAfter) ? ` → ≈${tokens(item.estimatedTokensAfter)}` : ""} tokens</small>}
      <ChevronDown size={12} />
    </summary>
    <div className="compaction-details">
      <div className="compaction-info">{branch ? t("携带离开分支的摘要；原始分支仍可在会话树中打开。") : ({ manual: t("手动压缩"), threshold: t("接近上下文上限，自动压缩"), overflow: t("上下文溢出恢复"), length: t("输出长度恢复") })[item.reason] || t("历史压缩记录")}
        {Number.isFinite(item.startedAt) && Number.isFinite(item.finishedAt) && t(" · {v0} 秒", { v0: ((item.finishedAt - item.startedAt) / 1000).toFixed(1) })}
        {item.firstKeptEntryId && <span title={t("压缩后保留上下文的起始记录")}> · {t("保留边界 {v0}", { v0: item.firstKeptEntryId })}</span>}
      </div>
      {item.error && <p role="alert">{item.error}</p>}
      {item.summary ? <div className="agent-body"><AgentMarkdown text={item.summary} /></div> : <p className="dim">{item.status === "running" ? t("正在生成摘要，原始聊天历史保留。") : t("此记录没有可用摘要。")}</p>}
    </div>
  </details>;
}

function DeliveryStatus({ delivery, wsUp, onRetry, onRestore }) {
  const error = ["failed", "uncertain"].includes(delivery.phase);
  const label = ({ sending: t("发送中"), receiving: t("确认中"), accepted: t("已接收"), queued: t("已排队"), failed: delivery.accepted ? t("执行失败") : t("发送失败"), uncertain: t("待确认") })[delivery.phase] || delivery.phase;
  return <span className={`delivery-notice ${delivery.phase}`} data-delivery-id={delivery.id} role={error ? "alert" : "status"}>
    <span className="delivery-state" title={t("发送回执，不代表已读")}>{label}</span>
    {error && <>
      <button disabled={!wsUp} onClick={() => onRetry?.(delivery)}>{delivery.phase === "failed" ? t("重试") : t("核对并重试")}</button>
      <button onClick={() => onRestore?.(delivery)}>{t("恢复编辑")}</button>
      <span className="delivery-error" title={delivery.error}>{delivery.error}{delivery.phase === "uncertain" ? t(" · 请核对后再发送") : ""}</span>
    </>}
  </span>;
}

function MessageActions({ text, onEdit, onResend, onFork, forkBusy, userIndex, side = false }) {
  const { copied, copy: copyText } = useCopyText();
  const [compact, setCompact] = useState(false), [menu, setMenu] = useState(null);
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (!side || !ref.current) return;
    const root = ref.current, content = root.parentElement, pane = root.closest(".chat") || root.closest(".col");
    const media = window.matchMedia?.("(hover: none), (pointer: coarse), (max-width: 768px)");
    const measure = () => {
      const box = content.getBoundingClientRect(), bounds = pane?.getBoundingClientRect();
      if (!box.width || !bounds) return;
      const count = 1 + !!onEdit + !!onResend + !!(onFork && userIndex != null);
      const narrow = !!media?.matches || box.left - bounds.left < count * 30 + 8;
      setCompact(narrow);
      const bubble = content.querySelector(".msg-bubble")?.getBoundingClientRect() || box;
      root.style.setProperty("--user-actions-top", `${bubble.top - box.top + Math.max(0, Math.min(10, (bubble.height - (media?.matches ? 44 : 28)) / 2))}px`);
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(content); if (pane) observer?.observe(pane);
    media?.addEventListener?.("change", measure);
    window.addEventListener("dw-view", measure);
    return () => { observer?.disconnect(); media?.removeEventListener?.("change", measure); window.removeEventListener("dw-view", measure); };
  }, [side, text, onEdit, onResend, onFork, userIndex]);
  if (!text) return null;
  const copyLabel = copied === text ? t("已复制") : t("复制");
  const copy = () => copyText(text);
  const actions = [
    ...(onEdit ? [{ id: "edit", label: t("编辑后重新发送"), icon: Pencil, onClick: () => onEdit(text) }] : []),
    ...(onResend ? [{ id: "resend", label: t("原样重发"), icon: RotateCw, onClick: () => onResend(text) }] : []),
    { id: "copy", label: copyLabel, icon: copied === text ? Check : Copy, onClick: copy },
    ...(onFork && userIndex != null ? [{ id: "fork", label: t("从此消息分叉出新会话"), icon: GitFork, disabled: forkBusy, onClick: () => onFork(userIndex) }] : []),
  ];
  return <div ref={ref} className={`msg-actions${compact ? " compact" : ""}`} role="group" aria-label={t("消息操作")}>
    {compact ? <button type="button" title={copied === text ? t("已复制") : t("更多消息操作")} aria-label={copied === text ? t("已复制") : t("更多消息操作")}
      aria-haspopup="menu" aria-expanded={!!menu} onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setMenu({ x: rect.left, y: rect.bottom + 4, items: actions });
      }}>{copied === text ? <Check size={14} /> : <MoreHorizontal size={16} />}</button>
      : actions.map(({ id, label, icon: Icon, disabled, onClick }) => <button key={id} type="button" title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon size={14} /></button>)}
    {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
  </div>;
}

/** Keep the complete prompt in the DOM; only its visual preview is clamped. */
function UserMessageText({ text, itemKey, deliveryStatus }) {
  const { query, keys } = useContext(TranscriptSearch);
  const forced = !!query && keys.has(itemKey);
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(() => text.split(/\r\n|\r|\n/, 11).length > 10);
  const ref = useRef(null), id = useId();
  useLayoutEffect(() => {
    const node = ref.current;
    let disposed = false;
    const measure = () => {
      if (disposed || !node.clientWidth) return;
      const lineHeight = parseFloat(window.getComputedStyle(node).lineHeight);
      if (lineHeight > 0) setLong(node.scrollHeight > Math.ceil(lineHeight * 10) + 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (!observer) window.addEventListener("resize", measure);
    document.fonts?.addEventListener?.("loadingdone", measure);
    document.fonts?.ready?.then(measure);
    return () => {
      disposed = true; observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.fonts?.removeEventListener?.("loadingdone", measure);
    };
  }, [text]);
  return <div className="msg-bubble">
    <div ref={ref} id={id} className="user-message-text" data-collapsed={!expanded && !forced}>{text}</div>
    {long && !forced && <button type="button" className="user-message-toggle" aria-controls={id} aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? t("收起全文") : t("展开全文")}</button>}
    {deliveryStatus}
  </div>;
}

const ProcessNotice = React.memo(function ProcessNotice({ item }) {
  return <div className="process-notification" data-search-key={item.key}><Activity size={14} /><span><strong>{item.name || t("后台任务")}</strong> · {item.summary}</span></div>;
});

function ProcessSummary({ item }) {
  const [open, setOpen] = useState(false), bodyId = useId();
  const search = useContext(TranscriptSearch);
  const forced = search.keys.has(item.key) || item.items.some((notice) => search.keys.has(notice.key));
  return <Disclosure className="process-summary" data-search-key={item.key} open={open || forced} instant={forced} summary={
    <summary aria-expanded={open || forced} aria-controls={bodyId} onClick={(event) => { event.preventDefault(); if (!forced) setOpen((value) => !value); }}>
      <Activity size={14} /><span>{t("已完成 {count} 个后台任务", { count: item.items.length })}</span><ChevronRight size={13} className="process-summary-chevron" />
    </summary>}>
    {() => <div id={bodyId} className="process-summary-items">{item.items.map((notice) => <ProcessNotice key={notice.key} item={notice} />)}</div>}
  </Disclosure>;
}

// Wrapper arrays are rebuilt every render; identity of the wrapped items is
// what determines whether the nav actually changed.
const MessageNav = React.memo(function MessageNav({ messages, scrollRef, onCopy }) {
  const navRef = useRef(null);
  const frameRef = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);
  // macOS Dock-style magnification: every tick's length is driven by a
  // gaussian of its distance from the cursor, via the --s CSS var.
  const navMove = (e) => {
    const nav = navRef.current;
    if (!nav || frameRef.current) return;
    const y = e.clientY;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const ticks = nav.children;
      const rects = [];
      for (const tick of ticks) rects.push(tick.getBoundingClientRect());
      for (let i = 0; i < ticks.length; i++) {
        const d = Math.abs(y - (rects[i].top + rects[i].height / 2));
        ticks[i].style.setProperty("--s", Math.exp(-((d / 20) ** 2)).toFixed(3));
      }
    });
  };
  const navReset = () => {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    const nav = navRef.current;
    if (nav) for (const tick of nav.children) tick.style.setProperty("--s", "0");
  };
  return (
    <nav className="msg-nav" aria-label={t("跳转到我的消息")} ref={navRef} onMouseMove={navMove} onMouseLeave={navReset}>
      {messages.map((w) => (
        <div key={w.key} className="mn-tick">
          <button
            className="mn-dot"
            aria-label={t("跳转到该消息")}
            onClick={() =>
              scrollRef.current
                ?.querySelector(`[data-ik="${w.key}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" })
            }
          />
          <div className="mn-preview">
            <div className="mn-text">{w.it.text || t("📷 图片")}</div>
            {w.it.text && (
              <button
                className="mn-copy"
                title={t("复制")}
                onClick={() => onCopy(w.it.text)}
              >
                <Copy size={12} />
              </button>
            )}
          </div>
        </div>
      ))}
    </nav>
  );
}, (a, b) => a.scrollRef === b.scrollRef && a.onCopy === b.onCopy &&
  a.messages.length === b.messages.length && a.messages.every((w, i) => w.it === b.messages[i].it));

const Item = React.memo(function Item({ item, deliveryStatus, userIndex, onFork, forkBusy, onResend, onEdit, autoFold, active, activeKeys, streaming }) {
  const { withToken } = useEnvironment();
  if (autoFold && ["thought", "tool", "toolgroup"].includes(item.kind)) {
    return (
      <StreamBlock item={item} active={active}>
        {item.kind === "toolgroup" ? item.items.map((child) => (
          <Item key={child.key} item={child} autoFold active={activeKeys.has(child.key)} />
        )) : item.kind === "tool" ? <MemoToolCall item={item} bodyOnly /> :
          <div className="thought-body">{compactThoughtText(item.text)}</div>}
      </StreamBlock>
    );
  }
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          <div className="user-message-content">
            {item.images?.length > 0 && (
              <div className="msg-imgs">
                {item.images.map((src, i) => {
                  const size = item.imageSizes?.[src], scale = size ? Math.min(1, 260 / size.width, 140 / size.height) : 1;
                  return <img key={i} src={withToken(src)} alt="" loading={size ? "lazy" : undefined} decoding={size ? "async" : undefined}
                    width={size ? Math.round(size.width * scale) : undefined} height={size ? Math.round(size.height * scale) : undefined} />;
                })}
              </div>
            )}
            {item.text && <UserMessageText text={item.text} itemKey={item.key} deliveryStatus={deliveryStatus} />}
            {!item.text && deliveryStatus}
            <MessageActions side text={item.text} onEdit={onEdit} onResend={onResend} onFork={onFork} forkBusy={forkBusy} userIndex={userIndex} />
          </div>
        </div>
      );
    case "agent":
      return (
        <div className="msg agent">
          <div className="agent-body">
            <AgentMarkdown text={item.text} streaming={streaming} />
          </div>
          <MessageActions text={item.text} />
        </div>
      );
    case "thought":
      return <ThoughtBlock item={item} />;
    case "tool":
      return <MemoToolCall item={item} />;
    case "toolgroup":
      return <MemoToolGroup items={item.items} />;
    case "compaction":
    case "branchSummary":
      return <CompactionNode item={item} />;
    case "processNotification":
      return <ProcessNotice item={item} />;
    case "processgroup":
      return <ProcessSummary item={item} />;
    case "plan":
      return <MemoPlanBox entries={item.entries} />;
    default:
      return null;
  }
});

export default function ChatView({ sessionId, session, focused = true, wsUp, home, searchRequest, onConsumeSearch, onSend, onCancel, onDequeue, onEditQueued, composerInject, onConsumeInject, onEditPrompt, canTree = false, canProcesses = false, treeBusy = false, onNavigateTree, canFork = true, onFork, forkBusy, onConfig, onPermission, onElicitation, onRetry, onRetryPrompt, onRetryDelivery, onRestoreDelivery, onRelease, onOpenDrawer, onExport, onToggleTerminal, terminalOpen, onOpenPalette, environmentName = t("本机"), remote = false, agentName = "Devin" }) {
  const env = useEnvironment();
  const [filePreview, setFilePreview] = useState(null);
  const closeFilePreview = useCallback(() => setFilePreview(null), []);
  const openFilePreview = useCallback((link) => {
    stickRef.current = false;
    readingAnchorRef.current = captureTranscriptAnchor(scrollRef.current);
    setFilePreview({ ...link, environment: env, sessionId,
      ...(link.host !== undefined && link.host !== env.host ? { error: t("文件链接不属于当前主机环境") }
        : link.sessionId && link.sessionId !== sessionId ? { error: t("文件链接不属于当前会话") } : {}),
    });
  }, [env, sessionId]);
  useEffect(() => { setFilePreview(null); }, [env.host, sessionId]);
  // One stable resend action for all rows. An inline callback defeats Item's
  // memo even for assistant rows, reparsing every historical Markdown block.
  const resendText = useCallback((text) => onSend([{ type: "text", text }]), [onSend]);
  const [treeOpen, setTreeOpen] = useState(false), [processesOpen, setProcessesOpen] = useState(false);
  const closeProcesses = useCallback(() => setProcessesOpen(false), []);
  useEffect(() => { setTreeOpen(false); setProcessesOpen(false); }, [env.host, sessionId]);
  const commands = useMemo(() => canTree ? [
    ...(session.commands || []).filter((cmd) => (typeof cmd === "string" ? cmd : cmd.name)?.replace(/^\//, "") !== "tree"),
    { name: "tree", description: t("打开会话分支列表") },
  ] : session.commands, [canTree, session.commands]);
  const historyLoading = session.historyLoading === true && !session.lockError;
  // Whole-pane drop target for attachments; dragenter/dragleave depth keeps
  // the overlay steady while moving across children.
  const dropApi = useRef(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const onDragEnter = (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); }
  };
  const onDragOver = (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); };
  const onDrop = (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const api = dropApi.current;
    if (!api) return;
    if (api.disabled) { api.reject("连接断开"); return; }
    for (const item of e.dataTransfer.items || []) {
      if (item.kind === "file" && item.webkitGetAsEntry?.()?.isDirectory) { api.directory(); return; }
    }
    for (const file of e.dataTransfer.files || []) api.add(file);
  };
  const scrollRef = useRef(null);
  const chatRef = useRef(null);
  const contentRef = useRef(null);
  const [autoFold, setAutoFold] = useState(() => getUi().autoFold);
  useEffect(() => {
    const sync = () => setAutoFold(getUi().autoFold);
    window.addEventListener("dw-ui", sync);
    return () => window.removeEventListener("dw-ui", sync);
  }, []);
  const activeKeys = useMemo(() => autoFold ? activeBlockKeys(session) : new Set(),
    [autoFold, session.items, session.running]);
  // The root stays open between child calls, closing only when the segment
  // gives way to prose/a new prompt, or when the turn stops.
  const liveTailKey = useMemo(() => autoFold && session.running
    ? session.items.findLast((it) => ["user", "agent", "thought", "tool"].includes(it.kind))?.key
    : null, [autoFold, session.items, session.running]);
  // The still-growing agent message re-parses only its tail block; marking a
  // single row keeps every other memoized Item out of each chunk's render.
  const streamingKey = useMemo(() => {
    if (!session.running) return null;
    for (let i = session.items.length - 1; i >= 0; i--) {
      const it = session.items[i];
      if (it.kind === "user") break;
      if (["agent", "thought", "tool"].includes(it.kind)) return it.kind === "agent" ? it.key : null;
    }
    return null;
  }, [session.items, session.running]);
  const [view, setViewState] = useState(getView);
  useEffect(() => {
    const sync = () => setViewState(getView());
    window.addEventListener("dw-view", sync);
    return () => window.removeEventListener("dw-view", sync);
  }, []);
  const pickView = (v) => {
    setView(v);
    setViewState(v);
  };
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const programmaticTopRef = useRef(null);
  const readingAnchorRef = useRef([]);
  const dockRef = useRef(null);
  const [showJump, setShowJump] = useState(false);
  // Image lightbox — transcript-level delegation catches every <img>
  // (markdown bodies, user attachments, tool results) without per-item wiring.
  const [imgView, setImgView] = useState(null);
  const [actionMenu, setActionMenu] = useState(null);
  const [todoHost, setTodoHost] = useState(null);
  const imageRef = useRef(null);
  useLayer({ open: !!imgView, ref: imageRef, onClose: () => setImgView(null), modal: true, initialFocus: ".imgview-close" });
  // Histories arrive atomically. Pin the initial load, but don't pull a reader
  // to the bottom merely because reconnect replays a new generation.
  const genRef = useRef(new Map());
  // Long transcripts mount only the tail — mounting ~2k markdown items at
  // once stalls the click for seconds. Earlier chunks expand on demand.
  const PAGE = 220;
  const [shown, setShown] = useState(PAGE);
  const anchorRef = useRef(null);

  // Fold consecutive tool calls + the agent's thoughts between them into one
  // collapsible group — otherwise every t("思考过程") splits the run apart.
  const groupCache = useRef(new WeakMap());
  const renderItems = useMemo(() => {
    const out = [];
    const inRun = (k) => k === "tool" || k === "thought";
    let successes = null;
    const flushSuccesses = () => { if (successes) { out.push(successes); successes = null; } };
    for (const it of session.items) {
      // Completion notices don't split a thought/tool run. Summarize successes
      // at its end, without crossing prose, user messages or exceptional events.
      if (it.kind === "processNotification" && (it.notificationKind ? it.notificationKind === "success" : it.exitCode === 0)) {
        successes ||= { kind: "processgroup", key: "pg-" + it.key, t: it.t, items: [] };
        successes.items.push(it);
        continue;
      }
      if (!inRun(it.kind)) flushSuccesses();
      const last = out[out.length - 1];
      if (inRun(it.kind)) {
        // This array is private to this projection, never a persisted item or
        // an already-published cached group. Avoid quadratic run copying.
        if (last?.kind === "toolgroup") last.items.push(it);
        // Create the root at the very first child so it doesn't remount when
        // a lone thought becomes a thought + tool run.
        else if (autoFold) out.push({ kind: "toolgroup", key: "tg-" + it.key, items: [it] });
        else if (last && inRun(last.kind))
          out[out.length - 1] = { kind: "toolgroup", key: "tg-" + last.key, items: [last, it] };
        else out.push(it);
      } else out.push(it);
    }
    flushSuccesses();
    // Preserve the original unwrapped thought-only runs when the setting is off.
    const flat = out.flatMap((g) =>
      !autoFold && g.kind === "toolgroup" && !g.items.some((i) => i.kind === "tool") ? g.items : [g]
    ).map((group) => {
      if (group.kind !== "toolgroup" && group.kind !== "processgroup") return group;
      const first = group.items[0], cached = groupCache.current.get(first);
      if (cached?.items.length === group.items.length && group.items.every((item, index) => item === cached.items[index])) return cached;
      groupCache.current.set(first, group);
      return group;
    });
    // Per-turn changed-file summary: collect paths touched by edit-like tool
    // calls and drop a `filesTouched` pseudo item before each user message.
    const EDIT_KINDS = new Set(["edit", "move", "delete"]);
    const withFiles = [];
    let touched = new Set();
    const collect = (t) => {
      if (t.kind === "tool" && EDIT_KINDS.has(t.toolKind))
        for (const l of t.locations || []) if (l.path) touched.add(l.path);
    };
    for (const it of flat) {
      if (it.kind === "user" && touched.size) {
        withFiles.push({ kind: "filesTouched", key: "ft-" + it.key, paths: [...touched] });
        touched = new Set();
      }
      withFiles.push(it);
      if (it.kind === "toolgroup") it.items.forEach(collect);
      else collect(it);
    }
    if (touched.size)
      withFiles.push({ kind: "filesTouched", key: "ft-end", paths: [...touched] });
    // Keep item refs untouched — flags ride a parallel wrapper so memoized
    // Item components still hit when only marking changed.
    let uIdx = -1;
    return withFiles.map((it, i) => ({
      it,
      key: it.key,
      turnStart:
        it.kind !== "user" &&
        it.kind !== "filesTouched" && it.kind !== "compaction" && it.kind !== "branchSummary" &&
        (i === 0 || withFiles[i - 1].kind === "user"),
      userIndex: it.kind === "user" ? ++uIdx : null,
    }));
  }, [session.items, autoFold]);

  // ---------- in-transcript search (Ctrl/Cmd+F) ----------
  const [searchOn, setSearchOn] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const lastSearchReq = useRef(null);
  const [hitNo, setHitNo] = useState(0);
  const [searchJump, setSearchJump] = useState(0);
  const searchBoxRef = useRef(null);

  useEffect(() => {
    setSearchOn(false);
    setSearchQ("");
  }, [sessionId]);

  useEffect(() => {
    if (searchRequest?.q && searchRequest.n !== lastSearchReq.current) {
      lastSearchReq.current = searchRequest.n;
      setSearchQ(searchRequest.q);
      setSearchOn(true);
      onConsumeSearch?.();
    }
  }, [searchRequest]);

  useEffect(() => {
    const onKey = (e) => {
      if (!focused || e.target.closest?.(".terminal-panel") || layerBlocks(chatRef.current)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOn(true);
        setTimeout(() => searchBoxRef.current?.focus(), 0);
      } else if (e.key === "Escape" && searchOn) {
        setSearchOn(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchOn, focused]);

  const hits = useMemo(() => searchOn ? transcriptHits(renderItems, searchQ) : [], [renderItems, searchQ, searchOn]);
  const activeHit = hits[Math.min(hitNo, hits.length - 1)];
  const searchContext = useMemo(() => ({
    query: searchOn ? searchQ.trim() : "",
    keys: new Set(activeHit ? [activeHit.key, activeHit.itemKey] : []),
  }), [searchOn, searchQ, activeHit?.key, activeHit?.itemKey]);

  const jumpToHit = useCallback(
    (n) => {
      if (!hits.length) return;
      const i = ((n % hits.length) + hits.length) % hits.length;
      setHitNo(i);
      setSearchJump((v) => v + 1);
    },
    [hits]
  );

  useEffect(() => {
    if (!activeHit || !searchContext.query) return;
    stickRef.current = false;
    if (renderItems.findIndex((w) => w.key === activeHit.key) < renderItems.length - shown) {
      setShown(renderItems.length);
      return;
    }
    let highlight;
    const frame = requestAnimationFrame(() => {
      const transcript = scrollRef.current;
      const root = transcript?.querySelector(`[data-search-key="${activeHit.itemKey}"]`) ||
        transcript?.querySelector(`[data-ik="${activeHit.key}"]`);
      if (!root) return;
      const body = root.querySelector(".tool-body, .thought-body, .agent-body, .msg-bubble") || root;
      highlight = highlightMatch(body, searchContext.query);
      // A metadata-only hit may be in a visible header instead of its body.
      if (!highlight.range && body !== root) { highlight.clear(); highlight = highlightMatch(root, searchContext.query); }
      revealMatch(highlight.range, transcript, root);
      lastTopRef.current = transcript.scrollTop;
      programmaticTopRef.current = transcript.scrollTop;
      readingAnchorRef.current = captureTranscriptAnchor(transcript);
    });
    return () => { cancelAnimationFrame(frame); highlight?.clear(); };
  }, [activeHit?.key, activeHit?.itemKey, searchContext.query, searchJump, shown, sessionId]);

  useEffect(() => {
    setShown(PAGE);
  }, [sessionId]);

  useLayoutEffect(() => {
    if (session.gen < 0 || genRef.current.get(sessionId) === session.gen) return;
    if (!genRef.current.has(sessionId)) stickRef.current = true;
    genRef.current.set(sessionId, session.gen);
  }, [session.gen, sessionId]);

  // Restore scroll position after an "earlier messages" chunk prepends —
  // keeps the same content under the cursor instead of jumping to top.
  useLayoutEffect(() => {
    const dist = anchorRef.current;
    if (dist == null) return;
    anchorRef.current = null;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight - dist;
      lastTopRef.current = programmaticTopRef.current = el.scrollTop;
    }
  });

  // Content changes, image/font loads, animated folds and pane resizing all
  // share one policy: follow only while pinned, otherwise preserve a text line.
  const reconcileScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !el.clientWidth || !el.clientHeight) return;
    const chat = el.closest(".chat");
    const bounds = chat.getBoundingClientRect();
    const dock = dockRef.current;
    const dockHeight = dock?.getBoundingClientRect().height || 0;
    // Folds resize their content every frame, not the pane/composer. Avoid
    // invalidating unchanged layout variables before reading the text anchor.
    const setMetric = (node, name, value) => {
      if (node && node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value);
    };
    setMetric(dock, "--chat-height", `${bounds.height}px`);
    setMetric(dock, "--chat-top", `${bounds.top}px`);
    setMetric(dock, "--chat-left", `${bounds.left}px`);
    setMetric(dock, "--chat-width", `${bounds.width}px`);
    setMetric(el, "--dock-clearance", `${Math.ceil(dockHeight + 12)}px`);
    if (searchContext.query) return;
    if (stickRef.current) el.scrollTop = el.scrollHeight;
    else if (!restoreTranscriptAnchor(el, readingAnchorRef.current)) readingAnchorRef.current = captureTranscriptAnchor(el);
    lastTopRef.current = programmaticTopRef.current = el.scrollTop;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 400);
  }, [searchContext.query]);

  useLayoutEffect(reconcileScroll, [reconcileScroll, session.items, session.pendingPermissions, session.pendingElicitations, session.running, autoFold, view, focused]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reconcileScroll);
    for (const el of [contentRef.current, scrollRef.current, dockRef.current]) if (el) observer.observe(el);
    const vv = window.visualViewport, workspace = scrollRef.current?.closest(".split-viewport");
    vv?.addEventListener("resize", reconcileScroll);
    workspace?.addEventListener("scroll", reconcileScroll, { passive: true });
    return () => { observer.disconnect(); vv?.removeEventListener("resize", reconcileScroll); workspace?.removeEventListener("scroll", reconcileScroll); };
  }, [reconcileScroll]);

  const prepareRead = (event) => {
    programmaticTopRef.current = null;
    const userToggle = event.target.closest?.(".user-message-toggle");
    const disclosure = userToggle?.closest(".msg-bubble") || event.target.closest?.("summary, .stream-head, .tool-head, .tg-head");
    if (disclosure || (event.type === "wheel" && event.deltaY < 0) ||
        (event.type === "keydown" && ["PageUp", "Home", "ArrowUp"].includes(event.key))) stickRef.current = false;
    if (!stickRef.current) {
      const el = scrollRef.current;
      readingAnchorRef.current = captureTranscriptAnchor(el);
      // The body being folded is about to become inert. Keep the clicked
      // header in place instead of switching mid-animation to a distant row.
      if (disclosure && el?.contains(disclosure)) {
        let offset = disclosure.getBoundingClientRect().top - el.getBoundingClientRect().top;
        // Expanding keeps the preview's first lines still, not the moving
        // bottom button. Collapsing a long, scrolled message reveals its start.
        if (userToggle?.getAttribute("aria-expanded") === "true")
          offset = Math.max(offset, (el.closest(".chat")?.querySelector(".chat-head")?.getBoundingClientRect().height || 56) + 8);
        readingAnchorRef.current.unshift({ node: disclosure, offset });
      }
    }
  };

  const onScroll = (event) => {
    const el = scrollRef.current;
    if (!el || (event && event.target !== el)) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const programmed = programmaticTopRef.current != null && Math.abs(el.scrollTop - programmaticTopRef.current) < 2;
    if (!programmed) {
      const movedUp = el.scrollTop < lastTopRef.current - 2;
      if (dist < 80 && !searchContext.query) stickRef.current = true;
      else if (movedUp) stickRef.current = false;
      if (!stickRef.current) readingAnchorRef.current = captureTranscriptAnchor(el);
    }
    lastTopRef.current = el.scrollTop;
    setShowJump(dist > 400);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    lastTopRef.current = programmaticTopRef.current = el.scrollTop;
    readingAnchorRef.current = [];
    setShowJump(false);
  };

  const selects = useMemo(() => (session.configOptions || []).filter(
    (c) => c.type === "select" && c.options?.length
  ), [session.configOptions]);
  // The session-mode select gets its own visible control — it's used far more
  // often than model/thinking/speed, which live in the overflow menu.
  const [modeSel, otherSels] = useMemo(() => {
    const mode = selects.find((c) => c.id === "mode");
    return [mode, selects.filter((c) => c !== mode)];
  }, [selects]);

  const pendingDeliveries = (session.deliveries || []).filter((d) => !["completed", "cancelled"].includes(d.phase) &&
    !(d.phase === "queued" && session.queue?.some((q) => q.requestId === d.id || q.id === d.queueId)));
  const messageDeliveries = new Map(), linkedDeliveries = new Set();
  for (const delivery of pendingDeliveries) {
    const item = session.items.find((it) => it.kind === "user" && it.deliveryId === delivery.id);
    if (item) { messageDeliveries.set(item.key, delivery); linkedDeliveries.add(delivery.id); }
  }
  const deliveryStatus = (delivery) => delivery ? <DeliveryStatus delivery={delivery} wsUp={wsUp} onRetry={onRetryDelivery} onRestore={onRestoreDelivery} /> : null;
  const hiddenCount = Math.max(0, renderItems.length - shown);
  const visibleItems = hiddenCount ? renderItems.slice(-shown) : renderItems;
  const navMsgs = visibleItems.filter((w) => w.it.kind === "user");
  const loadEarlier = () => {
    const el = scrollRef.current;
    stickRef.current = false;
    readingAnchorRef.current = captureTranscriptAnchor(el);
    // Immediate prepend correction; the text anchor handles later image loads.
    anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setShown((n) => n + PAGE);
  };

  const pct = session.usage?.size && Number.isFinite(session.usage.used)
    ? Math.min(100, Math.round((100 * session.usage.used) / session.usage.size))
    : null;
  const meterColor = pct == null ? null : pct > 90 ? "var(--red)" : pct > 70 ? "var(--amber)" : "var(--accent)";
  const RING_C = 2 * Math.PI * 7;
  const { copy: copyMessage } = useCopyText();
  // Single state key — drives the pill on desktop and the ⋮ button's
  // color/animation on mobile, where the pill folds into the menu button.
  const headState = session.lockError ? "locked"
    : (session.pendingPermissions?.length || session.pendingElicitations?.length) ? "waiting"
    : session.running ? "running" : session.attached ? "idle" : "off";
  // Memoized composer props: unchanged references let the memoized InputBar
  // skip every streaming render that only grew session.items.
  const onOpenTree = useCallback(() => setTreeOpen(true), []);
  const controls = useMemo(() => (
    <>
      {modeSel && (
        <NiceSelect
          options={modeSel.options}
          label={modeSel.name || t("会话模式")}
          value={modeSel.currentValue}
          onChange={(v) => onConfig(modeSel.id, v)}
        />
      )}
      <ConfigMenu selects={otherSels} onConfig={onConfig} />
    </>
  ), [modeSel, otherSels, onConfig]);
  const meter = useMemo(() => (
    (session.usage?.size || session.stats) && (
      <UsagePop
        up
        usage={session.usage}
        hist={session.usageHist}
        byAgent={session.usageByAgent}
        stats={session.stats}
        trigger={
          <>
            <svg className="ctx-ring" width="18" height="18" viewBox="0 0 18 18">
              <circle cx="9" cy="9" r="7" fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
              <circle
                cx="9" cy="9" r="7" fill="none"
                stroke={meterColor} strokeWidth="2.5" strokeLinecap="round"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - (pct ?? 0) / 100)}
                transform="rotate(-90 9 9)"
              />
            </svg>
            <span className="ctx-pct">{pct == null ? t("待更新") : `${session.usage.estimated ? "≈" : ""}${pct}%`}</span>
          </>
        }
      />
    )
  ), [session.usage, session.usageHist, session.usageByAgent, session.stats, meterColor, pct]);

  // Timeline stamps dedupe by minute — a burst of same-minute rows shows
  // the stamp once, not a column of identical labels.
  let prevTlMin = null;

  return (
    <div ref={chatRef} className="chat" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={onDragOver} onDrop={onDrop}>
      {dragging && <div className="chat-drop" aria-hidden="true">{t("松开以添加附件（图片或文本文件）")}</div>}
      <header className="chat-head">
        {onOpenDrawer && (
          <button className="icon-ghost menu-btn" title={t("会话列表")} onClick={onOpenDrawer}>
            <Menu size={18} />
          </button>
        )}
        <div className="chat-title-col">
          <div className="t">{session.title || sessionId}</div>
          <div className="chat-context">
            <span className={"chat-environment" + (remote ? " remote" : "")} title={remote ? t("远程环境：{v0}", { v0: environmentName }) : t("本机环境")}>{remote ? t("远程 · {v0}", { v0: environmentName }) : t("本机")}</span>
            <span className="chat-agent">{agentName}</span>
            <PathChip cwd={session.cwd} home={home} />
          </div>
        </div>
        <div className="chat-state">
          <span className="todo-dock" ref={setTodoHost} />
          {session.lockError ? (
            <span className="state-pill locked">
              <Lock size={12} className="pill-dot" />
              <span className="pill-txt">{t("只读")}</span>
            </span>
          ) : (session.pendingPermissions?.length || session.pendingElicitations?.length) ? (
            <span className="state-pill waiting" title={t("需要你的确认或回答")}>
              <ShieldAlert size={12} className="pill-dot" /><span className="pill-txt">{t("等待确认")}</span>
            </span>
          ) : session.running ? (
            <span className="state-pill running">
              <Loader2 size={12} className="spin pill-dot" />
              <span className="pill-txt">{t("运行中")}</span>
            </span>
          ) : session.attached ? (
            <span className="state-pill idle">
              <span className="pill-dot" />
              <span className="pill-txt">{t("已连接")}</span>
            </span>
          ) : (
            <span className="state-pill off">
              <span className="pill-dot" />
              <span className="pill-txt">{t("未连接")}</span>
            </span>
          )}
          {canProcesses && <button type="button" className="icon-ghost processes-toggle" aria-label={t("后台任务")} aria-haspopup="dialog" aria-expanded={processesOpen}
            title={t("后台任务（{count} 个运行中）", { count: session.processes?.activeCount || 0 })} onClick={() => setProcessesOpen(true)}>
            <Activity size={16} />{!!session.processes?.activeCount && <small>{session.processes.activeCount}</small>}
          </button>}
          {onToggleTerminal && (
            <button className={"icon-ghost" + (terminalOpen ? " on" : "")} title={t("工作区终端 (Ctrl+`)")} data-terminal-toggle="" aria-label={t("切换工作区终端")} aria-expanded={terminalOpen} onClick={onToggleTerminal}>
              <TerminalSquare size={16} />
            </button>
          )}
          <button type="button" className={"icon-ghost chat-more " + headState} title={t("更多会话操作")} aria-label={t("更多会话操作")} aria-haspopup="menu" aria-expanded={!!actionMenu} onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setActionMenu({ x: rect.right - 200, y: rect.bottom + 4, items: [
              { label: t("搜索对话"), icon: Search, onClick: () => { setSearchOn(true); setTimeout(() => searchBoxRef.current?.focus(), 0); } },
              ...(canTree ? [{ label: t("会话树"), icon: GitBranch, onClick: () => setTreeOpen(true) }] : []),
              ...(canProcesses ? [{ label: t("后台任务"), icon: Activity, onClick: () => setProcessesOpen(true) }] : []),
              ...(onOpenPalette ? [{ label: t("命令面板"), icon: Command, onClick: onOpenPalette }] : []),
              ...(onToggleTerminal ? [{ label: t("工作区终端"), icon: TerminalSquare, checked: terminalOpen, onClick: onToggleTerminal }] : []),
              ...(onExport ? [{ label: t("导出为 Markdown"), icon: Download, onClick: onExport }] : []),
              { sep: true },
              { label: t("对话视图"), icon: Rows3, children: VIEWS.map((option) => ({ label: option.name, checked: view === option.value, onClick: () => pickView(option.value) })) },
            ] });
          }}><MoreHorizontal size={18} /></button>
        </div>
      </header>
      {session.todos?.length > 0 && todoHost && <TodoNotice key={sessionId} tasks={session.todos} dockHost={todoHost} running={session.running} />}

      <div
        className="transcript"
        ref={scrollRef}
        onScroll={onScroll}
        onScrollCapture={(e) => {
          if (e.target !== e.currentTarget && !stickRef.current) readingAnchorRef.current = captureTranscriptAnchor(scrollRef.current);
        }}
        onWheel={prepareRead}
        onPointerDown={prepareRead}
        onClickCapture={(event) => { if (event.target.closest?.(".user-message-toggle")) prepareRead(event); }}
        onTouchStart={prepareRead}
        onKeyDown={prepareRead}
        onClick={(e) => {
          const img = e.target.closest?.("img");
          if (img && !img.closest("a")) setImgView(img.src);
        }}
      >
        {searchOn && (
          <div className="ts-search">
            <Search size={13} />
            <input
              ref={searchBoxRef}
              placeholder={t("搜索对话内容…")}
              aria-label={t("搜索对话内容")}
              value={searchQ}
              onChange={(e) => {
                setSearchQ(e.target.value);
                setHitNo(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  jumpToHit(hitNo + (e.shiftKey ? -1 : 1));
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setSearchOn(false);
                }
              }}
            />
            <span className="ts-count">
              {searchQ.trim() ? (hits.length ? `${Math.min(hitNo + 1, hits.length)}/${hits.length}` : "0/0") : ""}
            </span>
            <button onClick={() => jumpToHit(hitNo - 1)} title={t("上一个 (Shift+Enter)")}>
              <ChevronUp size={14} />
            </button>
            <button onClick={() => jumpToHit(hitNo + 1)} title={t("下一个 (Enter)")}>
              <ChevronDown size={14} />
            </button>
            <button onClick={() => setSearchOn(false)} title={t("关闭 (Esc)")}>
              <X size={14} />
            </button>
          </div>
        )}
        {!historyLoading && !session.items.length && !session.running && !session.lockError && session.attached && (
          <div className="empty-hints">
            <div className="eh-title">
              <Sparkles size={14} /> {t("新会话已就绪")}
            </div>
            <div className="eh-chips">
              {[
                t("概览这个项目，告诉我它是做什么的"),
                t("解释代码库的整体架构"),
                t("找一个可以改进的地方并修复"),
                t("为核心模块补充单元测试"),
              ].map((t) => (
                <button key={t} className="eh-chip" onClick={() => onSend([{ type: "text", text: t }])}>
                  {t}
                </button>
              ))}
            </div>
            <div className="eh-tip">{t("输入 / 查看全部命令 · @ 引用文件 · Ctrl+K 打开命令面板 · Ctrl+F 搜索对话")}</div>
          </div>
        )}
        <FilePreviewContext.Provider value={openFilePreview}>
        <TranscriptSearch.Provider value={searchContext}>
        <ImgSessionCtx.Provider value={sessionId}>
        <div ref={contentRef}>
        {historyLoading ? (
          <div className="empty-hint col" role="status">
            <div className="ld-bubble"><span /><span /><span /></div>
            <span className="ld-text">{t("正在加载会话…")}</span>
          </div>
        ) : <>
        {hiddenCount > 0 && (
          <button className="col load-earlier" onClick={loadEarlier}>
            {t("加载更早消息（还有 {v0} 条）", { v0: hiddenCount })}
          </button>
        )}
        {visibleItems.map((w) => (
          <div
            key={w.key}
            data-ik={w.key}
            className={
              "col anim-in" + (activeHit?.key === w.key && searchContext.query ? " search-hit" : "")
            }
          >
            {view === "timeline" && w.it.t != null && (() => {
              const m = fmtHM(w.it.t);
              const show = m !== prevTlMin;
              prevTlMin = m;
              return show ? <span className="tl-time">{m}</span> : null;
            })()}
            {w.turnStart && (
              <div className="turn-head">
                <span className="turn-mark">
                  <Sparkles size={12} />
                </span>
                {agentName}
              </div>
            )}
            {w.it.kind === "filesTouched" ? (
              <FilesTouchedChip paths={w.it.paths} />
            ) : (
            <Item
              item={w.it}
              deliveryStatus={deliveryStatus(messageDeliveries.get(w.it.key))}
              autoFold={autoFold}
              active={w.it.kind === "toolgroup"
                ? w.it.items.some((it) => it.key === liveTailKey)
                : activeKeys.has(w.key)}
              activeKeys={autoFold && w.it.kind === "toolgroup" ? (w.it.items.some((item) => activeKeys.has(item.key)) ? activeKeys : inactiveKeys) : undefined}
              streaming={w.key === streamingKey}
              userIndex={w.userIndex}
              onFork={w.it.kind === "user" && canFork && session.attached && !session.lockError ? onFork : null}
              forkBusy={w.it.kind === "user" ? forkBusy : false}
              onResend={w.it.kind === "user" && session.attached ? resendText : null}
              onEdit={w.it.kind === "user" && session.attached ? onEditPrompt : null}
            />
            )}
            {w.it.failed && w.it._blocks && (
              <button className="msg-retry" onClick={() => onRetryPrompt?.(w.it)}>
                {t("发送失败 · 点击重试")}
              </button>
            )}
          </div>
        ))}
        {pendingDeliveries.filter((d) => !linkedDeliveries.has(d.id)).map((delivery) => (
          <div key={delivery.id} className="delivery-recovery col">
            <span className="delivery-preview" title={delivery.text}>{delivery.text || t("附件消息")}</span>{deliveryStatus(delivery)}
          </div>
        ))}
        {session.queue?.length > 0 && (
          <div className="queue-list col">
            {session.queue.map((q, i) => (
              <div key={q.id} className="queue-chip">
                <span className="qc-pos">{i + 1}</span>
                <span className="qc-text">{q.text || (q.images ? t("📷 {v0} 张图片", { v0: q.images }) : "…")}</span>
                <button className="qc-btn" title={t("撤回编辑")} onClick={() => onEditQueued?.(q)}>
                  {t("编辑")}
                </button>
                <button className="qc-btn qc-x" title={t("从队列移除")} onClick={() => onDequeue?.(q.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {session.running && (
          <div className="running-hint col">
            <Loader2 size={14} className="spin" />
            <span className="shimmer">{t("{v0} 正在工作", { v0: agentName })}</span>
            <LiveTps session={session} sessionId={sessionId} />
          </div>
        )}
        {!session.running && session.lastTurn && (
          <div className="turn-foot col">
            <span>
              {fmtMs(session.lastTurn.totalTimeMs)}
              {session.lastTurn.inputTokens != null && t(" · 输入 {v0}", { v0: fmtTok(session.lastTurn.inputTokens) })}
              {session.lastTurn.outputTokens != null && t(" · 输出 {v0}", { v0: fmtTok(session.lastTurn.outputTokens) })}
              {Number.isFinite(session.lastTurn.tps) && <span className="final-tps" title={t("真实输出 tokens / 模型请求耗时；含首 token 等待，不含工具执行")}> · {session.lastTurn.tps.toFixed(1)} tok/s</span>}
              {session.lastTurn.toolCalls > 0 && t(" · {v0} 次工具调用", { v0: session.lastTurn.toolCalls })}
              {session.lastTurn.filesChanged > 0 && t(" · {v0} 个文件", { v0: session.lastTurn.filesChanged })}
            </span>
          </div>
        )}
        </>}
        </div>
        </ImgSessionCtx.Provider>
        </TranscriptSearch.Provider>
        </FilePreviewContext.Provider>
      </div>
      {!historyLoading && navMsgs.length > 1 && (
        <MessageNav messages={navMsgs} scrollRef={scrollRef} onCopy={copyMessage} />
      )}
      {showJump && (
        <button className="jump-bottom" onClick={jumpToBottom} title={t("回到最新消息")}>
          <ArrowDown size={15} />
        </button>
      )}

      {session.lockError && (
        <div className="lock-notice col">
          <div className="lock-card">
            <Lock size={15} />
            <span className="lock-msg">
              <strong>{t("只读模式")}</strong>
              {session.lockPid ? t("（被进程 {v0} 占用）", { v0: session.lockPid }) : ""} — {session.lockError}
              {session.items.length > 0 && t("（历史记录如下）")}
            </span>
            <button onClick={() => onRetry(sessionId, session.cwd)}>
              <RotateCw size={13} /> {t("重试加载")}
            </button>
          </div>
        </div>
      )}

      <div className="dock" ref={dockRef}>
        <PermissionPrompt pendingPermissions={session.pendingPermissions} onPermission={onPermission} agentName={agentName} wsUp={wsUp} />
        <ElicitationCard pendingElicitations={session.pendingElicitations} onAnswer={onElicitation} agentName={agentName} wsUp={wsUp} />
        <InputBar
        running={session.running}
        disabled={!wsUp || !!session.lockError || treeBusy}
        offline={!wsUp}
        dropRef={dropApi}
        onSend={onSend}
        onCancel={onCancel}
        onPreviewImage={setImgView}
        sessionId={sessionId}
        agentName={agentName}
        inject={composerInject}
        onConsumeInject={onConsumeInject}
        cwd={session.cwd}
        commands={commands}
        onOpenTree={canTree ? onOpenTree : undefined}
        controls={controls}
        meter={meter}
      />
      </div>
      <ContextMenu menu={actionMenu} onClose={() => setActionMenu(null)} />
      {processesOpen && canProcesses && <ProcessesPanel key={`${env.host}:${sessionId}`} sessionId={sessionId} title={session.title}
        environmentName={environmentName} wsUp={wsUp} summary={session.processes} onClose={closeProcesses} />}
      {treeOpen && canTree && <SessionTree key={`${env.host}:${sessionId}`} sessionId={sessionId} session={session}
        wsUp={wsUp} busy={treeBusy} onNavigate={onNavigateTree} onClose={() => setTreeOpen(false)} environmentName={environmentName}
        questions={<><PermissionPrompt pendingPermissions={session.pendingPermissions} onPermission={onPermission} agentName={agentName} wsUp={wsUp} />
          <ElicitationCard pendingElicitations={session.pendingElicitations} onAnswer={onElicitation} agentName={agentName} wsUp={wsUp} /></>} />}
      {filePreview && <React.Suspense fallback={<div className="modal-back"><div className="file-preview-loading" role="status">{t("正在打开预览…")}<button onClick={closeFilePreview}>{t("关闭预览")}</button></div></div>}>
        <LazyFilePreview key={`${filePreview.environment.host}:${filePreview.sessionId}:${filePreview.path}`} source={filePreview} onClose={closeFilePreview} />
      </React.Suspense>}
      {imgView && createPortal(
        <div ref={imageRef} className="imgview" onClick={() => setImgView(null)} role="dialog" aria-modal="true" aria-label={t("图片预览")} tabIndex={-1}>
          <button type="button" className="imgview-close" onClick={() => setImgView(null)} aria-label={t("关闭图片预览")} title={t("关闭图片预览")}><X size={22} /></button>
          <img src={imgView} alt={t("图片预览")} onClick={(e) => e.stopPropagation()} />
        </div>, document.body
      )}
    </div>
  );
}
