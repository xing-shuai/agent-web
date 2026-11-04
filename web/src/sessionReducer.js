// Folds a stream of ACP `session/update` payloads into renderable transcript
// items. Pure functions — the same logic is used for live updates and for
// replaying a session's buffered history.

export function emptySession() {
  return {
    items: [],
    configOptions: [],
    modes: null,
    commands: [],
    pendingPermissions: [],
    queue: [], // prompts parked while a turn runs (server-side FIFO)
    running: false,
    attached: false,
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
    hasUnread: false,
  };
}

let seq = 0;
const key = () => `it-${seq++}`;

function appendText(items, kind, text, t) {
  const last = items[items.length - 1];
  if (last && last.kind === kind) {
    return [...items.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...items, { key: key(), kind, text, t }];
}

function updateTool(items, toolCallId, fields, t) {
  const idx = items.findIndex((i) => i.kind === "tool" && i.toolCallId === toolCallId);
  if (idx === -1) {
    return [...items, { key: key(), kind: "tool", toolCallId, t, ...fields }];
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
  return [...items.slice(0, idx), merged, ...items.slice(idx + 1)];
}

const textOf = (content) =>
  content && content.type === "text" ? content.text : content?.text || "";

/** Apply one session/update payload to a session state object.
 *  `t` = event wall-clock (ms) — stamped on newly created items so views
 *  (e.g. timeline) can show per-row timestamps. */
export function applyUpdate(s, update, t) {
  if (!update) return s;
  const u = update;
  switch (u.sessionUpdate) {
    case "user_message_chunk": {
      // Image blocks ride the same channel — keep them on the user bubble
      // instead of dropping them through textOf (replay/mirror parity).
      if (u.content?.type === "image") {
        const src = u.content.data
          ? `data:${u.content.mimeType || "image/*"};base64,${u.content.data}`
          : u.content.url || u.content.uri;
        if (!src) return s;
        const last = s.items[s.items.length - 1];
        if (last?.kind === "user") {
          // The client's optimistic bubble already carries this image — the
          // server-side optimistic echo (same data: URI) must not append a
          // second copy. Also covers duplicate grafted rows from sqlite.
          if (last.images?.includes(src)) return s;
          return {
            ...s,
            items: [...s.items.slice(0, -1), { ...last, images: [...(last.images || []), src] }],
          };
        }
        return { ...s, items: [...s.items, { key: key(), kind: "user", text: "", images: [src], t }] };
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
      return { ...s, items: appendText(s.items, "user", text, t) };
    }
    case "agent_message_chunk":
      return { ...s, items: appendText(s.items, "agent", textOf(u.content), t) };
    case "agent_thought_chunk":
      return { ...s, items: appendText(s.items, "thought", textOf(u.content), t) };
    case "tool_call":
      return {
        ...s,
        items: updateTool(s.items, u.toolCallId, {
          title: u.title,
          toolKind: u.kind,
          toolName: u._meta?.["cognition.ai/inferenceToolName"],
          status: u.status || "pending",
          content: u.content || [],
          locations: u.locations || [],
          rawInput: u.rawInput,
          rawOutput: u.rawOutput,
          images: u.images,
        }, t),
      };
    case "tool_call_update":
      return {
        ...s,
        items: updateTool(s.items, u.toolCallId, {
          title: u.title,
          toolName: u._meta?.["cognition.ai/inferenceToolName"],
          status: u.status,
          content: u.content,
          locations: u.locations,
          rawOutput: u.rawOutput,
          images: u.images,
        }, t),
      };
    case "plan": {
      const idx = s.items.findIndex((i) => i.kind === "plan");
      const item = { key: idx === -1 ? key() : s.items[idx].key, kind: "plan", entries: u.entries || [], t: s.items[idx]?.t ?? t };
      const items = idx === -1 ? [...s.items, item] : [...s.items.slice(0, idx), item, ...s.items.slice(idx + 1)];
      return { ...s, items };
    }
    case "available_commands_update":
      return { ...s, commands: u.availableCommands || [] };
    case "current_mode_update":
      return { ...s, modeId: u.currentModeId };
    case "config_option_update":
      return { ...s, configOptions: u.configOptions || [] };
    case "session_info_update":
      return { ...s, title: u.title ?? s.title };
    case "usage_update": {
      const usage = {
        used: u.used,
        size: u.size,
        input: u._meta?.["cognition.ai/inputTokens"],
        output: u._meta?.["cognition.ai/outputTokens"],
        cached: u._meta?.["cognition.ai/cachedReadTokens"],
      };
      const last = s.usageHist[s.usageHist.length - 1];
      // Samples arrive per turn; keep a short bounded history for the sparkline.
      const same = last && last.used === u.used && last.size === u.size;
      // Fusion sessions emit usage per agent; key by the context the event
      // came from (root sessions get the "root" bucket).
      const ctx = u._meta?.["cognition.ai/subagent_context"];
      const agent =
        (ctx && (ctx.agentId || ctx.role || ctx.name || ctx.parentAgentId)) || "root";
      return {
        ...s,
        usage,
        usageHist: same ? s.usageHist : [...s.usageHist, usage].slice(-40),
        usageByAgent: { ...s.usageByAgent, [agent]: usage },
      };
    }
    default:
      return s;
  }
}

export function foldEvents(events) {
  const s = emptySession();
  let cur = s;
  for (const e of events) cur = applyUpdate(cur, e.update, e.t);
  return cur;
}
