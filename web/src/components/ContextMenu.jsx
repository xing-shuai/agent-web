import React, { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Check } from "lucide-react";
import { useLayer } from "../layers.js";
import { t } from "../i18n.js";

/** Drill-down menus share one surface and preserve focus when going back. */
export default function ContextMenu({ menu, onClose }) {
  const panelRef = useRef(null), returnIndex = useRef(null);
  const [navigation, setNavigation] = useState({ menu: null, trail: [] });
  const trail = navigation.menu === menu ? navigation.trail : [];
  const current = trail.at(-1) || menu;
  const back = () => {
    returnIndex.current = trail.at(-1)?.from;
    setNavigation({ menu, trail: trail.slice(0, -1) });
  };
  useLayer({ open: !!menu, ref: panelRef, onClose: () => trail.length ? back() : onClose(), initialFocus: "button:not(:disabled)" });
  useLayoutEffect(() => {
    if (!menu) return;
    const selector = returnIndex.current == null ? "button:not(:disabled)" : `[data-menu-index="${returnIndex.current}"]`;
    panelRef.current?.querySelector(selector)?.focus({ preventScroll: true });
    returnIndex.current = null;
  }, [menu, current]);
  if (!menu) return null;
  const vv = window.visualViewport;
  const vx = vv?.offsetLeft || 0, vy = vv?.offsetTop || 0;
  const vw = vv?.width || window.innerWidth, vh = vv?.height || window.innerHeight;
  const w = Math.min(224, vw - 16);
  const rowHeight = window.matchMedia?.("(max-width: 768px), (pointer: coarse)").matches ? 44 : 38;
  const h = Math.min(vh - 16, current.items.reduce((n, i) => n + (i.sep ? 10 : rowHeight), trail.length ? 60 : 12));
  const x = Math.max(vx + 8, Math.min(menu.x, vx + vw - w - 8));
  const y = Math.max(vy + 8, Math.min(menu.y, vy + vh - h - 8));
  return createPortal(
    <div className="ctx-backdrop" onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
      <div ref={panelRef} className="ctx-menu" role="menu" aria-label={current.title || t("操作菜单")} tabIndex={-1}
        style={{ left: x, top: y, minWidth: w }} onKeyDown={(event) => {
          if (event.key === "ArrowLeft" && trail.length) { event.preventDefault(); event.stopPropagation(); back(); }
          if (event.key === "ArrowRight" && current.items[event.target.dataset.menuIndex]?.children) { event.preventDefault(); event.target.click(); }
        }}>
        {trail.length > 0 && <button type="button" role="menuitem" className="ctx-back" aria-label={t("返回上一级：{v0}", { v0: current.title })} onClick={back}><ChevronLeft size={15} />{current.title}</button>}
        {current.items.map((item, index) => item.sep ? <div key={index} className="ctx-sep" role="separator" /> : (
          <button key={index} type="button" data-menu-index={index} disabled={item.disabled}
            role={item.checked == null ? "menuitem" : "menuitemradio"} aria-checked={item.checked == null ? undefined : item.checked}
            aria-haspopup={item.children ? "menu" : undefined} className={"ctx-item" + (item.danger ? " danger" : "")}
            onClick={() => {
              if (item.children) setNavigation({ menu, trail: [...trail, { items: item.children, title: item.label, from: index }] });
              else { onClose(); item.onClick?.(); }
            }}>
            {item.icon && <item.icon size={15} />}<span className="ctx-label">{item.label}</span>
            {item.checked && <Check size={14} />}{item.children && <ChevronRight size={14} />}
          </button>
        ))}
      </div>
    </div>, document.body
  );
}
