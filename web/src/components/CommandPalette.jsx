import React, { useEffect, useMemo, useRef, useState } from "react";
import { Search, CornerDownLeft, Zap, MessageSquare, FolderOpen } from "lucide-react";

/**
 * Cmd/Ctrl+K palette — actions + session jump in one list.
 * props:
 *   open, onClose
 *   sessions   [{sessionId,title,cwd,state}]
 *   actions    [{id,title,hint?,run()}]   — shown above session matches
 *   onOpenSession(sessionId)
 */
export default function CommandPalette({ open, onClose, sessions = [], actions = [], onOpenSession }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const entries = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const acts = actions
      .filter((a) => !needle || a.title.toLowerCase().includes(needle))
      .map((a) => ({ kind: "action", key: "a:" + a.id, label: a.title, hint: a.hint, run: a.run }));
    const sess = sessions
      .filter(
        (s) =>
          !needle ||
          (s.title || "").toLowerCase().includes(needle) ||
          s.sessionId.toLowerCase().includes(needle) ||
          (s.cwd || "").toLowerCase().includes(needle)
      )
      .slice(0, 15)
      .map((s) => ({
        kind: "session",
        key: "s:" + s.sessionId,
        label: s.title || s.sessionId,
        hint: s.cwd,
        run: () => onOpenSession?.(s.sessionId),
      }));
    return [...acts, ...sess];
  }, [q, actions, sessions, onOpenSession]);

  const run = (e) => {
    if (!e) return;
    onClose();
    e.run();
  };

  const onKey = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (i + 1) % Math.max(1, entries.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (i - 1 + entries.length) % Math.max(1, entries.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(entries[idx % Math.max(1, entries.length)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  // Keep the selected row visible.
  useEffect(() => {
    const el = listRef.current?.querySelector(".cp-item.sel");
    el?.scrollIntoView?.({ block: "nearest" });
  }, [idx]);

  if (!open) return null;
  return (
    <div className="cp-backdrop" onMouseDown={onClose}>
      <div className="cp-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cp-input-row">
          <Search size={15} />
          <input
            ref={inputRef}
            value={q}
            placeholder="搜索会话或命令…"
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
          />
        </div>
        <div className="cp-list" ref={listRef}>
          {entries.length === 0 && <div className="cp-empty">无匹配结果</div>}
          {entries.map((e, i) => (
            <button
              key={e.key}
              className={"cp-item" + (i === idx % Math.max(1, entries.length) ? " sel" : "")}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(e)}
            >
              {e.kind === "action" ? (
                <Zap size={13} className="cp-ic" />
              ) : (
                <MessageSquare size={13} className="cp-ic" />
              )}
              <span className="cp-label">{e.label}</span>
              {e.hint && (
                <span className="cp-hint">
                  {e.kind === "session" ? <FolderOpen size={10} /> : null}
                  {e.hint}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="cp-foot">
          <span>
            <CornerDownLeft size={11} /> 选择
          </span>
          <span>↑↓ 移动 · Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
