import React, { useContext, useEffect, useMemo, useState } from "react";
import {
  Terminal,
  FileText,
  Pencil,
  Search,
  Globe,
  ListChecks,
  Plug,
  Sparkles,
  Wrench,
  Loader2,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Layers,
  Brain,
  CheckCircle2,
  CircleDot,
  Circle,
} from "lucide-react";
import DiffView from "./DiffView.jsx";
import Disclosure from "./Disclosure.jsx";
import { useEnvironment } from "../environmentContext.js";
import { TranscriptSearch } from "../transcriptSearch.js";
import { t } from "../i18n.js";
import { historyImageAsset, hasHistoryImages, hydrateHistoryImages } from "../historyImages.js";

const STATUS_LABEL = {
  pending: t("等待"),
  in_progress: t("运行中"),
  completed: t("完成"),
  failed: t("失败"),
};

const clip = (t, n = 110) => {
  t = String(t ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
};

const tail = (p) => {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p;
};

const EXEC_TOOLS = new Set(["exec", "execute", "bash", "shell"]);
const EDIT_TOOLS = new Set(["edit", "write", "multi_edit", "apply_patch", "notebook_edit"]);
const SEARCH_TOOLS = new Set(["grep", "find_file_by_name", "glob", "search"]);
const WEB_TOOLS = new Set(["web_search", "webfetch", "fetch"]);

/** Pick a lucide icon for a tool by its name (falling back to kind). */
export function toolIcon(item) {
  const n = String(item?.toolName || item?.toolKind || "").toLowerCase();
  if (EXEC_TOOLS.has(n) || n.includes("exec") || n.includes("shell") || n.includes("terminal"))
    return Terminal;
  if (EDIT_TOOLS.has(n) || n.includes("edit") || n.includes("write") || n.includes("patch"))
    return Pencil;
  if (SEARCH_TOOLS.has(n) || n.includes("grep") || n.includes("find") || n.includes("search"))
    return Search;
  if (WEB_TOOLS.has(n) || n.includes("web")) return Globe;
  if (n === "read" || n.includes("read") || n.includes("file")) return FileText;
  if (n.startsWith("task") || n.includes("todo") || n.includes("plan")) return ListChecks;
  if (n.startsWith("mcp_") || n.startsWith("mcp.")) return Plug;
  if (n === "skill" || n.includes("skill")) return Sparkles;
  return Wrench;
}

/** One-line summary shown in the collapsed tool header. */
export function toolSummary(item) {
  const ri = item.rawInput;
  if (ri && typeof ri === "object") {
    if (ri.subject) return clip(ri.subject);
    if (ri.taskId) return `#${ri.taskId}${ri.status ? ` · ${STATUS_LABEL[ri.status] || ri.status}` : ""}`;
    if (ri.command) return "$ " + clip(String(ri.command).split("\n")[0]);
    if (ri.file_path) {
      const loc = item.locations?.[0];
      const range =
        loc?.line != null
          ? `:${loc.line}${loc._meta?.["cognition.ai/endLine"] ? `-${loc._meta["cognition.ai/endLine"]}` : ""}`
          : "";
      return tail(ri.file_path) + range;
    }
    if (ri.path && ri.query) return `'${ri.query}' in ${tail(ri.path)}`;
    if (ri.query) return t("搜索: {v0}", { v0: clip(ri.query, 60) });
    if (ri.url) return clip(ri.url, 80);
    if (ri.path) return tail(ri.path);
    if (ri.skill) return `skill: ${ri.skill}`;
    if (ri.shell_id) return `shell ${ri.shell_id}`;
    if (ri.pattern) return `'${ri.pattern}'`;
  }
  const loc = item.locations?.[0]?.path;
  if (loc) return tail(loc) + (item.locations[0].line != null ? `:${item.locations[0].line}` : "");
  return item.title || item.toolCallId || "tool";
}

/** Show the actual tool name; reserve the adjacent summary for its target. */
export function toolPresentation(item) {
  const internal = item.toolName || (/^[\w.-]+$/.test(item.title || "") ? item.title : null) || item.toolKind || "tool";
  const name = String(internal).split(".").at(-1).toLowerCase();
  const input = item.rawInput || {};
  let summary = toolSummary(item);
  if (name === "taskcreate") summary = input.subject || t("准备任务内容");
  else if (name === "taskupdate") summary = input.subject || (input.taskId ? t("任务 #{v0}", { v0: input.taskId }) : t("同步任务状态"));
  else if (["tasklist", "taskget"].includes(name)) summary = input.taskId ? t("任务 #{v0}", { v0: input.taskId }) : t("当前任务列表");
  else if (name === "taskexecute") summary = input.task_ids?.map((id) => `#${id}`).join("、") || t("执行已选任务");
  else if (["taskoutput", "taskstop"].includes(name)) summary = input.task_id ? t("任务 #{v0}", { v0: input.task_id }) : t("后台任务");
  else if (["ask_user", "question", "questionnaire"].includes(name)) summary = input.title || input.question || input.questions?.[0]?.prompt || t("等待你的选择");
  return { label: internal, summary: summary === internal ? "" : clip(summary), internal };
}

function StatusIcon({ status }) {
  const label = STATUS_LABEL[status] || status || t("等待");
  if (status === "completed")
    return (
      <span className="tool-st completed" title={label}>
        <Check size={14} />
      </span>
    );
  if (status === "failed")
    return (
      <span className="tool-st failed" title={label}>
        <X size={14} />
      </span>
    );
  if (status === "in_progress" || status === "pending" || !status)
    return (
      <span className="tool-st running" title={label}>
        <Loader2 size={14} className="spin" />
      </span>
    );
  return (
    <span className="tool-st pending" title={label}>
      <Circle size={13} />
    </span>
  );
}

function ContentBlock({ c, skipText }) {
  const { withToken } = useEnvironment();
  if (!c) return null;
  switch (c.type) {
    case "diff":
      return <DiffView path={c.path} oldText={c.oldText} newText={c.newText} />;
    case "content": {
      const inner = c.content || {};
      if (inner.type === "text") {
        if (skipText != null && inner.text === skipText) return null;
        return <pre className="tool-out">{inner.text}</pre>;
      }
      if (inner.type === "image") {
        const asset = historyImageAsset(inner);
        return <img className="tool-img" src={withToken(asset?.url || inner.url) || `data:${inner.mimeType};base64,${inner.data}`}
          loading={asset ? "lazy" : undefined} decoding="async" width={asset?.width} height={asset?.height} />;
      }
      if (inner.type === "resource") {
        const r = inner.resource || {};
        if (skipText != null && r.text === skipText) return null;
        return <pre className="tool-out">{r.text || r.uri}</pre>;
      }
      if (inner.text != null) return <pre className="tool-out">{inner.text}</pre>;
      return <RawText className="tool-out" value={inner} json />;
    }
    case "terminal":
      return <div className="tool-out dim">{t("等待命令输出…")}</div>;
    default:
      return <RawText className="tool-out" value={c} json />;
  }
}

function RawText({ value, className, json = false }) {
  const env = useEnvironment(), deferred = useMemo(() => hasHistoryImages(value), [value]);
  const [result, setResult] = useState(null), [revision, retry] = useState(0);
  useEffect(() => {
    if (!deferred) return;
    const controller = new AbortController(); let disposed = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    setResult(null);
    hydrateHistoryImages(value, env.api, { signal: controller.signal }).then((full) => {
      if (!disposed) setResult({ source: value, text: JSON.stringify(full, null, 2) });
    }).catch((e) => { if (!disposed) setResult({ source: value, error: timedOut ? t("图片读取超时，请重试") : e.message }); })
      .finally(() => clearTimeout(timer));
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [value, deferred, env, revision]);
  if (!deferred) return <pre className={className}>{!json && typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
  if (result?.source !== value) return <p role="status">{t("正在读取完整原始图片数据…")}</p>;
  if (result.error) return <div role="alert">{result.error} <button onClick={() => retry((n) => n + 1)}>{t("重试")}</button></div>;
  return <pre className={className}>{result.text}</pre>;
}

function RawDetails({ label, value, expanded, searchOpen }) {
  const [state, setState] = useState({ expanded, open: !!expanded });
  if (state.expanded !== expanded) setState({ expanded, open: !!expanded });
  if (value == null) return null;
  return (
    <Disclosure className="raw" open={searchOpen || state.open} instant={searchOpen} summary={
      <summary aria-expanded={searchOpen || state.open} onClick={(e) => { e.preventDefault(); if (!searchOpen) setState({ expanded, open: !state.open }); }}>
        <ChevronRight size={12} className="raw-chev" />
        {label}
      </summary>}>
      {() => <RawText value={value} />}
    </Disclosure>
  );
}

export default function ToolCall({ item, nested, bodyOnly = false }) {
  const { withToken } = useEnvironment();
  const [manualOpen, setOpen] = useState(false);
  const search = useContext(TranscriptSearch);
  const searchOpen = search.keys.has(item.key);
  const open = bodyOnly || manualOpen || searchOpen;
  const rawMatch = (value) => searchOpen && value != null && JSON.stringify(value).toLowerCase().includes(search.query.toLowerCase());
  const cmd = item.rawInput?.command ?? item.rawInput?.cmd;
  const hasBody =
    !!cmd ||
    (item.content && item.content.length > 0) ||
    (item.images && item.images.length > 0) ||
    item.rawInput != null ||
    item.rawOutput != null ||
    (item.locations && item.locations.length > 0);
  const Icon = toolIcon(item);
  const presentation = toolPresentation(item);

  return (
    <div data-search-key={item.key} className={`tool${open ? " open" : ""}${nested ? " nested" : ""}${item.status === "failed" ? " failed" : ""}`}>
      {!bodyOnly && <button type="button" className="tool-head" aria-expanded={hasBody ? open : undefined} onClick={() => hasBody && !searchOpen && setOpen((o) => !o)} title={presentation.internal}>
        <span className="tool-ic">
          <Icon size={15} />
        </span>
        <span className="tool-name">{presentation.label}</span>
        <span className="tool-sum">{presentation.summary}</span>
        <StatusIcon status={item.status} />
        {hasBody && (
          <span className="chev">
            <ChevronDown size={14} />
          </span>
        )}
      </button>}
      {hasBody && <Disclosure open={open} instant={bodyOnly || searchOpen}>{() => (
        <div className="tool-body">
          {cmd ? (
            <>
              {(Number.isFinite(item.exitCode) || item.rawInput?.workdir) && <div className="tool-exec-meta">
                {item.rawInput?.workdir && <span className="tool-workdir" title={item.rawInput.workdir}>{tail(item.rawInput.workdir)}</span>}
                {Number.isFinite(item.exitCode) && <span className={"tool-exit" + (item.exitCode !== 0 ? " failed" : "")}>{t("退出 {v0}", { v0: item.exitCode })}</span>}
              </div>}
              <div className="term-scroll">
                <div className="term-cmd">
                  <span className="prompt">$</span>
                  <span>{cmd}</span>
                </div>
                {(item.content || []).map((c, i) => (
                  <ContentBlock key={i} c={c} skipText={item.rawOutput != null ? undefined : cmd} />
                ))}
              </div>
            </>
          ) : (
            (item.content || []).map((c, i) => <ContentBlock key={i} c={c} />)
          )}
          {item.images?.map((img, i) => {
            const asset = historyImageAsset(img);
            return <img key={`img-${i}`} className="tool-img"
              src={withToken(asset?.url || img.url) || `data:${img.mimeType || "image/png"};base64,${img.data}`}
              loading={asset ? "lazy" : undefined} decoding="async" width={asset?.width} height={asset?.height} />;
          })}
          {item.locations?.length > 0 && (
            <div className="tool-locs">
              {item.locations.map((l, i) => (
                <div key={i} className="loc">
                  {l.path}
                  {l.line != null ? `:${l.line}` : ""}
                  {l._meta?.["cognition.ai/endLine"] ? `-${l._meta["cognition.ai/endLine"]}` : ""}
                </div>
              ))}
            </div>
          )}
          <RawDetails label={t("输入")} value={!cmd || rawMatch(item.rawInput) ? item.rawInput : null} searchOpen={rawMatch(item.rawInput)} />
          <RawDetails label={item.content?.length ? t("原始输出") : t("输出")} value={item.rawOutput} expanded={bodyOnly && !item.content?.length} searchOpen={rawMatch(item.rawOutput)} />
        </div>
      )}</Disclosure>}
    </div>
  );
}

/** Display-only whitespace compaction; persisted thinking stays untouched.
 * Preserve blank lines inside fenced/indented code, including unfinished fences
 * while streaming. Ordinary paragraphs use normal line breaks, without empty rows. */
export function compactThoughtText(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let fence = null, previousIndented = false, blanks = [];
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      output.push(line);
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      previousIndented = false;
      continue;
    }
    if (!line.trim()) { if (output.length) blanks.push(line); continue; }
    const indented = /^(?: {4}|\t)/.test(line);
    if (blanks.length) {
      if (previousIndented && indented) for (const blank of blanks) output.push(blank);
      blanks = [];
    }
    output.push(line);
    if (marker && (marker[1][0] === "~" || !marker[2].includes(" "))) fence = marker[1];
    previousIndented = indented;
  }
  return output.join("\n");
}

export function ThoughtBlock({ item }) {
  const [open, setOpen] = useState(false);
  const search = useContext(TranscriptSearch), forced = search.keys.has(item.key);
  const text = useMemo(() => compactThoughtText(item.text), [item.text]);
  return (
    <Disclosure className="thought" data-search-key={item.key} open={open || forced} instant={forced} summary={
      <summary aria-expanded={open || forced} onClick={(e) => { e.preventDefault(); if (!forced) setOpen((o) => !o); }}>
        <Brain size={13} />
        {t("思考过程")}
        <ChevronRight size={13} className="th-chev" />
      </summary>}>
      <div className="thought-body">{text}</div>
    </Disclosure>
  );
}

/** Collapsible wrapper for consecutive tool calls + the thoughts between
 *  them — keeps the transcript mostly conversation, tool noise one click away. */
export function ToolGroup({ items }) {
  const [manualOpen, setOpen] = useState(false);
  const search = useContext(TranscriptSearch);
  const searchOpen = items.some((it) => search.keys.has(it.key));
  const open = manualOpen || searchOpen;
  const tools = items.filter((i) => i.kind === "tool");
  const running = tools.filter((i) => i.status === "in_progress" || i.status === "pending");
  const fails = tools.filter((i) => i.status === "failed").length;
  const kinds = useMemo(() => {
    const m = [];
    for (const i of tools) {
      const { label: k, internal } = toolPresentation(i);
      const hit = m.find((e) => e[0] === k);
      if (hit) hit[1].n++;
      else m.push([k, { n: 1, icon: toolIcon(i), title: internal }]);
    }
    return m;
  }, [tools]);

  return (
    <div className={"toolgroup" + (open ? " open" : "") + (running.length ? " running" : "")}>
      <button type="button" className="tg-head" aria-expanded={open} onClick={() => { if (!searchOpen) setOpen((o) => !o); }}>
        <span className="tg-ic">
          <Layers size={15} />
        </span>
        <span className="tg-count">{t("{v0} 个工具调用", { v0: tools.length })}</span>
        <span className="tg-kinds">
          {kinds.slice(0, 4).map(([k, v]) => (
            <span key={k} className="kind-chip" title={v.title}>
              <v.icon size={11} />
              {k} ×{v.n}
            </span>
          ))}
          {kinds.length > 4 && <span className="kind-chip">+{kinds.length - 4}</span>}
        </span>
        <span className="tg-right">
          {running.length > 0 ? (
            <span className="tg-live">
              <Loader2 size={12} className="spin" />
              {toolSummary(running[running.length - 1])}
            </span>
          ) : fails > 0 ? (
            <span className="tg-fail">{t("{v0} 失败", { v0: fails })}</span>
          ) : null}
          <span className="chev">
            <ChevronDown size={14} />
          </span>
        </span>
      </button>
      <Disclosure open={open} instant={searchOpen}>{() => (
        <div className="tg-body">
          {items.map((it) =>
            it.kind === "tool" ? (
              <ToolCall key={it.key} item={it} nested />
            ) : (
              <ThoughtBlock key={it.key} item={it} />
            )
          )}
        </div>
      )}</Disclosure>
    </div>
  );
}

export function PlanBox({ entries }) {
  const done = entries.filter((e) => e.status === "completed").length;
  const pct = entries.length ? Math.round((100 * done) / entries.length) : 0;
  return (
    <div className="plan">
      <div className="plan-head">
        <ListChecks size={14} />
        {t("计划")}
        <span className="plan-count">
          {done}/{entries.length}
        </span>
      </div>
      <div className="plan-bar">
        <span className="plan-fill" style={{ width: `${pct}%` }} />
      </div>
      {entries.map((e, i) => (
        <div key={i} className={`plan-row ${e.status}`}>
          <span className="plan-ic">
            {e.status === "completed" ? (
              <CheckCircle2 size={15} />
            ) : e.status === "in_progress" ? (
              <CircleDot size={15} />
            ) : (
              <Circle size={15} />
            )}
          </span>
          <span className="plan-text">{e.content}</span>
        </div>
      ))}
    </div>
  );
}
