import React, { useEffect, useMemo, useRef, useState } from "react";
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

const firstWord = (o) => String(o.name || "").split(/[\s-]/)[0] || "其他";

/**
 * Styled dropdown replacing native <select>. Supports option descriptions,
 * per-option icons, search filtering and vendor grouping for long lists.
 */
export default function NiceSelect({ options, value, onChange, groupBy, className = "" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef(null);
  const searchRef = useRef(null);
  const curRef = useRef(null);

  const searchable = (options?.length || 0) > 8;

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
    // Keep the current option in view.
    requestAnimationFrame(() => curRef.current?.scrollIntoView({ block: "center" }));
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
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
  };

  return (
    <div className={"nice-select " + className} ref={ref}>
      <button className="ns-trigger" onClick={() => setOpen((o) => !o)} type="button">
        {current?._meta && optIcon(current) ? (
          React.createElement(optIcon(current), { size: 13 })
        ) : null}
        <span className="ns-value">{current?.name || value || "…"}</span>
        <ChevronDown size={12} className={open ? "flip" : ""} />
      </button>
      {open && (
        <div className="ns-panel">
          {searchable && (
            <div className="ns-search">
              <Search size={13} />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索…"
              />
            </div>
          )}
          <div className="ns-list">
            {filtered.length === 0 && <div className="ns-empty">无匹配项</div>}
            {grouped.map(([g, items]) => (
              <div key={g || "_"}>
                {g && <div className="ns-group">{g}</div>}
                {items.map((o) => {
                  const Ic = optIcon(o);
                  const cur = o.value === value;
                  return (
                    <button
                      key={o.value}
                      ref={cur ? curRef : null}
                      className={"ns-item" + (cur ? " cur" : "")}
                      onClick={() => pick(o.value)}
                      type="button"
                    >
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
      )}
    </div>
  );
}

export { firstWord };
