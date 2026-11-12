import React, { useId, useRef, useState } from "react";
import { ChevronUp, SlidersHorizontal } from "lucide-react";
import { useLayer } from "../layers.js";
import NiceSelect, { firstWord } from "./NiceSelect.jsx";
import { t } from "../i18n.js";

export function modelOption(option) {
  const full = String(option.name || option.value || "");
  const qualified = full.match(/^([^\s/]+)\/(.+)$/);
  const provider = qualified?.[1] || String(option.value || "").match(/^([^\s/]+)\/.+$/)?.[1];
  return { ...option, name: qualified?.[2] || full, title: full, provider,
    description: [provider, option.description].filter(Boolean).join(" · ") };
}

/**
 * One popover for the secondary config selects (model / thinking / speed…).
 * The session mode select is rendered separately by ChatView. The trigger
 * shows the current model name when it can be identified.
 */
export default function ConfigMenu({ selects, onConfig }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const ownerId = useId();

  useLayer({ open, ref, onClose: () => setOpen(false), initialFocus: false });

  if (!selects?.length) return null;

  const current = (s) => s.options?.find((o) => o.value === s.currentValue)?.name || s.currentValue;
  const isModel = (s) => s.category === "model" || /model|模型/i.test(s.id + (s.name || ""));
  const primary = selects.find(isModel) || selects[0];

  return (
    <div className="cfg-pop" ref={ref}>
      <button className="cfg-trigger" type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={t("模型与运行选项：{v0}", { v0: current(primary) })}>
        <SlidersHorizontal size={13} />
        <span className="cfg-label">{isModel(primary) ? modelOption({ name: current(primary) }).name : current(primary)}</span>
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
                options={isModel(s) ? s.options.map(modelOption) : s.options}
                value={s.currentValue}
                portal portalOwner={ownerId} label={isModel(s) ? t("模型") : s.name || s.id}
                searchable={isModel(s) ? true : undefined}
                onChange={(v) => onConfig(s.id, v)}
                groupBy={s.options?.length > 16 ? (isModel(s) ? (option) => option.provider || t("其他") : firstWord) : null}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
