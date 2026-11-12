import { createHash } from "node:crypto";

export const treeError = (status, code, message) => Object.assign(new Error(message), { status, code });
const clip = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
export const treeVersion = (manager) => {
  const entries = manager.getEntries();
  return createHash("sha256").update(JSON.stringify([manager.getSessionId(), manager.getLeafId(), entries.length, entries.at(-1)?.id])).digest("hex");
};

// Never serialize raw messages: images, provider signatures and arbitrary
// extension metadata can be huge. Preview recorded, non-redacted text only.
export function treeNode(entry, manager, preview = false) {
  const message = entry.message;
  const kind = entry.type === "message" ? message?.role || "message" : entry.type;
  const content = message?.content ?? entry.content;
  const blocks = Array.isArray(content) ? content : [];
  const limit = preview ? 65536 : 180;
  let text = "", thinking = "", images = 0;
  const tools = [];
  let truncated = false;
  const add = (current, value) => {
    if (typeof value !== "string" || !value) return current;
    const room = limit - current.length - (current ? 1 : 0);
    if (value.length > room) truncated = true;
    if (room <= 0) return current;
    return current ? `${current}\n${value.slice(0, room)}` : value.slice(0, room);
  };
  if (typeof content === "string") text = add(text, content);
  for (const block of blocks) {
    if (block.type === "text") text = add(text, block.text);
    if (block.type === "thinking" && !block.redacted) thinking = add(thinking, block.thinking);
    if (block.type === "image") images++;
    if (block.type === "toolCall") {
      if (tools.length < 20) tools.push(clip(block.name, 100)); else truncated = true;
    }
  }
  text = add(text, entry.summary ?? message?.output);
  const navigable = entry.type === "message" || ["compaction", "branch_summary", "custom_message"].includes(entry.type);
  return {
    id: entry.id, parentId: entry.parentId ?? null, kind, timestamp: entry.timestamp,
    label: clip(manager.getLabel?.(entry.id), 200), text: preview ? text : text || clip(thinking, limit),
    images, tools, navigable: navigable && kind !== "system",
    ...(preview ? { thinking, truncated, toolName: clip(message?.toolName, 100) } : {}),
  };
}

export function sessionTree(loaded) {
  const session = loaded?.proc.session;
  if (!session?.sessionManager) throw treeError(409, "TREE_NOT_LOADED", "请等待会话加载完成后刷新会话树");
  const manager = session.sessionManager;
  const background = loaded.proc.processes?.summary();
  return { version: treeVersion(manager), leafId: manager.getLeafId(),
    backgroundCount: background?.activeCount || 0, backgroundPending: !!background?.pending,
    busy: !!(background?.activeCount || background?.pending || loaded.runActive || loaded.pendingTurn || loaded.inAgentLoop || loaded.turnQueue?.length || session.isIdle === false || session.isStreaming || session.isCompacting || session.isRetrying || session.pendingMessageCount),
    nodes: manager.getEntries().map((entry) => treeNode(entry, manager)) };
}
