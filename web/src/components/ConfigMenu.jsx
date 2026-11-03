import React, { useEffect, useRef, useState } from "react";
import { ChevronUp, SlidersHorizontal } from "lucide-react";
import NiceSelect, { firstWord } from "./NiceSelect.jsx";

/**
 * One popover for the secondary config selects (model / thinking / speed…).
 * The session mode select is rendered separately by ChatView. The trigger
 * shows the current model name when it can be identified.
 */
export default function ConfigMenu({ selects, onConfig }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const esc = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (!selects?.length) return null;

  const current = (s) => s.options?.find((o) => o.value === s.currentValue)?.name || s.currentValue;
  const primary =
    selects.find((s) => /model|模型/i.test(s.id + (s.name || ""))) || selects[0];

  return (
    <div className="cfg-pop" ref={ref}>
      <button className="cfg-trigger" onClick={() => setOpen((o) => !o)} title="模型与运行选项">
        <SlidersHorizontal size={13} />
        <span className="cfg-label">{current(primary)}</span>
        <ChevronUp size={12} className={open ? "" : "flip"} />
      </button>
      {open && (
        <div className="cfg-panel">
          {selects.map((s) => (
            <div key={s.id} className="cfg-row">
              <span className="cfg-name" title={s.description || ""}>
                {s.name || s.id}
              </span>
              <NiceSelect
                options={s.options}
                value={s.currentValue}
                onChange={(v) => onConfig(s.id, v)}
                groupBy={s.options?.length > 16 ? firstWord : null}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
