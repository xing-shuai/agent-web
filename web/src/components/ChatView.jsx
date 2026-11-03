import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  Sparkles,
  Brain,
  ChevronRight,
  Loader2,
  Lock,
  RotateCw,
  MessageSquare,
  FolderOpen,
  Copy,
  Check,
  Menu,
  Plus,
  Bell,
  BellOff,
  Download,
  Rows3,
  ArrowDown,
} from "lucide-react";
import ToolCall, { PlanBox, ToolGroup } from "./ToolCall.jsx";
import PermissionPrompt from "./PermissionPrompt.jsx";
import InputBar from "./InputBar.jsx";
import FullscreenButton from "./FullscreenButton.jsx";
import UsagePop from "./UsagePop.jsx";
import ConfigMenu from "./ConfigMenu.jsx";
import NiceSelect from "./NiceSelect.jsx";
import { getView, setView, VIEWS } from "../theme.js";
import { withToken } from "../api.js";

const md = [remarkGfm];
const hl = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtTok = (n) => (n == null ? "?" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

function shortCwd(cwd, home) {
  if (!cwd) return "";
  if (home && (cwd === home || cwd.startsWith(home + "/")))
    return "~" + cwd.slice(home.length);
  return cwd;
}

/** Flatten a React node tree to plain text (for the copy button). */
function textContent(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return textContent(node.props?.children);
}

function CodePre({ children }) {
  const [copied, setCopied] = useState(false);
  const codeEl = Array.isArray(children) ? children.find((c) => c?.props) : children;
  const cls = codeEl?.props?.className || "";
  const lang = (cls.match(/language-([\w#+-]+)/) || [])[1] || "code";
  const raw = textContent(codeEl?.props?.children);
  const doCopy = () => {
    navigator.clipboard?.writeText(raw).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="code-card">
      <div className="cc-head">
        <span className="cc-lang">{lang}</span>
        <button className="cc-copy" onClick={doCopy}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

// Session id for markdown image resolution — relative `![](shots/a.png)`
// goes through /api/sessions/<id>/raw against the session cwd.
const ImgSessionCtx = React.createContext(null);

function MdImg({ node, src, alt, ...props }) {
  const sid = React.useContext(ImgSessionCtx);
  const [fallback, setFallback] = useState(false);
  if (!src) return null;
  let u = src;
  if (/^(data:|blob:|https?:)/i.test(u)) {
    // external/embedded — keep as-is
  } else if (u.startsWith("/api/")) {
    u = withToken(u);
  } else if (fallback || !u.startsWith("/")) {
    // Relative path (or web-path fallback): serve the workspace file via the
    // session raw endpoint — the file lives on disk, not in the web bundle.
    u = withToken(`/api/sessions/${sid}/raw?path=${encodeURIComponent(src)}`);
  }
  // A leading "/" src tries the web root first; onError retries as an
  // absolute filesystem path via the raw endpoint.
  return (
    <img
      src={u}
      alt={alt || ""}
      {...props}
      onError={fallback ? undefined : () => setFallback(true)}
    />
  );
}

const mdComponents = {
  pre: CodePre,
  img: MdImg,
  table: ({ node, ...props }) => (
    <div className="tbl-wrap">
      <table {...props} />
    </div>
  ),
};

function PathChip({ cwd, home }) {
  const [copied, setCopied] = useState(false);
  if (!cwd) return null;
  return (
    <button
      className="path-chip"
      title={`${cwd}（点击复制）`}
      onClick={() => {
        navigator.clipboard?.writeText(cwd).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={12} /> : <FolderOpen size={12} />}
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

const Item = React.memo(function Item({ item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          {item.images?.length > 0 && (
            <div className="msg-imgs">
              {item.images.map((src, i) => (
                <img key={i} src={withToken(src)} alt="" />
              ))}
            </div>
          )}
          {item.text && <div className="msg-bubble">{item.text}</div>}
        </div>
      );
    case "agent":
      return (
        <div className="msg agent">
          <div className="agent-body">
            <ReactMarkdown remarkPlugins={md} rehypePlugins={hl} components={mdComponents}>
              {item.text}
            </ReactMarkdown>
          </div>
        </div>
      );
    case "thought":
      return (
        <details className="thought">
          <summary>
            <Brain size={13} />
            思考过程
            <ChevronRight size={13} className="th-chev" />
          </summary>
          <div className="thought-body">{item.text}</div>
        </details>
      );
    case "tool":
      return <MemoToolCall item={item} />;
    case "toolgroup":
      return <MemoToolGroup items={item.items} />;
    case "plan":
      return <MemoPlanBox entries={item.entries} />;
    default:
      return null;
  }
});

export default function ChatView({ sessionId, session, wsUp, home, onSend, onCancel, onConfig, onPermission, onRetry, onRetryPrompt, onRelease, onOpenDrawer, onNewSession, notifyEnabled, onToggleNotify, onExport }) {
  const scrollRef = useRef(null);
  const [view, setViewState] = useState(getView);
  const pickView = (v) => {
    setView(v);
    setViewState(v);
  };
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  // Per-session transcript generation — histories arrive consolidated (one
  // atomic fold), so a gen bump just means "pin to bottom after the swap",
  // not a streaming refill that needs covering.
  const genRef = useRef(new Map());
  // Long transcripts mount only the tail — mounting ~2k markdown items at
  // once stalls the click for seconds. Earlier chunks expand on demand.
  const PAGE = 220;
  const [shown, setShown] = useState(PAGE);
  const anchorRef = useRef(null);

  useEffect(() => {
    setShown(PAGE);
  }, [sessionId]);

  useEffect(() => {
    if (session.gen < 0) return;
    if (genRef.current.get(sessionId) === session.gen) return;
    genRef.current.set(sessionId, session.gen);
    stickRef.current = true;
  }, [session.gen, sessionId]);

  // Restore scroll position after an "earlier messages" chunk prepends —
  // keeps the same content under the cursor instead of jumping to top.
  useLayoutEffect(() => {
    const dist = anchorRef.current;
    if (dist == null) return;
    anchorRef.current = null;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - dist;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [session.items, session.pendingPermissions]);

  // Mobile keyboards resize the visual viewport — re-pin to bottom so the
  // composer doesn't cover the newest messages.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const el = scrollRef.current;
      if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Only a user scrolling up unsticks. During replay, scrollHeight keeps
    // growing after our programmatic scroll — a scroll event then reads
    // "above bottom" without any user intent, so that must not unstick.
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = dist < 80;
    const movedUp = el.scrollTop < lastTopRef.current - 2;
    if (nearBottom) stickRef.current = true;
    else if (movedUp) stickRef.current = false;
    lastTopRef.current = el.scrollTop;
    setShowJump(dist > 400);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTop = el.scrollHeight;
    setShowJump(false);
  };

  const selects = (session.configOptions || []).filter(
    (c) => c.type === "select" && c.options?.length
  );
  // The session-mode select gets its own visible control — it's used far more
  // often than model/thinking/speed, which live in the overflow menu.
  const modeSel = selects.find((c) => c.id === "mode");
  const otherSels = selects.filter((c) => c !== modeSel);

  // Fold consecutive tool calls + the agent's thoughts between them into one
  // collapsible group — otherwise every "思考过程" splits the run apart.
  const renderItems = useMemo(() => {
    const out = [];
    const inRun = (k) => k === "tool" || k === "thought";
    for (const it of session.items) {
      const last = out[out.length - 1];
      if (inRun(it.kind)) {
        if (last?.kind === "toolgroup") last.items = [...last.items, it];
        else if (last && inRun(last.kind))
          out[out.length - 1] = { kind: "toolgroup", key: "tg-" + last.key, items: [last, it] };
        else out.push(it);
      } else out.push(it);
    }
    // A run with no tool calls (only thoughts) renders unwrapped.
    const flat = out.flatMap((g) =>
      g.kind === "toolgroup" && !g.items.some((i) => i.kind === "tool") ? g.items : [g]
    );
    // Mark the first non-user item of each Devin turn for a header row, and
    // flag every item belonging to the latest turn (the spotlight view dims
    // all earlier turns).
    const lastUser = flat.reduce((acc, it, i) => (it.kind === "user" ? i : acc), -1);
    // Keep item refs untouched — flags ride a parallel wrapper so memoized
    // Item components still hit when only marking changed.
    return flat.map((it, i) => ({
      it,
      key: it.key,
      turnStart: it.kind !== "user" && (i === 0 || flat[i - 1].kind === "user"),
      spot: i >= lastUser,
    }));
  }, [session.items]);

  const hiddenCount = Math.max(0, renderItems.length - shown);
  const visibleItems = hiddenCount ? renderItems.slice(-shown) : renderItems;
  const loadEarlier = () => {
    const el = scrollRef.current;
    // Anchor: distance from the bottom edge stays constant across the prepend.
    anchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    setShown((n) => n + PAGE);
  };

  const pct = session.usage?.size
    ? Math.min(100, Math.round((100 * session.usage.used) / session.usage.size))
    : null;
  const meterColor = pct == null ? null : pct > 90 ? "var(--red)" : pct > 70 ? "var(--amber)" : "var(--accent)";
  const RING_C = 2 * Math.PI * 7;

  return (
    <div className="chat">
      <header className="chat-head">
        <button className="icon-ghost menu-btn" title="会话列表" onClick={onOpenDrawer}>
          <Menu size={18} />
        </button>
        <div className="chat-title-col">
          <div className="t">{session.title || sessionId}</div>
          <PathChip cwd={session.cwd} home={home} />
        </div>
        <div className="chat-state">
          <span className="view-sel" title="瀑布流样式">
            <Rows3 size={14} />
            <NiceSelect options={VIEWS} value={view} onChange={pickView} />
          </span>
          {session.lockError ? (
            <span className="state-pill locked">
              <Lock size={12} className="pill-dot" />
              <span className="pill-txt">只读</span>
            </span>
          ) : session.running ? (
            <span className="state-pill running">
              <Loader2 size={12} className="spin pill-dot" />
              <span className="pill-txt">运行中</span>
            </span>
          ) : session.attached ? (
            <span className="state-pill idle">
              <span className="pill-dot" />
              <span className="pill-txt">已连接</span>
            </span>
          ) : (
            <span className="state-pill off">
              <span className="pill-dot" />
              <span className="pill-txt">未连接</span>
            </span>
          )}
          {onToggleNotify && (
            <button
              className={"icon-ghost" + (notifyEnabled ? " on" : "")}
              title={notifyEnabled ? "关闭完成通知" : "任务完成时通知我"}
              onClick={onToggleNotify}
            >
              {notifyEnabled ? <Bell size={15} /> : <BellOff size={15} />}
            </button>
          )}
          {onExport && (
            <button className="icon-ghost" title="导出为 Markdown" onClick={onExport}>
              <Download size={15} />
            </button>
          )}
          <span className="chat-mobile-actions">
            <FullscreenButton size={17} />
            {onNewSession && (
              <button className="icon-ghost" title="新建会话" onClick={() => onNewSession()}>
                <Plus size={18} />
              </button>
            )}
          </span>
        </div>
      </header>

      <div className="transcript" ref={scrollRef} onScroll={onScroll}>
        <ImgSessionCtx.Provider value={sessionId}>
        {hiddenCount > 0 && (
          <button className="col load-earlier" onClick={loadEarlier}>
            加载更早消息（还有 {hiddenCount} 条）
          </button>
        )}
        {session.items.length === 0 && (
          <div className="empty-hint col">
            <MessageSquare size={30} />
            {session.attached ? "会话已就绪，开始对话吧。" : "正在加载会话…"}
          </div>
        )}
        {visibleItems.map((w) => (
          <div key={w.key} className={"col anim-in" + (w.spot ? " spot" : "")}>
            {w.turnStart && (
              <div className="turn-head">
                <span className="turn-mark">
                  <Sparkles size={12} />
                </span>
                Devin
              </div>
            )}
            <Item item={w.it} />
            {w.it.failed && w.it._blocks && (
              <button className="msg-retry" onClick={() => onRetryPrompt?.(w.it)}>
                发送失败 · 点击重试
              </button>
            )}
          </div>
        ))}
        {session.running && (
          <div className="running-hint col">
            <Loader2 size={14} className="spin" />
            <span className="shimmer">Devin 正在工作</span>
          </div>
        )}
        {!session.running && session.lastTurn && (
          <div className="turn-foot col">
            <span>
              {fmtMs(session.lastTurn.totalTimeMs)}
              {session.lastTurn.inputTokens != null && ` · 输入 ${fmtTok(session.lastTurn.inputTokens)}`}
              {session.lastTurn.outputTokens != null && ` · 输出 ${fmtTok(session.lastTurn.outputTokens)}`}
              {session.lastTurn.toolCalls > 0 && ` · ${session.lastTurn.toolCalls} 次工具调用`}
              {session.lastTurn.filesChanged > 0 && ` · ${session.lastTurn.filesChanged} 个文件`}
            </span>
          </div>
        )}
        </ImgSessionCtx.Provider>
      </div>
      {showJump && (
        <button className="jump-bottom" onClick={jumpToBottom} title="回到最新消息">
          <ArrowDown size={15} />
        </button>
      )}

      {session.lockError && (
        <div className="lock-notice col">
          <div className="lock-card">
            <Lock size={15} />
            <span className="lock-msg">
              <strong>只读模式</strong>
              {session.lockPid ? `（被进程 ${session.lockPid} 占用）` : ""} — {session.lockError}
              {session.items.length > 0 && "（历史记录如下）"}
            </span>
            <button onClick={() => onRetry(sessionId, session.cwd)}>
              <RotateCw size={13} /> 重试加载
            </button>
          </div>
        </div>
      )}

      <PermissionPrompt pendingPermissions={session.pendingPermissions} onPermission={onPermission} />
      <InputBar
        running={session.running}
        disabled={!wsUp || !!session.lockError}
        onSend={onSend}
        onCancel={onCancel}
        sessionId={sessionId}
        commands={session.commands}
        controls={
          <>
            {modeSel && (
              <NiceSelect
                options={modeSel.options}
                value={modeSel.currentValue}
                onChange={(v) => onConfig(modeSel.id, v)}
              />
            )}
            <ConfigMenu selects={otherSels} onConfig={onConfig} />
          </>
        }
        meter={
          pct != null && (
            <UsagePop
              up
              usage={session.usage}
              hist={session.usageHist}
              byAgent={session.usageByAgent}
              trigger={
                <>
                  <svg className="ctx-ring" width="18" height="18" viewBox="0 0 18 18">
                    <circle cx="9" cy="9" r="7" fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
                    <circle
                      cx="9" cy="9" r="7" fill="none"
                      stroke={meterColor} strokeWidth="2.5" strokeLinecap="round"
                      strokeDasharray={RING_C}
                      strokeDashoffset={RING_C * (1 - pct / 100)}
                      transform="rotate(-90 9 9)"
                    />
                  </svg>
                  <span className="ctx-pct">{pct}%</span>
                </>
              }
            />
          )
        }
      />
    </div>
  );
}
