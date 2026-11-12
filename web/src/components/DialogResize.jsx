import { Maximize2, Minimize2 } from "lucide-react";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "../i18n.js";

const MIN_W = 360, MIN_H = 240, MARGIN = 24;
const clampSize = (w, h) => {
  const vw = (window.visualViewport?.width || window.innerWidth) - MARGIN;
  const vh = (window.visualViewport?.height || window.innerHeight) - MARGIN;
  return [vw < MIN_W ? vw : Math.min(Math.max(MIN_W, w), vw),
          vh < MIN_H ? vh : Math.min(Math.max(MIN_H, h), vh)];
};

/** Read a persisted {"w","h"} dialog size; tolerant of missing/bad storage. */
export function readDialogSize(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw == null) return null;
    const { w, h } = JSON.parse(raw);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
  } catch { return null; }
}

// The dialogs remain centered. Pointer capture plus a local shield keeps HTML
// iframes from swallowing drag events; no React state or child remounts.
export default function DialogResize({ target, storageKey }) {
  const drag = useRef(null);
  const apply = () => {
    const d = drag.current;
    if (!d) return;
    d.frame = null;
    d.node.style.width = `${d.width}px`;
    d.node.style.height = `${d.height}px`;
  };
  const persist = (node, w, h) => {
    if (!storageKey) return;
    const [cw, ch] = clampSize(w, h);
    node.style.width = `${cw}px`;
    node.style.height = `${ch}px`;
    try { localStorage.setItem(storageKey, JSON.stringify({ w: Math.round(cw), h: Math.round(ch) })); }
    catch { /* storage is optional */ }
  };
  const finish = () => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.frame); apply(); persist(d.node, d.width, d.height); drag.current = null;
    d.node.removeAttribute("data-resizing");
    if (d.handle.hasPointerCapture?.(d.id)) d.handle.releasePointerCapture(d.id);
  };
  useEffect(() => finish, []);
  return <button type="button" className="dialog-resize" aria-label={t("调整弹框大小")} title={t("拖动调整大小，也可使用方向键")}
    onPointerDown={(e) => {
      if (e.button !== 0 || drag.current || !target.current) return;
      e.preventDefault();
      const node = target.current, box = node.getBoundingClientRect();
      drag.current = { node, handle: e.currentTarget, id: e.pointerId, x: e.clientX, y: e.clientY,
        startWidth: box.width, startHeight: box.height, width: box.width, height: box.height, frame: null };
      node.setAttribute("data-resizing", "");
      e.currentTarget.setPointerCapture(e.pointerId);
    }}
    onPointerMove={(e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      d.width = Math.max(0, d.startWidth + 2 * (e.clientX - d.x));
      d.height = Math.max(0, d.startHeight + 2 * (e.clientY - d.y));
      if (d.frame === null) d.frame = requestAnimationFrame(apply);
    }}
    onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}
    onKeyDown={(e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key) || !target.current) return;
      e.preventDefault(); e.stopPropagation();
      const node = target.current, box = node.getBoundingClientRect();
      const w = Math.max(0, box.width + (e.key === "ArrowRight" ? 20 : e.key === "ArrowLeft" ? -20 : 0));
      const h = Math.max(0, box.height + (e.key === "ArrowDown" ? 20 : e.key === "ArrowUp" ? -20 : 0));
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
      persist(node, w, h);
    }} />;
}

// A CSS override preserves the prior inline/default dimensions for restoration.
export function DialogMaximize({ target, storageKey }) {
  const desktop = () => !window.matchMedia?.("(max-width: 768px), (pointer: coarse)")?.matches;
  const [maximized, setMaximized] = useState(() => {
    try { return !!(storageKey && desktop() && localStorage.getItem(storageKey) === "1"); }
    catch { return false; }
  });
  // Restore before paint so a remembered maximize never animates open.
  useLayoutEffect(() => { if (maximized) target.current?.setAttribute("data-maximized", ""); }, []);
  const label = maximized ? t("还原窗口") : t("最大化窗口");
  return <button type="button" className="icon-ghost dialog-maximize" aria-label={label} title={label} aria-pressed={maximized}
    onClick={() => {
      if (!target.current) return;
      const next = !maximized;
      target.current.toggleAttribute("data-maximized", next);
      setMaximized(next);
      if (storageKey && desktop()) try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch { /* storage is optional */ }
    }}>{maximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>;
}
