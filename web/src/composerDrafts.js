import { environment } from "./api.js";
import { t } from "./i18n.js";

// Text keeps its existing durable key; attachments never enter localStorage.
// sessionStorage is tab-scoped. Reserve room for auth and delivery receipts.
const TAB_BUDGET = 3 * 1024 * 1024;
const PREFIX = "devin-web.attachments.";
const memory = new Map();
const textKey = (env, sid) => env.storageKey(`devin-web.draft.${sid}`);
const attachmentKey = (env, sid) => env.storageKey(`${PREFIX}${sid}`);
const memoryKey = (env, sid) => `${env.host}\n${sid}`;
export const emptyDraft = (sessionId) => ({ sessionId, text: "", images: [], files: [], refs: new Map() });

export function readDraft(sessionId, env = environment("")) {
  const key = memoryKey(env, sessionId);
  if (memory.has(key)) return memory.get(key).draft;
  const draft = emptyDraft(sessionId);
  if (!sessionId) return draft;
  try { draft.text = localStorage.getItem(textKey(env, sessionId)) || ""; } catch {}
  try {
    const saved = JSON.parse(sessionStorage.getItem(attachmentKey(env, sessionId)) || "null");
    if (saved) {
      draft.images = (saved.images || []).filter((i) => typeof i.data === "string" && typeof i.mimeType === "string")
        .map((i) => ({ ...i, preview: `data:${i.mimeType};base64,${i.data}` }));
      draft.files = (saved.files || []).filter((f) => typeof f.name === "string" && typeof f.data === "string");
      draft.refs = new Map((saved.refs || []).filter((r) => Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === "string")));
    }
  } catch {}
  return draft;
}

export function saveDraft(draft, env = environment("")) {
  const sid = draft.sessionId;
  if (!sid) return null;
  const key = memoryKey(env, sid);
  const previous = memory.get(key);
  let warning = null;
  try {
    if (draft.text) localStorage.setItem(textKey(env, sid), draft.text);
    else localStorage.removeItem(textKey(env, sid));
  } catch { warning = t("文字草稿暂存当前页面，浏览器存储不可用，刷新后可能丢失。"); }
  if (previous?.draft.images === draft.images && previous.draft.files === draft.files && previous.draft.refs === draft.refs) {
    warning ||= previous.attachmentWarning;
    memory.set(key, { ...previous, draft });
    return warning;
  }
  let attachmentWarning = null;
  const storage = attachmentKey(env, sid);
  try {
    if (!draft.images.length && !draft.files.length && !draft.refs.size) sessionStorage.removeItem(storage);
    else {
      const json = JSON.stringify({ images: draft.images.map(({ data, mimeType }) => ({ data, mimeType })), files: draft.files, refs: [...draft.refs] });
      let size = json.length * 2;
      for (let i = 0; i < sessionStorage.length; i++) {
        const other = sessionStorage.key(i);
        if (other.startsWith(PREFIX) && other !== storage) size += (sessionStorage.getItem(other)?.length || 0) * 2;
      }
      if (size > TAB_BUDGET) throw new Error("quota");
      sessionStorage.setItem(storage, json);
    }
  } catch {
    // Never restore an older attachment snapshot after a failed save.
    try { sessionStorage.removeItem(storage); } catch {}
    attachmentWarning = t("附件草稿仅保留在当前页面：浏览器存储不可用或暂存限额已满。切换会话可恢复，刷新或切换环境前请先发送。");
  }
  memory.set(key, { draft, attachmentWarning });
  return warning || attachmentWarning;
}
