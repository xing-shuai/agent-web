import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Download,
  Rows3,
  ArrowDown,
  GitFork,
  Pencil,
  FileDiff,
  Search,
  ChevronUp,
  ChevronDown,
  X,
} from "lucide-react";
import ToolCall, { PlanBox, ToolGroup } from "./ToolCall.jsx";
import PermissionPrompt from "./PermissionPrompt.jsx";
import InputBar from "./InputBar.jsx";
import UsagePop from "./UsagePop.jsx";
import ConfigMenu from "./ConfigMenu.jsx";
import NiceSelect from "./NiceSelect.jsx";
import { getView, setView, VIEWS } from "../theme.js";
import { withToken } from "../api.js";

const md = [remarkGfm];
const hl = [[rehypeHighlight, { detect: false, ignoreMissing: true }]];

// Live generation rate — same heuristic as pi-open-tui's telemetry: estimate
// tokens from streamed text (~4 chars/token latin, ~1/char CJK) over a
// trailing 2s window, sampled from the tail of the transcript.
const CJK_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;
const estTok = (t) => {
  const cjk = (t.match(CJK_RE) || []).length;
  return cjk + (t.length - cjk) / 4;
};

function useLiveTps(items, running) {
  const [tps, setTps] = useState(null);
  const ref = useRef({ items, samples: [] });
  ref.current.items = items;
  useEffect(() => {
    ref.current.samples = [];
    if (!running) {
      setTps(null);
      return;
    }
    const iv = setInterval(() => {
      const its = ref.current.items;
      let tok = 0;
      for (let i = its.length - 1; i >= 0; i--) {
        const it = its[i];
        if (it.kind === "agent" || it.kind === "thought") tok += it.text ? estTok(it.text) : 0;
        else if (it.kind === "user") break;
      }
      const now = performance.now();
      const s = ref.current.samples;
      s.push({ t: now, tok });
      while (s.length > 2 && s[1].t <= now - 2000) s.shift();
      if (s.length >= 2) {
        const v = (s.at(-1).tok - s[0].tok) / ((s.at(-1).t - s[0].t) / 1000);
        setTps(v > 0.5 ? Math.round(v) : null);
      }
    }, 400);
    return () => clearInterval(iv);
  }, [running]);
  return tps;
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

/** Per-turn summary of files touched by edit/delete/move tool calls. */
function FilesTouchedChip({ paths }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="files-touched">
      <button className="ft-chip" onClick={() => setOpen((o) => !o)}>
        <FileDiff size={13} />
        本轮变更 {paths.length} 个文件
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

const Item = React.memo(function Item({ item, userIndex, onFork, forkBusy, onResend, onEdit }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user">
          {(onFork || onResend || onEdit) && item.text && (
            <div className="msg-actions">
              {onEdit && (
                <button title="编辑后重新发送" onClick={() => onEdit(item.text)}>
                  <Pencil size={12} />
                </button>
              )}
              {onResend && (
                <button title="原样重发" onClick={() => onResend(item.text)}>
                  <RotateCw size={12} />
                </button>
              )}
              <button
                title="复制"
                onClick={() => navigator.clipboard?.writeText(item.text).catch(() => {})}
              >
                <Copy size={12} />
              </button>
              {onFork && userIndex != null && (
                <button
                  title="从此消息分叉出新会话"
                  disabled={forkBusy}
                  onClick={() => onFork(userIndex)}
                >
                  <GitFork size={12} />
                </button>
              )}
            </div>
          )}
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

export default function ChatView({ sessionId, session, wsUp, home, onSend, onCancel, onDequeue, onEditQueued, composerInject, onEditPrompt, canFork = true, onFork, forkBusy, onConfig, onPermission, onRetry, onRetryPrompt, onRelease, onOpenDrawer, onExport, agentName = "Devin" }) {
  const scrollRef = useRef(null);
  const [view, setViewState] = useState(getView);
  const pickView = (v) => {
    setView(v);
    setViewState(v);
  };
  const stickRef = useRef(true);
  const lastTopRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  // Image lightbox — transcript-level delegation catches every <img>
  // (markdown bodies, user attachments, tool results) without per-item wiring.
  const [imgView, setImgView] = useState(null);
  useEffect(() => {
    if (!imgView) return;
    const esc = (e) => {
      if (e.key === "Escape") setImgView(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [imgView]);
  // Per-session transcript generation — histories arrive consolidated (one
  // atomic fold), so a gen bump just means "pin to bottom after the swap",
  // not a streaming refill that needs covering.
  const genRef = useRef(new Map());
  // Long transcripts mount only the tail — mounting ~2k markdown items at
  // once stalls the click for seconds. Earlier chunks expand on demand.
  const PAGE = 220;
  const [shown, setShown] = useState(PAGE);
  const anchorRef = useRef(null);

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
    const lastUser = withFiles.reduce(
      (acc, it, i) => (it.kind === "user" ? i : acc),
      -1
    );
    // Keep item refs untouched — flags ride a parallel wrapper so memoized
    // Item components still hit when only marking changed.
    let uIdx = -1;
    return withFiles.map((it, i) => ({
      it,
      key: it.key,
      turnStart:
        it.kind !== "user" &&
        it.kind !== "filesTouched" &&
        (i === 0 || withFiles[i - 1].kind === "user"),
      spot: i >= lastUser,
      userIndex: it.kind === "user" ? ++uIdx : null,
    }));
  }, [session.items]);

  // ---------- in-transcript search (Ctrl/Cmd+F) ----------
  const [searchOn, setSearchOn] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [hitNo, setHitNo] = useState(0);
  const searchBoxRef = useRef(null);

  useEffect(() => {
    setSearchOn(false);
    setSearchQ("");
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e) => {
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
  }, [searchOn]);

  const hits = useMemo(() => {
    const q = searchQ.trim().toLowerCase();
    if (!q) return [];
    const textOf = (it) => {
      if (it.kind === "toolgroup") return it.items.map(textOf).join("\n");
      return [it.text, it.title, it.toolName, ...(it.content || []).map((c) => c.text || "")]
        .filter(Boolean)
        .join("\n");
    };
    return renderItems
      .filter((w) => w.it.kind !== "filesTouched" && textOf(w.it).toLowerCase().includes(q))
      .map((w) => w.key);
  }, [renderItems, searchQ]);

  const jumpToHit = useCallback(
    (n) => {
      if (!hits.length) return;
      const i = ((n % hits.length) + hits.length) % hits.length;
      setHitNo(i);
      if (renderItems.length > shown) setShown(renderItems.length);
      setTimeout(() => {
        scrollRef.current
          ?.querySelector(`[data-ik="${hits[i]}"]`)
          ?.scrollIntoView({ block: "center" });
      }, 60);
    },
    [hits, shown, renderItems.length]
  );

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

  const hiddenCount = Math.max(0, renderItems.length - shown);
  const visibleItems = hiddenCount ? renderItems.slice(-shown) : renderItems;
  const navMsgs = visibleItems.filter((w) => w.it.kind === "user");
  const navRef = useRef(null);
  // macOS Dock-style magnification: every tick's length is driven by a
  // gaussian of its distance from the cursor, via the --s CSS var.
  const navMove = (e) => {
    const nav = navRef.current;
    if (!nav) return;
    for (const tick of nav.children) {
      const r = tick.getBoundingClientRect();
      const d = Math.abs(e.clientY - (r.top + r.height / 2));
      tick.style.setProperty("--s", Math.exp(-((d / 20) ** 2)).toFixed(3));
    }
  };
  const navReset = () => {
    const nav = navRef.current;
    if (nav) for (const tick of nav.children) tick.style.setProperty("--s", "0");
  };
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
  const tps = useLiveTps(session.items, session.running);

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
          {onExport && (
            <button className="icon-ghost" title="导出为 Markdown" onClick={onExport}>
              <Download size={15} />
            </button>
          )}
        </div>
      </header>

      <div
        className="transcript"
        ref={scrollRef}
        onScroll={onScroll}
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
              placeholder="搜索对话内容…"
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
            <button onClick={() => jumpToHit(hitNo - 1)} title="上一个 (Shift+Enter)">
              <ChevronUp size={14} />
            </button>
            <button onClick={() => jumpToHit(hitNo + 1)} title="下一个 (Enter)">
              <ChevronDown size={14} />
            </button>
            <button onClick={() => setSearchOn(false)} title="关闭 (Esc)">
              <X size={14} />
            </button>
          </div>
        )}
        {!session.items.length && !session.running && !session.lockError && session.attached && (
          <div className="empty-hints">
            <div className="eh-title">
              <Sparkles size={14} /> 新会话已就绪
            </div>
            <div className="eh-chips">
              {[
                "概览这个项目，告诉我它是做什么的",
                "解释代码库的整体架构",
                "找一个可以改进的地方并修复",
                "为核心模块补充单元测试",
              ].map((t) => (
                <button key={t} className="eh-chip" onClick={() => onSend([{ type: "text", text: t }])}>
                  {t}
                </button>
              ))}
            </div>
            <div className="eh-tip">输入 / 查看全部命令 · @ 引用文件 · Ctrl+K 打开命令面板 · Ctrl+F 搜索对话</div>
          </div>
        )}
        <ImgSessionCtx.Provider value={sessionId}>
        {hiddenCount > 0 && (
          <button className="col load-earlier" onClick={loadEarlier}>
            加载更早消息（还有 {hiddenCount} 条）
          </button>
        )}
        {session.items.length === 0 && !session.attached && (
          <div className="empty-hint col">
            <MessageSquare size={30} />
            正在加载会话…
          </div>
        )}
        {visibleItems.map((w) => (
          <div
            key={w.key}
            data-ik={w.key}
            className={
              "col anim-in" + (w.spot ? " spot" : "") + (hits[hitNo] === w.key && searchQ.trim() ? " search-hit" : "")
            }
          >
            {view === "timeline" && w.it.t != null && (
              <span className="tl-time">{fmtHM(w.it.t)}</span>
            )}
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
              userIndex={w.userIndex}
              onFork={canFork && session.attached && !session.lockError ? onFork : null}
              forkBusy={forkBusy}
              onResend={session.attached ? (t) => onSend([{ type: "text", text: t }]) : null}
              onEdit={session.attached ? onEditPrompt : null}
            />
            )}
            {w.it.failed && w.it._blocks && (
              <button className="msg-retry" onClick={() => onRetryPrompt?.(w.it)}>
                发送失败 · 点击重试
              </button>
            )}
          </div>
        ))}
        {session.queue?.length > 0 && (
          <div className="queue-list col">
            {session.queue.map((q, i) => (
              <div key={q.id} className="queue-chip">
                <span className="qc-pos">{i + 1}</span>
                <span className="qc-text">{q.text || (q.images ? `📷 ${q.images} 张图片` : "…")}</span>
                <button className="qc-btn" title="撤回编辑" onClick={() => onEditQueued?.(q)}>
                  编辑
                </button>
                <button className="qc-btn qc-x" title="从队列移除" onClick={() => onDequeue?.(q.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {session.running && (
          <div className="running-hint col">
            <Loader2 size={14} className="spin" />
            <span className="shimmer">{agentName} 正在工作</span>
            {tps != null && <span className="tps"> ~{tps} tok/s</span>}
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
      {navMsgs.length > 1 && (
        <nav className="msg-nav" aria-label="跳转到我的消息" ref={navRef} onMouseMove={navMove} onMouseLeave={navReset}>
          {navMsgs.map((w) => (
            <div key={w.key} className="mn-tick">
              <button
                className="mn-dot"
                aria-label="跳转到该消息"
                onClick={() =>
                  scrollRef.current
                    ?.querySelector(`[data-ik="${w.key}"]`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" })
                }
              />
              <div className="mn-preview">
                <div className="mn-text">{w.it.text || "📷 图片"}</div>
                {w.it.text && (
                  <button
                    className="mn-copy"
                    title="复制"
                    onClick={() => navigator.clipboard?.writeText(w.it.text).catch(() => {})}
                  >
                    <Copy size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </nav>
      )}
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

      <div className="dock">
        <PermissionPrompt pendingPermissions={session.pendingPermissions} onPermission={onPermission} agentName={agentName} />
        <InputBar
        running={session.running}
        disabled={!wsUp || !!session.lockError}
        onSend={onSend}
        onCancel={onCancel}
        sessionId={sessionId}
        agentName={agentName}
        inject={composerInject}
        cwd={session.cwd}
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
          (pct != null || session.stats) && (
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
      {imgView && (
        <div className="imgview" onClick={() => setImgView(null)}>
          <img src={imgView} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
