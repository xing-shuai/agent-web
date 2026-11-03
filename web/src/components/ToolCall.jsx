import React, { useMemo, useState } from "react";
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
import { withToken } from "../api.js";

const STATUS_LABEL = {
  pending: "等待",
  in_progress: "运行中",
  completed: "完成",
  failed: "失败",
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
  if (n === "todo_write" || n.includes("todo") || n.includes("plan")) return ListChecks;
  if (n.startsWith("mcp_") || n.startsWith("mcp.")) return Plug;
  if (n === "skill" || n.includes("skill")) return Sparkles;
  return Wrench;
}

/** One-line summary shown in the collapsed tool header. */
export function toolSummary(item) {
  const ri = item.rawInput;
  if (ri && typeof ri === "object") {
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
    if (ri.query) return `搜索: ${clip(ri.query, 60)}`;
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

function StatusIcon({ status }) {
  const label = STATUS_LABEL[status] || status || "等待";
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
      if (inner.type === "image")
        return (
          <img
            className="tool-img"
            src={withToken(inner.url) || `data:${inner.mimeType};base64,${inner.data}`}
          />
        );
      if (inner.type === "resource") {
        const r = inner.resource || {};
        if (skipText != null && r.text === skipText) return null;
        return <pre className="tool-out">{r.text || r.uri}</pre>;
      }
      if (inner.text != null) return <pre className="tool-out">{inner.text}</pre>;
      return <pre className="tool-out">{JSON.stringify(inner, null, 2)}</pre>;
    }
    case "terminal":
      return <div className="tool-out dim">terminal: {c.terminalId}</div>;
    default:
      return <pre className="tool-out">{JSON.stringify(c, null, 2)}</pre>;
  }
}

function RawDetails({ label, value }) {
  if (value == null) return null;
  return (
    <details className="raw">
      <summary>
        <ChevronRight size={12} className="raw-chev" />
        {label}
      </summary>
      <pre>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export default function ToolCall({ item, nested }) {
  const running = item.status === "in_progress" || item.status === "pending";
  const [open, setOpen] = useState(false);
  const cmd = item.rawInput?.command;
  const hasBody =
    !!cmd ||
    (item.content && item.content.length > 0) ||
    (item.images && item.images.length > 0) ||
    item.rawInput != null ||
    item.rawOutput != null ||
    (item.locations && item.locations.length > 0);
  const Icon = toolIcon(item);
  const name = item.toolName || item.toolKind || "tool";

  return (
    <div className={`tool${open ? " open" : ""}${nested ? " nested" : ""}`}>
      <div className="tool-head" onClick={() => hasBody && setOpen((o) => !o)} title={item.title}>
        <span className="tool-ic">
          <Icon size={15} />
        </span>
        <span className="tool-name">{name}</span>
        <span className="tool-sum">{toolSummary(item)}</span>
        <StatusIcon status={item.status} />
        {hasBody && (
          <span className="chev">
            <ChevronDown size={14} />
          </span>
        )}
      </div>
      {open && hasBody && (
        <div className="tool-body">
          {cmd ? (
            <div className="term-card">
              <div className="term-head">
                <Terminal size={12} />
                终端
                {item.rawInput?.workdir && <span className="wd-chip">{tail(item.rawInput.workdir)}</span>}
              </div>
              <div className="term-scroll">
                <div className="term-cmd">
                  <span className="prompt">$</span>
                  <span>{cmd}</span>
                </div>
                {(item.content || []).map((c, i) => (
                  <ContentBlock key={i} c={c} skipText={cmd} />
                ))}
              </div>
            </div>
          ) : (
            (item.content || []).map((c, i) => <ContentBlock key={i} c={c} />)
          )}
          {item.images?.map((img, i) => (
            <img
              key={`img-${i}`}
              className="tool-img"
              src={withToken(img.url) || `data:${img.mimeType || "image/png"};base64,${img.data}`}
            />
          ))}
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
          <RawDetails label="输入" value={cmd ? null : item.rawInput} />
          <RawDetails label="输出" value={item.rawOutput} />
        </div>
      )}
    </div>
  );
}

function ThoughtBlock({ item }) {
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
}

/** Collapsible wrapper for consecutive tool calls + the thoughts between
 *  them — keeps the transcript mostly conversation, tool noise one click away. */
export function ToolGroup({ items }) {
  const [open, setOpen] = useState(false);
  const tools = items.filter((i) => i.kind === "tool");
  const running = tools.filter((i) => i.status === "in_progress" || i.status === "pending");
  const fails = tools.filter((i) => i.status === "failed").length;
  const kinds = useMemo(() => {
    const m = [];
    for (const i of tools) {
      const k = i.toolName || i.toolKind || "tool";
      const hit = m.find((e) => e[0] === k);
      if (hit) hit[1].n++;
      else m.push([k, { n: 1, icon: toolIcon(i) }]);
    }
    return m;
  }, [tools]);

  return (
    <div className={"toolgroup" + (open ? " open" : "") + (running.length ? " running" : "")}>
      <div className="tg-head" onClick={() => setOpen((o) => !o)}>
        <span className="tg-ic">
          <Layers size={15} />
        </span>
        <span className="tg-count">{tools.length} 个工具调用</span>
        <span className="tg-kinds">
          {kinds.slice(0, 4).map(([k, v]) => (
            <span key={k} className="kind-chip">
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
            <span className="tg-fail">{fails} 失败</span>
          ) : (
            <span className="tg-done" title="全部完成">
              <Check size={14} />
            </span>
          )}
          <span className="chev">
            <ChevronDown size={14} />
          </span>
        </span>
      </div>
      {open && (
        <div className="tg-body">
          {items.map((it) =>
            it.kind === "tool" ? (
              <ToolCall key={it.key} item={it} nested />
            ) : (
              <ThoughtBlock key={it.key} item={it} />
            )
          )}
        </div>
      )}
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
        计划
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
