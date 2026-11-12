import { useCallback, useEffect, useReducer, useRef } from "react";
import { noticesReducer } from "../notices.js";
import { COPY_FAILED_EVENT } from "../clipboard.js";
import { t } from "../i18n.js";

let seq = 0;
export default function useNotices() {
  const [items, dispatch] = useReducer(noticesReducer, []);
  const timers = useRef(new Map()); // id -> {at, timer}
  const notify = useCallback((notice) => {
    const n = { host: "", kind: "info", sticky: false, reload: false, ...notice };
    if (!n.id) n.id = `n${++seq}`;
    dispatch({ type: "notify", notice: n });
    return n.id;
  }, []);
  useEffect(() => {
    const failed = (event) => notify({ host: event.detail?.host || "", kind: "warn", text: t("复制失败，请选中文字后手动复制") });
    window.addEventListener(COPY_FAILED_EVENT, failed);
    return () => window.removeEventListener(COPY_FAILED_EVENT, failed);
  }, [notify]);
  const dismiss = useCallback((id) => dispatch({ type: "dismiss", id }), []);
  const dismissWhere = useCallback((pred) => dispatch({ type: "dismissWhere", pred }), []);
  useEffect(() => {
    for (const n of items) {
      if (n.sticky || n.kind === "error") continue;
      const existing = timers.current.get(n.id);
      if (existing?.at === n.at) continue;
      if (existing) clearTimeout(existing.timer);
      timers.current.set(n.id, { at: n.at, timer: setTimeout(() => { timers.current.delete(n.id); dispatch({ type: "dismiss", id: n.id }); }, 4000) });
    }
  }, [items]);
  useEffect(() => () => { for (const t of timers.current.values()) clearTimeout(t.timer); }, []);
  return { items, notify, dismiss, dismissWhere };
}
