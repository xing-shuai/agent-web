// Folds a stream of ACP `session/update` payloads into renderable transcript
// items. Pure functions — the same logic is used for live updates and for
// replaying a session's buffered history.

import { advanceStreamRate } from "./turnTelemetry.js";
import { t } from "./i18n.js";

export function emptySession() {
  return {
    items: [],
    todos: [],
    todoSource: null,
    configOptions: [],
    modes: null,
    commands: [],
    pendingPermissions: [],
    pendingElicitations: [],
    deliveries: [], // local pending/failed prompts, preserved across history refresh
    queue: [], // prompts parked while a turn runs (server-side FIFO)
    running: false,
    processes: null, // live SDK summary; never infer jobs from old tool calls
    attached: false,
    historyLoading: true, // connection/receipts/live deltas are not a complete transcript
    gen: -1,
    lockError: null,
    lockCode: null,
    lockPid: null,
    title: null,
    modeId: null,
    usage: null,
    usageHist: [],
    usageByAgent: {}, // parentAgentId -> usage (fusion sessions have several)
    cwd: null,
    lastTurn: null, // stats from the last completed turn (agent_stopped)
    telemetry: null, // authoritative pi/open-tui live + final measurement
    streamRate: null, // ACP-only live estimate; never restored from replay
    hasUnread: false,
  };
}

function usageFromUpdate(update) {
  const context = update._meta?.piAcp?.contextUsage;
  return { used: update.used, size: update.size,
    input: update._meta?.["cognition.ai/inputTokens"], output: update._meta?.["cognition.ai/outputTokens"],
    cached: update._meta?.["cognition.ai/cachedReadTokens"],
    ...(context ? { estimated: context.estimated === true, source: context.source } : {}) };
}

export function historyUsage(usage, update) {
  const cached = update?.size ? usageFromUpdate(update) : null;
  if (!usage) return cached;
  // Cold boundaries lack token-after counts. New bridges supply a current,
  // provenance-aware sample; legacy cached percentages may predate compaction.
  if ((!usage.size || usage.source === "unknown") && cached?.source) return cached;
  return usage.size ? usage : { ...usage, size: cached?.size ?? null };
}

function withUsage(state, usage, agent = "root") {
  const last = state.usageHist.at(-1);
  const same = last && last.used === usage.used && last.size === usage.size && last.estimated === usage.estimated;
  return { ...state, usage, usageByAgent: { ...state.usageByAgent, [agent]: usage },
    usageHist: same || !Number.isFinite(usage.used) ? state.usageHist : [...state.usageHist, usage].slice(-40) };
}

let seq = 0;
const key = () => `it-${seq++}`;

// `fold` marks a replay-owned items array: branches may replace elements in
// place instead of copying, and fold.toolIndex maps toolCallId -> first index
// so lookups skip a linear scan. Item objects themselves stay immutable.
function appendText(items, kind, text, t, fold) {
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    const merged = { ...last, text: last.text + text };
    if (fold) { items[items.length - 1] = merged; return items; }
    return [...items.slice(0, -1), merged];
  }
  const item = { key: key(), kind, text, t };
  if (fold) { items.push(item); return items; }
  return [...items, item];
}

function updateTool(items, toolCallId, fields, t, fold) {
  const idx = fold ? fold.toolIndex.get(toolCallId) ?? -1 : items.findIndex((i) => i.kind === "tool" && i.toolCallId === toolCallId);
  if (idx === -1) {
    const item = { key: key(), kind: "tool", toolCallId, t, ...fields };
    if (fold) { fold.toolIndex.set(toolCallId, items.length); items.push(item); return items; }
    return [...items, item];
  }
  const cur = items[idx];
  const merged = { ...cur };
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    // tool_call_update.content is a cumulative snapshot, not a delta —
    // verified against a live stream (the block's text grows in place).
    // Concatenating it produced duplicated output; replace instead.
    if (k === "content" && Array.isArray(v)) merged.content = v;
    else if (k === "locations" && Array.isArray(v)) merged.locations = v;
    // Tool-result images live on their own field (kept out of `content` so a
    // later snapshot update can't wipe them).
    else if (k === "images" && Array.isArray(v)) merged.images = v;
    else merged[k] = v;
  }
  if (fold) { items[idx] = merged; return items; }
  return [...items.slice(0, idx), merged, ...items.slice(idx + 1)];
}

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const todoRows = (rows) => rows.filter((row) => row && typeof row === "object").map((row, i) => ({
  id: String(row.id ?? i), subject: String(row.subject ?? row.content ?? row.text ?? ""),
  status: TODO_STATUSES.has(row.status) ? row.status : "pending",
})).filter((row) => row.subject);

/** Commit task mutations only after successful execution. Tool results, not
 * prose or optimistic/partial arguments, are the source of truth. */
function toolTodos(s, item) {
  if (item.status !== "completed" || item.rawOutput?.isError) return {};
  const name = String(item.toolName || item.title || "").split(".").at(-1).toLowerCase();
  if (!["taskcreate", "taskupdate", "tasklist", "taskget", "todowrite", "todo_write"].includes(name)) return {};
  const input = item.rawInput || {};
  const output = item.rawOutput;
  const content = Array.isArray(output?.content) ? output.content : [];
  const text = typeof output === "string" ? output :
    content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") ||
    (item.content || []).map((c) => c.content?.text || "").join("\n");
  if (/^Task(?: #[^\s]+)? not found\s*$/i.test(text.trim())) return {};
  if (["todowrite", "todo_write"].includes(name) && Array.isArray(input.todos))
    return { todos: todoRows(input.todos), todoSource: "todo" };
  if (!["taskcreate", "taskupdate", "tasklist", "taskget"].includes(name)) return {};
  const tasks = s.todoSource === "task" ? s.todos || [] : [];
  if (name === "tasklist") {
    const rows = [...text.matchAll(/^#([^\s]+) \[(pending|in_progress|completed)\] (.+)$/gm)]
      .map((m) => ({ ...tasks.find((t) => t.id === m[1]), id: m[1], status: m[2], subject: m[3] }));
    return rows.length || /^No tasks found\s*$/i.test(text)
      ? { todos: rows, todoSource: "task" } : {};
  }
  let id;
  let fields;
  if (name === "taskcreate") {
    id = output?.task?.id ?? output?.details?.task?.id ?? text.match(/Task #([^\s:]+) created\b/i)?.[1];
    if (id == null || !input.subject) return {};
    // A repeated snapshot of this create must not undo later status updates.
    if (tasks.some((task) => task.id === String(id) && task.callId === item.toolCallId)) return {};
    fields = { subject: input.subject, activeForm: input.activeForm, status: "pending", callId: item.toolCallId };
  } else if (name === "taskget") {
    const match = text.match(/^Task #([^\s:]+): (.+)$/m);
    const status = text.match(/^Status: (pending|in_progress|completed)\s*$/m)?.[1];
    if (!match || !status) return {};
    id = match[1];
    fields = { subject: match[2], status };
  } else {
    id = input.taskId;
    if (id == null) return {};
    if (input.status === "deleted") return { todos: tasks.filter((task) => task.id !== String(id)), todoSource: "task" };
    fields = {};
    for (const key of ["subject", "activeForm"]) if (typeof input[key] === "string") fields[key] = input[key];
    if (TODO_STATUSES.has(input.status)) fields.status = input.status;
    if (!Object.keys(fields).length) return {};
  }
  id = String(id);
  const previous = tasks.find((task) => task.id === id);
  const task = { subject: t("任务 #{v0}", { v0: id }), status: "pending", ...previous, ...fields, id };
  return { todos: previous ? tasks.map((old) => old.id === id ? task : old) : [...tasks, task], todoSource: "task" };
}

function withTool(s, toolCallId, fields, t, meta, fold) {
  if (meta?.terminal_output && typeof meta.terminal_output.data === "string") {
    const previous = fold ? s.items[fold.toolIndex.get(toolCallId) ?? -1] : s.items.find((it) => it.kind === "tool" && it.toolCallId === toolCallId);
    fields.terminalOutput = (previous?.terminalOutput || "") + meta.terminal_output.data;
    if (!fields.content?.some((block) => block.type !== "terminal"))
      fields.content = [{ type: "content", content: { type: "text", text: fields.terminalOutput } }];
  }
  if (meta?.terminal_exit) { fields.exitCode = meta.terminal_exit.exit_code; fields.signal = meta.terminal_exit.signal; }
  const items = updateTool(s.items, toolCallId, fields, t, fold);
  const item = fold ? items[fold.toolIndex.get(toolCallId)] : items.find((it) => it.kind === "tool" && it.toolCallId === toolCallId);
  return { ...s, items, ...toolTodos(s, item) };
}

const textOf = (content) =>
  content && content.type === "text" ? content.text : content?.text || "";

/** Apply one session/update payload to a session state object.
 *  `t` = event wall-clock (ms) — stamped on newly created items so views
 *  (e.g. timeline) can show per-row timestamps. `fold` is internal: only
 *  history replay passes it, marking s.items as replay-owned (mutable
 *  in place) with a toolCallId index — see appendText/updateTool. */
export function applyUpdate(s, update, t, fold) {
  if (!update) return s;
  const u = update;
  if (!s.telemetry) {
    const streamRate = advanceStreamRate(s.streamRate, u, t ?? Date.now());
    if (streamRate !== s.streamRate) s = { ...s, streamRate };
  }
  switch (u.sessionUpdate) {
    case "user_message_chunk": {
      // Image blocks ride the same channel — keep them on the user bubble
      // instead of dropping them through textOf (replay/mirror parity).
      if (u.content?.type === "image") {
        const src = u.content.data
          ? `data:${u.content.mimeType || "image/*"};base64,${u.content.data}`
          : u.content.url || u.content.uri;
        if (!src) return s;
        const size = Number.isSafeInteger(u.content.width) && Number.isSafeInteger(u.content.height) && u.content.width > 0 && u.content.height > 0
          ? { [src]: { width: u.content.width, height: u.content.height } } : null;
        const last = s.items[s.items.length - 1];
        if (last?.kind === "user") {
          // The client's optimistic bubble already carries this image — the
          // server-side optimistic echo (same data: URI) must not append a
          // second copy. Also covers duplicate grafted rows from sqlite.
          if (last.images?.includes(src)) return s;
          return {
            ...s,
            items: [...s.items.slice(0, -1), { ...last, images: [...(last.images || []), src], ...(size ? { imageSizes: { ...last.imageSizes, ...size } } : {}) }],
          };
        }
        return { ...s, items: [...s.items, { key: key(), kind: "user", text: "", images: [src], ...(size ? { imageSizes: size } : {}), t }] };
      }
      const text = textOf(u.content);
      const last = s.items[s.items.length - 1];
      // If we optimistically rendered the sent message, an echo of it
      // (equal text, or a prefix either way for chunked echoes) supersedes
      // the placeholder instead of duplicating it.
      if (last?.kind === "user" && last.optimistic) {
        if (text.startsWith(last.text) || last.text.startsWith(text)) {
          return { ...s, items: [...s.items.slice(0, -1), { ...last, text, optimistic: false }] };
        }
        const items = s.items.map((it, i) => (i === s.items.length - 1 ? { ...it, optimistic: false } : it));
        return { ...s, items: [...items, { key: key(), kind: "user", text, t }] };
      }
      const id = u._meta?.["devin-web/requestId"];
      const items = id && last?.kind === "user" && last.deliveryId !== id
        ? [...s.items, { key: key(), kind: "user", text, t, deliveryId: id }]
        : appendText(s.items, "user", text, t, fold);
      if (id) items[items.length - 1] = { ...items[items.length - 1], deliveryId: id };
      return { ...s, items };
    }
    case "agent_message_chunk":
      return { ...s, items: appendText(s.items, "agent", textOf(u.content), t, fold) };
    case "agent_thought_chunk":
      return { ...s, items: appendText(s.items, "thought", textOf(u.content), t, fold) };
    case "tool_call":
      return withTool(s, u.toolCallId, {
        title: u.title,
        toolKind: u.kind,
        toolName: u._meta?.["cognition.ai/inferenceToolName"] || (/^[\w.-]+$/.test(u.title || "") ? u.title : undefined),
        status: u.status || "pending",
        content: u.content || [],
        locations: u.locations || [],
        rawInput: u.rawInput,
        rawOutput: u.rawOutput,
        images: u.images,
      }, t, u._meta, fold);
    case "tool_call_update":
      return withTool(s, u.toolCallId, {
        title: u.title,
        toolName: u._meta?.["cognition.ai/inferenceToolName"],
        status: u.status,
        content: u.content,
        locations: u.locations,
        rawInput: u.rawInput,
        rawOutput: u.rawOutput,
        images: u.images,
      }, t, u._meta, fold);
    case "plan": {
      const idx = s.items.findIndex((i) => i.kind === "plan");
      const item = { key: idx === -1 ? key() : s.items[idx].key, kind: "plan", entries: u.entries || [], t: s.items[idx]?.t ?? t };
      const items = idx === -1 ? [...s.items, item] : [...s.items.slice(0, idx), item, ...s.items.slice(idx + 1)];
      return { ...s, items, todos: todoRows(u.entries || []), todoSource: "plan" };
    }
    case "available_commands_update":
      return { ...s, commands: u.availableCommands || [] };
    case "current_mode_update":
      return { ...s, modeId: u.currentModeId };
    case "config_option_update":
      return { ...s, configOptions: u.configOptions || [] };
    case "session_info_update": {
      const notice = u._meta?.piAcp?.processNotification;
      if (notice?.id) {
        if (s.items.some((item) => item.kind === "processNotification" && item.id === notice.id)) return s;
        return { ...s, items: [...s.items, { ...notice, notificationKind: notice.kind, key: key(), kind: "processNotification", t: notice.at }] };
      }
      const branchSummary = u._meta?.piAcp?.branchSummary;
      if (branchSummary?.id) {
        if (s.items.some((item) => item.kind === "branchSummary" && item.id === branchSummary.id)) return s;
        return { ...s, items: [...s.items, { ...branchSummary, key: key(), kind: "branchSummary", status: "completed", t: branchSummary.at }] };
      }
      const telemetry = u._meta?.piAcp?.telemetry;
      const compaction = u._meta?.piAcp?.compaction;
      if (compaction?.id) {
        const idx = s.items.findIndex((it) => it.kind === "compaction" && it.id === compaction.id);
        const previous = s.items[idx];
        const at = Number.isFinite(compaction.at) ? compaction.at : null;
        const item = { ...previous, ...compaction, key: previous?.key || key(), kind: "compaction",
          at: previous?.at ?? at, t: previous?.t ?? at,
          startedAt: previous?.startedAt ?? (compaction.status === "running" ? at : null),
          finishedAt: compaction.status === "running" ? null : at,
        };
        const next = { ...s, items: idx < 0 ? [...s.items, item] : s.items.map((it, i) => i === idx ? item : it) };
        if (compaction.status === "completed" && previous?.status !== "completed") {
          const used = Number.isSafeInteger(compaction.estimatedTokensAfter) && compaction.estimatedTokensAfter >= 0 ? compaction.estimatedTokensAfter : null;
          return withUsage(next, { used, size: s.usage?.size ?? null, estimated: used != null, source: used != null ? "compaction" : "unknown" });
        }
        return next;
      }
      return { ...s, title: u.title ?? s.title,
        ...(u._meta?.piAcp?.processes ? { processes: u._meta.piAcp.processes } : {}),
        ...(typeof u._meta?.piAcp?.running === "boolean" ? { running: u._meta.piAcp.running } : {}),
        ...(telemetry ? {
        telemetry: { ...s.telemetry, ...telemetry },
        streamRate: null,
        lastTurn: telemetry.reset ? null : telemetry.final ? {
          totalTimeMs: telemetry.final.totalMs,
          inputTokens: telemetry.final.inputTokens, outputTokens: telemetry.final.outputTokens,
          generationMs: telemetry.final.generationMs, ttftMs: telemetry.final.ttftMs, tps: telemetry.final.tps,
        } : s.lastTurn,
      } : {}) };
    }
    case "usage_update": {
      const usage = usageFromUpdate(u);
      // Fusion sessions emit usage per agent; key by the context the event
      // came from (root sessions get the "root" bucket).
      const ctx = u._meta?.["cognition.ai/subagent_context"];
      const agent =
        (ctx && (ctx.agentId || ctx.role || ctx.name || ctx.parentAgentId)) || "root";
      return withUsage(s, usage, agent);
    }
    default:
      return s;
  }
}

/** ACP text chunks have no end marker: the next text/tool block or turn end
 * closes them. Tools have independent statuses and may execute in parallel.
 * Ignore old turns so an interrupted tool cannot reopen on the next prompt. */
export function activeBlockKeys({ items, running }) {
  const active = new Set();
  if (!running) return active;
  let tail = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") break;
    if (!["agent", "thought", "tool"].includes(it.kind)) continue;
    tail ||= it;
    if (it.kind === "tool" && (!it.status || it.status === "pending" || it.status === "in_progress"))
      active.add(it.key);
  }
  if (tail?.kind === "agent" || tail?.kind === "thought") active.add(tail.key);
  return active;
}

export function foldEvents(events) {
  const s = emptySession();
  // items starts as emptySession()'s fresh array; in-place branches only ever
  // append or replace at an index, so toolIndex entries stay valid.
  const fold = { toolIndex: new Map() };
  let cur = s;
  for (const e of events) cur = applyUpdate(cur, e.update, e.t, fold);
  // Replay can restore final usage, but cannot be treated as fresh generation.
  return { ...cur, streamRate: null, telemetry: cur.telemetry ? { ...cur.telemetry, live: null } : null };
}

// One immutable folded checkpoint shares unchanged items/strings with live UI
// state. It is tab-memory-only and leaves with the existing session cache.
export function historySnapshot(state) {
  const keys = ["items", "todos", "todoSource", "configOptions", "modes", "commands", "modeId", "usage", "usageHist", "usageByAgent", "cwd", "lastTurn", "telemetry", "processes", "title"];
  const snapshot = emptySession();
  for (const key of keys) snapshot[key] = state[key];
  return { ...snapshot, streamRate: null, telemetry: snapshot.telemetry ? { ...snapshot.telemetry, live: null } : null };
}
export function foldHistoryDelta(snapshot, events) {
  // The snapshot's array and items are shared with live UI state: copy the
  // array once, then the fold owns the copy. Indices only ever grow.
  const fold = { toolIndex: new Map() };
  snapshot.items.forEach((it, i) => {
    if (it.kind === "tool" && !fold.toolIndex.has(it.toolCallId)) fold.toolIndex.set(it.toolCallId, i);
  });
  let result = { ...snapshot, items: snapshot.items.slice() };
  for (const event of events) result = applyUpdate(result, event.update, event.t, fold);
  return historySnapshot(result);
}
