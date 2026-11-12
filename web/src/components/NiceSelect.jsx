import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLayer } from "../layers.js";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  Search,
  Code,
  Sparkles,
  MessageCircle,
  FileText,
  ShieldOff,
} from "lucide-react";
import { t } from "../i18n.js";

// Devin sends icon names in option._meta["cognition.ai/icon"] — map the ones
// we know; anything else falls back to no icon.
const ICONS = {
  code: Code,
  sparkles: Sparkles,
  "message-circle": MessageCircle,
  "file-text": FileText,
  "shield-off": ShieldOff,
};
const optIcon = (o) => ICONS[o?._meta?.["cognition.ai/icon"]] || null;

const firstWord = (o) => String(o.name || "").split(/[\s-]/)[0] || t("其他");

/**
 * Styled dropdown replacing native <select>. Supports option descriptions,
 * per-option icons, search filtering and vendor grouping for long lists.
 */
export default function NiceSelect({ options, value, onChange, groupBy, className = "", searchable: forceSearch, portal = false, portalOwner, label = t("选项") }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const searchRef = useRef(null);
  const curRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const listRef = useRef(null);
  const panelId = useId();
  const [position, setPosition] = useState(null);
  const searchable = forceSearch ?? (options?.length || 0) > 8;

  // A nested config panel may animate/scroll, so its dropdown belongs outside
  // that clipping/transform context. Keep it inside the visible chat/IME area.
  useLayoutEffect(() => {
    if (!open || !portal) return;
    const update = () => {
      const anchor = triggerRef.current.getBoundingClientRect();
      const vv = window.visualViewport;
      const vx = vv?.offsetLeft || 0, vy = vv?.offsetTop || 0;
      const vw = vv?.width || window.innerWidth, vh = vv?.height || window.innerHeight;
      const chat = triggerRef.current.closest(".chat")?.getBoundingClientRect();
      const minX = Math.max(vx, chat?.width ? chat.left : vx) + 8;
      const maxX = Math.min(vx + vw, chat?.width ? chat.right : vx + vw) - 8;
      const available = Math.max(0, maxX - minX);
      const compact = vw <= 768 || (chat?.width > 0 && chat.width <= 720);
      const width = compact ? available : Math.min(420, available);
      const next = { width, left: Math.max(minX, Math.min(anchor.left, maxX - width)) };
      if (compact) {
        next.bottom = Math.max(8, window.innerHeight - vy - vh + 8);
        next.maxHeight = Math.max(0, Math.min(vh * .62, vh - 16));
      } else {
        const above = anchor.top - vy - 6, below = vy + vh - anchor.bottom - 6;
        next.maxHeight = Math.max(0, Math.min(360, Math.max(above, below)));
        if (above >= below) next.bottom = window.innerHeight - anchor.top + 6;
        else next.top = anchor.bottom + 6;
      }
      setPosition((previous) => previous && Object.keys(previous).length === Object.keys(next).length &&
        Object.entries(next).every(([key, value]) => previous[key] === value) ? previous : next);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(triggerRef.current);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [open, portal]);

  useLayer({ open, ref: panelRef, triggerRef, onClose: () => setOpen(false), initialFocus: false });

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (searchable && !panelRef.current?.contains(document.activeElement)) searchRef.current?.focus({ preventScroll: true });
      // Scroll the list alone, never its clipped ancestors or the chat page.
      const list = listRef.current, current = curRef.current;
      if (list && current) list.scrollTop += current.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - current.offsetHeight) / 2;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open, searchable]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options || [];
    return (options || []).filter(
      (o) =>
        String(o.name || "").toLowerCase().includes(q) ||
        String(o.value || "").toLowerCase().includes(q) ||
        String(o.description || "").toLowerCase().includes(q)
    );
  }, [options, query]);

  // Group by first name token (vendor family) when enabled; groups keep the
  // order in which they first appear, except single-item groups aren't split.
  const grouped = useMemo(() => {
    if (!groupBy) return [["", filtered]];
    const order = [];
    const map = new Map();
    for (const o of filtered) {
      const g = groupBy(o);
      if (!map.has(g)) {
        map.set(g, []);
        order.push(g);
      }
      map.get(g).push(o);
    }
    return order.map((g) => [g, map.get(g)]);
  }, [filtered, groupBy]);

  const current = (options || []).find((o) => o.value === value);

  const pick = (v) => {
    onChange(v);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus({ preventScroll: true });
  };

  const panel = open && (
    <div id={panelId} ref={panelRef} className={"ns-panel" + (portal ? " ns-floating" : "")}
      data-select-owner={portalOwner} style={portal ? (position || { visibility: "hidden" }) : undefined}>
      {searchable && (
        <div className="ns-search">
          <Search size={13} />
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={label === t("选项") ? t("搜索…") : t("搜索{v0}…", { v0: label })} aria-label={t("搜索{v0}", { v0: label })} />
        </div>
      )}
      <div className="ns-list" ref={listRef} role="listbox" aria-label={label}>
        {filtered.length === 0 && <div className="ns-empty">{t("无匹配项")}</div>}
        {grouped.map(([g, items]) => (
          <div key={g || "_"}>
            {g && <div className="ns-group">{g}</div>}
            {items.map((o) => {
              const Ic = optIcon(o), cur = o.value === value;
              return (
                <button key={o.value} ref={cur ? curRef : null} className={"ns-item" + (cur ? " cur" : "")}
                  role="option" aria-selected={cur} title={o.title || o.name} onClick={() => pick(o.value)} type="button">
                  {Ic && <Ic size={14} className="ns-ic" />}
                  <span className="ns-txt">
                    <span className="ns-name">{o.name}</span>
                    {o.description && <span className="ns-desc">{o.description}</span>}
                  </span>
                  {cur && <Check size={14} className="ns-check" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className={"nice-select " + className} ref={ref} onKeyDown={(event) => {
      if (!open) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && searchable) {
        event.preventDefault(); event.stopPropagation(); searchRef.current?.focus();
      }
    }}>
      <button ref={triggerRef} className="ns-trigger" onClick={() => setOpen((o) => !o)} type="button"
        aria-expanded={open} aria-haspopup="listbox" aria-label={t("{v0}：{v1}", { v0: label, v1: current?.name || value || t("未选择") })} aria-controls={open ? panelId : undefined} title={current?.title || current?.name || value}>
        {current?._meta && optIcon(current) ? (
          React.createElement(optIcon(current), { size: 13 })
        ) : null}
        <span className="ns-value">{current?.name || value || "…"}</span>
        <ChevronDown size={12} className={open ? "flip" : ""} />
      </button>
      {portal && panel ? createPortal(panel, document.body) : panel}
    </div>
  );
}

export { firstWord };
