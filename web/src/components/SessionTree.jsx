import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Focus, RotateCw, ChevronUp, ChevronDown, Loader2 } from "lucide-react";
import { useEnvironment } from "../environmentContext.js";
import { readDraft } from "../composerDrafts.js";
import { useLayer } from "../layers.js";
import { sessionTreeRows } from "../sessionTree.js";
import { compactThoughtText } from "./ToolCall.jsx";
import { t } from "../i18n.js";

const kindName = (kind) => ({ user: t("你"), assistant: t("助手"), toolResult: t("工具结果"), compaction: t("上下文压缩"), branch_summary: t("分支摘要"), custom_message: t("扩展消息") })[kind] || kind;
const nodeText = (node) => (node.label && node.text && node.label !== node.text ? `${node.label} · ${node.text}` : node.label || node.text) || node.tools?.join(", ") || (node.images ? t("{v0} 张图片", { v0: node.images }) : kindName(node.kind));
const TreeRow = React.memo(function TreeRow({ node, selected, match, register, onSelect }) {
  const rowRef = useCallback((element) => register(node.id, element), [register, node.id]);
  const date = new Date(node.timestamp), validDate = !!node.timestamp && Number.isFinite(date.getTime());
  return <li className="tree-list-row" style={{ "--branch-depth": Math.min(node.depth, 6) }}>
    <button type="button" ref={rowRef} data-tree-node={node.id} data-kind={node.kind} tabIndex={selected ? 0 : -1}
      className={`tree-row${node.active ? " active" : ""}${node.current ? " current" : ""}${selected ? " selected" : ""}${match ? " match" : ""}`}
      aria-pressed={selected} aria-current={node.current ? "location" : undefined} onClick={() => onSelect(node.id)}>
      <span className="tree-row-meta">
        {node.branchStart && <span className="tree-branch-label">{t("分支 {v0}", { v0: node.branchIndex })}</span>}
        {node.kind !== "user" && <span>{kindName(node.kind)}</span>}
        {validDate && <time dateTime={date.toISOString()} title={date.toLocaleString()}>{date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time>}
        {node.current && <span className="tree-row-current">{t("当前分支")}</span>}
      </span>
      <span className="tree-row-text">{nodeText(node)}</span>
    </button>
  </li>;
});

export default function SessionTree({ sessionId, session, wsUp, busy, onNavigate, onClose, questions, environmentName }) {
  const env = useEnvironment(), ref = useRef(null), helpId = React.useId();
  const reads = useRef(null), mounted = useRef(true), rowRefs = useRef(new Map());
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState("user"), [selected, setSelected] = useState(null), [preview, setPreview] = useState(null), [previewError, setPreviewError] = useState("");
  const [query, setQuery] = useState(""), [summarize, setSummarize] = useState(false), [confirmed, setConfirmed] = useState(false);
  const model = useMemo(() => sessionTreeRows(data?.nodes || [], data?.leafId, filter), [data, filter]);
  const hitIds = useMemo(() => query.trim() ? model.rows.filter((node) => `${nodeText(node)} ${kindName(node.kind)}`.toLowerCase().includes(query.trim().toLowerCase())).map((node) => node.id) : [], [model, query]);
  const matches = useMemo(() => new Set(hitIds), [hitIds]);
  const target = model.byId.get(selected);
  const draft = readDraft(sessionId, env), hasDraft = !!(draft.text || draft.images.length || draft.files.length || draft.refs.size);
  const compacting = session.items?.some((item) => item.kind === "compaction" && item.status === "running");
  const background = !!(data?.backgroundCount || data?.backgroundPending || session.processes?.activeCount || session.processes?.pending);
  const active = busy || background || compacting || session.running || data?.busy || !!(session.pendingPermissions?.length || session.pendingElicitations?.length);
  const ready = session.attached && !session.historyLoading && !session.lockError;
  const allowed = ready && target?.navigable && target.id !== data?.leafId && preview?.id === target.id && !active && wsUp && (!hasDraft || confirmed);
  useLayer({ ref, modal: true, outside: false, onClose, initialFocus: window.innerWidth <= 768 ? ".tree-header button" : ".tree-search" });

  const refresh = useCallback(async () => {
    reads.current?.abort();
    const controller = new AbortController(); reads.current = controller;
    const timer = setTimeout(() => controller.abort(), 30000);
    setLoading(true); setLoadError("");
    try {
      const next = await env.api.get(`/api/sessions/${encodeURIComponent(sessionId)}/tree`, { signal: controller.signal });
      if (!Array.isArray(next?.nodes) || typeof next.version !== "string") throw new Error(t("当前环境后端尚不支持会话树，需要更新对应组件。"));
      if (!controller.signal.aborted && mounted.current) setData(next);
    } catch (err) {
      if (mounted.current && reads.current === controller) setLoadError(err.status === 404 ? t("当前环境后端尚不支持会话树，需要更新对应组件。") : err.name === "AbortError" ? t("会话树读取超时，请重试") : err.message);
    } finally { clearTimeout(timer); if (mounted.current && reads.current === controller) setLoading(false); }
  }, [env, sessionId]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => { mounted.current = true; refreshRef.current(); return () => { mounted.current = false; reads.current?.abort(); }; }, [env, sessionId]);
  // Refresh only at activity/config/reconnect boundaries, not on token deltas.
  useEffect(() => { if (data && !busy) refreshRef.current(); }, [session.running, compacting, session.attached, session.configOptions, wsUp, busy, session.processes]);
  useLayoutEffect(() => {
    if (data && !model.byId.has(selected)) setSelected(model.nearest(selected) || model.current || model.rows[0]?.id || null);
  }, [model, data, selected]);
  const register = useCallback((id, element) => { if (element) rowRefs.current.set(id, element); else rowRefs.current.delete(id); }, []);
  const reveal = useCallback((id, focus = false) => {
    const row = rowRefs.current.get(id);
    if (focus) row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "nearest" });
  }, []);
  useLayoutEffect(() => { reveal(selected); }, [selected, filter, reveal]);
  const selectAndReveal = useCallback((id, focus = false) => { setSelected(id); reveal(id, focus); }, [reveal]);
  useEffect(() => {
    setPreview(null); setPreviewError(""); setConfirmed(false);
    if (!selected) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
    let live = true;
    env.api.get(`/api/sessions/${encodeURIComponent(sessionId)}/tree/nodes/${encodeURIComponent(selected)}`, { signal: controller.signal })
      .then((node) => { if (node?.id !== selected) throw new Error(t("节点预览无效，请刷新会话树")); if (live) setPreview(node); })
      .catch((err) => { if (live) setPreviewError(err.name === "AbortError" ? t("节点预览读取超时，请重新选择") : err.message); })
      .finally(() => clearTimeout(timer));
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [selected, env, sessionId, data?.version]);
  const keyboard = (e) => {
    const index = model.rows.findIndex((node) => node.id === selected);
    const next = ({ ArrowLeft: target?.parent, ArrowRight: target?.children[0],
      ArrowUp: model.rows[Math.max(0, index - 1)]?.id, ArrowDown: model.rows[Math.min(model.rows.length - 1, index + 1)]?.id,
      Home: model.rows[0]?.id, End: model.rows.at(-1)?.id })[e.key];
    if (next) { e.preventDefault(); selectAndReveal(next, true); }
  };
  const navigate = async () => {
    if (!allowed) return;
    setError("");
    try {
      const result = await onNavigate({ targetId: selected, version: data.version, summarize, replaceDraft: confirmed });
      if (!mounted.current) return;
      if (!result.cancelled) onClose(); else { setError(t("切换已取消，原分支保留。")); refreshRef.current(); }
    } catch (err) { if (mounted.current) { setError(err.message); refreshRef.current(); } }
  };
  return createPortal(<div className="modal-back tree-back">
    <section className="session-tree" ref={ref} role="dialog" aria-modal="true" aria-label={t("Pi 会话树")} onKeyDown={(e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); e.stopPropagation(); ref.current.querySelector(".tree-search")?.focus(); }
    }}>
      <header className="tree-header"><div><strong>{t("Pi 会话树")}</strong><small>{environmentName} · {session.title || sessionId}</small></div>
        <button className="icon-ghost" onClick={onClose} aria-label={t("关闭会话树")} title={t("关闭会话树")}><X size={18} /></button></header>
      <div className="tree-toolbar">
        <input className="tree-search" placeholder={t("搜索节点摘要")} aria-label={t("搜索节点摘要")} value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <><small aria-live="polite">{hitIds.length}</small>{[[-1, ChevronUp], [1, ChevronDown]].map(([dir, Icon]) => <button className="icon-ghost" key={dir} disabled={!hitIds.length} aria-label={dir < 0 ? t("上一个匹配") : t("下一个匹配")} onClick={() => {
          const index = hitIds.indexOf(selected);
          selectAndReveal(hitIds[index < 0 ? (dir > 0 ? 0 : hitIds.length - 1) : (index + dir + hitIds.length) % hitIds.length]);
        }}><Icon size={15} /></button>)}</>}
        <select className="tree-filter" aria-label={t("显示消息类型")} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="user">{t("仅用户消息")}</option><option value="messages">{t("消息与摘要")}</option><option value="all">{t("全部节点")}</option>
        </select>
        <button className="icon-ghost" disabled={!model.current} onClick={() => selectAndReveal(model.current)} aria-label={t("定位当前分支")} title={t("定位当前分支")}><Focus size={15} /></button>
        <button className="icon-ghost" disabled={loading || busy} onClick={() => { setError(""); refresh(); }} aria-label={t("刷新会话树")} title={t("刷新会话树")}><RotateCw size={15} className={loading ? "spin" : ""} /></button>
      </div>
      {(error || loadError) && <div className="tree-error" role="alert">{error || loadError}</div>}
      <div className="tree-body">
        <div className="tree-list-panel" onKeyDown={keyboard}>
          {!data ? <p className="tree-list-status" role="status">{loading ? t("正在读取会话树…") : t("会话树尚未加载")}</p> : <>
            {!model.current && model.rows.length > 0 && <p className="tree-list-status">{t("当前分支尚无可显示的消息")}</p>}
            <ul className="tree-list" aria-label={t("会话分支列表")} aria-describedby={helpId}>
              {model.rows.map((node) => <TreeRow key={node.id} node={node} selected={node.id === selected} match={matches.has(node.id)} register={register} onSelect={selectAndReveal} />)}
            </ul>
            {!model.rows.length && <p className="tree-list-status" role="status">{filter === "user" ? t("此会话暂无用户消息，可切换查看其他节点。") : t("暂无可显示的节点")}</p>}
          </>}
        </div>
        <aside className="tree-preview">
          <div className="tree-preview-content">
            <h3>{target ? kindName(target.kind) : t("选择节点预览")}</h3>
            {target?.label && <strong>{target.label}</strong>}
            {target?.timestamp && <small>{new Date(target.timestamp).toLocaleString()}</small>}
            {selected && !preview && !previewError && <p role="status">{t("正在读取节点预览…")}</p>}
            {previewError && <p role="alert">{previewError}</p>}
            {preview?.text && <pre>{preview.text}</pre>}
            {preview?.thinking && <details><summary>{t("思考过程")}</summary><pre>{compactThoughtText(preview.thinking)}</pre></details>}
            {!!preview?.tools?.length && <p>{t("工具调用：{v0}", { v0: preview.tools.join(", ") })}</p>}
            {preview?.truncated && <p className="dim">{t("预览已截断，原始记录未修改。")}</p>}
            {!!preview?.images && <p className="tree-warning">{t("此节点含图片：仅恢复文字，图片需重新添加。")}</p>}
          </div>
          <div className="tree-continue">
            {questions}
            {target && <p>{["user", "custom_message"].includes(target.kind) ? t("回到此消息之前，将原文恢复到输入框；修改后发送会形成新分支。") : t("保留旧分支，从所选节点继续；输入框将清空，不自动发送。")}</p>}
            <label className="tree-check"><input type="checkbox" checked={summarize} disabled={busy} onChange={(e) => setSummarize(e.target.checked)} />{t("携带旧分支摘要（会调用模型）")}</label>
            {hasDraft && <label className="tree-check tree-warning"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(e) => setConfirmed(e.target.checked)} />{t("我确认替换当前草稿（含附件）")}</label>}
            {background && <p role="status" className="tree-warning">{t("有后台任务运行或正在交付结果，请先停止或等待任务完成再切换分支。")}</p>}
            {active && !background && <p role="status" className="dim">{busy ? t("正在切换分支；关闭窗口不会撤销操作。") : t("会话运行、压缩或等待确认中，可浏览但不能切换。")}</p>}
            {!ready && <p role="status" className="dim">{session.lockError || t("正在等待会话历史加载完成，可浏览但不能切换。")}</p>}
            {!wsUp && <p role="status" className="tree-warning">{t("连接断开，仅可浏览已加载的树。")}</p>}
            <button className="btn primary" disabled={!allowed} onClick={navigate}>{busy && <Loader2 size={14} className="spin" />}{t("从这里继续")}</button>
            <small className="dim">{t("只切换会话上下文，不回滚文件或终端。")}</small>
          </div>
        </aside>
      </div>
      <footer id={helpId}>{t("↑↓ 选择消息 · ←→ 跳转父子消息 · Ctrl+F 搜索")}</footer>
    </section>
  </div>, document.body);
}
